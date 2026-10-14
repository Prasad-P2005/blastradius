/**
 * Pure helpers (no I/O) for the MCP server: the input shape of each tool and
 * the static part of the `blastradius://schema` resource.
 *
 * Kept separate from server.ts so they can be unit-tested without FalkorDB.
 */
import { z } from "zod";
import {
  AgentNameSchema,
  EMBEDDED_LABELS,
  EMBEDDING_DIM,
  MEMORY_LABELS,
  NODE_LABELS,
  REL_TYPES,
  TENANTS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  ToolInputSchemas,
  isWriteTool,
  type RelType,
  type ToolName,
} from "@blastradius/shared";

/**
 * Tools that read or write agent memory scoped to a session. Over MCP the
 * caller has no injected context, so these get optional `sessionId` / `agent`
 * fields. `read_handoffs` and `record_finding` cannot work without them;
 * `recall_memory` uses `sessionId` only to exclude the caller's own session.
 */
export const MEMORY_TOOLS = ["recall_memory", "read_handoffs", "record_finding"] as const satisfies readonly ToolName[];
/** Memory tools that fail without both `sessionId` and `agent`. */
export const SESSION_REQUIRED_TOOLS = ["read_handoffs", "record_finding"] as const satisfies readonly ToolName[];

export function isMemoryTool(t: ToolName): boolean {
  return (MEMORY_TOOLS as readonly string[]).includes(t);
}
export function requiresSession(t: ToolName): boolean {
  return (SESSION_REQUIRED_TOOLS as readonly string[]).includes(t);
}

const tenantField = z.enum(TENANTS).describe("Which tenant graph to query (one FalkorDB graph per tenant)");
const sessionIdField = z
  .string()
  .min(1)
  .optional()
  .describe("Investigation session id (required for read_handoffs and record_finding)");
const agentField = AgentNameSchema.optional().describe("Which agent you are acting as (required for read_handoffs and record_finding)");

/**
 * The zod raw shape registered as a tool's `inputSchema`:
 * `{ tenant, ...ToolInputSchemas[name].shape }`, plus `sessionId` / `agent`
 * for memory tools.
 */
export function toolInputShape(name: ToolName): z.ZodRawShape {
  const base = ToolInputSchemas[name].shape as z.ZodRawShape;
  return isMemoryTool(name)
    ? { tenant: tenantField, ...base, sessionId: sessionIdField, agent: agentField }
    : { tenant: tenantField, ...base };
}

/** Which tools the server exposes for a given write mode. */
export function exposedToolNames(allowWrites: boolean, available: readonly ToolName[] = TOOL_NAMES): ToolName[] {
  return available.filter((t) => allowWrites || !isWriteTool(t));
}

/**
 * Relationship directions, mirroring the comments on REL_TYPES in
 * packages/shared/src/index.ts (comments do not exist at runtime, so they are
 * restated here; a unit test checks the keys match REL_TYPES exactly).
 */
export const REL_DIRECTIONS: Record<RelType, { from: string[]; to: string[]; props?: string[]; note?: string }> = {
  DEPENDS_ON: { from: ["Service"], to: ["Service"], props: ["protocol", "source"], note: "caller -> callee" },
  OWNS: { from: ["Team"], to: ["Service"] },
  PART_OF: { from: ["File"], to: ["Service"] },
  AUTHORED: { from: ["Person"], to: ["PR"] },
  MODIFIES: { from: ["PR"], to: ["File"], props: ["additions", "deletions"] },
  TOUCHES: { from: ["PR"], to: ["Service"], note: "derived at load time from PR-MODIFIES->File-PART_OF->Service" },
  MEMBER_OF: { from: ["Person"], to: ["Team"] },
  ON_CALL_FOR: { from: ["Person"], to: ["Service"], props: ["weekStart", "weekStartTs"], note: "one edge per week" },
  MENTIONS: {
    from: ["Issue", "Thread", "Doc", "Decision", "Incident"],
    to: ["Service", "PR", "Person", "Incident", "Decision", "Issue"],
  },
  JUSTIFIES: { from: ["Decision"], to: ["PR"] },
  DOCUMENTED_IN: { from: ["Decision"], to: ["Doc"] },
  DECIDED_BY: { from: ["Decision"], to: ["Person", "Team"] },
  ABOUT: {
    from: ["Decision", "Doc", "Issue", "Thread", "Finding"],
    to: ["Service", "any domain node (from Finding)"],
  },
  AFFECTED: { from: ["Incident"], to: ["Service"] },
  CAUSED_BY: { from: ["Incident"], to: ["PR"] },
  RESOLVED_BY: { from: ["Incident"], to: ["Runbook"] },
  RESPONDED_BY: { from: ["Incident"], to: ["Person"] },
  TRIGGERED_BY: { from: ["Incident"], to: ["Alert"] },
  APPLIES_TO: { from: ["Runbook"], to: ["Service"] },
  FIRED_ON: { from: ["Alert"], to: ["Service"] },
  HAS_EPISODE: { from: ["Session"], to: ["Episode"] },
  NEXT: { from: ["Episode"], to: ["Episode"], note: "chain within one session, in order" },
  PRODUCED: { from: ["Episode"], to: ["Finding"] },
  WROTE: { from: ["Agent"], to: ["Finding"] },
  SUPPORTED_BY: { from: ["Finding"], to: ["any domain node"], note: "the evidence behind a claim" },
  HANDED_TO: { from: ["Finding"], to: ["Agent"], note: "the only way agents hand off work" },
  INVESTIGATES: { from: ["Session"], to: ["Alert", "Service", "Incident"] },
};

/** Indexes that `ensureSchema(tenant)` creates (SPEC §1). Live indexes are added by the server if FalkorDB answers. */
export const DOCUMENTED_INDEXES = {
  range: [
    "uid on every label",
    "Service.slug",
    "PR.number",
    "PR.mergedAt",
    "Person.slug",
    "Person.isBot",
    "Incident.key",
    "Decision.key",
    "Issue.key",
    "Session.sessionId",
    "Episode.sessionId",
    "Finding.sessionId",
    "Finding.id",
  ],
  fulltext: [
    "Service(name, slug, description)",
    "PR(title)",
    "Person(name)",
    "Team(name)",
    "Decision(title)",
    "Doc(title)",
    "Incident(title)",
    "Issue(title)",
    "Thread(title)",
    "Runbook(title)",
  ],
  vector: EMBEDDED_LABELS.map((l) => `${l}(embedding) dim=${EMBEDDING_DIM} cosine`),
};

/** The static body of `blastradius://schema`. */
export function staticSchema(exposed: readonly ToolName[]) {
  return {
    graphPerTenant: TENANTS.map((t) => `blastradius_${t}`),
    labels: NODE_LABELS.map((l) => ({
      label: l,
      memory: (MEMORY_LABELS as readonly string[]).includes(l),
      embedded: (EMBEDDED_LABELS as readonly string[]).includes(l),
    })),
    relationships: REL_TYPES.map((t) => ({ type: t, ...REL_DIRECTIONS[t] })),
    indexes: DOCUMENTED_INDEXES,
    notes: [
      "Every node has a uid property `Label:key` (e.g. Service:checkout, PR:4087). Use uids in tool inputs.",
      "Times are epoch-millisecond integers in *At properties.",
      "Vector scores from db.idx.vector.queryNodes are cosine DISTANCES (lower = closer); tools convert them to similarity.",
    ],
    tools: exposed.map((t) => ({ name: t, description: TOOL_DESCRIPTIONS[t], writes: isWriteTool(t) })),
  };
}
