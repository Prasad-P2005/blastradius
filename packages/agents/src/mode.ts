/**
 * Which brain runs the agents: an LLM (AI SDK tool loop) or the deterministic
 * scripted planner. Both use the same tools through the same ToolExecutor.
 *
 *   AGENT_MODE=auto (default) → llm if the provider's API key is set, else scripted
 *   AGENT_MODE=llm            → llm (falls back to scripted, with a warning, if no key)
 *   AGENT_MODE=scripted       → scripted
 *   request.agentMode         → overrides AGENT_MODE (same key rule)
 */
import type { AgentMode } from "@blastradius/shared";

export type LlmProvider = "anthropic" | "openai";

/** Default model per provider (the spec's default is Claude Sonnet 5.5). */
export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-5",
};

export function llmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  return env.LLM_PROVIDER?.trim().toLowerCase() === "openai" ? "openai" : "anthropic";
}

export function llmModelId(env: NodeJS.ProcessEnv = process.env): string {
  return env.LLM_MODEL?.trim() || DEFAULT_MODELS[llmProvider(env)];
}

export function hasLlmKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const key = llmProvider(env) === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

let warned = false;

export function resolveAgentMode(
  override?: AgentMode,
  env: NodeJS.ProcessEnv = process.env,
): { mode: AgentMode; model?: string } {
  const configured = (override ?? env.AGENT_MODE?.trim().toLowerCase() ?? "auto") as string;
  const keyed = hasLlmKey(env);
  if (configured === "scripted") return { mode: "scripted" };
  if (configured === "llm" && !keyed) {
    if (!warned) {
      warned = true;
      console.warn(`[agents] llm mode requested but no ${llmProvider(env).toUpperCase()}_API_KEY is set; using scripted mode`);
    }
    return { mode: "scripted" };
  }
  if (configured === "llm" || (configured !== "scripted" && keyed)) {
    return { mode: "llm", model: `${llmProvider(env)}:${llmModelId(env)}` };
  }
  return { mode: "scripted" };
}

export function toolTransport(env: NodeJS.ProcessEnv = process.env): "direct" | "mcp" {
  return env.AGENT_TOOL_TRANSPORT?.trim().toLowerCase() === "mcp" ? "mcp" : "direct";
}
