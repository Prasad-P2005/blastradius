/**
 * memory.ts — Track 02: all agent memory lives in the tenant graph.
 *
 *   episodic:   (Session)-[:HAS_EPISODE]->(Episode)-[:NEXT]->(Episode)…
 *   semantic:   (Agent)-[:WROTE]->(Finding)-[:ABOUT|SUPPORTED_BY]->(domain node)
 *               (Episode)-[:PRODUCED]->(Finding)
 *   handoffs:   (Finding)-[:HANDED_TO]->(Agent)       the ONLY way agents hand off
 *   procedural: (Incident)-[:RESOLVED_BY]->(Runbook)-[:APPLIES_TO]->(Service),
 *               written by closeIncident (the Scribe) and recalled by later sessions.
 *
 * Concurrency: FalkorDB runs write queries on one graph one at a time, and each
 * query is atomic, so computing an Episode's seq INSIDE the write query (from
 * the session's current last Episode) is safe even when several writers append
 * to the same session at once.
 */
import { randomUUID } from "node:crypto";
import {
  AGENT_INFO,
  CloseIncidentRequestSchema,
  ToolInputSchemas,
  assertLabel,
  cosineDistanceToSimilarity,
  isNodeLabel,
  parseUid,
  serviceUid,
  slugify,
  uid,
  type AgentMode,
  type AgentName,
  type CloseIncidentRequest,
  type CloseIncidentResult,
  type Finding,
  type FindingKind,
  type GraphPath,
  type GraphToolResult,
  type InvestigationMode,
  type Json,
  type NodeLabel,
  type RecalledMemory,
  type Row,
  type SessionSummary,
  type Tenant,
  type ToolContext,
  type ToolInput,
} from "@blastradius/shared";
import { runCypher } from "./connection.ts";
import { pathsFromRaw } from "./convert.ts";
import { embed, vecParam } from "./embed.ts";
import { makeResult, num, queryVector, round, str, toolQuery } from "./tools/common.ts";

const now = () => Date.now();

function requireSession(ctx: ToolContext, tool: string): string {
  if (!ctx.sessionId) throw new Error(`${tool} needs ctx.sessionId (memory tools run inside a session)`);
  return ctx.sessionId;
}
function requireAgent(ctx: ToolContext, tool: string): AgentName {
  if (!ctx.agent) throw new Error(`${tool} needs ctx.agent (the calling agent)`);
  return ctx.agent;
}

/* ── Sessions ─────────────────────────────────────────────────────────────── */

export const START_SESSION_CYPHER = `// Start (or resume) an investigation session
OPTIONAL MATCH (existing:Session {sessionId: $sessionId})
WITH existing IS NULL AS created
MERGE (s:Session {sessionId: $sessionId})
ON CREATE SET s.uid = $uid, s.mode = $mode, s.question = $question, s.startedAt = $now,
              s.status = 'open', s.agentMode = $agentMode
WITH s, created
// the service under investigation (if any)
OPTIONAL MATCH (svc:Service {uid: $service})
FOREACH (_ IN CASE WHEN svc IS NULL THEN [] ELSE [1] END | MERGE (s)-[:INVESTIGATES]->(svc))
FOREACH (_ IN CASE WHEN svc IS NULL THEN [] ELSE [1] END | SET s.service = svc.uid)
RETURN s.sessionId AS sessionId, s.uid AS uid, created`;

export async function startSession(
  tenant: Tenant,
  opts: { sessionId?: string; mode: InvestigationMode; question: string; service?: string; agentMode: AgentMode },
): Promise<{ sessionId: string; uid: string; created: boolean }> {
  const sessionId = opts.sessionId ?? `s_${randomUUID().slice(0, 12)}`;
  const params = {
    sessionId,
    uid: uid("Session", sessionId),
    mode: opts.mode,
    question: opts.question,
    agentMode: opts.agentMode,
    service: opts.service ? serviceUid(opts.service) : null,
    now: now(),
  };
  const { rows } = await runCypher(tenant, START_SESSION_CYPHER, params);
  const r = rows[0];
  if (!r) throw new Error("startSession: no row returned");
  return { sessionId: str(r.sessionId), uid: str(r.uid), created: r.created === true };
}

export const RECORD_EPISODE_CYPHER = `// Append an Episode to the session's chain. seq is computed INSIDE the write
// query (FalkorDB serialises writes per graph), so concurrent appends are safe.
MATCH (s:Session {sessionId: $sessionId})
OPTIONAL MATCH (s)-[:HAS_EPISODE]->(prev:Episode)
WITH s, prev ORDER BY prev.seq DESC LIMIT 1
WITH s, prev, CASE WHEN prev IS NULL THEN 0 ELSE prev.seq + 1 END AS seq
CREATE (ep:Episode {uid: 'Episode:' + $sessionId + ':' + toString(seq), sessionId: $sessionId, seq: seq,
                    agent: $agent, kind: $kind, summary: $summary, at: $now})
CREATE (s)-[:HAS_EPISODE]->(ep)
FOREACH (_ IN CASE WHEN prev IS NULL THEN [] ELSE [1] END | CREATE (prev)-[:NEXT]->(ep))
RETURN ep.uid AS uid, seq`;

export async function recordEpisode(
  tenant: Tenant,
  opts: { sessionId: string; agent: AgentName | "system"; kind: string; summary: string },
): Promise<{ uid: string; seq: number }> {
  const params = { sessionId: opts.sessionId, agent: opts.agent, kind: opts.kind, summary: opts.summary, now: now() };
  const { rows } = await runCypher(tenant, RECORD_EPISODE_CYPHER, params);
  const r = rows[0];
  if (!r) throw new Error(`recordEpisode: session ${opts.sessionId} not found`);
  return { uid: str(r.uid), seq: num(r.seq) };
}

/* ── Findings (record_finding) ────────────────────────────────────────────── */

/** Groups uids by (whitelisted) label so each lookup can use that label's uid index. */
function groupByLabel(uids: string[]): Map<NodeLabel, string[]> {
  const m = new Map<NodeLabel, string[]>();
  for (const u of uids) {
    const p = parseUid(u);
    if (!p || !isNodeLabel(p.label)) continue; // malformed refs are skipped, not fatal
    if (!m.has(p.label)) m.set(p.label, []);
    m.get(p.label)!.push(u);
  }
  return m;
}

/**
 * The record_finding write query. Labels of the ABOUT / SUPPORTED_BY targets
 * are interpolated (after assertLabel) so each lookup uses a uid index;
 * uids that do not exist are simply not linked.
 */
export function recordFindingCypher(about: Map<NodeLabel, string[]>, evidence: Map<NodeLabel, string[]>, handTo: boolean): string {
  const links: string[] = [];
  let i = 0;
  for (const [rel, groups] of [
    ["ABOUT", about],
    ["SUPPORTED_BY", evidence],
  ] as const) {
    for (const label of groups.keys()) {
      const L = assertLabel(label);
      const v = `t${i}`;
      const param = `${rel === "ABOUT" ? "about" : "evidence"}_${L}`;
      links.push(`WITH f
OPTIONAL MATCH (${v}:${L}) WHERE ${v}.uid IN $${param}
WITH f, collect(${v}) AS ${v}s
FOREACH (x IN ${v}s | MERGE (f)-[:${rel}]->(x))`);
      i++;
    }
  }
  return `// Record a Finding: who wrote it, which episode produced it, what it is about,
// what supports it, and (optionally) which agent it is handed to.
MATCH (s:Session {sessionId: $sessionId})
MERGE (ag:Agent {name: $agent})
ON CREATE SET ag.uid = 'Agent:' + $agent, ag.title = $agentTitle
CREATE (f:Finding {uid: $uid})
SET f += $props, f.embedding = vecf32($vec)
CREATE (ag)-[:WROTE]->(f)
WITH s, f
// PRODUCED by the session's latest Episode
OPTIONAL MATCH (s)-[:HAS_EPISODE]->(ep:Episode)
WITH f, ep ORDER BY ep.seq DESC LIMIT 1
FOREACH (_ IN CASE WHEN ep IS NULL THEN [] ELSE [1] END | CREATE (ep)-[:PRODUCED]->(f))
${links.join("\n")}${
    handTo
      ? `
WITH f
// the handoff: the next agent finds this via read_handoffs
MERGE (to:Agent {name: $handTo})
ON CREATE SET to.uid = 'Agent:' + $handTo, to.title = $handToTitle
CREATE (f)-[:HANDED_TO]->(to)`
      : ""
  }
RETURN f.uid AS uid`;
}

export async function recordFinding(
  ctx: ToolContext & { sessionId: string; agent: AgentName },
  input: ToolInput<"record_finding">,
): Promise<{ finding: Finding; result: GraphToolResult }> {
  const sessionId = requireSession(ctx, "record_finding");
  const agent = requireAgent(ctx, "record_finding");
  const args = ToolInputSchemas.record_finding.parse(input);
  const id = `f_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const createdAt = now();
  const finding: Finding = {
    id,
    uid: uid("Finding", id),
    sessionId,
    agent,
    kind: args.kind as FindingKind,
    claim: args.claim,
    confidence: args.confidence,
    about: args.about,
    evidence: args.evidence,
    cypher: args.cypher,
    ...(args.handTo ? { handTo: args.handTo } : {}),
    createdAt: new Date(createdAt).toISOString(),
  };
  const about = groupByLabel(args.about);
  const evidence = groupByLabel(args.evidence);
  const cypher = recordFindingCypher(about, evidence, Boolean(args.handTo));
  const props: Record<string, Json> = {
    id,
    sessionId,
    agent,
    kind: args.kind,
    claim: args.claim,
    confidence: args.confidence,
    about: args.about,
    evidence: args.evidence,
    cypher: args.cypher,
    createdAt,
  };
  if (args.handTo) props.handTo = args.handTo;
  const params: Record<string, Json> = {
    sessionId,
    agent,
    agentTitle: AGENT_INFO[agent].title,
    uid: finding.uid,
    props,
    text: args.claim,
    vec: vecParam(await embed(args.claim)),
  };
  for (const [l, us] of about) params[`about_${l}`] = us;
  for (const [l, us] of evidence) params[`evidence_${l}`] = us;
  if (args.handTo) {
    params.handTo = args.handTo;
    params.handToTitle = AGENT_INFO[args.handTo].title;
  }
  const out = await toolQuery(ctx, cypher, params, { readOnly: false });
  if (out.rows.length === 0) throw new Error(`record_finding: session ${sessionId} not found`);
  const result = makeResult(
    "record_finding",
    ctx,
    cypher,
    params,
    { rows: [{ finding: finding as unknown as Json }], paths: [], ms: out.ms },
    `${agent} recorded ${args.kind} finding ${id}${args.handTo ? ` and handed it to ${args.handTo}` : ""}`,
  );
  return { finding, result };
}

/** Converts a stored Finding node's plain props back into the contract shape. */
export function findingFromProps(p: Record<string, Json>): Finding {
  const arr = (v: Json | undefined) => (Array.isArray(v) ? v.map(String) : []);
  const f: Finding = {
    id: str(p.id),
    uid: str(p.uid),
    sessionId: str(p.sessionId),
    agent: str(p.agent) as AgentName,
    kind: str(p.kind) as FindingKind,
    claim: str(p.claim),
    confidence: num(p.confidence),
    about: arr(p.about),
    evidence: arr(p.evidence),
    cypher: arr(p.cypher),
    createdAt: new Date(num(p.createdAt)).toISOString(),
  };
  if (typeof p.handTo === "string") f.handTo = p.handTo as AgentName;
  return f;
}

/* ── read_handoffs ────────────────────────────────────────────────────────── */

export const READ_HANDOFFS_CYPHER = `// Findings in THIS session handed to the calling agent (graph-only handoff)
MATCH p = (from:Agent)-[:WROTE]->(f:Finding {sessionId: $sessionId})-[:HANDED_TO]->(:Agent {name: $agent})
RETURN f.id AS finding, f.uid AS uid, from.name AS from, f.kind AS kind, f.claim AS claim,
       f.confidence AS confidence, f.about AS about, f.evidence AS evidence, f.cypher AS cypher,
       f.createdAt AS createdAt, p AS path
ORDER BY createdAt ASC`;

export async function readHandoffs(ctx: ToolContext): Promise<GraphToolResult> {
  const sessionId = requireSession(ctx, "read_handoffs");
  const agent = requireAgent(ctx, "read_handoffs");
  const params = { sessionId, agent };
  const out = await toolQuery(ctx, READ_HANDOFFS_CYPHER, params, { pathColumns: ["path"] });
  const froms = [...new Set(out.rows.map((r) => str(r.from)))];
  const summary = out.rows.length
    ? `${out.rows.length} findings handed to ${agent} (from ${froms.join(", ")})`
    : `no findings handed to ${agent} yet`;
  return makeResult("read_handoffs", ctx, READ_HANDOFFS_CYPHER, params, out, summary);
}

/* ── recall_memory ────────────────────────────────────────────────────────── */

/**
 * Builds the recall query from the branches that apply (service and/or text).
 * Every branch returns the same columns so they can be UNION ALL-ed into ONE
 * query, and every branch excludes the current session.
 */
export function recallMemoryCypher(hasService: boolean, hasText: boolean): string {
  const branches: string[] = [];
  if (hasService) {
    branches.push(`  // findings other sessions recorded ABOUT the service
  MATCH p = (s:Service {uid: $service})<-[:ABOUT]-(f:Finding)
  WHERE $sessionId IS NULL OR f.sessionId <> $sessionId
  RETURN 'finding' AS kind, f.uid AS uid, f.claim AS title, f.kind AS summary, f.sessionId AS sessionId,
         f.agent AS agent, null AS runbook, null AS distance, f.createdAt AS createdAt, p AS path`);
    branches.push(`  // resolved incidents on the service and the runbook that fixed them (procedural memory)
  MATCH p = (s:Service {uid: $service})<-[:AFFECTED]-(i:Incident)-[:RESOLVED_BY]->(rb:Runbook)
  WHERE i.status = 'resolved' AND ($sessionId IS NULL OR coalesce(i.sessionId, '') <> $sessionId)
  RETURN 'incident' AS kind, i.uid AS uid, i.title AS title, i.summary AS summary, i.sessionId AS sessionId,
         null AS agent, {uid: rb.uid, title: rb.title, steps: rb.steps} AS runbook, null AS distance,
         coalesce(i.resolvedAt, i.startedAt) AS createdAt, p AS path`);
  }
  if (hasText) {
    branches.push(`  // findings whose claim is semantically close to $text (vector index on Finding)
  CALL db.idx.vector.queryNodes('Finding', 'embedding', $k, vecf32($vec)) YIELD node AS f, score
  WITH f, score WHERE $sessionId IS NULL OR f.sessionId <> $sessionId
  OPTIONAL MATCH p = (f)-[:ABOUT]->()
  WITH f, score, collect(p)[0] AS p
  RETURN 'finding' AS kind, f.uid AS uid, f.claim AS title, f.kind AS summary, f.sessionId AS sessionId,
         f.agent AS agent, null AS runbook, score AS distance, f.createdAt AS createdAt, p AS path`);
    branches.push(`  // resolved incidents semantically close to $text, with their runbook
  CALL db.idx.vector.queryNodes('Incident', 'embedding', $k, vecf32($vec)) YIELD node AS i, score
  WITH i, score WHERE i.status = 'resolved' AND ($sessionId IS NULL OR coalesce(i.sessionId, '') <> $sessionId)
  MATCH p = (i)-[:RESOLVED_BY]->(rb:Runbook)
  RETURN 'incident' AS kind, i.uid AS uid, i.title AS title, i.summary AS summary, i.sessionId AS sessionId,
         null AS agent, {uid: rb.uid, title: rb.title, steps: rb.steps} AS runbook, score AS distance,
         coalesce(i.resolvedAt, i.startedAt) AS createdAt, p AS path`);
  }
  return `// Recall memory from OTHER sessions: findings + resolved incidents with runbooks,
// each with the path that connects it to the service / question
CALL {
${branches.join("\n  UNION ALL\n")}
}
RETURN kind, uid, title, summary, sessionId, agent, runbook, distance, createdAt, path
ORDER BY createdAt DESC`;
}

export async function recallMemory(
  ctx: ToolContext,
  input: ToolInput<"recall_memory">,
): Promise<{ memories: RecalledMemory[]; result: GraphToolResult }> {
  const args = ToolInputSchemas.recall_memory.parse(input ?? {});
  if (!args.service && !args.text) throw new Error("recall_memory needs a service or a text");
  const service = args.service ? serviceUid(args.service) : null;
  const cypher = recallMemoryCypher(Boolean(service), Boolean(args.text));
  const params: Record<string, Json> = { sessionId: ctx.sessionId ?? null, service, k: args.limit * 2 };
  if (args.text) {
    params.text = args.text;
    params.vec = await queryVector(args.text);
  }
  const { rows, raw, ms } = await runCypher(ctx.tenant, cypher, params, { readOnly: true });
  // Rows and paths line up 1:1 here (one path per memory), so convert per row.
  const perRowPaths: (GraphPath | undefined)[] = raw.map((r) => pathsFromRaw([r], ["path"])[0]);

  // De-duplicate by uid (a memory can match several branches); keep the first,
  // but remember a similarity if any branch had one.
  const anchored = (x?: GraphPath) => Boolean(service && x?.nodes.some((n) => n.id === service));
  const byUid = new Map<string, { row: Row; path?: GraphPath }>();
  rows.forEach((r, i) => {
    const u = str(r.uid);
    const prev = byUid.get(u);
    if (!prev) byUid.set(u, { row: r, path: perRowPaths[i] });
    else {
      if (prev.row.distance === null && r.distance !== null && r.distance !== undefined) prev.row.distance = r.distance;
      // prefer the path anchored at the investigated service (the "why it is relevant here")
      const p = perRowPaths[i];
      if (p && anchored(p) && !anchored(prev.path)) prev.path = p;
    }
  });
  // Rank before cutting to `limit`. The Cypher sorts by recency only, so once a
  // tenant has a few sessions, fresh findings from unrelated runs would crowd
  // out an older resolved incident on the very service that is alerting.
  // Order: incidents on the service (procedural memory: "what worked last
  // time"), findings about the service, other incidents, other findings.
  // The sort is stable, so recency still decides within a tier.
  const tier = ({ row, path }: { row: Row; path?: GraphPath }) => (anchored(path) ? 0 : 2) + (row.kind === "incident" ? 0 : 1);
  const kept = [...byUid.values()].sort((a, b) => tier(a) - tier(b)).slice(0, args.limit);

  const memories: RecalledMemory[] = kept.map(({ row: r, path }) => {
    const m: RecalledMemory = {
      kind: r.kind === "incident" ? "incident" : "finding",
      uid: str(r.uid),
      title: str(r.title),
      summary: str(r.summary),
    };
    if (r.sessionId) m.sessionId = str(r.sessionId);
    if (r.agent) m.agent = str(r.agent) as AgentName;
    if (r.runbook && typeof r.runbook === "object" && !Array.isArray(r.runbook)) {
      const rb = r.runbook as Record<string, Json>;
      m.runbook = { uid: str(rb.uid), title: str(rb.title), steps: Array.isArray(rb.steps) ? rb.steps.map(String) : [] };
    }
    if (r.distance !== null && r.distance !== undefined) m.similarity = round(cosineDistanceToSimilarity(num(r.distance)));
    if (path) m.path = path;
    if (r.createdAt !== null && r.createdAt !== undefined) m.createdAt = new Date(num(r.createdAt)).toISOString();
    return m;
  });

  const outRows: Row[] = memories.map((m) => ({
    kind: m.kind,
    uid: m.uid,
    title: m.title,
    summary: m.summary,
    sessionId: m.sessionId ?? null,
    agent: m.agent ?? null,
    runbook: (m.runbook ?? null) as Json,
    similarity: m.similarity ?? null,
    createdAt: m.createdAt ?? null,
  }));
  const paths = memories.flatMap((m) => (m.path ? [m.path] : []));
  const summary = memories.length
    ? `${memories.length} memories from earlier sessions (${memories.filter((m) => m.kind === "incident").length} incidents, ${memories.filter((m) => m.kind === "finding").length} findings)`
    : "no memories from earlier sessions";
  const result = makeResult("recall_memory", ctx, cypher, params, { rows: outRows, paths, ms }, summary);
  return { memories, result };
}

/* ── Reads ────────────────────────────────────────────────────────────────── */

export const GET_FINDINGS_CYPHER = `// All findings of a session, oldest first
MATCH (f:Finding {sessionId: $sessionId})
RETURN f
ORDER BY f.createdAt ASC`;

export async function getFindings(tenant: Tenant, sessionId: string): Promise<Finding[]> {
  const { rows } = await runCypher(tenant, GET_FINDINGS_CYPHER, { sessionId }, { readOnly: true });
  return rows.map((r) => findingFromProps(((r.f as Record<string, Json>)?.props ?? {}) as Record<string, Json>));
}

export const LIST_SESSIONS_CYPHER = `// Sessions, newest first, with episode and finding counts
MATCH (s:Session)
OPTIONAL MATCH (s)-[:HAS_EPISODE]->(e:Episode)
WITH s, count(e) AS episodes
OPTIONAL MATCH (f:Finding {sessionId: s.sessionId})
WITH s, episodes, count(f) AS findings
RETURN s.sessionId AS sessionId, s.uid AS uid, s.mode AS mode, s.question AS question,
       s.startedAt AS startedAt, s.status AS status, episodes, findings
ORDER BY startedAt DESC
LIMIT $limit`;

export async function listGraphSessions(tenant: Tenant, limit = 50): Promise<SessionSummary[]> {
  const { rows } = await runCypher(tenant, LIST_SESSIONS_CYPHER, { limit }, { readOnly: true });
  return rows.map((r) => ({
    sessionId: str(r.sessionId),
    uid: str(r.uid),
    mode: (r.mode === "ask" ? "ask" : "incident") as InvestigationMode,
    question: str(r.question),
    startedAt: num(r.startedAt),
    status: r.status === "closed" ? "closed" : "open",
    episodes: num(r.episodes),
    findings: num(r.findings),
  }));
}

/* ── closeIncident (the Scribe writes procedural memory) ──────────────────── */

export const CLOSE_INCIDENT_CYPHER = `// Close a session: write the Incident (with its embedding) and the Runbook that
// resolved it, so the NEXT session's recall_memory / past_incidents / similar_incidents find them.
MATCH (sess:Session {sessionId: $sessionId})
MATCH (s:Service {uid: $service})
MERGE (i:Incident {uid: $incidentUid})
SET i += $incident, i.startedAt = coalesce(sess.startedAt, $now), i.embedding = vecf32($vec)
MERGE (rb:Runbook {uid: $runbookUid})
SET rb += $runbook
MERGE (i)-[:AFFECTED]->(s)
MERGE (i)-[:RESOLVED_BY]->(rb)
MERGE (rb)-[:APPLIES_TO]->(s)
MERGE (sess)-[:INVESTIGATES]->(i)
SET sess.status = 'closed', sess.closedAt = $now
WITH i
// the PR that caused it (if known)
OPTIONAL MATCH (pr:PR {uid: $causedByPr})
FOREACH (_ IN CASE WHEN pr IS NULL THEN [] ELSE [1] END | MERGE (i)-[:CAUSED_BY]->(pr))
WITH DISTINCT i
// the people who responded
OPTIONAL MATCH (p:Person) WHERE p.uid IN $responders
WITH i, collect(p) AS people
FOREACH (x IN people | MERGE (i)-[:RESPONDED_BY]->(x))
RETURN i.uid AS incidentUid`;

export async function closeIncident(reqIn: CloseIncidentRequest): Promise<CloseIncidentResult> {
  const req = CloseIncidentRequestSchema.parse(reqIn);
  const t = now();
  const service = serviceUid(req.service);
  const key = `INC-${req.sessionId}`;
  const incidentUid = uid("Incident", key);
  const runbookUid = uid("Runbook", `${slugify(req.runbook.title) || "runbook"}-${req.sessionId}`);
  const rootCause = req.causedByPr ? `Caused by ${req.causedByPr}` : "";
  const incident: Record<string, Json> = {
    key,
    title: req.title,
    summary: req.summary,
    severity: req.severity,
    status: "resolved",
    resolvedAt: t,
    sessionId: req.sessionId,
    findingIds: req.findingIds,
    synthetic: false,
  };
  if (rootCause) incident.rootCause = rootCause;
  const params: Record<string, Json> = {
    sessionId: req.sessionId,
    service,
    incidentUid,
    runbookUid,
    incident,
    runbook: { title: req.runbook.title, steps: req.runbook.steps, createdAt: t, sessionId: req.sessionId, synthetic: false },
    causedByPr: req.causedByPr ?? null,
    responders: req.responders,
    now: t,
    // same text recipe as EMBED_TEXT_FIELDS.Incident (title, summary, rootCause)
    vec: vecParam(await embed([req.title, req.summary, rootCause].filter(Boolean).join("\n"))),
  };
  const { rows } = await runCypher(req.tenant, CLOSE_INCIDENT_CYPHER, params);
  if (rows.length === 0) throw new Error(`closeIncident: session ${req.sessionId} or service ${service} not found`);
  return { incidentUid, runbookUid, cypher: CLOSE_INCIDENT_CYPHER };
}
