/**
 * LLM-mode wiring, tested with the AI SDK's MockLanguageModelV2 (no API key,
 * no network): the model only gets its allowed tools, schemas omit
 * tenant/sessionId/agent, record_finding takes `cites` and code fills the
 * exact cypher, results are capped, and a fatal tool error stops the loop.
 */
import { describe, expect, it } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
import { AGENT_TOOLS, MODEL_ROW_CAP } from "@blastradius/shared";
import { runLlmAgent } from "./llm.ts";
import { AgentScope, FatalRunError, RunState } from "./runtime.ts";
import { CANNED, fakeDeps, result } from "./test/fakes.ts";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const call = (id: string, toolName: string, input: unknown) => ({
  content: [{ type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: "tool-calls" as const,
  usage,
  warnings: [],
});
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], finishReason: "stop" as const, usage, warnings: [] });

function setup() {
  const f = fakeDeps();
  const run = new RunState("r1", "s1", "acme", f.deps, new AbortController().signal, () => {});
  run.service = "Service:checkout";
  return { f, run, scope: new AgentScope(run, "triage") };
}

describe("runLlmAgent (mock model)", () => {
  it("exposes only allowed tools, without injected fields; cites → exact cypher", async () => {
    const { scope } = setup();
    const steps = [
      call("t1", "blast_radius", { service: "checkout" }),
      call("t2", "record_finding", { kind: "impact", claim: "If checkout fails, frontend breaks.", confidence: 0.9, about: ["Service:checkout"], evidence: [], cites: ["c1"] }),
      text("Checkout failure hits frontend."),
    ];
    let i = 0;
    const model = new MockLanguageModelV2({ doGenerate: async () => steps[i++]! });
    const out = await runLlmAgent({ scope, prompt: "Alert on checkout", model });
    expect(out.text).toBe("Checkout failure hits frontend.");

    const tools = model.doGenerateCalls[0]!.tools!;
    expect(tools.map((t) => t.name).sort()).toEqual([...AGENT_TOOLS.triage].sort());
    for (const t of tools) {
      const props = Object.keys((t as { inputSchema: { properties?: object } }).inputSchema.properties ?? {});
      expect(props).not.toContain("tenant");
      expect(props).not.toContain("sessionId");
    }
    const rf = tools.find((t) => t.name === "record_finding") as { inputSchema: { properties: object } };
    expect(Object.keys(rf.inputSchema.properties)).toContain("cites");
    expect(Object.keys(rf.inputSchema.properties)).not.toContain("cypher");

    expect(scope.findings).toHaveLength(1);
    expect(scope.findings[0]!.cypher).toEqual([CANNED.blast_radius!({}).cypher]);
    expect(scope.findings[0]!.handTo).toBe("investigator");
    // the tool result the model saw carries its callId
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain('"callId":"c1"');
  });

  it("tells the model when a finding has no valid cites", async () => {
    const { scope } = setup();
    const steps = [call("t1", "record_finding", { kind: "impact", claim: "made up claim", confidence: 1, cites: ["c99"] }), text("done")];
    let i = 0;
    const model = new MockLanguageModelV2({ doGenerate: async () => steps[i++]! });
    await runLlmAgent({ scope, prompt: "x", model });
    expect(scope.findings).toHaveLength(0);
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toMatch(/record_finding needs cites/);
  });

  it("caps rows shown to the model", async () => {
    const { f, scope } = setup();
    const many = Array.from({ length: 40 }, (_, k) => ({ service: `Service:s${k}`, name: `s${k}`, betweenness: 0 }));
    const orig = f.executor.run.bind(f.executor);
    f.executor.run = async (t, c, inp) => (t === "critical_services" ? result("critical_services", many) : orig(t, c, inp));
    const steps = [call("t1", "critical_services", { limit: 40 }), text("ok")];
    let i = 0;
    const model = new MockLanguageModelV2({ doGenerate: async () => steps[i++]! });
    await runLlmAgent({ scope, prompt: "x", model });
    const seen = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(seen).toContain(`"rowCount":40`);
    expect(seen).toContain(`s${MODEL_ROW_CAP - 1}"`);
    expect(seen).not.toContain(`"s${MODEL_ROW_CAP}"`);
  });

  it("FalkorDB down inside a tool call stops the loop with a fatal error", async () => {
    const { f, scope } = setup();
    f.executor.failWith = new Error("ECONNREFUSED");
    f.setHealthy(false);
    const model = new MockLanguageModelV2({ doGenerate: async () => call("t1", "blast_radius", { service: "checkout" }) });
    await expect(runLlmAgent({ scope, prompt: "x", model })).rejects.toBeInstanceOf(FatalRunError);
    expect(model.doGenerateCalls.length).toBe(1);
  });
});
