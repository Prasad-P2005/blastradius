/**
 * LLM mode: one AI SDK v5 tool loop per agent.
 *
 *   - The model gets ONLY its allowed tools (AGENT_TOOLS), with the contract's
 *     input schemas (tenant / sessionId / agent are injected by code).
 *   - record_finding is exposed with `cites` (callIds) instead of `cypher`:
 *     code fills cypher[] with the exact strings of the cited results.
 *   - Each tool result is shown to the model capped at MODEL_ROW_CAP rows.
 *   - At most MAX_AGENT_STEPS steps; the run's abort signal is honoured.
 *   - A fatal error (FalkorDB down, MCP down) aborts the loop and is rethrown.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import {
  MAX_AGENT_STEPS,
  TOOL_DESCRIPTIONS,
  ToolInputSchemas,
  type Finding,
  type ToolName,
} from "@blastradius/shared";
import { SYSTEM_PROMPTS } from "./agents/index.ts";
import { modelView } from "./ledger.ts";
import { llmModelId, llmProvider } from "./mode.ts";
import { FatalRunError, FindingRejected, RunAborted, ToolCallError, type AgentScope } from "./runtime.ts";

/** What the model fills in for record_finding (no cypher: code derives it from `cites`). */
export const RecordFindingModelSchema = ToolInputSchemas.record_finding.omit({ cypher: true }).extend({
  cites: z
    .array(z.string())
    .min(1)
    .describe("callIds (e.g. 'c3') of the tool results backing this claim; the scribe may also cite session finding ids"),
});

export function languageModel(): LanguageModel {
  const id = llmModelId();
  return llmProvider() === "openai" ? openai(id) : anthropic(id);
}

export interface LlmAgentInput {
  scope: AgentScope;
  /** The alert / question and any graph state read by code (handoffs). Never another agent's text. */
  prompt: string;
  /** Session findings read from the graph (scribe only) — citeable by id. */
  sessionFindings?: Finding[];
  model?: LanguageModel;
}

export async function runLlmAgent({ scope, prompt, sessionFindings = [], model }: LlmAgentInput): Promise<{ text: string }> {
  const run = scope.run;
  // Our own controller so a fatal tool error can stop the loop immediately.
  const loopAbort = new AbortController();
  const onRunAbort = () => loopAbort.abort();
  run.signal.addEventListener("abort", onRunAbort, { once: true });
  let fatal: Error | undefined;

  const tools: ToolSet = {};
  for (const name of scope.allowed) {
    if (name === "record_finding") {
      tools[name] = tool({
        description: `${TOOL_DESCRIPTIONS.record_finding} Cite the callIds of the results that back the claim.`,
        inputSchema: RecordFindingModelSchema,
        execute: async (input) => {
          const byId = new Map(sessionFindings.map((f) => [f.id, f]));
          const citeFindings = input.cites.map((c) => byId.get(c)).filter((f): f is Finding => !!f);
          const cites = input.cites.filter((c) => !byId.has(c));
          try {
            const f = await scope.recordFinding({
              kind: input.kind,
              claim: input.claim,
              confidence: input.confidence,
              about: input.about,
              evidence: input.evidence,
              cites,
              citeFindings,
              ...(input.handTo ? { handTo: input.handTo } : {}),
            });
            return { ok: true, findingId: f.id, cypherCount: f.cypher.length, evidence: f.evidence, handTo: f.handTo ?? null };
          } catch (err) {
            return handleToolError(err);
          }
        },
      });
      continue;
    }
    const schema = ToolInputSchemas[name as ToolName];
    tools[name] = tool({
      description: TOOL_DESCRIPTIONS[name as ToolName],
      inputSchema: schema as z.ZodObject,
      execute: async (input: Record<string, unknown>) => {
        try {
          const { callId, result } = await scope.callTool(name, input);
          return modelView(callId, result);
        } catch (err) {
          return handleToolError(err);
        }
      },
    });
  }

  function handleToolError(err: unknown): { error: string } {
    if (err instanceof FatalRunError || err instanceof RunAborted) {
      fatal = err;
      loopAbort.abort();
      return { error: err.message };
    }
    if (err instanceof FindingRejected || err instanceof ToolCallError) return { error: err.message };
    return { error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const res = await generateText({
      model: model ?? languageModel(),
      system: SYSTEM_PROMPTS[scope.agent],
      prompt,
      tools,
      stopWhen: stepCountIs(MAX_AGENT_STEPS),
      abortSignal: loopAbort.signal,
      maxOutputTokens: 4000,
      maxRetries: 2,
      onStepFinish: () => {
        // Step boundary: stop as soon as the client went away.
        if (run.signal.aborted) loopAbort.abort();
      },
    });
    if (fatal) throw fatal;
    return { text: res.text.trim() };
  } catch (err) {
    if (fatal) throw fatal;
    if (run.signal.aborted) throw new RunAborted();
    throw new FatalRunError("llm", `LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    run.signal.removeEventListener("abort", onRunAbort);
  }
}
