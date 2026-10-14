/**
 * memory.ts — agent memory in the graph (STUB, being implemented).
 */
import type {
  AgentMode, AgentName, CloseIncidentRequest, CloseIncidentResult, Finding, GraphToolResult,
  InvestigationMode, RecalledMemory, SessionSummary, Tenant, ToolContext, ToolInput,
} from "@blastradius/shared";

const ni = (): never => { throw new Error("not implemented"); };

export async function startSession(
  _tenant: Tenant,
  _opts: { sessionId?: string; mode: InvestigationMode; question: string; service?: string; agentMode: AgentMode },
): Promise<{ sessionId: string; uid: string; created: boolean }> { return ni(); }
export async function recordEpisode(
  _tenant: Tenant,
  _opts: { sessionId: string; agent: AgentName | "system"; kind: string; summary: string },
): Promise<{ uid: string; seq: number }> { return ni(); }
export async function recordFinding(
  _ctx: ToolContext & { sessionId: string; agent: AgentName },
  _input: ToolInput<"record_finding">,
): Promise<{ finding: Finding; result: GraphToolResult }> { return ni(); }
export async function readHandoffs(_ctx: ToolContext): Promise<GraphToolResult> { return ni(); }
export async function recallMemory(
  _ctx: ToolContext,
  _input: ToolInput<"recall_memory">,
): Promise<{ memories: RecalledMemory[]; result: GraphToolResult }> { return ni(); }
export async function getFindings(_tenant: Tenant, _sessionId: string): Promise<Finding[]> { return ni(); }
export async function closeIncident(_req: CloseIncidentRequest): Promise<CloseIncidentResult> { return ni(); }
export async function listGraphSessions(_tenant: Tenant, _limit?: number): Promise<SessionSummary[]> { return ni(); }
