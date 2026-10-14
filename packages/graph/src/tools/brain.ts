/**
 * tools/brain.ts — Track 03 "Company brain": decision_trace and ask_company.
 *
 * Tickets, threads, ADRs and docs live in the same graph as the code, with
 * their embeddings in FalkorDB vector indexes. A vector hit is therefore not a
 * dead end: the same query walks from the hit to the services, PRs, people and
 * decisions around it, which become the answer's sources.
 */
import {
  EMBEDDED_LABELS,
  assertLabel,
  cosineDistanceToSimilarity,
  type EmbeddedLabel,
  type Json,
  type NodeLabel,
} from "@blastradius/shared";
import { defineTool, labelOfUid, makeResult, num, queryVector, round, str, toolQuery } from "./common.ts";

/** How decision_trace finds its starting Decisions. */
export function decisionEntry(kind: "query" | NodeLabel): string {
  switch (kind) {
    case "query":
      return `// entry: Decisions semantically closest to $text (vector index on Decision)
CALL db.idx.vector.queryNodes('Decision', 'embedding', $limit, vecf32($vec))
YIELD node AS d, score AS distance`;
    case "Decision":
      return `// entry: the given Decision
MATCH (d:Decision {uid: $uid})
WITH d, 0.0 AS distance`;
    case "PR":
      return `// entry: Decisions that justified the given PR
MATCH (d:Decision)-[:JUSTIFIES]->(:PR {uid: $uid})
WITH d, 0.0 AS distance`;
    case "Service":
      return `// entry: Decisions about the service, or justifying PRs that touched it
MATCH (s:Service {uid: $uid})
MATCH (d:Decision)
WHERE (d)-[:ABOUT]->(s) OR (d)-[:JUSTIFIES]->(:PR)-[:TOUCHES]->(s)
WITH d, 0.0 AS distance`;
    case "Incident":
      return `// entry: Decisions the incident mentions, or behind the PR that caused it
MATCH (inc0:Incident {uid: $uid})
MATCH (d:Decision)
WHERE (inc0)-[:MENTIONS]->(d) OR (inc0)-[:CAUSED_BY]->(:PR)<-[:JUSTIFIES]-(d)
WITH d, 0.0 AS distance`;
    default:
      throw new Error(`decision_trace cannot start from a ${kind}; give a Decision, PR, Service or Incident uid`);
  }
}

export function decisionTraceCypher(kind: "query" | NodeLabel): string {
  return `// Decision tracing: Doc <-DOCUMENTED_IN- Decision -JUSTIFIES-> PR <-CAUSED_BY- Incident
${decisionEntry(kind)}
WITH DISTINCT d, distance ORDER BY distance ASC LIMIT $limit
OPTIONAL MATCH dp = (d)-[:DOCUMENTED_IN]->(doc:Doc)
WITH d, distance, collect(doc.uid)[0] AS doc, collect(dp) AS docPaths
OPTIONAL MATCH jp = (d)-[:JUSTIFIES]->(pr:PR)
WITH d, distance, doc, docPaths, collect(DISTINCT pr.uid) AS prs, collect(jp) AS prPaths
OPTIONAL MATCH ip = (d)-[:JUSTIFIES]->(:PR)<-[:CAUSED_BY]-(inc:Incident)
WITH d, distance, doc, docPaths, prs, prPaths, collect(DISTINCT inc.uid) AS incidents, collect(ip) AS incidentPaths
OPTIONAL MATCH (d)-[:DECIDED_BY]->(who)
WITH d, distance, doc, docPaths, prs, prPaths, incidents, incidentPaths, collect(DISTINCT who.uid) AS decidedBy
OPTIONAL MATCH (d)-[:ABOUT]->(s:Service)
WITH d, distance, doc, docPaths, prs, prPaths, incidents, incidentPaths, decidedBy, collect(DISTINCT s.uid) AS services
RETURN d.uid AS decision, d.title AS title, d.status AS status, d.decidedAt AS decidedAt, distance,
       doc, prs, incidents, decidedBy, services, docPaths, prPaths, incidentPaths
ORDER BY distance ASC`;
}

export const decisionTrace = defineTool("decision_trace", async (ctx, args) => {
  if (!args.uid && !args.query) throw new Error("decision_trace needs a query or a uid");
  const kind = args.uid ? labelOfUid(args.uid) : "query";
  const cypher = decisionTraceCypher(kind);
  const params: Record<string, Json> = args.uid
    ? { uid: args.uid, limit: args.limit }
    : { text: args.query!, vec: await queryVector(args.query!), limit: args.limit };
  const out = await toolQuery(ctx, cypher, params, { pathColumns: ["docPaths", "prPaths", "incidentPaths"] });
  for (const r of out.rows) {
    const distance = num(r.distance);
    r.similarity = round(cosineDistanceToSimilarity(distance));
    r.distance = round(distance, 4);
  }
  const top = out.rows[0];
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const summary = top
    ? `${str(top.decision)} "${str(top.title)}": doc ${str(top.doc) || "none"}, ${len(top.prs)} PRs, ${len(top.incidents)} incidents`
    : "no matching decision";
  return makeResult("decision_trace", ctx, cypher, params, out, summary);
});

/** Labels ask_company searches by default: every embedded label except agent Findings. */
export const ASK_LABELS = EMBEDDED_LABELS.filter((l) => l !== "Finding");

/**
 * One vector CALL per label, combined with UNION ALL inside CALL {} (verified
 * on FalkorDB 6.0.2), then the top $k overall are expanded to their sources.
 */
export function askCompanyCypher(labels: EmbeddedLabel[]): string {
  const branches = labels.map(
    (l) => `  CALL db.idx.vector.queryNodes('${assertLabel(l)}', 'embedding', $k, vecf32($vec)) YIELD node, score
  RETURN node, score`,
  );
  return `// "Ask the company": vector search across ${labels.join(", ")} (cosine distance, lower = closer)
CALL {
${branches.join("\n  UNION ALL\n")}
}
WITH node AS hit, score AS distance
ORDER BY distance ASC
LIMIT $k
// 1 hop: what each hit is about / justifies / mentions / is documented in / was decided by
OPTIONAL MATCH p = (hit)-[:ABOUT|JUSTIFIES|MENTIONS|DOCUMENTED_IN|DECIDED_BY|AFFECTED|CAUSED_BY|RESOLVED_BY|RESPONDED_BY]-(rel)
WHERE NOT rel:Finding AND NOT rel:Episode
WITH hit, distance, collect(p) AS paths,
     collect({uid: rel.uid, label: labels(rel)[0], name: coalesce(rel.name, rel.title, rel.key, rel.uid),
              rel: type(relationships(p)[0])}) AS related
// 2 hops: the team that owns the service a hit is about (the "who to ask")
OPTIONAL MATCH op = (hit)-[:ABOUT|AFFECTED]->(:Service)<-[:OWNS]-(team:Team)
WITH hit, distance, paths, related, collect(op) AS ownerPaths,
     collect({uid: team.uid, label: 'Team', name: team.name, rel: 'OWNS'}) AS owners
RETURN hit.uid AS source, labels(hit)[0] AS label,
       coalesce(hit.title, hit.name, hit.key, hit.uid) AS title, distance,
       substring(coalesce(hit.text, hit.summary, hit.body, hit.context, hit.decision, ''), 0, 280) AS snippet,
       related + owners AS related, paths, ownerPaths
ORDER BY distance ASC`;
}

export const askCompany = defineTool("ask_company", async (ctx, args) => {
  const labels = (args.labels?.length ? args.labels : ASK_LABELS) as EmbeddedLabel[];
  const cypher = askCompanyCypher(labels);
  const params = { text: args.question, vec: await queryVector(args.question), k: args.k };
  const out = await toolQuery(ctx, cypher, params, { pathColumns: ["paths", "ownerPaths"] });
  out.rows = out.rows.map((r) => {
    const distance = num(r.distance);
    // OPTIONAL MATCH misses produce {uid: null, …} entries: drop them.
    const related = Array.isArray(r.related)
      ? r.related.filter((x) => x !== null && typeof x === "object" && !Array.isArray(x) && x.uid !== null)
      : [];
    return {
      source: r.source!,
      label: r.label!,
      title: r.title!,
      similarity: round(cosineDistanceToSimilarity(distance)),
      distance: round(distance, 4),
      snippet: r.snippet ?? "",
      related,
    };
  });
  const top = out.rows[0];
  const summary = top
    ? `${out.rows.length} sources for "${args.question}"; best: ${str(top.label)} ${str(top.source)} "${str(top.title)}" (similarity ${num(top.similarity)})`
    : `no sources for "${args.question}"`;
  return makeResult("ask_company", ctx, cypher, params, out, summary);
});
