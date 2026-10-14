/**
 * tools/context.ts — navigation tools: service_context (1-hop card),
 * explain_path (shortestPath) and search_nodes (full-text indexes).
 */
import { assertLabel, serviceUid, type Json, type NodeLabel } from "@blastradius/shared";
import { FULLTEXT_INDEXES } from "../schema.ts";
import { defineTool, fulltextQuery, hopInt, labelOfUid, makeResult, num, str, toolQuery } from "./common.ts";

export const SERVICE_CONTEXT_CYPHER = `// Context card for $service: everything one hop away, in one row.
// Edge properties (DEPENDS_ON.protocol) are collected with OPTIONAL MATCH first:
// on FalkorDB 6.0.2 a pattern comprehension that binds a relationship variable
// makes LATER comprehensions in the same RETURN come back empty (verified).
MATCH (s:Service {uid: $service})
OPTIONAL MATCH (team:Team)-[:OWNS]->(s)
WITH s, collect(team)[0] AS team
OPTIONAL MATCH (s)-[d1:DEPENDS_ON]->(callee:Service)
WITH s, team, collect({uid: callee.uid, name: callee.name, protocol: d1.protocol}) AS dependsOn
OPTIONAL MATCH (caller:Service)-[d2:DEPENDS_ON]->(s)
WITH s, team, dependsOn, collect({uid: caller.uid, name: caller.name, protocol: d2.protocol}) AS dependents
// pattern comprehensions collect each neighbour kind without multiplying rows
RETURN s.uid AS service, s.name AS name, s.kind AS kind, s.tier AS tier, s.language AS language,
       s.description AS description, team.uid AS team, team.name AS teamName,
       [(team)<-[:MEMBER_OF]-(m:Person) WHERE NOT coalesce(m.isBot, false) | {uid: m.uid, name: m.name}] AS owners,
       dependsOn, dependents,
       [(rb:Runbook)-[:APPLIES_TO]->(s) | {uid: rb.uid, title: rb.title, steps: rb.steps}] AS runbooks,
       [(doc:Doc)-[:ABOUT]->(s) | {uid: doc.uid, title: doc.title, kind: doc.kind}] AS docs,
       [(i:Incident)-[:AFFECTED]->(s) | {uid: i.uid, title: i.title, severity: i.severity, startedAt: i.startedAt}] AS recentIncidents,
       [(dec:Decision)-[:ABOUT]->(s) | {uid: dec.uid, title: dec.title, status: dec.status}] AS decisions,
       // evidence: the 1-hop edges themselves
       [p = (s)-[:DEPENDS_ON]-(:Service) | p] + [p = (s)<-[:OWNS]-(:Team) | p] +
       [p = (s)<-[:APPLIES_TO]-(:Runbook) | p] + [p = (s)<-[:ABOUT]-(:Doc) | p] +
       [p = (s)<-[:ABOUT]-(:Decision) | p] + [p = (s)<-[:AFFECTED]-(:Incident) | p] AS paths`;

export const serviceContext = defineTool("service_context", async (ctx, args) => {
  const service = serviceUid(args.service);
  const params = { service };
  const out = await toolQuery(ctx, SERVICE_CONTEXT_CYPHER, params, { pathColumns: ["paths"] });
  const row = out.rows[0];
  if (row) {
    // OPTIONAL MATCH misses leave {uid: null, …} entries: drop them.
    for (const k of ["dependsOn", "dependents"]) {
      if (Array.isArray(row[k])) row[k] = (row[k] as Json[]).filter((x) => x !== null && typeof x === "object" && !Array.isArray(x) && x.uid !== null);
    }
  }
  if (row && Array.isArray(row.recentIncidents)) {
    // newest first, at most 5 (pattern comprehensions cannot sort)
    row.recentIncidents = (row.recentIncidents as { startedAt?: Json }[])
      .sort((a, b) => num(b.startedAt) - num(a.startedAt))
      .slice(0, 5) as Json;
  }
  const len = (v: Json | undefined) => (Array.isArray(v) ? v.length : 0);
  const summary = row
    ? `${str(row.name)}: owned by ${str(row.teamName) || "no team"}, ${len(row.dependsOn)} dependencies, ${len(row.dependents)} dependents, ${len(row.runbooks)} runbooks, ${len(row.recentIncidents)} incidents`
    : `service ${service} not found`;
  return makeResult("service_context", ctx, SERVICE_CONTEXT_CYPHER, params, out, summary);
});

/** shortestPath is only legal inside WITH/RETURN on FalkorDB, so the path is built in a WITH. */
export function explainPathCypher(fromLabel: NodeLabel, toLabel: NodeLabel, maxHops: number): string {
  const A = assertLabel(fromLabel);
  const B = assertLabel(toLabel);
  const h = hopInt(maxHops, 1, 8);
  return `// How is $from connected to $to? Shortest path over any relationship, either direction.
MATCH (a:${A} {uid: $from}), (b:${B} {uid: $to})
WITH a, b, shortestPath((a)-[*..${h}]-(b)) AS path
WHERE path IS NOT NULL
RETURN length(path) AS hops, [n IN nodes(path) | n.uid] AS nodes,
       [r IN relationships(path) | type(r)] AS rels, path`;
}

export const explainPath = defineTool("explain_path", async (ctx, args) => {
  const cypher = explainPathCypher(labelOfUid(args.from), labelOfUid(args.to), args.maxHops);
  const params = { from: args.from, to: args.to };
  const out = await toolQuery(ctx, cypher, params, { pathColumns: ["path"] });
  const row = out.rows[0];
  const summary = row
    ? `${args.from} is ${num(row.hops)} hops from ${args.to}: ${(row.nodes as string[]).join(" → ")}`
    : `no path within ${args.maxHops} hops between ${args.from} and ${args.to}`;
  return makeResult("explain_path", ctx, cypher, params, out, summary);
});

/** One full-text CALL per label, combined with UNION ALL inside a CALL {} subquery. */
export function searchNodesCypher(labels: NodeLabel[]): string {
  const branches = labels.map(
    (l) => `  CALL db.idx.fulltext.queryNodes('${assertLabel(l)}', $query) YIELD node, score
  RETURN node, score`,
  );
  return `// Resolve a name to node uids: full-text search over names/titles of ${labels.join(", ")}
CALL {
${branches.join("\n  UNION ALL\n")}
}
RETURN node.uid AS uid, labels(node)[0] AS label,
       coalesce(node.name, node.title, node.key, node.uid) AS name, score
ORDER BY score DESC
LIMIT $limit`;
}

export const FULLTEXT_LABELS = Object.keys(FULLTEXT_INDEXES) as NodeLabel[];

export const searchNodes = defineTool("search_nodes", async (ctx, args) => {
  const labels = (args.labels?.length ? args.labels : FULLTEXT_LABELS).filter((l) => FULLTEXT_LABELS.includes(l));
  if (labels.length === 0) throw new Error(`search_nodes: no full-text index on ${args.labels?.join(", ")}`);
  const query = fulltextQuery(args.query);
  if (!query) throw new Error("search_nodes: query has no searchable words");
  const cypher = searchNodesCypher(labels);
  const params = { query, limit: args.limit };
  const out = await toolQuery(ctx, cypher, params);
  const summary = out.rows.length
    ? `${out.rows.length} matches for "${args.query}"; best: ${str(out.rows[0]?.uid)}`
    : `no matches for "${args.query}"`;
  return makeResult("search_nodes", ctx, cypher, params, out, summary);
});
