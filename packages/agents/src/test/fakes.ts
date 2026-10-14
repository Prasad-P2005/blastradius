/**
 * In-memory fakes for unit tests: a ToolExecutor that returns canned
 * GraphToolResults (and implements record_finding / read_handoffs over an
 * in-memory finding list), plus fake graph + db deps that log call order.
 * No FalkorDB, no Postgres.
 */
import type { AgentEvent, Finding, GraphToolResult, Row, ToolContext, ToolName } from "@blastradius/shared";
import type { ToolExecutor } from "../executor.ts";
import type { DbDeps, GraphDeps, RunDeps } from "../runtime.ts";

export function result(tool: ToolName, rows: Row[], extra: Partial<GraphToolResult> = {}): GraphToolResult {
  return {
    tool,
    tenant: "acme",
    cypher: `// ${tool}\nMATCH (n) RETURN n /* ${tool} */`,
    params: {},
    rows,
    paths: [],
    summary: `${tool}: ${rows.length} rows`,
    ms: 1,
    ...extra,
  };
}

const node = (id: string) => ({ id, label: id.split(":")[0] as "Service", name: id.split(":")[1]!, props: {} });

export const CANNED: Partial<Record<ToolName, (input: Record<string, unknown>) => GraphToolResult>> = {
  blast_radius: () =>
    result(
      "blast_radius",
      [
        { service: "Service:frontend", name: "frontend", hops: 1, betweenness: 0.42, tier: 1, team: "Team:web" },
        { service: "Service:frontend-proxy", name: "frontend-proxy", hops: 2, betweenness: 0.1, tier: 1, team: "Team:web" },
        { service: "Service:load-generator", name: "load-generator", hops: 3, betweenness: 0, tier: 3, team: null },
      ],
      {
        paths: [
          {
            nodes: [node("Service:frontend"), node("Service:checkout")],
            edges: [{ id: "e1", source: "Service:frontend", target: "Service:checkout", type: "DEPENDS_ON", props: {} }],
          },
        ],
      },
    ),
  critical_services: () =>
    result("critical_services", [
      { service: "Service:frontend", name: "frontend", betweenness: 0.5, dependents: 3, dependencies: 8 },
      { service: "Service:checkout", name: "checkout", betweenness: 0.3, dependents: 1, dependencies: 6 },
    ]),
  failure_communities: () =>
    result("failure_communities", [{ community: 1, services: ["Service:checkout", "Service:payment", "Service:cart"], size: 3 }]),
  suspect_changes: () =>
    result(
      "suspect_changes",
      [
        { pr: "PR:2001", number: 2001, title: "bump deps", mergedAt: 1727000000000, author: "Person:renovate-bot", isBot: true, service: "Service:checkout", hops: 0 },
        { pr: "PR:1999", number: 1999, title: "Refactor payment retries", mergedAt: 1726900000000, author: "Person:jane-doe", isBot: false, service: "Service:payment", hops: 1 },
      ],
      { extraQueries: [{ cypher: "// newest PR\nMATCH (p:PR) RETURN max(p.mergedAt)", params: {} }] },
    ),
  past_incidents: () =>
    result("past_incidents", [
      { incident: "Incident:INC-2025-031", title: "Checkout 5xx after payment deploy", severity: "SEV2", causedBy: "PR:1500", runbook: "Runbook:rollback-payment", service: "Service:checkout" },
    ]),
  similar_incidents: () => result("similar_incidents", []),
  who_knows: () =>
    result("who_knows", [
      { person: "Person:jane-doe", name: "Jane Doe", score: 0.31234, prs: 12, team: "Team:payments", onCall: false },
      { person: "Person:bob-roe", name: "Bob Roe", score: 0.2, prs: 5, team: "Team:payments", onCall: true },
    ]),
  on_call: () => result("on_call", [{ person: "Person:bob-roe", name: "Bob Roe", weekStart: "2025-09-29", team: "Team:payments", service: "Service:checkout" }]),
  search_nodes: (input) =>
    result("search_nodes", String(input.query).includes("checkout") ? [{ uid: "Service:checkout", label: "Service", name: "checkout", score: 1 }] : []),
  ask_company: () =>
    result("ask_company", [
      { source: "Decision:ADR-007", label: "Decision", title: "Move cart to valkey", similarity: 0.71, snippet: "We moved the cart store to valkey." },
      { source: "Thread:t-0007", label: "Thread", title: "valkey migration", similarity: 0.6, snippet: "..." },
    ]),
  decision_trace: () =>
    result("decision_trace", [
      { decision: "Decision:ADR-007", title: "Move cart to valkey", status: "accepted", decidedAt: 1700000000000, prs: ["PR:1200"], incidents: [], decidedBy: ["Person:jane-doe"] },
    ]),
  recall_memory: () => result("recall_memory", []),
  service_context: () => result("service_context", [{ service: "Service:checkout" }]),
};

export class FakeExecutor implements ToolExecutor {
  readonly transport = "direct" as const;
  findings: Finding[] = [];
  calls: { tool: ToolName; ctx: ToolContext; input: Record<string, unknown> }[] = [];
  failWith?: Error;
  private n = 0;

  async run(tool: ToolName, ctx: ToolContext, input: Record<string, unknown>): Promise<GraphToolResult> {
    this.calls.push({ tool, ctx, input });
    if (this.failWith) throw this.failWith;
    if (tool === "record_finding") {
      const id = `f_${++this.n}`;
      const f: Finding = {
        id,
        uid: `Finding:${id}`,
        sessionId: ctx.sessionId!,
        agent: ctx.agent!,
        kind: input.kind as Finding["kind"],
        claim: String(input.claim),
        confidence: Number(input.confidence),
        about: input.about as string[],
        evidence: input.evidence as string[],
        cypher: input.cypher as string[],
        ...(input.handTo ? { handTo: input.handTo as Finding["agent"] } : {}),
        createdAt: new Date().toISOString(),
      };
      this.findings.push(f);
      return result("record_finding", [{ finding: f as never }]);
    }
    if (tool === "read_handoffs") {
      const rows = this.findings
        .filter((f) => f.sessionId === ctx.sessionId && f.handTo === ctx.agent)
        .map((f) => ({ finding: f.id, from: f.agent, claim: f.claim, confidence: f.confidence, about: f.about, evidence: f.evidence, cypher: f.cypher }));
      return result("read_handoffs", rows);
    }
    const make = CANNED[tool];
    if (!make) throw new Error(`no canned result for ${tool}`);
    return make(input);
  }
}

export function fakeDeps(executor = new FakeExecutor()) {
  const log: string[] = [];
  const events: AgentEvent[] = [];
  let healthy = true;
  const episodes: { agent: string; kind: string; seq: number }[] = [];
  const graph: GraphDeps = {
    falkorHealth: async () => (healthy ? { ok: true, ms: 1 } : { ok: false, error: "ECONNREFUSED" }),
    startSession: async (_t, s) => {
      log.push("graph.startSession");
      return { sessionId: s.sessionId!, uid: `Session:${s.sessionId}`, created: true };
    },
    recordEpisode: async (_t, e) => {
      log.push(`graph.recordEpisode:${e.kind}`);
      episodes.push({ agent: e.agent, kind: e.kind, seq: episodes.length });
      return { uid: `Episode:${e.sessionId}:${episodes.length - 1}`, seq: episodes.length - 1 };
    },
    getFindings: async (_t, sid) => executor.findings.filter((f) => f.sessionId === sid),
    runCypher: async () => ({ rows: [{ number: 1999, title: "Refactor payment retries", sha: "abc123", url: "https://github.com/x/y/pull/1999", author: "Jane Doe" }], raw: [], ms: 1 }),
  };
  const db: DbDeps = {
    ensureTenant: async () => true,
    createSession: async () => {
      log.push("db.createSession");
      return null;
    },
    touchSession: async () => true,
    addMessage: async (m) => {
      log.push(`db.addMessage:${m.role}`);
      return null;
    },
    startRun: async () => {
      log.push("db.startRun");
      return true;
    },
    finishRun: async (_id, status) => {
      log.push(`db.finishRun:${status}`);
      return true;
    },
    appendEvent: async (e) => {
      events.push(e);
      return true;
    },
    recordAction: async () => true,
  };
  const deps: RunDeps = { executor, graph, db };
  return {
    deps,
    executor,
    log,
    events,
    episodes,
    setHealthy: (v: boolean) => {
      healthy = v;
    },
  };
}
