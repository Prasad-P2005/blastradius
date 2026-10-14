/**
 * Runs one investigation and prints its events (for manual checks).
 *   pnpm --filter @blastradius/agents investigate -- acme incident checkout "checkout 5xx at 12%"
 *   pnpm --filter @blastradius/agents investigate -- acme ask - "Why did we move cart to valkey?"
 * Env: AGENT_MODE, AGENT_TOOL_TRANSPORT, BLASTRADIUS_GRAPH_NAMESPACE (as usual).
 */
import { loadRootEnv } from "@blastradius/shared/env";
import type { AgentEvent, Tenant } from "@blastradius/shared";

loadRootEnv();
const { investigate, closeDefaultExecutor } = await import("../index.ts");
const { closeFalkor } = await import("@blastradius/graph");
const { closeDb } = await import("@blastradius/db");

const [tenant = "acme", mode = "incident", service = "checkout", ...rest] = process.argv.slice(2).filter((a) => a !== "--");
const message = rest.join(" ") || `${service} 5xx at 12%`;
const alert = mode === "incident" && service !== "-" ? { service } : undefined;

for await (const e of investigate({ tenant: tenant as Tenant, mode: mode as "incident" | "ask", message, ...(alert ? { alert } : {}) })) {
  console.log(describe(e));
}
await closeDefaultExecutor();
await closeFalkor();
await closeDb();

function describe(e: AgentEvent): string {
  const head = `#${String(e.seq).padStart(3)} ${e.type}`;
  switch (e.type) {
    case "run_started":
      return `${head} ${e.agentMode}${e.model ? ` (${e.model})` : ""} session=${e.sessionId} "${e.question}"`;
    case "memory_recalled":
      return `${head} ${e.memories.length} memories: ${e.memories.map((m) => m.title).join(" | ")}`;
    case "agent_started":
      return `${head} ${e.agent}: ${e.goal}`;
    case "tool_call":
      return `${head} ${e.agent} ${e.callId} ${e.tool} ${JSON.stringify(e.input)}`;
    case "tool_result":
      return `${head} ${e.agent} ${e.callId} ${e.error ? `ERROR ${e.error}` : `${e.result?.rows.length} rows, ${e.result?.ms} ms — ${e.result?.summary}`}`;
    case "finding":
      return `${head} ${e.agent} ${e.finding.id} [${e.finding.kind}] ${e.finding.claim}\n       about=${e.finding.about.join(",")} evidence=${e.finding.evidence.length} cypher=${e.finding.cypher.length}${e.finding.handTo ? ` → ${e.finding.handTo}` : ""}`;
    case "handoff":
      return `${head} ${e.from} → ${e.to} (${e.findingId})`;
    case "action":
      return `${head} ${e.action.kind} ${e.action.status} ${e.action.title}${e.action.url ? ` ${e.action.url}` : ""}`;
    case "agent_message":
      return `${head} ${e.agent}: ${e.text}\n       claims: ${e.claims.map((c) => c.findingIds.join("+")).join(", ")}`;
    case "agent_finished":
      return `${head} ${e.agent} (${e.findingIds.length} findings)`;
    case "run_finished":
      return `${head} ${e.status} in ${e.ms} ms, ${e.findingIds.length} findings`;
    case "error":
      return `${head} ${e.where}${e.fatal ? " FATAL" : ""}: ${e.message}`;
  }
}
