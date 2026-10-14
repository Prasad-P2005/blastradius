/**
 * @blastradius/agents — public API (SPEC §5).
 *
 *   investigate(req, {signal})  → AsyncIterable<AgentEvent>
 *   closeIncident(req)          → graph.closeIncident + Episode(kind=close) + audit
 *   resolveAgentMode(override?) → { mode, model? }
 *   loadScenarios(tenant?)      → data/scenarios.json
 *   listActions(tenant, sid?)   → action audit log (Postgres)
 *   getHealth()                 → FalkorDB / Postgres / mode / embeddings / transport
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CloseIncidentRequestSchema,
  type ActionRecord,
  type CloseIncidentRequest,
  type CloseIncidentResult,
  type HealthStatus,
  type Scenario,
  type Tenant,
} from "@blastradius/shared";
import { findRepoRoot } from "@blastradius/shared/env";
import { resolveAgentMode, toolTransport } from "./mode.ts";

export { investigate, type InvestigateOptions } from "./pipeline.ts";
export { resolveAgentMode } from "./mode.ts";
export type { ToolExecutor } from "./executor.ts";
export { DirectExecutor, McpExecutor, defaultExecutor, closeDefaultExecutor } from "./executor.ts";

/**
 * Closes an incident: the graph writes Incident + Runbook into procedural
 * memory (so the NEXT session's recall_memory surfaces it), then we append an
 * Episode(kind=close) to the session and log it in Postgres.
 */
export async function closeIncident(raw: CloseIncidentRequest): Promise<CloseIncidentResult> {
  const req = CloseIncidentRequestSchema.parse(raw);
  const graph = await import("@blastradius/graph");
  const db = await import("@blastradius/db");
  const result = await graph.closeIncident(req);
  await graph.recordEpisode(req.tenant, {
    sessionId: req.sessionId,
    agent: "scribe",
    kind: "close",
    summary: `Closed as ${result.incidentUid} (${req.severity}): ${req.title}. Runbook ${result.runbookUid}.`,
  });
  await db.addMessage({
    sessionId: req.sessionId,
    role: "system",
    content: `Incident closed: ${result.incidentUid} "${req.title}" (${req.severity}); runbook ${result.runbookUid} with ${req.runbook.steps.length} steps.`,
  });
  await db.touchSession(req.sessionId, { status: "closed" });
  console.log(`[agents] closeIncident ${req.tenant}/${req.sessionId} → ${result.incidentUid}, ${result.runbookUid}`);
  return result;
}

/** Scenarios from data/scenarios.json (empty list if the file is missing or invalid). */
export async function loadScenarios(tenant?: Tenant): Promise<Scenario[]> {
  const file = join(findRepoRoot(), "data", "scenarios.json");
  try {
    const all = JSON.parse(await readFile(file, "utf8")) as Scenario[];
    if (!Array.isArray(all)) return [];
    return tenant ? all.filter((s) => s.tenant === tenant) : all;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[agents] cannot read ${file}: ${(err as Error).message}`);
    return [];
  }
}

export async function listActions(tenant: Tenant, sessionId?: string): Promise<ActionRecord[]> {
  const db = await import("@blastradius/db");
  return db.listActions(tenant, sessionId);
}

export async function getHealth(): Promise<HealthStatus> {
  const graph = await import("@blastradius/graph");
  const db = await import("@blastradius/db");
  const [falkordb, postgres, embeddings] = await Promise.all([
    graph.falkorHealth().catch((e: Error) => ({ ok: false, error: e.message })),
    db.pgHealth(),
    graph.embeddingBackend().catch(() => undefined),
  ]);
  const { mode, model } = resolveAgentMode();
  return {
    falkordb,
    postgres,
    agentMode: mode,
    ...(model ? { model } : {}),
    ...(embeddings ? { embeddings } : {}),
    transport: toolTransport(),
  };
}
