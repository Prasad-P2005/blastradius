/**
 * tools/incidents.ts — Track 01/02 "What worked last time?": past_incidents
 * (graph walk) and similar_incidents (vector index + expansion in ONE query).
 *
 * Both read procedural memory: seed incidents from the snapshot AND incidents
 * the Scribe wrote when an earlier session was closed (closeIncident), so a
 * new session finds what the previous one learned.
 */
import { cosineDistanceToSimilarity, serviceUid } from "@blastradius/shared";
import { defineTool, hopInt, makeResult, num, queryVector, round, str, toolQuery } from "./common.ts";

export function pastIncidentsCypher(includeNeighbors: boolean): string {
  const h = hopInt(includeNeighbors ? 1 : 0, 0, 1);
  return `// Q4 "What worked last time on $service?" Incidents that AFFECTED the service
// (or a direct DEPENDS_ON neighbour), with cause PR, runbook and responders.
MATCH (s:Service {uid: $service})
MATCH p = (i:Incident)-[:AFFECTED]->(svc:Service)-[:DEPENDS_ON*0..${h}]-(s)
WITH i, svc, p, length(p) - 1 AS hops ORDER BY hops ASC
WITH i, collect(svc.uid)[0] AS service, min(hops) AS hops, collect(p)[0] AS affectedPath
OPTIONAL MATCH cp = (i)-[:CAUSED_BY]->(pr:PR)
WITH i, service, hops, affectedPath, collect(pr.uid)[0] AS causedBy, collect(cp)[0] AS causePath
OPTIONAL MATCH rp = (i)-[:RESOLVED_BY]->(rb:Runbook)
WITH i, service, hops, affectedPath, causedBy, causePath, collect(rb)[0] AS rb, collect(rp)[0] AS runbookPath
OPTIONAL MATCH (i)-[:RESPONDED_BY]->(person:Person)
WITH i, service, hops, affectedPath, causedBy, causePath, rb, runbookPath, collect(person.uid) AS responders
RETURN i.uid AS incident, i.title AS title, i.severity AS severity, i.status AS status,
       i.startedAt AS startedAt, service, hops, causedBy,
       rb.uid AS runbook, rb.title AS runbookTitle, rb.steps AS runbookSteps, responders,
       coalesce(i.synthetic, false) AS synthetic, i.sessionId AS sessionId,
       affectedPath, causePath, runbookPath
ORDER BY hops ASC, startedAt DESC
LIMIT $limit`;
}

export const pastIncidents = defineTool("past_incidents", async (ctx, args) => {
  const service = serviceUid(args.service);
  const cypher = pastIncidentsCypher(args.includeNeighbors);
  const params = { service, limit: args.limit };
  const out = await toolQuery(ctx, cypher, params, { pathColumns: ["affectedPath", "causePath", "runbookPath"] });
  for (const r of out.rows) if (!Array.isArray(r.runbookSteps)) r.runbookSteps = [];
  const top = out.rows[0];
  const summary = top
    ? `${out.rows.length} past incidents on ${service}${args.includeNeighbors ? " or its neighbours" : ""}; latest: ${str(top.incident)} "${str(top.title)}"${top.runbook ? ` (runbook ${str(top.runbookTitle)})` : ""}`
    : `no past incidents on ${service}`;
  return makeResult("past_incidents", ctx, cypher, params, out, summary);
});

export const SIMILAR_INCIDENTS_CYPHER = `// "Have we seen this before?" Vector search over Incident embeddings
// (score = cosine DISTANCE, lower is closer), then follow every hit to its
// affected services, cause PR, runbook and responders IN THE SAME QUERY.
CALL db.idx.vector.queryNodes('Incident', 'embedding', $candidates, vecf32($vec))
YIELD node AS i, score AS distance
OPTIONAL MATCH ap = (i)-[:AFFECTED]->(svc:Service)
WITH i, distance, collect(svc.uid) AS services, collect(ap) AS affectedPaths
OPTIONAL MATCH cp = (i)-[:CAUSED_BY]->(pr:PR)
WITH i, distance, services, affectedPaths, collect(pr.uid)[0] AS causedBy, collect(cp)[0] AS causePath
OPTIONAL MATCH rp = (i)-[:RESOLVED_BY]->(rb:Runbook)
WITH i, distance, services, affectedPaths, causedBy, causePath, collect(rb)[0] AS rb, collect(rp)[0] AS runbookPath
OPTIONAL MATCH (i)-[:RESPONDED_BY]->(person:Person)
WITH i, distance, services, affectedPaths, causedBy, causePath, rb, runbookPath, collect(person.uid) AS responders,
     ($service IS NOT NULL AND $service IN services) AS onService
RETURN i.uid AS incident, i.title AS title, i.severity AS severity, distance,
       CASE WHEN onService THEN $service ELSE services[0] END AS service, services, onService,
       causedBy, rb.uid AS runbook, rb.title AS runbookTitle, rb.steps AS runbookSteps, responders,
       i.sessionId AS sessionId, affectedPaths, causePath, runbookPath
// incidents on the alerting service get a small boost (0.1 of distance)
ORDER BY CASE WHEN onService THEN distance - 0.1 ELSE distance END ASC
LIMIT $k`;

export const similarIncidents = defineTool("similar_incidents", async (ctx, args) => {
  const service = args.service ? serviceUid(args.service) : null;
  const vec = await queryVector(args.text);
  // over-fetch candidates so the service boost can reorder them
  const params = { text: args.text, vec, candidates: args.k * 3, k: args.k, service };
  const out = await toolQuery(ctx, SIMILAR_INCIDENTS_CYPHER, params, {
    pathColumns: ["affectedPaths", "causePath", "runbookPath"],
  });
  // Distances → similarities (0..1) before anything is shown to a human or a model.
  out.rows = out.rows.map((r) => {
    const distance = num(r.distance);
    const { distance: _d, ...rest } = r;
    return { incident: r.incident!, title: r.title!, similarity: round(cosineDistanceToSimilarity(distance)), distance: round(distance, 4), ...rest };
  });
  const top = out.rows[0];
  const summary = top
    ? `${out.rows.length} similar incidents; closest: ${str(top.incident)} "${str(top.title)}" (similarity ${num(top.similarity)})`
    : "no similar incidents";
  return makeResult("similar_incidents", ctx, SIMILAR_INCIDENTS_CYPHER, params, out, summary);
});
