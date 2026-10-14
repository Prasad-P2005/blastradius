/**
 * tools/common.ts — helpers shared by every tool: input parsing, running the
 * one query, separating evidence paths from rows, and building GraphToolResult.
 */
import {
  ToolInputSchemas,
  TOOL_DESCRIPTIONS,
  assertLabel,
  isWriteTool,
  parseUid,
  type GraphPath,
  type GraphToolResult,
  type Json,
  type NodeLabel,
  type Row,
  type ToolArgs,
  type ToolContext,
  type ToolInput,
  type ToolName,
} from "@blastradius/shared";
import { runCypher } from "../connection.ts";
import { pathsFromRaw } from "../convert.ts";
import { embed, vecParam } from "../embed.ts";
import type { ToolSpec } from "./types.ts";

export interface ToolQueryOut {
  rows: Row[];
  paths: GraphPath[];
  ms: number;
}

/**
 * Runs a tool query. Columns listed in `pathColumns` hold `MATCH p = …` paths
 * (or lists of them): they are converted to uid-based GraphPaths by the
 * converter and removed from the plain rows.
 */
export async function toolQuery(
  ctx: ToolContext,
  cypher: string,
  params: Record<string, Json>,
  opts: { pathColumns?: string[]; readOnly?: boolean; timeoutMs?: number } = {},
): Promise<ToolQueryOut> {
  const pathColumns = opts.pathColumns ?? [];
  const { rows, raw, ms } = await runCypher(ctx.tenant, cypher, params, {
    readOnly: opts.readOnly ?? true,
    timeoutMs: opts.timeoutMs,
  });
  const paths = pathColumns.length ? pathsFromRaw(raw, pathColumns) : [];
  const clean = rows.map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) if (!pathColumns.includes(k)) out[k] = v;
    return out;
  });
  return { rows: clean, paths, ms };
}

/**
 * Params as reported in GraphToolResult. The 384-float query vector is
 * replaced by a short description (it is always `embed($text)` of a text
 * param that IS reported), so results stay readable for models and humans.
 */
export function reportedParams(params: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = k === "vec" && Array.isArray(v) ? `<${v.length}-dim embedding of $text>` : v;
  }
  return out;
}

export function makeResult(
  tool: ToolName,
  ctx: ToolContext,
  cypher: string,
  params: Record<string, Json>,
  out: ToolQueryOut,
  summary: string,
  extraQueries?: { cypher: string; params: Record<string, Json> }[],
): GraphToolResult {
  const r: GraphToolResult = {
    tool,
    tenant: ctx.tenant,
    cypher,
    params: reportedParams(params),
    rows: out.rows,
    paths: out.paths,
    summary,
    ms: out.ms,
  };
  if (extraQueries?.length) r.extraQueries = extraQueries.map((q) => ({ cypher: q.cypher, params: reportedParams(q.params) }));
  return r;
}

/** Builds a ToolSpec whose `run` validates input with the contract's zod schema (applying defaults). */
export function defineTool<T extends ToolName>(
  name: T,
  impl: (ctx: ToolContext, args: ToolArgs<T>) => Promise<GraphToolResult>,
): ToolSpec<T> {
  const input = ToolInputSchemas[name];
  return {
    name,
    description: TOOL_DESCRIPTIONS[name],
    input,
    readOnly: !isWriteTool(name),
    async run(ctx: ToolContext, raw: ToolInput<T>) {
      const args = input.parse(raw ?? {}) as ToolArgs<T>;
      return impl(ctx, args);
    },
  };
}

/** Label of a uid, validated against the whitelist (safe to interpolate). */
export function labelOfUid(u: string): NodeLabel {
  const p = parseUid(u);
  if (!p) throw new Error(`not a node uid: ${u}`);
  return assertLabel(p.label);
}

/** A validated integer for interpolation into var-length patterns (`*1..3`), which cannot take params. */
export function hopInt(n: number, min: number, max: number): number {
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`hop count out of range: ${n}`);
  return n;
}

/** Query embedding for vector-index tools. */
export async function queryVector(text: string): Promise<number[]> {
  return vecParam(await embed(text));
}

/**
 * Turns free text into a RediSearch full-text query: lowercase word tokens,
 * prefix-matched (`valk*`) when ≥ 3 chars, OR-ed so partial matches still rank.
 * Strips the punctuation that RediSearch treats as syntax.
 */
export function fulltextQuery(text: string): string {
  const toks = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !STOP.has(t));
  if (toks.length === 0) return "";
  // Exact term (stemmed by RediSearch) OR prefix (no stemming): "payments" matches "payment" and "valk" matches "valkey".
  return toks.map((t) => (t.length >= 3 ? `${t} | ${t}*` : t)).join(" | ");
}
const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "what", "who", "why", "how", "did", "we", "our"]);

export const num = (v: Json | undefined): number => (typeof v === "number" ? v : Number(v ?? 0));
export const str = (v: Json | undefined): string => (v === null || v === undefined ? "" : String(v));
export const round = (x: number, d = 3): number => Math.round(x * 10 ** d) / 10 ** d;
