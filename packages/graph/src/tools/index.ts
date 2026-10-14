/**
 * tools/index.ts — THE tool registry. One registry, three consumers: the
 * agents (AI SDK tools), the MCP server and the UI. Each entry validates its
 * input with the contract's zod schema and runs one Cypher query.
 */
import { ToolNameSchema, type GraphToolResult, type ToolArgs, type ToolContext, type ToolName } from "@blastradius/shared";
import { readHandoffs, recallMemory, recordFinding } from "../memory.ts";
import { askCompany, decisionTrace } from "./brain.ts";
import { suspectChanges } from "./changes.ts";
import { defineTool } from "./common.ts";
import { explainPath, searchNodes, serviceContext } from "./context.ts";
import { blastRadius, criticalServices, failureCommunities } from "./impact.ts";
import { pastIncidents, similarIncidents } from "./incidents.ts";
import { onCall, whoKnows } from "./people.ts";
import type { ToolSpec } from "./types.ts";

export { newestPrAt } from "./changes.ts";

// Memory tools wrap memory.ts so the registry and the direct API share one implementation.
const recallMemoryTool = defineTool("recall_memory", async (ctx, args) => (await recallMemory(ctx, args)).result);
const readHandoffsTool = defineTool("read_handoffs", async (ctx) => readHandoffs(ctx));
const recordFindingTool = defineTool("record_finding", async (ctx, args: ToolArgs<"record_finding">) => {
  if (!ctx.sessionId) throw new Error("record_finding needs ctx.sessionId (memory tools run inside a session)");
  if (!ctx.agent) throw new Error("record_finding needs ctx.agent (the calling agent)");
  return (await recordFinding({ ...ctx, sessionId: ctx.sessionId, agent: ctx.agent }, args)).result;
});

export const toolSpecs: { [T in ToolName]: ToolSpec<T> } = {
  blast_radius: blastRadius,
  critical_services: criticalServices,
  suspect_changes: suspectChanges,
  who_knows: whoKnows,
  on_call: onCall,
  service_context: serviceContext,
  past_incidents: pastIncidents,
  similar_incidents: similarIncidents,
  decision_trace: decisionTrace,
  explain_path: explainPath,
  search_nodes: searchNodes,
  failure_communities: failureCommunities,
  ask_company: askCompany,
  recall_memory: recallMemoryTool,
  read_handoffs: readHandoffsTool,
  record_finding: recordFindingTool,
};

/** Runs a tool by name. `ctx.tenant` (and sessionId/agent for memory tools) are injected by code. */
export async function runTool(name: ToolName, ctx: ToolContext, rawInput: unknown): Promise<GraphToolResult> {
  const tool = toolSpecs[ToolNameSchema.parse(name)] as unknown as ToolSpec;
  return tool.run(ctx, (rawInput ?? {}) as never);
}
