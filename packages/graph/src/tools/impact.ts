/**
 * tools/impact.ts — Track 01 "What else breaks?": blast_radius,
 * critical_services and failure_communities. All three run FalkorDB graph
 * algorithms (algo.betweenness, algo.labelPropagation, algo.WCC) over the
 * Service/DEPENDS_ON subgraph as agent tools.
 *
 * DEPENDS_ON points caller → callee. If `cart` fails, the services that break
 * are the ones with a DEPENDS_ON path INTO cart (its dependents).
 */
import { serviceUid } from "@blastradius/shared";
import { defineTool, hopInt, makeResult, num, round, str, toolQuery } from "./common.ts";

/** The blast-radius query for a hop cap and direction (hops cannot be a parameter). */
export function blastRadiusCypher(maxHops: number, direction: "dependents" | "dependencies" | "both"): string {
  const h = hopInt(maxHops, 1, 6);
  const pattern =
    direction === "dependents"
      ? `(svc)-[:DEPENDS_ON*1..${h}]->(s)` // svc calls (transitively) into s → svc breaks when s fails
      : direction === "dependencies"
        ? `(s)-[:DEPENDS_ON*1..${h}]->(svc)` // s calls svc → svc is a possible upstream cause
        : `(svc)-[:DEPENDS_ON*1..${h}]-(s)`;
  return `// Q1 "What else breaks if $service fails?"
// 1) betweenness centrality over the whole dependency graph (chokepoints score high)
CALL algo.betweenness({nodeLabels: ['Service'], relationshipTypes: ['DEPENDS_ON']})
YIELD node, score
WITH node AS svc, score AS betweenness
// 2) keep the services within ${h} DEPENDS_ON hops of the alerting service
MATCH (s:Service {uid: $service})
MATCH p = ${pattern}
WHERE svc <> s
// 3) one (shortest) evidence path per affected service
WITH svc, betweenness, p ORDER BY length(p) ASC
WITH svc, betweenness, collect(p)[0] AS path
OPTIONAL MATCH (team:Team)-[:OWNS]->(svc)
RETURN svc.uid AS service, svc.name AS name, length(path) AS hops, betweenness,
       svc.tier AS tier, team.name AS team, path
ORDER BY betweenness DESC, hops ASC`;
}

export const blastRadius = defineTool("blast_radius", async (ctx, args) => {
  const service = serviceUid(args.service);
  const cypher = blastRadiusCypher(args.maxHops, args.direction);
  const params = { service };
  const out = await toolQuery(ctx, cypher, params, { pathColumns: ["path"] });
  for (const r of out.rows) r.betweenness = round(num(r.betweenness));
  const top = out.rows[0];
  const summary = out.rows.length
    ? `${out.rows.length} services within ${args.maxHops} hops of ${service} (${args.direction}); top: ${str(top?.name)} (betweenness ${num(top?.betweenness)})`
    : `no ${args.direction} of ${service} within ${args.maxHops} hops`;
  return makeResult("blast_radius", ctx, cypher, params, out, summary);
});

export const CRITICAL_SERVICES_CYPHER = `// Which services are chokepoints? Betweenness centrality on Service/DEPENDS_ON,
// plus how many services call each one (dependents) and how many it calls.
CALL algo.betweenness({nodeLabels: ['Service'], relationshipTypes: ['DEPENDS_ON']})
YIELD node, score
OPTIONAL MATCH (caller:Service)-[:DEPENDS_ON]->(node)
WITH node, score, count(DISTINCT caller) AS dependents
OPTIONAL MATCH (node)-[:DEPENDS_ON]->(callee:Service)
WITH node, score, dependents, count(DISTINCT callee) AS dependencies
RETURN node.uid AS service, node.name AS name, score AS betweenness, dependents, dependencies
ORDER BY betweenness DESC, dependents DESC
LIMIT $limit`;

export const criticalServices = defineTool("critical_services", async (ctx, args) => {
  const params = { limit: args.limit };
  const out = await toolQuery(ctx, CRITICAL_SERVICES_CYPHER, params);
  for (const r of out.rows) r.betweenness = round(num(r.betweenness));
  const top = out.rows[0];
  const summary = top
    ? `top chokepoint: ${str(top.name)} (betweenness ${num(top.betweenness)}, ${num(top.dependents)} dependents)`
    : "no services";
  return makeResult("critical_services", ctx, CRITICAL_SERVICES_CYPHER, params, out, summary);
});

/** CDLP (label propagation) or WCC over the dependency graph. */
export function failureCommunitiesCypher(algorithm: "cdlp" | "wcc"): string {
  return algorithm === "cdlp"
    ? `// Which services fail together? Community detection by label propagation (CDLP)
CALL algo.labelPropagation({nodeLabels: ['Service'], relationshipTypes: ['DEPENDS_ON']})
YIELD node, communityId
WITH communityId AS community, collect(node.uid) AS services, collect(node.name) AS names
RETURN community, services, names, size(services) AS size
ORDER BY size DESC, community ASC`
    : `// Which services are connected at all? Weakly connected components (WCC)
CALL algo.WCC({nodeLabels: ['Service'], relationshipTypes: ['DEPENDS_ON']})
YIELD node, componentId
WITH componentId AS community, collect(node.uid) AS services, collect(node.name) AS names
RETURN community, services, names, size(services) AS size
ORDER BY size DESC, community ASC`;
}

export const failureCommunities = defineTool("failure_communities", async (ctx, args) => {
  const cypher = failureCommunitiesCypher(args.algorithm);
  const out = await toolQuery(ctx, cypher, {});
  const top = out.rows[0];
  const summary = `${out.rows.length} ${args.algorithm.toUpperCase()} communities; largest has ${num(top?.size)} services`;
  return makeResult("failure_communities", ctx, cypher, {}, out, summary);
});
