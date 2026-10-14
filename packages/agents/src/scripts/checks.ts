/**
 * Verification helpers shared by `smoke` and `concurrency`. Every check reads
 * the REAL stores back (FalkorDB for memory, Postgres for the event log and
 * actions) instead of trusting the in-memory event stream.
 */
import { parseUid, type AgentEvent, type AgentName, type Finding, type InvestigateRequest, type Tenant } from "@blastradius/shared";

type Graph = typeof import("@blastradius/graph");
type Db = typeof import("@blastradius/db");

export interface RunOutcome {
  req: InvestigateRequest;
  events: AgentEvent[];
  sessionId: string;
  runId: string;
  ms: number;
}

export class Checker {
  failures: string[] = [];
  passes = 0;
  ok(cond: unknown, what: string): boolean {
    if (cond) this.passes++;
    else this.failures.push(what);
    return Boolean(cond);
  }
}

export async function runOne(investigate: typeof import("../index.ts").investigate, req: InvestigateRequest): Promise<RunOutcome> {
  const t0 = Date.now();
  const events: AgentEvent[] = [];
  for await (const e of investigate(req)) events.push(e);
  const first = events[0];
  return { req, events, sessionId: first?.sessionId ?? "", runId: first?.runId ?? "", ms: Date.now() - t0 };
}

const INCIDENT_AGENTS: AgentName[] = ["triage", "investigator", "expert", "scribe"];
const CHAIN: [AgentName, AgentName][] = [
  ["triage", "investigator"],
  ["investigator", "expert"],
  ["expert", "scribe"],
];

/** Findings, handoffs, claims, exact cypher, actions and the persisted event log of one run. */
export async function checkRun(c: Checker, o: RunOutcome, graph: Graph, db: Db, opts: { expectActions: boolean }): Promise<Finding[]> {
  const { tenant } = o.req;
  const last = o.events.at(-1);
  c.ok(last?.type === "run_finished" && last.status === "ok", `run finished ok (got ${last?.type === "run_finished" ? last.status : last?.type})`);
  const fatal = o.events.find((e) => e.type === "error" && e.fatal);
  c.ok(!fatal, `no fatal error${fatal && fatal.type === "error" ? `: ${fatal.where} ${fatal.message}` : ""}`);

  // 1. findings, read back from the graph
  // (a session can hold several runs: keep this run's findings, and check each one exists in the graph)
  const runFindingIds = new Set(o.events.flatMap((e) => (e.type === "finding" ? [e.finding.id] : [])));
  const inGraph = await graph.getFindings(tenant, o.sessionId);
  const findings = inGraph.filter((f) => runFindingIds.has(f.id));
  c.ok(findings.length === runFindingIds.size, `all ${runFindingIds.size} streamed findings exist in the graph (${findings.length})`);
  const agents = o.req.mode === "incident" ? INCIDENT_AGENTS : (["navigator"] as AgentName[]);
  for (const a of agents) {
    const mine = findings.filter((f) => f.agent === a);
    c.ok(mine.length > 0, `${a} recorded ≥1 finding in the graph`);
    c.ok(mine.some((f) => f.evidence.length > 0 && f.cypher.length > 0), `${a} has a finding with evidence + cypher`);
  }

  // 2. lesson 5: every finding's cypher[] is exactly a query that ran in this run
  const ran = new Set<string>();
  for (const e of o.events) {
    if (e.type === "tool_result" && e.result) {
      ran.add(e.result.cypher);
      for (const q of e.result.extraQueries ?? []) ran.add(q.cypher);
    }
  }
  for (const f of findings) {
    const stray = f.cypher.filter((q) => !ran.has(q));
    c.ok(stray.length === 0, `finding ${f.id} (${f.agent}/${f.kind}) cypher strings all ran in this run (${stray.length} stray)`);
  }

  // 3. handoff chain in the graph (HANDED_TO)
  if (o.req.mode === "incident") {
    const { rows } = await graph.runCypher(
      tenant,
      `// handoff edges of one session
MATCH (f:Finding {sessionId: $sessionId})-[:HANDED_TO]->(a:Agent)
RETURN f.id AS id, f.agent AS from, a.name AS to`,
      { sessionId: o.sessionId },
      { readOnly: true },
    );
    const pairs = new Set(rows.filter((r) => runFindingIds.has(String(r.id))).map((r) => `${r.from}->${r.to}`));
    for (const [from, to] of CHAIN) c.ok(pairs.has(`${from}->${to}`), `HANDED_TO chain ${from} → ${to} exists in the graph`);
    // downstream agents read handoffs first
    for (const a of ["investigator", "expert", "scribe"] as AgentName[]) {
      const first = o.events.find((e) => e.type === "tool_call" && e.agent === a);
      c.ok(first?.type === "tool_call" && first.tool === "read_handoffs", `${a}'s first tool call is read_handoffs`);
    }
  }

  // 4. claims → real findings with non-empty cypher
  // claims may cite any finding of the session in the graph (the scribe summarises the session)
  const byId = new Map(inGraph.map((f) => [f.id, f]));
  const messages = o.events.filter((e) => e.type === "agent_message");
  c.ok(messages.length === agents.length, `one agent_message per agent (${messages.length})`);
  for (const m of messages) {
    if (m.type !== "agent_message") continue;
    c.ok(m.claims.length > 0, `${m.agent} message has claims`);
    for (const cl of m.claims) {
      c.ok(cl.findingIds.length > 0 && cl.findingIds.every((id) => (byId.get(id)?.cypher.length ?? 0) > 0), `${m.agent} claim maps to graph findings with cypher`);
    }
  }

  // 5. actions (Postgres audit log) — dry_run is fine
  if (opts.expectActions) {
    const actions = await db.listActions(tenant, o.sessionId);
    c.ok(actions.length >= 1, `≥1 action recorded in Postgres (${actions.map((a) => `${a.kind}:${a.status}`).join(", ")})`);
    c.ok(o.events.some((e) => e.type === "action"), "action event emitted");
  }

  // 6. events persisted to Postgres, no seq gaps
  const persisted = await db.listEvents({ runId: o.runId });
  c.ok(persisted.length === o.events.length, `all ${o.events.length} events persisted (${persisted.length} in Postgres)`);
  const seqs = persisted.map((e) => e.seq).sort((a, b) => a - b);
  c.ok(
    seqs.every((s, i) => s === i),
    `event seq 0..${seqs.length - 1} without gaps`,
  );
  const msgs = await db.listMessages(o.sessionId);
  c.ok(msgs.some((m) => m.role === "user" && m.content === o.req.message), "user message saved in Postgres");
  return findings;
}

/** Episode chain of a session: seq 0..n-1, unique, n-1 NEXT edges each seq→seq+1, no forks. */
export async function checkEpisodeChain(c: Checker, graph: Graph, tenant: Tenant, sessionId: string, minEpisodes: number): Promise<number> {
  const { rows } = await graph.runCypher(
    tenant,
    `// the session's episodes, with their outgoing/incoming NEXT degree
MATCH (s:Session {sessionId: $sessionId})-[:HAS_EPISODE]->(e:Episode)
OPTIONAL MATCH (e)-[:NEXT]->(n:Episode)
WITH e, collect(n.seq) AS nextSeqs
OPTIONAL MATCH (p:Episode)-[:NEXT]->(e)
RETURN e.seq AS seq, nextSeqs, count(p) AS incoming
ORDER BY seq`,
    { sessionId },
    { readOnly: true },
  );
  const seqs = rows.map((r) => Number(r.seq));
  c.ok(seqs.length >= minEpisodes, `${sessionId}: ≥${minEpisodes} episodes (${seqs.length})`);
  c.ok(seqs.every((s, i) => s === i), `${sessionId}: episode seq 0..${seqs.length - 1}, no duplicates or gaps`);
  for (const r of rows) {
    const seq = Number(r.seq);
    const next = (r.nextSeqs as number[]).map(Number);
    const isLast = seq === seqs.length - 1;
    c.ok(isLast ? next.length === 0 : next.length === 1 && next[0] === seq + 1, `${sessionId}: episode ${seq} NEXT → ${isLast ? "none" : seq + 1} (got ${next.join(",") || "none"})`);
    c.ok(Number(r.incoming) === (seq === 0 ? 0 : 1), `${sessionId}: episode ${seq} has ${seq === 0 ? "no" : "one"} incoming NEXT`);
  }
  return seqs.length;
}

/** Every about/evidence uid of the findings exists in THIS tenant's graph. */
export async function checkUidsExist(c: Checker, graph: Graph, tenant: Tenant, findings: Finding[], label: string): Promise<void> {
  const uids = [...new Set(findings.flatMap((f) => [...f.about, ...f.evidence]))];
  const byLabel = new Map<string, string[]>();
  for (const u of uids) {
    const p = parseUid(u);
    if (!p) {
      c.ok(false, `${label}: malformed uid ${u}`);
      continue;
    }
    byLabel.set(p.label, [...(byLabel.get(p.label) ?? []), u]);
  }
  for (const [l, us] of byLabel) {
    // label comes from parseUid, i.e. the whitelist
    const { rows } = await graph.runCypher(tenant, `// which of these uids exist in this tenant graph?\nMATCH (n:${l}) WHERE n.uid IN $uids RETURN n.uid AS uid`, { uids: us }, { readOnly: true });
    const found = new Set(rows.map((r) => String(r.uid)));
    const missing = us.filter((u) => !found.has(u));
    c.ok(missing.length === 0, `${label}: all ${us.length} ${l} uids exist in ${tenant}'s graph${missing.length ? ` (missing ${missing.slice(0, 3).join(", ")})` : ""}`);
  }
}

/** None of `otherSessionIds` appear in `tenant`'s graph (Session, Episode or Finding). */
export async function checkNoForeignSessions(c: Checker, graph: Graph, tenant: Tenant, otherSessionIds: string[]): Promise<void> {
  if (!otherSessionIds.length) return;
  const { rows } = await graph.runCypher(
    tenant,
    `// memory written by the OTHER tenant's sessions must never land in this graph
OPTIONAL MATCH (s:Session) WHERE s.sessionId IN $ids
WITH count(s) AS sessions
OPTIONAL MATCH (e:Episode) WHERE e.sessionId IN $ids
WITH sessions, count(e) AS episodes
OPTIONAL MATCH (f:Finding) WHERE f.sessionId IN $ids
RETURN sessions, episodes, count(f) AS findings`,
    { ids: otherSessionIds },
    { readOnly: true },
  );
  const r = rows[0] ?? {};
  c.ok(Number(r.sessions) === 0 && Number(r.episodes) === 0 && Number(r.findings) === 0, `no foreign-tenant sessions/episodes/findings in ${tenant} (got ${JSON.stringify(r)})`);
}

export function report(c: Checker, title: string): boolean {
  if (c.failures.length) {
    console.error(`\n✗ ${title}: ${c.failures.length} failed, ${c.passes} passed`);
    for (const f of c.failures) console.error(`  - ${f}`);
    return false;
  }
  console.log(`\n✓ ${title}: all ${c.passes} checks passed`);
  return true;
}
