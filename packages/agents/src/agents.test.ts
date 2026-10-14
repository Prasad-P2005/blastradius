/**
 * Unit tests (no DB): row capping, cypher mapping from cited results,
 * scripted claim templating, mode resolution, and the scripted pipeline
 * end to end over a fake ToolExecutor.
 */
import { describe, expect, it } from "vitest";
import { MODEL_ROW_CAP, type AgentEvent, type Finding } from "@blastradius/shared";
import { CallLedger, cypherFromEntries, evidenceFromEntries, modelView } from "./ledger.ts";
import { resolveAgentMode } from "./mode.ts";
import { investigate } from "./pipeline.ts";
import { AgentScope, FindingRejected, RunState } from "./runtime.ts";
import { answerClaim, causeClaim, criticalityClaim, expertClaim, impactClaim, precedentClaim } from "./templates.ts";
import { findingsMarkdown, rollbackPlanMarkdown, webhookPayload } from "./actions.ts";
import { parseMcpToolResult } from "./executor.ts";
import { searchTerms } from "./scripted.ts";
import { CANNED, fakeDeps, result } from "./test/fakes.ts";

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("row capping (modelView)", () => {
  it("caps rows at MODEL_ROW_CAP and reports the full count", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ i }));
    const v = modelView("c1", result("search_nodes", rows));
    expect(v.rows).toHaveLength(MODEL_ROW_CAP);
    expect(v.rowCount).toBe(60);
    expect(v.truncated).toBe(true);
    expect(v.callId).toBe("c1");
    expect(v.cypher).toContain("search_nodes");
  });
  it("does not truncate small results", () => {
    const v = modelView("c2", result("on_call", [{ a: 1 }]));
    expect(v.truncated).toBe(false);
    expect(v.rows).toEqual([{ a: 1 }]);
  });
});

describe("cypher mapping from cited results (ledger)", () => {
  const ledger = new CallLedger();
  const blast = CANNED.blast_radius!({});
  const suspects = CANNED.suspect_changes!({});
  ledger.add(ledger.nextId(), blast); // c1
  ledger.add(ledger.nextId(), suspects); // c2
  ledger.add(ledger.nextId(), result("record_finding", [])); // c3

  it("resolves callIds and tool names, rejects unknown and record_finding", () => {
    const { entries, unknown } = ledger.resolve(["c2", "blast_radius", "c9", "c3", "c2"]);
    expect(entries.map((e) => e.callId)).toEqual(["c2", "c1"]);
    expect(unknown).toEqual(["c9", "c3"]);
  });
  it("copies the EXACT cypher strings, including extraQueries", () => {
    const { entries } = ledger.resolve(["c2"]);
    expect(cypherFromEntries(entries)).toEqual([suspects.cypher, suspects.extraQueries![0]!.cypher]);
  });
  it("harvests evidence uids from paths, then rows", () => {
    const { entries } = ledger.resolve(["c1"]);
    const ev = evidenceFromEntries(entries);
    expect(ev.slice(0, 2)).toEqual(["Service:frontend", "Service:checkout"]);
    expect(ev).toContain("Team:web");
  });
});

describe("AgentScope.recordFinding", () => {
  function scope() {
    const f = fakeDeps();
    const events: AgentEvent[] = [];
    const run = new RunState("r1", "s1", "acme", f.deps, new AbortController().signal, (e) => events.push(e));
    run.service = "Service:checkout";
    return { s: new AgentScope(run, "triage"), events, f };
  }

  it("fills cypher from cites, filters unseen uids, defaults handTo", async () => {
    const { s, events } = scope();
    const { callId, result: r } = await s.callTool("blast_radius", { service: "checkout" });
    const finding = await s.recordFinding({
      kind: "impact",
      claim: "If checkout fails, 3 services are affected.",
      confidence: 0.9,
      about: ["Service:checkout", "Service:made-up"],
      evidence: [],
      cites: [callId],
    });
    expect(finding.cypher).toEqual([r.cypher]);
    expect(finding.about).toEqual(["Service:checkout"]);
    expect(finding.evidence).toContain("Service:frontend");
    expect(finding.handTo).toBe("investigator");
    const types = events.map((e) => e.type);
    expect(types).toEqual(["tool_call", "tool_result", "tool_call", "tool_result", "finding", "handoff"]);
  });

  it("rejects findings without valid citations", async () => {
    const { s } = scope();
    await expect(s.recordFinding({ kind: "impact", claim: "made up", confidence: 1, cites: ["c42"] })).rejects.toBeInstanceOf(FindingRejected);
  });

  it("refuses tools outside AGENT_TOOLS", async () => {
    const { s } = scope();
    await expect(s.callTool("who_knows", {})).rejects.toThrow(/may not call/);
  });
});

describe("scripted claim templates", () => {
  it("impact", () => {
    expect(impactClaim("Service:checkout", CANNED.blast_radius!({}).rows, 3)).toBe(
      "If checkout fails, 3 services are affected within 3 hops; the most central is frontend (betweenness 0.42). Customer-facing (tier 1): frontend, frontend-proxy.",
    );
    expect(impactClaim("checkout", [], 3)).toMatch(/^No services depend on checkout within 3 hops/);
  });
  it("criticality + community", () => {
    const s = criticalityClaim("Service:checkout", CANNED.critical_services!({}).rows, CANNED.failure_communities!({}).rows);
    expect(s).toBe("checkout is chokepoint #2 of the top 2 by betweenness (0.30, 1 dependents). It sits in a failure community of 3 services with payment, cart.");
  });
  it("cause prefers humans", () => {
    expect(causeClaim("Service:checkout", CANNED.suspect_changes!({}).rows)).toBe(
      'The most likely cause is PR #1999 "Refactor payment retries" by Jane Doe, merged 2024-09-21, touching payment (1 hop from checkout).',
    );
  });
  it("precedent", () => {
    expect(precedentClaim("Service:checkout", CANNED.past_incidents!({}).rows)).toBe(
      'Last time: INC-2025-031 "Checkout 5xx after payment deploy" (SEV2) was caused by PR #1500 and resolved with runbook "rollback-payment".',
    );
  });
  it("expert", () => {
    expect(expertClaim("Service:checkout", CANNED.who_knows!({}).rows, CANNED.on_call!({}).rows)).toBe(
      "Best person to fix checkout: Jane Doe (score 0.312, 12 PRs on checkout, team payments). Backup: Bob Roe. On call: Bob Roe (week of 2025-09-29).",
    );
  });
  it("answer", () => {
    expect(answerClaim("why valkey?", CANNED.ask_company!({}).rows)).toMatch(/^Top sources: ADR-007 "Move cart to valkey" \(Decision, similarity 0.71\)/);
  });
  it("search terms drop stopwords", () => {
    expect(searchTerms("Why is checkout failing with 5xx?")).toEqual(["checkout"]);
  });
});

describe("resolveAgentMode", () => {
  it("auto → scripted without a key, llm with one", () => {
    expect(resolveAgentMode(undefined, { AGENT_MODE: "auto" })).toEqual({ mode: "scripted" });
    expect(resolveAgentMode(undefined, { ANTHROPIC_API_KEY: "k" })).toEqual({ mode: "llm", model: "anthropic:claude-sonnet-5-5" });
    expect(resolveAgentMode(undefined, { LLM_PROVIDER: "openai", OPENAI_API_KEY: "k", LLM_MODEL: "gpt-5" })).toEqual({
      mode: "llm",
      model: "openai:gpt-5",
    });
  });
  it("explicit scripted wins; llm without key falls back", () => {
    expect(resolveAgentMode("scripted", { ANTHROPIC_API_KEY: "k" })).toEqual({ mode: "scripted" });
    expect(resolveAgentMode(undefined, { AGENT_MODE: "scripted", ANTHROPIC_API_KEY: "k" })).toEqual({ mode: "scripted" });
    expect(resolveAgentMode("llm", {})).toEqual({ mode: "scripted" });
  });
});

describe("scripted pipeline over a fake executor", () => {
  const req = {
    tenant: "acme" as const,
    mode: "incident" as const,
    message: "checkout 5xx at 12%",
    alert: { service: "checkout", metric: "5xx", value: "12%" },
    agentMode: "scripted" as const,
  };

  it("runs triage → investigator → expert → actions → scribe with cited claims and graph handoffs", async () => {
    const f = fakeDeps();
    const events = await collect(investigate(req, { deps: f.deps }));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run_started");
    expect(types.at(-1)).toBe("run_finished");
    expect(events.at(-1)).toMatchObject({ type: "run_finished", status: "ok" });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));

    // lesson 6: user message saved before run_started; startSession after
    expect(f.log.indexOf("db.addMessage:user")).toBeLessThan(f.log.indexOf("graph.startSession"));
    expect(f.log).toContain("db.finishRun:ok");

    const agents = events.filter((e) => e.type === "agent_started").map((e) => (e as { agent: string }).agent);
    expect(agents).toEqual(["triage", "investigator", "expert", "scribe"]);

    // every agent recorded ≥1 finding with evidence + cypher
    const findings = events.filter((e) => e.type === "finding").map((e) => (e as { finding: Finding }).finding);
    for (const a of agents) {
      const mine = findings.filter((x) => x.agent === a);
      expect(mine.length, a).toBeGreaterThan(0);
      for (const x of mine) {
        expect(x.cypher.length, `${a} cypher`).toBeGreaterThan(0);
        expect(x.evidence.length, `${a} evidence`).toBeGreaterThan(0);
      }
    }
    // claims reference real findings with non-empty cypher
    const byId = new Map(findings.map((x) => [x.id, x]));
    for (const m of events.filter((e) => e.type === "agent_message")) {
      const claims = (m as { claims: { findingIds: string[] }[] }).claims;
      expect(claims.length).toBeGreaterThan(0);
      for (const c of claims) for (const id of c.findingIds) expect(byId.get(id)?.cypher.length).toBeGreaterThan(0);
    }
    // handoffs: downstream agents read them from the (fake) graph first
    const handoffs = events.filter((e) => e.type === "handoff").map((e) => `${(e as { from: string }).from}->${(e as { to: string }).to}`);
    expect(handoffs).toEqual(expect.arrayContaining(["triage->investigator", "investigator->expert", "expert->scribe"]));
    const firstCall = (agent: string) => events.find((e) => e.type === "tool_call" && (e as { agent: string }).agent === agent) as { tool: string };
    expect(firstCall("investigator").tool).toBe("read_handoffs");
    expect(firstCall("expert").tool).toBe("read_handoffs");
    // cause finding copies the exact cypher of suspect_changes incl. extra query
    const cause = findings.find((x) => x.kind === "cause")!;
    const sc = CANNED.suspect_changes!({});
    expect(cause.cypher).toEqual([sc.cypher, sc.extraQueries![0]!.cypher]);
    expect(cause.about[0]).toBe("PR:1999");
    // actions: dry runs (no env), incl. rollback for PR:1999
    const actions = events.filter((e) => e.type === "action").map((e) => (e as { action: { kind: string; status: string } }).action);
    expect(actions.map((a) => `${a.kind}:${a.status}`)).toEqual(["github_issue:dry_run", "rollback_pr:dry_run", "webhook:dry_run"]);
    // tenant/session/agent injected by code on every call
    for (const c of f.executor.calls) expect(c.ctx.tenant).toBe("acme");
    expect(f.episodes.map((e) => e.kind)).toEqual([
      "user_message",
      "recall",
      "agent_run",
      "agent_run",
      "agent_run",
      "action",
      "action",
      "action",
      "agent_run",
    ]);
    // all events persisted
    await new Promise((r) => setTimeout(r, 10));
    expect(f.events.length).toBe(events.length);
  });

  it("resolves the service from free text via search_nodes", async () => {
    const f = fakeDeps();
    const events = await collect(investigate({ tenant: "acme", mode: "incident", message: "users report checkout is broken", agentMode: "scripted" }, { deps: f.deps }));
    const call = events.find((e) => e.type === "tool_call") as unknown as { tool: string };
    expect(call.tool).toBe("search_nodes");
    expect(events.at(-1)).toMatchObject({ status: "ok" });
    expect(f.executor.calls.some((c) => c.tool === "blast_radius" && c.input.service === "Service:checkout")).toBe(true);
  });

  it("ask mode runs the navigator with decision trace", async () => {
    const f = fakeDeps();
    const events = await collect(investigate({ tenant: "acme", mode: "ask", message: "Why did we move cart to valkey?", agentMode: "scripted" }, { deps: f.deps }));
    const tools = events.filter((e) => e.type === "tool_call").map((e) => (e as { tool: string }).tool);
    expect(tools.slice(0, 3)).toEqual(["ask_company", "record_finding", "decision_trace"]);
    const msg = events.find((e) => e.type === "agent_message") as { agent: string; claims: unknown[] };
    expect(msg.agent).toBe("navigator");
    expect(msg.claims.length).toBe(2);
  });

  it("FalkorDB down → error{falkordb, fatal} then run_finished{error}, no hang", async () => {
    const f = fakeDeps();
    f.executor.failWith = new Error("connect ECONNREFUSED 127.0.0.1:6380");
    f.setHealthy(false);
    const events = await collect(investigate(req, { deps: f.deps }));
    const err = events.find((e) => e.type === "error") as { where: string; fatal: boolean };
    expect(err).toMatchObject({ where: "falkordb", fatal: true });
    expect(events.at(-1)).toMatchObject({ type: "run_finished", status: "error" });
    expect(events.some((e) => e.type === "finding")).toBe(false);
  });

  it("abort stops the run with status aborted", async () => {
    const f = fakeDeps();
    const ac = new AbortController();
    const out: AgentEvent[] = [];
    for await (const e of investigate(req, { deps: f.deps, signal: ac.signal })) {
      out.push(e);
      if (e.type === "agent_started") ac.abort();
    }
    expect(out.at(-1)).toMatchObject({ type: "run_finished", status: "aborted" });
    expect(out.filter((e) => e.type === "agent_started")).toHaveLength(1);
  });

  it("rejects invalid requests synchronously", () => {
    expect(() => investigate({ tenant: "nope", mode: "incident", message: "x" } as never)).toThrow();
  });
});

describe("actions content + MCP parsing", () => {
  const f: Finding = {
    id: "f_1",
    uid: "Finding:f_1",
    sessionId: "s1",
    agent: "investigator",
    kind: "cause",
    claim: "PR #1999 is the likely cause.",
    confidence: 0.7,
    about: ["PR:1999"],
    evidence: ["PR:1999"],
    cypher: ["MATCH (p:PR) RETURN p"],
    createdAt: "",
  };
  it("issue body carries the exact Why? cypher", () => {
    expect(findingsMarkdown([f])).toContain("```cypher\nMATCH (p:PR) RETURN p\n```");
  });
  it("rollback plan has the git revert line", () => {
    const md = rollbackPlanMarkdown({ tenant: "acme", sessionId: "s1", service: "Service:checkout", pr: { uid: "PR:1999", number: 1999, title: "t", sha: "abc123" }, findings: [f] });
    expect(md).toContain("git revert --no-edit abc123");
    expect(md).toContain("MATCH (p:PR) RETURN p");
  });
  it("webhook payload per kind", () => {
    expect(webhookPayload("slack", "hi")).toEqual({ text: "hi" });
    expect(webhookPayload("discord", "hi")).toEqual({ content: "hi" });
  });
  it("parses structuredContent, falls back to JSON text, throws on isError", () => {
    const r = result("on_call", [{ a: 1 }]);
    expect(parseMcpToolResult("on_call", { structuredContent: r }).rows).toEqual([{ a: 1 }]);
    expect(parseMcpToolResult("on_call", { content: [{ type: "text", text: JSON.stringify(r) }] }).cypher).toBe(r.cypher);
    expect(() => parseMcpToolResult("on_call", { isError: true, content: [{ type: "text", text: "boom" }] })).toThrow("boom");
  });
});

describe("actionEnv", () => {
  it("ignores empty values and leftover # comments", async () => {
    const { actionEnv } = await import("./actions.ts");
    expect(actionEnv({ WEBHOOK_URL: "# Slack or Discord incoming webhook", GITHUB_SANDBOX_REPO: "# owner/repo", GITHUB_TOKEN: "" })).toEqual({
      webhookKind: "slack",
    });
    expect(actionEnv({ WEBHOOK_URL: "https://hooks.slack.com/x", GITHUB_SANDBOX_REPO: "me/sandbox", GITHUB_TOKEN: "t", WEBHOOK_KIND: "discord" })).toEqual({
      githubToken: "t",
      githubRepo: "me/sandbox",
      webhookUrl: "https://hooks.slack.com/x",
      webhookKind: "discord",
    });
  });
});
