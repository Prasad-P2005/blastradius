/**
 * investigate(): the agent pipeline (SPEC §5).
 *
 *   validate → save user message (pg) → run_started → startSession (graph) → run row (pg)
 *   incident: recall_memory (system) → triage → investigator → expert → actions → scribe
 *   ask:      navigator
 *   → run_finished
 *
 * Every agent: agent_started → Episode(agent_run) → tool loop (LLM or scripted)
 * → findings (+ handoff events) → agent_message (claims → finding ids) → agent_finished.
 * Agent N+1 learns what agent N found ONLY by calling read_handoffs on the graph.
 */
import {
  AGENT_INFO,
  InvestigateRequestSchema,
  TENANT_INFO,
  type AgentEvent,
  type AgentName,
  type Claim,
  type Finding,
  type InvestigateRequest,
  type RecalledMemory,
} from "@blastradius/shared";
import { runActions } from "./actions.ts";
import { defaultExecutor } from "./executor.ts";
import { modelView, type LedgerEntry } from "./ledger.ts";
import { resolveAgentMode } from "./mode.ts";
import {
  AgentScope,
  AsyncQueue,
  FatalRunError,
  RunAborted,
  RunState,
  newId,
  normalizeService,
  withTimeout,
  type RunDeps,
} from "./runtime.ts";
import { scriptedExpert, scriptedInvestigator, scriptedNavigator, scriptedScribe, scriptedTriage } from "./scripted.ts";
import { keyOf } from "./templates.ts";

export interface InvestigateOptions {
  signal?: AbortSignal;
  /** Test seam: replace graph / db / executor. */
  deps?: Partial<RunDeps>;
}

let defaultDepsPromise: Promise<RunDeps> | null = null;

/** Real modules, loaded lazily so unit tests never touch FalkorDB/Postgres. */
export async function defaultDeps(): Promise<RunDeps> {
  defaultDepsPromise ??= (async () => {
    const graph = await import("@blastradius/graph");
    const db = await import("@blastradius/db");
    return { executor: defaultExecutor(), graph, db } as RunDeps;
  })();
  const d = await defaultDepsPromise;
  return { ...d, executor: defaultExecutor() };
}

/**
 * Runs one investigation and streams its events. Throws synchronously (ZodError)
 * if the request is invalid. Breaking out of the iteration aborts the run.
 */
export function investigate(rawReq: InvestigateRequest, opts: InvestigateOptions = {}): AsyncIterable<AgentEvent> {
  const req = InvestigateRequestSchema.parse(rawReq);
  const controller = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const queue = new AsyncQueue<AgentEvent>(() => controller.abort());
  void runPipeline(req, controller.signal, queue, opts.deps).finally(() => queue.close());
  return queue;
}

async function runPipeline(
  req: InvestigateRequest,
  signal: AbortSignal,
  queue: AsyncQueue<AgentEvent>,
  depsOverride?: Partial<RunDeps>,
): Promise<void> {
  const deps = { ...(depsOverride?.graph && depsOverride.db && depsOverride.executor ? {} : await defaultDeps()), ...depsOverride } as RunDeps;
  const { mode: agentMode, model } = resolveAgentMode(req.agentMode);
  const sessionId = req.sessionId ?? newId("s");
  const runId = newId("r");
  const run = new RunState(runId, sessionId, req.tenant, deps, signal, (e) => queue.push(e));
  run.service = normalizeService(req.alert?.service);

  // Lesson 6: the user's message is in Postgres BEFORE run_started (bounded wait; pg is optional).
  await withTimeout(
    (async () => {
      await deps.db.ensureTenant(req.tenant, TENANT_INFO[req.tenant].name);
      await deps.db.createSession({ id: sessionId, tenant: req.tenant, mode: req.mode, title: req.message.slice(0, 160) });
      await deps.db.addMessage({ sessionId, role: "user", content: req.message, runId });
    })(),
    4000,
    undefined,
  );

  run.emit({
    type: "run_started",
    mode: req.mode,
    agentMode,
    ...(model ? { model } : {}),
    question: req.message,
    ...(req.scenarioId ? { scenarioId: req.scenarioId } : {}),
    ...(run.service ? { service: run.service } : {}),
  });

  let status: "ok" | "error" | "aborted" = "ok";
  let errorMessage: string | undefined;
  let finalText = "";
  try {
    await run.graphWrite("startSession", () =>
      deps.graph.startSession(req.tenant, {
        sessionId,
        mode: req.mode,
        question: req.message,
        ...(run.service ? { service: run.service } : {}),
        agentMode,
      }),
    );
    await deps.db.startRun({ id: runId, sessionId, tenant: req.tenant, mode: req.mode, agentMode, ...(model ? { model } : {}) });
    await run.graphWrite("recordEpisode(user_message)", () =>
      deps.graph.recordEpisode(req.tenant, { sessionId, agent: "system", kind: "user_message", summary: req.message.slice(0, 500) }),
    );

    const ctx: AgentCtx = { run, req, agentMode };
    if (req.mode === "incident") {
      await recallStep(run, req);
      await runAgent(ctx, "triage", `Scope the blast radius of ${run.service ? keyOf(run.service) : "the alerted service"}.`);
      await runAgent(ctx, "investigator", "Find the probable cause: recent changes and similar past incidents.");
      await runAgent(ctx, "expert", "Find who can fix it: authorship PageRank, team and on-call.");
      run.checkAbort();
      await runActions(run, { question: req.message });
      finalText = await runAgent(ctx, "scribe", "Summarise the investigation with sources.");
    } else {
      finalText = await runAgent(ctx, "navigator", "Answer the question with sources from the company graph.");
    }
  } catch (err) {
    if (err instanceof RunAborted || signal.aborted) {
      status = "aborted";
    } else {
      status = "error";
      const where = err instanceof FatalRunError ? err.where : "internal";
      errorMessage = err instanceof Error ? err.message : String(err);
      run.emit({ type: "error", where, message: errorMessage, fatal: true });
    }
  }

  run.emit({ type: "run_finished", status, findingIds: run.findings.map((f) => f.id), ms: Date.now() - run.startedAt });
  // Bookkeeping after the stream is done (best-effort, bounded).
  await withTimeout(
    (async () => {
      if (finalText) await deps.db.addMessage({ sessionId, role: "assistant", content: finalText, runId });
      await deps.db.finishRun(runId, status, errorMessage);
      await deps.db.touchSession(sessionId);
    })(),
    4000,
    undefined,
  );
  await run.flush();
}

interface AgentCtx {
  run: RunState;
  req: InvestigateRequest;
  agentMode: "llm" | "scripted";
}

/** System step: recall memory from OTHER sessions before triage starts (SPEC §5). */
async function recallStep(run: RunState, req: InvestigateRequest): Promise<void> {
  run.checkAbort();
  const input = { ...(run.service ? { service: run.service } : {}), text: req.message, limit: 5 };
  let memories: RecalledMemory[] = [];
  try {
    // recall_memory is a memory tool: it needs an agent; triage owns it in AGENT_TOOLS.
    const result = await run.deps.executor.run("recall_memory", run.ctx("triage"), input);
    const callId = run.ledger.nextId();
    run.recallEntry = run.ledger.add(callId, result);
    memories = memoriesFromResult(result);
    run.emit({ type: "memory_recalled", memories, result });
  } catch (err) {
    const c = await run.classify(err);
    if (c instanceof FatalRunError || c instanceof RunAborted) throw c;
    run.emit({ type: "error", where: "falkordb", message: `recall_memory: ${c.message}`, fatal: false });
    run.emit({ type: "memory_recalled", memories: [] });
  }
  const summary = memories.length
    ? `Recalled ${memories.length} memories: ${memories
        .slice(0, 3)
        .map((m) => m.title)
        .join("; ")}`
    : "No memories from earlier sessions.";
  await run.graphWrite("recordEpisode(recall)", () =>
    run.deps.graph.recordEpisode(run.tenant, { sessionId: run.sessionId, agent: "system", kind: "recall", summary }),
  );
}

/** recall_memory rows → RecalledMemory[] (paths matched by the memory's uid). */
export function memoriesFromResult(result: import("@blastradius/shared").GraphToolResult): RecalledMemory[] {
  return result.rows.map((r) => {
    const uid = String(r.uid ?? "");
    const path = result.paths.find((p) => p.nodes.some((n) => n.id === uid));
    const rb = r.runbook;
    let runbook: RecalledMemory["runbook"];
    if (rb && typeof rb === "object" && !Array.isArray(rb)) {
      runbook = {
        uid: String(rb.uid ?? ""),
        title: String(rb.title ?? ""),
        steps: Array.isArray(rb.steps) ? rb.steps.map(String) : [],
      };
    } else if (typeof rb === "string" && rb) {
      runbook = { uid: rb, title: rb, steps: Array.isArray(r.runbookSteps) ? r.runbookSteps.map(String) : [] };
    }
    return {
      kind: r.kind === "finding" ? "finding" : "incident",
      uid,
      title: String(r.title ?? uid),
      summary: String(r.summary ?? ""),
      ...(typeof r.sessionId === "string" ? { sessionId: r.sessionId } : {}),
      ...(typeof r.agent === "string" ? { agent: r.agent as AgentName } : {}),
      ...(runbook ? { runbook } : {}),
      ...(typeof r.similarity === "number" ? { similarity: r.similarity } : {}),
      ...(path ? { path } : {}),
      ...(typeof r.createdAt === "string" ? { createdAt: r.createdAt } : {}),
    };
  });
}

/** Runs one agent end to end and returns its final message text. */
async function runAgent(ctx: AgentCtx, agent: AgentName, goal: string): Promise<string> {
  const { run, req } = ctx;
  run.checkAbort();
  run.emit({ type: "agent_started", agent, goal });
  await run.graphWrite(`recordEpisode(${agent})`, () =>
    run.deps.graph.recordEpisode(run.tenant, { sessionId: run.sessionId, agent, kind: "agent_run", summary: `${AGENT_INFO[agent].title}: ${goal}` }),
  );
  const scope = new AgentScope(run, agent);
  const sessionFindings =
    agent === "scribe" ? await run.graphWrite("getFindings", () => run.deps.graph.getFindings(run.tenant, run.sessionId)) : [];

  let text: string;
  if (ctx.agentMode === "llm") {
    try {
      text = await llmAgent(scope, req, sessionFindings);
    } catch (err) {
      if (!(err instanceof FatalRunError) || err.where !== "llm") throw err;
      // The model failed (rate limit, outage): keep the run alive with the scripted plan.
      run.emit({ type: "error", agent, where: "llm", message: `${err.message}; continuing in scripted mode`, fatal: false });
      text = "";
    }
    if (!scope.findings.length) {
      // No usable finding from the model: the scripted plan guarantees a cited handoff.
      text = (text ? `${text} ` : "") + (await scriptedAgent(scope, req, sessionFindings));
    }
  } else {
    text = await scriptedAgent(scope, req, sessionFindings);
  }

  const claims: Claim[] = claimsFor(agent, scope.findings, sessionFindings);
  run.emit({ type: "agent_message", agent, text: text || scope.findings.map((f) => f.claim).join(" "), claims });
  run.emit({
    type: "agent_finished",
    agent,
    summary: scope.findings[0]?.claim ?? text.slice(0, 200),
    findingIds: scope.findings.map((f) => f.id),
  });
  return text;
}

/**
 * Claims for the agent_message. Each claim points at findings whose cypher[]
 * came from real tool results; the scribe also re-surfaces the session's
 * impact/cause/expert/precedent findings so every summary line has a Why? chip.
 */
export function claimsFor(agent: AgentName, own: Finding[], sessionFindings: Finding[]): Claim[] {
  const claims: Claim[] = own.filter((f) => f.cypher.length > 0).map((f) => ({ text: f.claim, findingIds: [f.id] }));
  if (agent === "scribe") {
    for (const kind of ["impact", "cause", "expert", "precedent"] as const) {
      const f = sessionFindings.find((x) => x.kind === kind && x.cypher.length > 0);
      if (f) claims.push({ text: f.claim, findingIds: [f.id] });
    }
  }
  return claims;
}

function scriptedAgent(scope: AgentScope, req: InvestigateRequest, sessionFindings: Finding[]): Promise<string> {
  switch (scope.agent) {
    case "triage":
      return scriptedTriage(scope, req.alert?.message ?? req.message);
    case "investigator":
      return scriptedInvestigator(scope, alertText(req));
    case "expert":
      return scriptedExpert(scope);
    case "scribe":
      return scriptedScribe(scope, sessionFindings);
    case "navigator":
      return scriptedNavigator(scope, req.message);
  }
}

function alertText(req: InvestigateRequest): string {
  const a = req.alert;
  if (!a) return req.message;
  return [a.message, a.metric && a.value ? `${a.metric} ${a.value}` : a.metric, req.message].filter(Boolean).join(". ");
}

/** LLM path: code reads the handoffs first (graph state), then the model takes over. */
async function llmAgent(scope: AgentScope, req: InvestigateRequest, sessionFindings: Finding[]): Promise<string> {
  const { runLlmAgent } = await import("./llm.ts");
  const parts: string[] = [];
  if (req.mode === "incident") {
    const a = req.alert;
    parts.push(
      a
        ? `Alert on service "${a.service}"${a.metric ? `: ${a.metric}${a.value ? ` = ${a.value}` : ""}` : ""}${a.message ? ` — ${a.message}` : ""}.`
        : "Incident report (no structured alert).",
    );
    parts.push(`User message: ${req.message}`);
  } else {
    parts.push(`Question: ${req.message}`);
  }
  if (scope.agent === "triage" && scope.run.recallEntry) {
    parts.push(`Memory recalled from earlier sessions (system step):\n${viewJson(scope.run.recallEntry)}`);
  }
  if (scope.allowed.includes("read_handoffs") && scope.agent !== "triage") {
    // First action of every downstream agent: read what was handed to it IN THE GRAPH.
    const { callId, result } = await scope.callTool("read_handoffs", {});
    parts.push(`Your first action, read_handoffs, returned:\n${JSON.stringify(modelView(callId, result))}`);
  }
  if (scope.agent === "scribe" && sessionFindings.length) {
    parts.push(
      `Findings recorded in this session (read from the graph; cite by id):\n${sessionFindings
        .map((f) => `- ${f.id} [${f.agent}/${f.kind}] ${f.claim}`)
        .join("\n")}`,
    );
  }
  parts.push("Do your part, record your findings with record_finding (cite callIds), then reply briefly.");
  return (await runLlmAgent({ scope, prompt: parts.join("\n\n"), sessionFindings })).text;
}

function viewJson(e: LedgerEntry): string {
  return JSON.stringify(modelView(e.callId, e.result));
}
