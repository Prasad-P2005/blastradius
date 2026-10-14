/**
 * scripts/gen-cypher-doc.ts — regenerates docs/CYPHER.md.
 *
 * Every query in the doc is taken from the code (the exact string the tool
 * sends), and every sample output is captured live from FalkorDB by running
 * the tool against the test fixture (namespace `docs`, so real graphs are
 * untouched). Run:
 *   pnpm --filter @blastradius/graph exec tsx scripts/gen-cypher-doc.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "@blastradius/shared/env";
import type { GraphToolResult, Json, ToolName } from "@blastradius/shared";

process.env.BLASTRADIUS_GRAPH_NAMESPACE = "docs";
const g = await import("../src/index.ts");
const { fixtureSnapshot, fixtureDelta } = await import("../test/fixture.ts");
const { schemaStatements } = await import("../src/schema.ts");
const load = await import("../src/load.ts");
const mem = await import("../src/memory.ts");
const reads = await import("../src/reads.ts");
const { NEWEST_PR_CYPHER } = await import("../src/tools/changes.ts");

const out: string[] = [];
const w = (s = "") => out.push(s);
const code = (lang: string, s: string) => w("```" + lang + "\n" + s + "\n```");

/** Trims long values so samples stay readable. */
function trim(v: Json, depth = 0): Json {
  if (typeof v === "string") return v.length > 160 ? v.slice(0, 157) + "…" : v;
  if (Array.isArray(v)) {
    const xs = v.slice(0, depth === 0 ? 6 : 4).map((x) => trim(x, depth + 1));
    return v.length > xs.length ? [...xs, `… ${v.length - xs.length} more`] : xs;
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, depth + 1)]));
  return v;
}

function sample(r: GraphToolResult, maxRows = 4) {
  w(`**Real output** (fixture, ${r.ms} ms): _${r.summary}_`);
  w();
  code("json", r.rows.slice(0, maxRows).map((row) => JSON.stringify(trim(row as Json))).join("\n") + (r.rows.length > maxRows ? `\n… ${r.rows.length - maxRows} more rows` : ""));
  if (r.paths.length) {
    const p = r.paths[0]!;
    const chain = p.nodes
      .map((n, i) => {
        const e = p.edges[i];
        if (!e) return n.id;
        const fwd = e.source === n.id;
        return `${n.id} ${fwd ? `-[:${e.type}]->` : `<-[:${e.type}]-`}`;
      })
      .join(" ");
    w(`Evidence paths: ${r.paths.length}. First: \`${chain}\``);
    w();
  }
}

interface Entry {
  tool: ToolName;
  title: string;
  question: string;
  track: string;
  feature: string;
  notes?: string;
  calls: Record<string, unknown>[];
}

const ctx = { tenant: "acme" as const };

const entries: Entry[] = [
  {
    tool: "blast_radius",
    title: "blast_radius: what else breaks?",
    question: "If `$service` fails, which services break (or, with `direction: dependencies`, what could be the upstream cause)?",
    track: "01",
    feature: "variable-length paths `DEPENDS_ON*1..N` + `algo.betweenness`",
    notes:
      "DEPENDS_ON points caller → callee, so the services that break are the ones with a path INTO the failing service. Betweenness ranks them by how much traffic flows through them. The hop cap is interpolated (Cypher cannot parameterise `*1..N`) after validation as an integer 1..6.",
    calls: [{ service: "cart" }],
  },
  {
    tool: "critical_services",
    title: "critical_services: chokepoints",
    question: "Which services sit on the most dependency paths?",
    track: "01",
    feature: "`algo.betweenness({nodeLabels, relationshipTypes})`",
    calls: [{ limit: 5 }],
  },
  {
    tool: "failure_communities",
    title: "failure_communities: what fails together",
    question: "Which groups of services are tightly coupled (CDLP) or connected at all (WCC)?",
    track: "01",
    feature: "`algo.labelPropagation` (CDLP) and `algo.WCC`",
    calls: [{ algorithm: "cdlp" }, { algorithm: "wcc" }],
  },
  {
    tool: "suspect_changes",
    title: "suspect_changes: what probably caused it?",
    question: "Which recent PRs touched the alerting service or something it depends on?",
    track: "01",
    feature: "derived `TOUCHES` edges + zero-or-more hop `DEPENDS_ON*0..N`; time window from the newest PR",
    notes:
      "\"Recent\" is measured back from `max(PR.mergedAt)` in the graph, not from today, so the frozen snapshot keeps working. Humans sort before bots unless `includeBots`. The evidence path is `Person-AUTHORED->PR-TOUCHES->Service<-DEPENDS_ON-…-alert service`.",
    calls: [{ service: "cart" }],
  },
  {
    tool: "who_knows",
    title: "who_knows: who can fix it / who knows X",
    question: "Who knows the service (or a free-text topic) best?",
    track: "01, 03",
    feature: "`algo.pageRank` combined with authorship activity; full-text on PR titles for topics",
    notes: `**Why PageRank is used this way.** \`algo.pageRank(label, relType)\` is directed and takes one label and one type. Authorship edges point Person → PR, so on the authorship graph alone every person gets the same teleport score (we verified: three authors with 1, 1 and 2 PRs all scored 0.333). So we run PageRank over the **whole company graph** (\`null, null\`): a person gains rank only through incoming edges (incidents they RESPONDED_BY, decisions DECIDED_BY them, threads/issues that MENTION them, findings SUPPORTED_BY them). That is a global "the organisation keeps pointing at this person" signal. We then combine it with service-specific activity:

\`\`\`
activity  = # of the person's PRs that TOUCH the service (or match the topic)
authority = 0.5 + 0.5 × pagerank / max(pagerank among candidates)    ∈ [0.5, 1]
score     = activity × authority × (0.1 if bot else 1)
\`\`\`

Activity decides who is a candidate and dominates the order; authority breaks ties and can at most double a score. Bots are excluded unless \`includeBots\` (then ×0.1). \`onCall\` = has the ON_CALL_FOR edge of the newest rotation week ≤ today.`,
    calls: [{ service: "checkout" }, { topic: "valkey pool" }],
  },
  {
    tool: "on_call",
    title: "on_call: who is on call",
    question: "Who is on call for the service at a given date (default today; falls back to the newest week ≤ date)?",
    track: "01",
    feature: "one `ON_CALL_FOR {weekStart}` edge per week, compared as ISO date strings",
    calls: [{ service: "cart", at: "2025-09-24" }],
  },
  {
    tool: "service_context",
    title: "service_context: the context card",
    question: "What is one hop around this service (team, owners, deps, dependents, runbooks, docs, incidents, decisions)?",
    track: "01, 03",
    feature: "pattern comprehensions (one row, no row multiplication)",
    notes:
      "FalkorDB 6.0.2 quirk we hit: a pattern comprehension that binds a relationship variable (e.g. `[(s)-[d:DEPENDS_ON]->(x) | d.protocol]`) makes later comprehensions in the same RETURN come back empty. So edge properties are collected with OPTIONAL MATCH + collect first, and the comprehensions bind nodes only.",
    calls: [{ service: "cart" }],
  },
  {
    tool: "past_incidents",
    title: "past_incidents: what worked last time",
    question: "Which incidents hit this service (or a direct neighbour), what caused them and which runbook fixed them?",
    track: "01, 02",
    feature: "multi-hop expansion `Incident-AFFECTED->Service`, `-CAUSED_BY->PR`, `-RESOLVED_BY->Runbook`",
    notes: "Reads procedural memory: seed incidents and incidents the Scribe wrote via `closeIncident`.",
    calls: [{ service: "cart" }],
  },
  {
    tool: "similar_incidents",
    title: "similar_incidents: have we seen this before?",
    question: "Which past incidents are semantically similar to this description, and what were their causes and fixes?",
    track: "01, 02",
    feature: "**vector index** `db.idx.vector.queryNodes` + graph expansion in the same query",
    notes:
      "The score FalkorDB returns is a cosine **distance** (lower = closer); the tool converts it with `cosineDistanceToSimilarity()` and reports both. `$vec` is `embed($text)` (384 floats, MiniLM); in `params` it is shown as a placeholder. Incidents on the alerting service get a 0.1 distance boost.",
    calls: [{ text: "cart returns 503, connection pool exhausted", service: "cart" }],
  },
  {
    tool: "decision_trace",
    title: "decision_trace: why did we do this?",
    question: "Trace a decision: the doc that records it, the PRs it justified, and the incidents those PRs caused.",
    track: "03",
    feature: "vector entry (or uid entry) + chain `Doc <-DOCUMENTED_IN- Decision -JUSTIFIES-> PR <-CAUSED_BY- Incident`",
    notes: "The entry clause depends on the input: free text (vector search over Decision), or a Decision / PR / Service / Incident uid.",
    calls: [{ query: "why did we move cart storage to valkey" }, { uid: "Incident:INC-2025-007" }],
  },
  {
    tool: "explain_path",
    title: "explain_path: how are these connected?",
    question: "What is the shortest connection between any two nodes?",
    track: "01",
    feature: "`shortestPath` (only legal inside WITH/RETURN on FalkorDB)",
    calls: [{ from: "Person:alice-chen", to: "Incident:INC-2025-019" }],
  },
  {
    tool: "search_nodes",
    title: "search_nodes: resolve a name",
    question: "Which nodes match this name/title?",
    track: "01, 03",
    feature: "**full-text indexes**, one `db.idx.fulltext.queryNodes` per label combined with `CALL { … UNION ALL … }`",
    notes: "User text is turned into a RediSearch query: each word as exact term OR prefix (`valkey | valkey*`), stop-words dropped.",
    calls: [{ query: "valkey" }],
  },
  {
    tool: "ask_company",
    title: "ask_company: ask the company",
    question: "Answer a free-text company question with sources: incidents, decisions, docs, tickets and threads, plus who/what they connect to.",
    track: "03",
    feature: "**vector search across several labels in ONE query** (`CALL { … UNION ALL … }`, verified on 6.0.2), then 1–2 hop expansion",
    calls: [{ question: "Why did we move the cart to Valkey and what went wrong?" }],
  },
];

// ── Load the fixture ────────────────────────────────────────────────────────
const stats = await g.loadSnapshot("acme", fixtureSnapshot, { reset: true });
const backend = await g.embeddingBackend();

w("# Cypher and graph algorithms");
w();
w("Every query Blastradius depends on, copied from `packages/graph` (this file is generated by `packages/graph/scripts/gen-cypher-doc.ts`, which takes each query string from the code and runs it live). For each query: the question it answers, the hackathon track, the FalkorDB feature it shows, and **real output** captured from FalkorDB 6.0.2.");
w();
w(`> Sample outputs come from the hand-written test fixture (\`packages/graph/test/fixture.ts\`: 9 services, 10 PRs incl. a renovate[bot] PR, 2 incidents with runbooks, an ADR chain, a thread and a ticket), loaded under the \`docs\` graph namespace with **${backend}** embeddings. They can be regenerated against the data team's real snapshot later.`);
w();
w("## Conventions");
w();
w("- One graph per tenant: `blastradius_acme`, `blastradius_globex`. Setting `BLASTRADIUS_GRAPH_NAMESPACE=ns` prefixes the key (`ns_blastradius_acme`); tests use `itest`, this doc uses `docs`.");
w("- Every value is a parameter (`$service`). Only labels, relationship types and validated hop counts are interpolated, after `assertLabel` / `assertRelType` / an integer range check.");
w("- Read tools use `GRAPH.RO_QUERY` (the client's `roQuery`), so they cannot write.");
w("- Every node leaving `packages/graph` is identified by its `uid` (`Service:cart`). FalkorDB internal ids never leave the package: `src/convert.ts` is the single converter, and edges reference node uids.");
w("- Every tool returns `GraphToolResult` with `cypher` exactly as sent, `params`, plain-JSON `rows` and evidence `paths` (from `MATCH p = …` or `shortestPath`). The query vector `$vec` is reported as `<384-dim embedding of $text>`; `$text` itself is in `params`.");
w("- Vector scores are cosine **distances** (lower = closer); rows show `similarity = 1 - distance` (clamped) and `distance`.");
w("- The server's default query timeout is 1000 ms. Tool queries take 1–60 ms on the fixture and on a synthetic 11k-node / 26k-edge graph (`scripts/scale-check.ts`: who_knows 8 ms, blast_radius at 6 hops 21 ms). Bulk loads pass `TIMEOUT 60000`.");
w();
w("## Contents");
w();
for (const e of entries) w(`- [${e.title}](#${e.tool.replace(/_/g, "_")})`);
w("- [Memory (Track 02)](#memory-track-02)");
w("- [UI reads](#ui-reads)");
w("- [Schema and indexes](#schema-and-indexes)");
w("- [Loading](#loading)");
w();
w("## Tools");
w();

for (const e of entries) {
  w(`<a id="${e.tool}"></a>`);
  w(`### ${e.title}`);
  w();
  w(`- **Question:** ${e.question}`);
  w(`- **Track:** ${e.track}`);
  w(`- **FalkorDB feature:** ${e.feature}`);
  w();
  if (e.notes) {
    w(e.notes);
    w();
  }
  const seen = new Set<string>();
  for (const input of e.calls) {
    const r = await g.runTool(e.tool, ctx, input);
    w(`Input \`${JSON.stringify(input)}\`:`);
    w();
    if (!seen.has(r.cypher)) {
      seen.add(r.cypher);
      code("cypher", r.cypher);
      w(`params: \`${JSON.stringify(r.params)}\``);
      w();
    } else {
      w("(same query as above)");
      w();
    }
    sample(r);
  }
}

// ── Memory ──────────────────────────────────────────────────────────────────
w("## Memory (Track 02)");
w();
w("All agent memory is in the tenant graph: episodic (`Session-[:HAS_EPISODE]->Episode-[:NEXT]->Episode`), semantic (`Agent-[:WROTE]->Finding-[:ABOUT|SUPPORTED_BY]->…`, `Episode-[:PRODUCED]->Finding`), handoffs (`Finding-[:HANDED_TO]->Agent`, the only handoff channel) and procedural (`Incident-[:RESOLVED_BY]->Runbook-[:APPLIES_TO]->Service`). The run below is real: session A records a finding for the investigator, is closed, and session B recalls it.");
w();
const sA = "docs_session_a";
const sB = "docs_session_b";
const st = await g.startSession("acme", { sessionId: sA, mode: "incident", question: "cart 5xx at 12%", service: "cart", agentMode: "scripted" });
w("### startSession");
w();
w("Creates or resumes a Session and links it to the investigated service.");
w();
code("cypher", mem.START_SESSION_CYPHER);
w(`Output: \`${JSON.stringify(st)}\``);
w();
const ep = await g.recordEpisode("acme", { sessionId: sA, agent: "triage", kind: "agent_run", summary: "triage started" });
w("### recordEpisode: episodic memory, safe under concurrency");
w();
w("`seq` is computed inside the write query from the session's current last Episode. FalkorDB executes writes to one graph one at a time and each query is atomic, so concurrent appends to one session get distinct, gap-free seqs (the integration test fires 5 in parallel and gets 0..4).");
w();
code("cypher", mem.RECORD_EPISODE_CYPHER);
w(`Output: \`${JSON.stringify(ep)}\``);
w();
const blast = await g.runTool("blast_radius", ctx, { service: "cart" });
const rf = await g.recordFinding(
  { tenant: "acme", sessionId: sA, agent: "triage" },
  { kind: "impact", claim: "Cart failure breaks checkout and frontend", confidence: 0.9, about: ["Service:cart"], evidence: ["Service:checkout", "Service:frontend"], cypher: [blast.cypher], handTo: "investigator" },
);
w("### record_finding: semantic memory + handoff");
w();
w("One write: MERGE the Agent, CREATE the Finding with its embedding (vector index on Finding), WROTE, PRODUCED from the latest Episode, ABOUT / SUPPORTED_BY per target label (so lookups use the uid index; unknown uids are skipped), and HANDED_TO when `handTo` is set. The query text depends on which labels the uids have; this is the query for the call shown:");
w();
code("cypher", rf.result.cypher);
w(`params (abridged): \`${JSON.stringify(trim({ ...rf.result.params, props: "…" } as Json))}\``);
w();
w(`Output finding: \`${JSON.stringify(trim(rf.finding as unknown as Json))}\``);
w();
const ho = await g.runTool("read_handoffs", { tenant: "acme", sessionId: sA, agent: "investigator" }, {});
w("### read_handoffs");
w();
w("- **Question:** what did earlier agents in this session hand to me? **Track:** 02");
w();
code("cypher", ho.cypher);
sample(ho);
const closed = await g.closeIncident({
  tenant: "acme",
  sessionId: sA,
  title: "Cart Valkey pool too small after PR 140",
  summary: "Cart 5xx at 12% because PR 140 shrank the Valkey connection pool.",
  severity: "SEV2",
  service: "cart",
  causedByPr: "PR:140",
  responders: ["Person:alice-chen"],
  runbook: { title: "Restore Valkey pool size", steps: ["Revert PR 140", "Restart cart pods"] },
  findingIds: [rf.finding.id],
});
w("### closeIncident: procedural memory");
w();
w("Written by the Scribe when a session closes. The Incident gets an embedding, so later sessions find it by vector search as well as by graph walk.");
w();
code("cypher", mem.CLOSE_INCIDENT_CYPHER);
w(`Output: \`${JSON.stringify({ incidentUid: closed.incidentUid, runbookUid: closed.runbookUid })}\``);
w();
await g.startSession("acme", { sessionId: sB, mode: "incident", question: "cart errors again", service: "cart", agentMode: "scripted" });
const rec = await g.recallMemory({ tenant: "acme", sessionId: sB }, { service: "cart", text: "cart valkey pool errors" });
w("### recall_memory: recall across sessions");
w();
w("- **Question:** what did OTHER sessions learn about this service / question? **Track:** 02");
w("- **FalkorDB feature:** graph walk + vector index (Finding, Incident) in one `CALL { … UNION ALL … }` query; the current session is excluded in every branch.");
w();
w("Run from session B, right after session A was closed:");
w();
code("cypher", rec.result.cypher);
w(`params: \`${JSON.stringify(rec.result.params)}\``);
w();
sample(rec.result, 6);
w("### getFindings, listGraphSessions");
w();
code("cypher", mem.GET_FINDINGS_CYPHER);
code("cypher", mem.LIST_SESSIONS_CYPHER);
const sessions = await g.listGraphSessions("acme");
w(`Output of listGraphSessions: \`${JSON.stringify(sessions)}\``);
w();

// ── UI reads ────────────────────────────────────────────────────────────────
w("## UI reads");
w();
const ov = await g.overview("acme");
w("### overview: the service map");
w();
code("cypher", reads.OVERVIEW_CYPHER);
w(`Output: ${ov.nodes.length} nodes, ${ov.edges.length} edges (Services, Teams, DEPENDS_ON, OWNS).`);
w();
const nb = await g.neighborhood("acme", "PR:140");
w("### neighborhood");
w();
code("cypher", reads.neighborhoodCypher("PR"));
w(`Output for \`PR:140\`: nodes \`${nb.nodes.map((n) => n.id).join(", ")}\`.`);
w();
const cnt = await g.counts("acme");
w("### counts");
w();
code("cypher", reads.COUNT_LABELS_CYPHER);
code("cypher", reads.COUNT_RELS_CYPHER);
w(`Output: \`${JSON.stringify(cnt)}\``);
w();
const mi = await g.memoryInspector("acme", sA);
w("### memoryInspector");
w();
w("Sessions + procedural memory, and for a selected session its episodes (with the findings each PRODUCED), handoffs and memory subgraph.");
w();
for (const c of [reads.PROCEDURAL_CYPHER, reads.SESSION_EPISODES_CYPHER, reads.SESSION_HANDOFFS_CYPHER, reads.SESSION_SUBGRAPH_CYPHER]) code("cypher", c);
w(`Output for session A: ${mi.session?.episodes.length} episodes, handoffs \`${JSON.stringify(mi.session?.handoffs)}\`, subgraph ${mi.subgraph.nodes.length} nodes / ${mi.subgraph.edges.length} edges of types \`${[...new Set(mi.subgraph.edges.map((e) => e.type))].join(", ")}\`.`);
w();

// ── Schema ──────────────────────────────────────────────────────────────────
w("## Schema and indexes");
w();
w("`ensureSchema(tenant)` runs these statements; \"already indexed\" errors are treated as success, so it is idempotent. Multi-property full-text indexes (`ON (n.name, n.slug, n.description)`) work on 6.0.2.");
w();
code("cypher", schemaStatements().join("\n"));
w();

// ── Loading ─────────────────────────────────────────────────────────────────
w("## Loading");
w();
w(`\`loadSnapshot(tenant, snap, {reset, embed})\`: reset (GRAPH.DELETE) → ensureSchema → nodes by label → relationships by (type, source label, target label) → derive TOUCHES → embeddings. Batches: 500 nodes, 1000 edges, 50 vectors per query, each with \`TIMEOUT 60000\`. Fixture load: \`${JSON.stringify(stats)}\`.`);
w();
w("Node upsert (per label, e.g. Service):");
code("cypher", load.nodeUpsertCypher("Service"));
w("Relationship upsert (per type and endpoint labels; both endpoints labelled so MATCH uses the uid index):");
code("cypher", load.edgeUpsertCypher("DEPENDS_ON", "Service", "Service"));
w("ON_CALL_FOR is MERGEd on `weekStart`, one edge per person/service/week:");
code("cypher", load.edgeUpsertCypher("ON_CALL_FOR", "Person", "Service"));
w("Derived TOUCHES (full load, then the incremental variant used by `ingestDelta`):");
code("cypher", load.touchesCypher(false));
code("cypher", load.touchesCypher(true));
w("Embeddings (text = `EMBED_TEXT_FIELDS[label]` joined by newlines):");
code("cypher", load.setEmbeddingCypher("Incident"));
w("The tenant's \"now\" (used by suspect_changes):");
code("cypher", NEWEST_PR_CYPHER);
const delta = await g.ingestDelta("acme", fixtureDelta.nodes, fixtureDelta.edges);
w(`\`ingestDelta\` (incremental re-ingest, Track 03) runs the same upserts without a reset, derives TOUCHES only for the delta's PRs and embeds only the delta's text nodes. Fixture delta (PR 150): \`${JSON.stringify(delta)}\`; afterwards \`newestPrAt\` = ${new Date(await g.newestPrAt("acme")).toISOString()}.`);
w();

await g.resetGraph("acme");
await g.closeFalkor();
const file = join(findRepoRoot(), "docs", "CYPHER.md");
writeFileSync(file, out.join("\n"));
console.log(`wrote ${file} (${out.length} lines)`);
