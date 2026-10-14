/**
 * Run state: a PURE reducer that turns the AgentEvent stream into UI state.
 *
 * The same function powers three things, which is why it must stay pure:
 *   1. live streaming (one event at a time from /api/investigate),
 *   2. session replay (all events from /api/sessions/[id]/messages at once),
 *   3. the dev fixture replay (?fixture=1).
 * Same events in ⇒ same state out. No Date.now(), no randomness, no mutation of inputs.
 *
 * State is plain JSON-ish data (records + arrays, no Map/Set) so tests can deep-compare it.
 */
import {
  AGENT_INFO,
  parseUid,
  type ActionRecord,
  type AgentEvent,
  type AgentMode,
  type AgentName,
  type Finding,
  type GEdge,
  type GNode,
  type GraphPath,
  type GraphToolResult,
  type InvestigationMode,
  type Json,
  type RecalledMemory,
  type Tenant,
  type ToolName,
} from "@blastradius/shared";

export type RunStatus = "idle" | "running" | "ok" | "error" | "aborted";

/** "system" is used for the memory recall that runs before any agent. */
export type Actor = AgentName | "system";

export interface ToolCallView {
  callId: string;
  agent: Actor;
  tool: ToolName;
  input: Record<string, Json>;
  status: "running" | "done" | "error";
  result?: GraphToolResult;
  error?: string;
  /** seq of the tool_call event (or of memory_recalled for the system recall) */
  seq: number;
  ts: string;
  /** seq of the tool_result event */
  doneSeq?: number;
}

export interface HandoffView {
  from: AgentName;
  to: AgentName;
  findingId: string;
  note: string;
  seq: number;
}

export interface ClaimView {
  /** stable: `${runId}:${seq}:${index}` */
  id: string;
  agent: AgentName;
  text: string;
  findingIds: string[];
}

export interface AgentMessageView {
  seq: number;
  text: string;
  claimIds: string[];
}

export interface AgentView {
  name: AgentName;
  title: string;
  role: string;
  goal: string;
  status: "running" | "done";
  summary?: string;
  /** callIds in order */
  toolCalls: string[];
  /** finding ids in order */
  findings: string[];
  handoffs: HandoffView[];
  /** action ids in order */
  actions: string[];
  messages: AgentMessageView[];
  startedSeq: number;
}

export interface ErrorView {
  seq: number;
  agent?: AgentName;
  where: string;
  message: string;
  fatal: boolean;
}

/** Order in which things first appeared — the chat timeline renders this list. */
export type TimelineItem =
  | { kind: "user"; seq: number }
  | { kind: "memory"; seq: number }
  | { kind: "agent"; agent: AgentName; seq: number }
  | { kind: "actions"; seq: number }
  | { kind: "error"; index: number; seq: number }
  | { kind: "finished"; seq: number };

export interface RunState {
  runId: string | null;
  sessionId: string | null;
  tenant: Tenant | null;
  status: RunStatus;
  mode: InvestigationMode | null;
  agentMode: AgentMode | null;
  model?: string;
  question: string;
  scenarioId?: string;
  service?: string;
  startedAt?: string;
  finishedAt?: string;
  ms?: number;

  timeline: TimelineItem[];
  agents: Partial<Record<AgentName, AgentView>>;
  toolCalls: Record<string, ToolCallView>;
  findings: Record<string, Finding>;
  /** seq at which each finding arrived (for "which tool result came before it") */
  findingSeq: Record<string, number>;
  findingOrder: string[];
  handoffs: HandoffView[];
  actions: Record<string, ActionRecord>;
  actionOrder: string[];
  claims: Record<string, ClaimView>;
  claimOrder: string[];
  memories: RecalledMemory[];
  errors: ErrorView[];

  /** Graph elements this run has touched (from tool paths, findings, memories). Keyed by uid / edge id. */
  nodes: Record<string, GNode>;
  edges: Record<string, GEdge>;
  /** seq at which each node/edge first appeared — the graph pulses recent ones. */
  addedAt: Record<string, number>;
  /** Last event seq applied (dedupe + "now" for pulses). -1 before any event. */
  lastSeq: number;
}

export function initialRunState(): RunState {
  return {
    runId: null,
    sessionId: null,
    tenant: null,
    status: "idle",
    mode: null,
    agentMode: null,
    question: "",
    timeline: [],
    agents: {},
    toolCalls: {},
    findings: {},
    findingSeq: {},
    findingOrder: [],
    handoffs: [],
    actions: {},
    actionOrder: [],
    claims: {},
    claimOrder: [],
    memories: [],
    errors: [],
    nodes: {},
    edges: {},
    addedAt: {},
    lastSeq: -1,
  };
}

/* ── graph merge helpers ─────────────────────────────────────────── */

/** Placeholder node for a bare uid (findings only carry uids). Real data replaces it later. */
export function nodeFromUid(id: string): GNode {
  const p = parseUid(id);
  return { id, label: p?.label ?? "Service", name: p?.key ?? id, props: {} };
}

function isPlaceholder(n: GNode): boolean {
  return Object.keys(n.props).length === 0;
}

function addNode(s: RunState, n: GNode, seq: number): void {
  const prev = s.nodes[n.id];
  if (!prev) {
    s.nodes[n.id] = n;
    s.addedAt[n.id] = seq;
  } else if (isPlaceholder(prev) && !isPlaceholder(n)) {
    s.nodes[n.id] = n; // upgrade placeholder, keep original addedAt
  }
}

function addEdge(s: RunState, e: GEdge, seq: number): void {
  if (!s.edges[e.id]) {
    s.edges[e.id] = e;
    s.addedAt[e.id] = seq;
  }
}

function addPath(s: RunState, p: GraphPath, seq: number): void {
  for (const n of p.nodes) addNode(s, n, seq);
  for (const e of p.edges) {
    // make sure both endpoints exist even if a converter omitted one
    if (!s.nodes[e.source]) addNode(s, nodeFromUid(e.source), seq);
    if (!s.nodes[e.target]) addNode(s, nodeFromUid(e.target), seq);
    addEdge(s, e, seq);
  }
}

function addResult(s: RunState, r: GraphToolResult | undefined, seq: number): void {
  if (!r) return;
  for (const p of r.paths ?? []) addPath(s, p, seq);
}

/* ── the reducer ─────────────────────────────────────────────────── */

function ensureAgent(s: RunState, name: AgentName, seq: number): AgentView {
  let a = s.agents[name];
  if (!a) {
    const info = AGENT_INFO[name];
    a = {
      name,
      title: info?.title ?? name,
      role: info?.role ?? "",
      goal: "",
      status: "running",
      toolCalls: [],
      findings: [],
      handoffs: [],
      actions: [],
      messages: [],
      startedSeq: seq,
    };
    s.agents[name] = a;
    s.timeline.push({ kind: "agent", agent: name, seq });
  }
  return a;
}

/**
 * Shallow-clone the containers we mutate so the previous state object is
 * never changed (React relies on that). Cheap enough for a few hundred events.
 */
function cloneForWrite(prev: RunState): RunState {
  const agents: Partial<Record<AgentName, AgentView>> = {};
  for (const [k, v] of Object.entries(prev.agents) as [AgentName, AgentView][]) {
    agents[k] = {
      ...v,
      toolCalls: [...v.toolCalls],
      findings: [...v.findings],
      handoffs: [...v.handoffs],
      actions: [...v.actions],
      messages: [...v.messages],
    };
  }
  return {
    ...prev,
    timeline: [...prev.timeline],
    agents,
    toolCalls: { ...prev.toolCalls },
    findings: { ...prev.findings },
    findingSeq: { ...prev.findingSeq },
    findingOrder: [...prev.findingOrder],
    handoffs: [...prev.handoffs],
    actions: { ...prev.actions },
    actionOrder: [...prev.actionOrder],
    claims: { ...prev.claims },
    claimOrder: [...prev.claimOrder],
    memories: [...prev.memories],
    errors: [...prev.errors],
    nodes: { ...prev.nodes },
    edges: { ...prev.edges },
    addedAt: { ...prev.addedAt },
  };
}

export function reduce(prev: RunState, ev: AgentEvent): RunState {
  // A different run's event never belongs here (buildSession splits by runId).
  if (prev.runId && ev.runId !== prev.runId) return prev;
  // Idempotent: replaying an event we've already applied is a no-op.
  if (ev.seq <= prev.lastSeq) return prev;

  const s = cloneForWrite(prev);
  s.lastSeq = ev.seq;
  s.runId = ev.runId;
  s.sessionId = ev.sessionId;
  s.tenant = ev.tenant;

  switch (ev.type) {
    case "run_started": {
      s.status = "running";
      s.mode = ev.mode;
      s.agentMode = ev.agentMode;
      if (ev.model) s.model = ev.model;
      s.question = ev.question;
      if (ev.scenarioId) s.scenarioId = ev.scenarioId;
      if (ev.service) {
        s.service = ev.service;
        addNode(s, nodeFromUid(ev.service), ev.seq);
      }
      s.startedAt = ev.ts;
      s.timeline.push({ kind: "user", seq: ev.seq });
      break;
    }
    case "memory_recalled": {
      s.memories = ev.memories;
      for (const m of ev.memories) {
        if (m.path) addPath(s, m.path, ev.seq);
        else addNode(s, nodeFromUid(m.uid), ev.seq);
      }
      if (ev.result) {
        const callId = `recall:${ev.seq}`;
        s.toolCalls[callId] = {
          callId,
          agent: "system",
          tool: ev.result.tool,
          input: ev.result.params,
          status: "done",
          result: ev.result,
          seq: ev.seq,
          ts: ev.ts,
          doneSeq: ev.seq,
        };
        addResult(s, ev.result, ev.seq);
      }
      s.timeline.push({ kind: "memory", seq: ev.seq });
      break;
    }
    case "agent_started": {
      const a = ensureAgent(s, ev.agent, ev.seq);
      a.goal = ev.goal;
      a.status = "running";
      break;
    }
    case "tool_call": {
      const a = ensureAgent(s, ev.agent, ev.seq);
      if (!a.toolCalls.includes(ev.callId)) a.toolCalls.push(ev.callId);
      s.toolCalls[ev.callId] = {
        callId: ev.callId,
        agent: ev.agent,
        tool: ev.tool,
        input: ev.input,
        status: "running",
        seq: ev.seq,
        ts: ev.ts,
      };
      break;
    }
    case "tool_result": {
      const a = ensureAgent(s, ev.agent, ev.seq);
      if (!a.toolCalls.includes(ev.callId)) a.toolCalls.push(ev.callId);
      const prevCall = s.toolCalls[ev.callId];
      const call: ToolCallView = {
        callId: ev.callId,
        agent: ev.agent,
        tool: ev.tool,
        input: prevCall?.input ?? ev.result?.params ?? {},
        seq: prevCall?.seq ?? ev.seq,
        ts: prevCall?.ts ?? ev.ts,
        status: ev.error ? "error" : "done",
        doneSeq: ev.seq,
      };
      if (ev.result) call.result = ev.result;
      if (ev.error) call.error = ev.error;
      s.toolCalls[ev.callId] = call;
      addResult(s, ev.result, ev.seq);
      break;
    }
    case "finding": {
      const f = ev.finding;
      const a = ensureAgent(s, ev.agent, ev.seq);
      if (!a.findings.includes(f.id)) a.findings.push(f.id);
      if (!s.findings[f.id]) s.findingOrder.push(f.id);
      s.findings[f.id] = f;
      s.findingSeq[f.id] = ev.seq;
      for (const u of [...f.about, ...f.evidence]) addNode(s, nodeFromUid(u), ev.seq);
      break;
    }
    case "handoff": {
      const h: HandoffView = { from: ev.from, to: ev.to, findingId: ev.findingId, note: ev.note, seq: ev.seq };
      s.handoffs.push(h);
      ensureAgent(s, ev.from, ev.seq).handoffs.push(h);
      break;
    }
    case "action": {
      const act = ev.action;
      if (!s.actions[act.id]) s.actionOrder.push(act.id);
      s.actions[act.id] = act;
      ensureAgent(s, ev.agent, ev.seq).actions.push(act.id);
      if (!s.timeline.some((t) => t.kind === "actions")) s.timeline.push({ kind: "actions", seq: ev.seq });
      break;
    }
    case "agent_message": {
      const a = ensureAgent(s, ev.agent, ev.seq);
      const claimIds: string[] = [];
      ev.claims.forEach((c, i) => {
        const id = `${ev.runId}:${ev.seq}:${i}`;
        s.claims[id] = { id, agent: ev.agent, text: c.text, findingIds: c.findingIds };
        s.claimOrder.push(id);
        claimIds.push(id);
      });
      a.messages.push({ seq: ev.seq, text: ev.text, claimIds });
      break;
    }
    case "agent_finished": {
      const a = ensureAgent(s, ev.agent, ev.seq);
      a.status = "done";
      a.summary = ev.summary;
      break;
    }
    case "error": {
      const err: ErrorView = { seq: ev.seq, where: ev.where, message: ev.message, fatal: ev.fatal };
      if (ev.agent) err.agent = ev.agent;
      s.errors.push(err);
      s.timeline.push({ kind: "error", index: s.errors.length - 1, seq: ev.seq });
      if (ev.fatal) s.status = "error";
      break;
    }
    case "run_finished": {
      s.status = ev.status;
      s.ms = ev.ms;
      s.finishedAt = ev.ts;
      // any agent still "running" stopped with the run
      for (const a of Object.values(s.agents)) if (a) a.status = "done";
      for (const c of Object.values(s.toolCalls)) {
        if (c.status === "running") s.toolCalls[c.callId] = { ...c, status: "error", error: c.error ?? `run ${ev.status}` };
      }
      s.timeline.push({ kind: "finished", seq: ev.seq });
      break;
    }
  }
  return s;
}

/** Sort by seq so out-of-order delivery (or DB ordering quirks) can't change the result. */
export function buildState(events: readonly AgentEvent[]): RunState {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  return sorted.reduce(reduce, initialRunState());
}

/** A session can contain several runs (follow-up questions). Group by runId in first-seen order. */
export function buildSession(events: readonly AgentEvent[]): RunState[] {
  const order: string[] = [];
  const byRun = new Map<string, AgentEvent[]>();
  for (const ev of events) {
    let list = byRun.get(ev.runId);
    if (!list) {
      list = [];
      byRun.set(ev.runId, list);
      order.push(ev.runId);
    }
    list.push(ev);
  }
  return order.map((id) => buildState(byRun.get(id) ?? []));
}

/* ── selectors ───────────────────────────────────────────────────── */

/** Every finding id a claim points at that we actually have. */
export function findingsForClaim(s: RunState, claimId: string): Finding[] {
  const c = s.claims[claimId];
  if (!c) return [];
  return c.findingIds.map((id) => s.findings[id]).filter((f): f is Finding => !!f);
}

export interface CypherEvidence {
  cypher: string;
  /** the tool call whose result ran exactly this Cypher (null if nothing matched) */
  call: ToolCallView | null;
  /** true when it matched one of the call's extraQueries rather than its main query */
  extra: boolean;
  params: Record<string, Json>;
}

function callMatches(c: ToolCallView, cypher: string): { extra: boolean; params: Record<string, Json> } | null {
  const r = c.result;
  if (!r) return null;
  if (r.cypher === cypher) return { extra: false, params: r.params };
  const x = r.extraQueries?.find((q) => q.cypher === cypher);
  return x ? { extra: true, params: x.params } : null;
}

/**
 * For each Cypher string on a finding, find the tool_result that ran it.
 * Matching is on the EXACT string (contract rule). The same query can run
 * several times (read_handoffs per agent), so prefer: same agent, then the
 * latest call that finished before the finding arrived, then anything.
 */
export function evidenceForFinding(s: RunState, f: Finding): CypherEvidence[] {
  const fSeq = s.findingSeq[f.id] ?? Number.MAX_SAFE_INTEGER;
  const calls = Object.values(s.toolCalls).sort((a, b) => a.seq - b.seq);
  return f.cypher.map((cypher) => {
    const candidates = calls
      .map((c) => ({ c, m: callMatches(c, cypher) }))
      .filter((x): x is { c: ToolCallView; m: { extra: boolean; params: Record<string, Json> } } => x.m !== null);
    const score = (x: { c: ToolCallView }) =>
      (x.c.agent === f.agent ? 2 : 0) + ((x.c.doneSeq ?? x.c.seq) <= fSeq ? 1 : 0);
    let best: (typeof candidates)[number] | undefined;
    for (const x of candidates) {
      // ties go to the later call (closest to the finding)
      if (!best || score(x) >= score(best)) best = x;
    }
    return best
      ? { cypher, call: best.c, extra: best.m.extra, params: best.m.params }
      : { cypher, call: null, extra: false, params: {} };
  });
}

/**
 * The evidence paths for a finding: paths from its matched tool results that
 * touch any of its about/evidence nodes (falling back to all paths of those results).
 */
export function pathsForFinding(s: RunState, f: Finding): GraphPath[] {
  const wanted = new Set([...f.about, ...f.evidence]);
  const out: GraphPath[] = [];
  const seen = new Set<string>();
  for (const ev of evidenceForFinding(s, f)) {
    const paths = ev.call?.result?.paths ?? [];
    const relevant = paths.filter((p) => p.nodes.some((n) => wanted.has(n.id)));
    for (const p of relevant.length ? relevant : paths) {
      const key = p.nodes.map((n) => n.id).join(">") + "|" + p.edges.map((e) => e.id).join(",");
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    }
  }
  return out;
}

/** Node + edge ids involved in this run (for the "dim everything else" effect). */
export function involvedIds(s: RunState): Set<string> {
  return new Set([...Object.keys(s.nodes), ...Object.keys(s.edges)]);
}

/** Elements added within the last `window` events — the graph pulses these. */
export function recentIds(s: RunState, window = 3): Set<string> {
  const out = new Set<string>();
  for (const [id, seq] of Object.entries(s.addedAt)) if (seq > s.lastSeq - window) out.add(id);
  return out;
}

/** Findings of a kind, highest confidence first. */
export function findingsOfKind(s: RunState, kind: Finding["kind"]): Finding[] {
  return s.findingOrder
    .map((id) => s.findings[id])
    .filter((f): f is Finding => !!f && f.kind === kind)
    .sort((a, b) => b.confidence - a.confidence);
}

/** Live counterpart of buildSession: route one event into the run it belongs to (new runId ⇒ new run). */
export function reduceSession(runs: readonly RunState[], ev: AgentEvent): RunState[] {
  const i = runs.findIndex((r) => r.runId === ev.runId);
  if (i === -1) return [...runs, reduce(initialRunState(), ev)];
  const next = reduce(runs[i]!, ev);
  if (next === runs[i]) return runs as RunState[];
  const out = [...runs];
  out[i] = next;
  return out;
}
