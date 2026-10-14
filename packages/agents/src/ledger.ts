/**
 * The call ledger: every tool result an agent has seen in this run, keyed by
 * a short callId ("c1", "c2", …). It is what makes `record_finding` hard to
 * misuse:
 *
 *   - The model (or the scripted plan) cites results by callId (or tool name).
 *   - Code copies the EXACT `result.cypher` (+ `extraQueries`) strings of those
 *     results into the finding's `cypher[]` (lesson 5: the Why? drawer matches
 *     them verbatim), so the model can never invent or paraphrase Cypher.
 *   - When no evidence uids are given, code harvests them from the cited
 *     results' paths (and uid-looking row cells).
 *
 * Also home of `modelView()`: the capped projection of a result the model sees.
 */
import { MEMORY_LABELS, MODEL_ROW_CAP, parseUid, type GraphToolResult, type Json, type Row, type ToolName } from "@blastradius/shared";

export interface LedgerEntry {
  callId: string;
  tool: ToolName;
  result: GraphToolResult;
}

export class CallLedger {
  private entries = new Map<string, LedgerEntry>();
  private order: string[] = [];
  private counter = 0;

  constructor(private readonly prefix = "c") {}

  /** Allocates the next callId (stable, short, model-friendly). */
  nextId(): string {
    this.counter += 1;
    return `${this.prefix}${this.counter}`;
  }

  add(callId: string, result: GraphToolResult): LedgerEntry {
    const e: LedgerEntry = { callId, tool: result.tool, result };
    this.entries.set(callId, e);
    this.order.push(callId);
    return e;
  }

  get(callId: string): LedgerEntry | undefined {
    return this.entries.get(callId);
  }

  all(): LedgerEntry[] {
    return this.order.map((id) => this.entries.get(id)!);
  }

  /**
   * Resolves citations to ledger entries. A citation is a callId ("c3") or a
   * tool name ("blast_radius" → its most recent call). Unknown citations are
   * returned separately so the caller can tell the model what was wrong.
   * `record_finding` results are never citeable (a finding cannot back itself).
   */
  resolve(cites: readonly string[]): { entries: LedgerEntry[]; unknown: string[] } {
    const out: LedgerEntry[] = [];
    const unknown: string[] = [];
    const seen = new Set<string>();
    for (const raw of cites) {
      const c = raw.trim();
      let e = this.entries.get(c);
      if (!e) {
        for (let i = this.order.length - 1; i >= 0; i--) {
          const cand = this.entries.get(this.order[i]!)!;
          if (cand.tool === c) {
            e = cand;
            break;
          }
        }
      }
      if (!e || e.tool === "record_finding") {
        unknown.push(c);
        continue;
      }
      if (!seen.has(e.callId)) {
        seen.add(e.callId);
        out.push(e);
      }
    }
    return { entries: out, unknown };
  }
}

/** Exact Cypher strings of a result: the main query, then any extra queries. */
export function cypherOf(result: GraphToolResult): string[] {
  const out = [result.cypher];
  for (const q of result.extraQueries ?? []) out.push(q.cypher);
  return out.filter((s) => typeof s === "string" && s.length > 0);
}

/** Exact Cypher strings of several results, de-duplicated, order preserved. */
export function cypherFromEntries(entries: readonly LedgerEntry[]): string[] {
  return dedupe(entries.flatMap((e) => cypherOf(e.result)));
}

/**
 * Evidence uids harvested from results: every node on every path, then any
 * row cell that looks like a uid (e.g. `service: "Service:cart"`, `pr: "PR:12"`).
 */
export function evidenceFromEntries(entries: readonly LedgerEntry[], max = 25): string[] {
  const out: string[] = [];
  for (const e of entries) {
    for (const p of e.result.paths ?? []) for (const n of p.nodes) out.push(n.id);
  }
  for (const e of entries) {
    for (const r of e.result.rows) collectUids(r, out, 0);
  }
  return dedupe(out)
    .filter((u) => isUid(u) && !MEMORY_LABEL_SET.has(parseUid(u)!.label))
    .slice(0, max);
}

/** Evidence should be domain nodes, not agent memory (Agent/Finding/Episode/Session). */
const MEMORY_LABEL_SET = new Set<string>(MEMORY_LABELS);

function collectUids(v: Json | undefined, out: string[], depth: number): void {
  if (v == null || depth > 3) return;
  if (typeof v === "string") {
    if (isUid(v)) out.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectUids(x, out, depth + 1);
    return;
  }
  if (typeof v === "object") for (const x of Object.values(v)) collectUids(x, out, depth + 1);
}

export function isUid(s: string): boolean {
  return parseUid(s) !== null && !/\s/.test(s);
}

export function dedupe<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

/* ── what the model sees ────────────────────────────────────────────────── */

export interface ModelToolView {
  callId: string;
  tool: ToolName;
  summary: string;
  rowCount: number;
  /** true when rows were cut to MODEL_ROW_CAP */
  truncated: boolean;
  rows: Row[];
  /** uids on the evidence paths (capped), so the model can cite nodes */
  pathNodes: string[];
  cypher: string;
}

/**
 * The capped projection of a tool result given to the model: at most
 * `cap` rows, plus the summary, the Cypher and the full row count. The UI's
 * tool_result event carries the full GraphToolResult instead.
 */
export function modelView(callId: string, result: GraphToolResult, cap = MODEL_ROW_CAP): ModelToolView {
  const rows = result.rows.slice(0, cap);
  const pathNodes = dedupe((result.paths ?? []).flatMap((p) => p.nodes.map((n) => n.id))).slice(0, 40);
  return {
    callId,
    tool: result.tool,
    summary: result.summary,
    rowCount: result.rows.length,
    truncated: result.rows.length > rows.length,
    rows,
    pathNodes,
    cypher: result.cypher,
  };
}
