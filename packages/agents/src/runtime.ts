/**
 * Run runtime shared by LLM and scripted mode:
 *
 *   AsyncQueue  — turns pushed events into the AsyncIterable `investigate` returns
 *   RunState    — one investigation run: seq-stamped events, Postgres persistence, ledger
 *   AgentScope  — one agent inside a run: allowed tools only, ctx injection, findings
 *
 * Everything an agent does goes through AgentScope.callTool / recordFinding,
 * so both modes produce identical events, findings and graph writes.
 */
import {
  AGENT_TOOLS,
  ToolInputSchemas,
  serviceUid,
  type AgentEvent,
  type AgentEventDraft,
  type AgentName,
  type Finding,
  type FindingKind,
  type GraphToolResult,
  type Json,
  type Tenant,
  type ToolContext,
  type ToolName,
} from "@blastradius/shared";
import type { ToolExecutor } from "./executor.ts";
import { McpTransportError } from "./executor.ts";
import { CallLedger, cypherFromEntries, dedupe, evidenceFromEntries, isUid, type LedgerEntry } from "./ledger.ts";

/* ── dependency seams (real modules by default, fakes in unit tests) ────── */

export interface GraphDeps {
  falkorHealth(): Promise<{ ok: boolean; ms?: number; error?: string }>;
  startSession(
    tenant: Tenant,
    s: { sessionId?: string; mode: "incident" | "ask"; question: string; service?: string; agentMode: "llm" | "scripted" },
  ): Promise<{ sessionId: string; uid: string; created: boolean }>;
  recordEpisode(
    tenant: Tenant,
    e: { sessionId: string; agent: AgentName | "system"; kind: string; summary: string },
  ): Promise<{ uid: string; seq: number }>;
  getFindings(tenant: Tenant, sessionId: string): Promise<Finding[]>;
  runCypher(
    tenant: Tenant,
    cypher: string,
    params?: Record<string, Json>,
    opts?: { readOnly?: boolean; timeoutMs?: number },
  ): Promise<{ rows: Record<string, Json>[]; raw: unknown[]; ms: number }>;
}

export interface DbDeps {
  ensureTenant(id: Tenant, name?: string): Promise<boolean>;
  createSession(s: { id: string; tenant: Tenant; mode: "incident" | "ask"; title: string }): Promise<unknown>;
  touchSession(id: string, patch?: { status?: "open" | "closed"; title?: string }): Promise<boolean>;
  addMessage(m: { sessionId: string; role: "user" | "assistant" | "system"; content: string; runId?: string }): Promise<unknown>;
  startRun(r: {
    id: string;
    sessionId: string;
    tenant: Tenant;
    mode: "incident" | "ask";
    agentMode: "llm" | "scripted";
    model?: string;
  }): Promise<boolean>;
  finishRun(id: string, status: "ok" | "error" | "aborted", error?: string): Promise<boolean>;
  appendEvent(e: AgentEvent): Promise<boolean>;
  recordAction(a: import("@blastradius/shared").ActionRecord, runId?: string): Promise<boolean>;
}

export interface RunDeps {
  executor: ToolExecutor;
  graph: GraphDeps;
  db: DbDeps;
}

/* ── errors ─────────────────────────────────────────────────────────────── */

export type ErrorWhere = "falkordb" | "postgres" | "llm" | "action" | "mcp" | "internal";

/** Stops the run: emitted as error{fatal:true} then run_finished{status:'error'}. */
export class FatalRunError extends Error {
  override name = "FatalRunError";
  constructor(
    readonly where: ErrorWhere,
    message: string,
  ) {
    super(message);
  }
}

export class RunAborted extends Error {
  override name = "RunAborted";
  constructor() {
    super("run aborted");
  }
}

/** A tool failed but the graph is up (bad input, timeout…): reported to the agent, run continues. */
export class ToolCallError extends Error {
  override name = "ToolCallError";
}

/** record_finding was called incorrectly (no valid citations…). Reported back to the model. */
export class FindingRejected extends Error {
  override name = "FindingRejected";
}

/* ── AsyncQueue ─────────────────────────────────────────────────────────── */

export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  constructor(private readonly onConsumerReturn?: () => void) {}

  push(x: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: x, done: false });
    else this.items.push(x);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: async () => {
        // The consumer stopped iterating (e.g. SSE client disconnected) → abort the run.
        this.onConsumerReturn?.();
        this.close();
        return { value: undefined as never, done: true };
      },
    };
  }
}

/* ── RunState ───────────────────────────────────────────────────────────── */

export class RunState {
  seq = 0;
  readonly ledger = new CallLedger();
  readonly findings: Finding[] = [];
  readonly startedAt = Date.now();
  /** service uid under investigation (from the alert, or resolved by triage) */
  service?: string;
  /** recall_memory result from the system step (citeable by triage) */
  recallEntry?: LedgerEntry;
  private persist: Promise<unknown> = Promise.resolve();

  constructor(
    readonly runId: string,
    readonly sessionId: string,
    readonly tenant: Tenant,
    readonly deps: RunDeps,
    readonly signal: AbortSignal,
    private readonly sink: (e: AgentEvent) => void,
  ) {}

  /** Stamps runId/sessionId/tenant/seq/ts, streams the event, and queues it for Postgres. */
  emit(draft: AgentEventDraft): AgentEvent {
    const event = {
      ...draft,
      runId: this.runId,
      sessionId: this.sessionId,
      tenant: this.tenant,
      seq: this.seq++,
      ts: new Date().toISOString(),
    } as AgentEvent;
    this.sink(event);
    // Persist in order, best-effort; never awaited by the stream.
    this.persist = this.persist.then(() => this.deps.db.appendEvent(event).catch(() => false));
    return event;
  }

  /** Waits (bounded) for queued Postgres writes. */
  async flush(timeoutMs = 5000): Promise<void> {
    await withTimeout(this.persist, timeoutMs, undefined);
  }

  checkAbort(): void {
    if (this.signal.aborted) throw new RunAborted();
  }

  ctx(agent?: AgentName): ToolContext {
    return { tenant: this.tenant, sessionId: this.sessionId, ...(agent ? { agent } : {}) };
  }

  /**
   * Classifies a failure from FalkorDB/MCP. Transport problems and a failing
   * FalkorDB health check are fatal; anything else is a recoverable tool error.
   */
  async classify(err: unknown): Promise<Error> {
    if (err instanceof FatalRunError || err instanceof RunAborted) return err;
    if (this.signal.aborted) return new RunAborted();
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof McpTransportError) return new FatalRunError("mcp", msg);
    const health = await this.deps.graph.falkorHealth().catch((e: Error) => ({ ok: false, error: e.message }));
    if (!health.ok) return new FatalRunError("falkordb", `FalkorDB unavailable: ${health.error ?? msg}`);
    return new ToolCallError(msg);
  }

  /** Graph memory writes (session, episodes): any failure is fatal (FalkorDB is the product). */
  async graphWrite<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const c = await this.classify(err);
      if (c instanceof ToolCallError) throw new FatalRunError("falkordb", `${what} failed: ${c.message}`);
      throw c;
    }
  }
}

/* ── AgentScope ─────────────────────────────────────────────────────────── */

/** Who each agent hands its findings to by default (the incident pipeline order). */
export const NEXT_AGENT: Partial<Record<AgentName, AgentName>> = {
  triage: "investigator",
  investigator: "expert",
  expert: "scribe",
};

export interface FindingDraft {
  kind: FindingKind;
  claim: string;
  confidence: number;
  about?: string[];
  evidence?: string[];
  /** callIds (or tool names) of this agent's results backing the claim */
  cites: string[];
  /** ids of session findings (read from the graph) this claim builds on — scribe/summary */
  citeFindings?: Finding[];
  /** default: NEXT_AGENT[agent]; pass null for no handoff */
  handTo?: AgentName | null;
}

export class AgentScope {
  readonly findings: Finding[] = [];
  /** callIds this agent may cite */
  private readonly own = new Set<string>();
  readonly allowed: readonly ToolName[];

  constructor(
    readonly run: RunState,
    readonly agent: AgentName,
  ) {
    this.allowed = AGENT_TOOLS[agent];
    if (agent === "triage" && run.recallEntry) this.own.add(run.recallEntry.callId);
  }

  get ledger(): CallLedger {
    return this.run.ledger;
  }

  /** Every uid this agent has seen in its own results (+ the investigated service). */
  knownUids(): Set<string> {
    const entries = this.ownEntries();
    const s = new Set(evidenceFromEntries(entries, Number.MAX_SAFE_INTEGER));
    if (this.run.service) s.add(this.run.service);
    return s;
  }

  ownEntries(): LedgerEntry[] {
    return this.ledger.all().filter((e) => this.own.has(e.callId));
  }

  /**
   * Calls one tool as this agent: enforces AGENT_TOOLS, injects tenant /
   * sessionId / agent, emits tool_call + tool_result (full result), and
   * records the result in the ledger under a fresh callId.
   */
  async callTool(tool: ToolName, input: Record<string, unknown>): Promise<{ callId: string; result: GraphToolResult }> {
    this.run.checkAbort();
    if (!this.allowed.includes(tool)) throw new ToolCallError(`${this.agent} may not call ${tool}`);
    const callId = this.ledger.nextId();
    this.run.emit({ type: "tool_call", agent: this.agent, callId, tool, input: toJsonRecord(input) });
    let result: GraphToolResult;
    try {
      result = await this.run.deps.executor.run(tool, this.run.ctx(this.agent), input);
    } catch (err) {
      const c = await this.run.classify(err);
      this.run.emit({ type: "tool_result", agent: this.agent, callId, tool, error: c.message });
      throw c;
    }
    this.ledger.add(callId, result);
    if (tool !== "record_finding") this.own.add(callId);
    this.run.emit({ type: "tool_result", agent: this.agent, callId, tool, result });
    return { callId, result };
  }

  /**
   * Records a finding the hard-to-misuse way:
   *   - `cites` must resolve to ≥1 of this agent's own tool results;
   *   - `cypher[]` = the EXACT Cypher of those results (+ the cypher[] of
   *     cited handoff rows / session findings) — never model-written;
   *   - evidence/about uids are kept only if they appeared in this agent's
   *     results; evidence defaults to the cited results' path nodes.
   */
  async recordFinding(d: FindingDraft): Promise<Finding> {
    const { entries, unknown } = this.ledger.resolve(d.cites);
    const usable = entries.filter((e) => this.own.has(e.callId));
    const foreign = entries.filter((e) => !this.own.has(e.callId)).map((e) => e.callId);
    const findingCypher = (d.citeFindings ?? []).flatMap((f) => f.cypher);
    if (!usable.length && !findingCypher.length) {
      throw new FindingRejected(
        `record_finding needs cites: the callIds of your own tool results that back the claim` +
          (unknown.length || foreign.length ? ` (not citeable: ${[...unknown, ...foreign].join(", ")})` : ""),
      );
    }
    const cypher = dedupe([...cypherFromEntries(usable), ...handoffRowCypher(usable), ...findingCypher]).filter(Boolean);
    const known = this.knownUids();
    for (const f of d.citeFindings ?? []) for (const u of [...f.about, ...f.evidence]) known.add(u);
    const keep = (xs: readonly string[] | undefined) => dedupe((xs ?? []).filter((u) => isUid(u) && known.has(u)));
    let evidence = keep(d.evidence);
    if (!evidence.length) evidence = evidenceFromEntries(usable);
    if (!evidence.length) evidence = dedupe((d.citeFindings ?? []).flatMap((f) => f.evidence)).slice(0, 25);
    let about = keep(d.about);
    if (!about.length && this.run.service) about = [this.run.service];
    if (!evidence.length) evidence = about.slice();
    const handTo = d.handTo === null ? undefined : (d.handTo ?? NEXT_AGENT[this.agent]);

    const input = ToolInputSchemas.record_finding.parse({
      kind: d.kind,
      claim: d.claim,
      confidence: clamp01(d.confidence),
      about,
      evidence,
      cypher,
      ...(handTo ? { handTo } : {}),
    });
    const { result } = await this.callTool("record_finding", input);
    const finding = findingFromResult(result, {
      sessionId: this.run.sessionId,
      agent: this.agent,
      ...input,
      ...(handTo ? { handTo } : {}),
    });
    this.findings.push(finding);
    this.run.findings.push(finding);
    this.run.emit({ type: "finding", agent: this.agent, finding });
    if (finding.handTo) {
      this.run.emit({
        type: "handoff",
        from: this.agent,
        to: finding.handTo,
        findingId: finding.id,
        note: truncate(finding.claim, 160),
      });
    }
    return finding;
  }
}

/** read_handoffs rows carry the original findings' cypher[]; citing the handoff carries them over. */
function handoffRowCypher(entries: readonly LedgerEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.tool !== "read_handoffs") continue;
    for (const r of e.result.rows) if (Array.isArray(r.cypher)) for (const c of r.cypher) if (typeof c === "string") out.push(c);
  }
  return out;
}

/** The graph returns the Finding in rows[0].finding (or as rows[0]); fill gaps from what we sent. */
export function findingFromResult(
  result: GraphToolResult,
  sent: Omit<Finding, "id" | "uid" | "createdAt">,
): Finding {
  const row = result.rows[0] ?? {};
  const f = (row.finding && typeof row.finding === "object" && !Array.isArray(row.finding) ? row.finding : row) as Record<string, Json>;
  const id = typeof f.id === "string" ? f.id : typeof f.uid === "string" ? String(f.uid).replace(/^Finding:/, "") : undefined;
  if (!id) throw new ToolCallError("record_finding returned no finding id");
  const strArr = (v: Json | undefined, fb: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fb);
  const createdAt =
    typeof f.createdAt === "string" ? f.createdAt : typeof f.createdAt === "number" ? new Date(f.createdAt).toISOString() : new Date().toISOString();
  return {
    id,
    uid: typeof f.uid === "string" ? f.uid : `Finding:${id}`,
    sessionId: typeof f.sessionId === "string" ? f.sessionId : sent.sessionId,
    agent: (typeof f.agent === "string" ? f.agent : sent.agent) as AgentName,
    kind: (typeof f.kind === "string" ? f.kind : sent.kind) as FindingKind,
    claim: typeof f.claim === "string" ? f.claim : sent.claim,
    confidence: typeof f.confidence === "number" ? f.confidence : sent.confidence,
    about: strArr(f.about, sent.about),
    evidence: strArr(f.evidence, sent.evidence),
    cypher: strArr(f.cypher, sent.cypher),
    ...((typeof f.handTo === "string" ? f.handTo : sent.handTo) ? { handTo: (typeof f.handTo === "string" ? f.handTo : sent.handTo) as AgentName } : {}),
    createdAt,
  };
}

/* ── utils ──────────────────────────────────────────────────────────────── */

export function toJsonRecord(x: Record<string, unknown>): Record<string, Json> {
  return JSON.parse(JSON.stringify(x ?? {})) as Record<string, Json>;
}

export function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    t = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p.catch(() => fallback), timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
}

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function normalizeService(s: string | undefined): string | undefined {
  return s ? serviceUid(s.trim()) : undefined;
}
