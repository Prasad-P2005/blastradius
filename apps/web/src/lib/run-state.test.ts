import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@blastradius/shared";
import incidentRun from "../fixtures/run.acme.json" with { type: "json" };
import askRun from "../fixtures/run.acme.ask.json" with { type: "json" };
import {
  buildSession,
  buildState,
  evidenceForFinding,
  findingsForClaim,
  findingsOfKind,
  initialRunState,
  pathsForFinding,
  recentIds,
  reduce,
} from "./run-state.ts";

const events = incidentRun as unknown as AgentEvent[];
const askEvents = askRun as unknown as AgentEvent[];

describe("fixture sanity", () => {
  it("has strictly increasing seq starting at 0, one runId", () => {
    events.forEach((e, i) => expect(e.seq).toBe(i));
    expect(new Set(events.map((e) => e.runId)).size).toBe(1);
    expect(events[0]?.type).toBe("run_started");
    expect(events.at(-1)?.type).toBe("run_finished");
  });
});

describe("buildState on the incident fixture", () => {
  const s = buildState(events);

  it("captures run metadata and final status", () => {
    expect(s.status).toBe("ok");
    expect(s.mode).toBe("incident");
    expect(s.agentMode).toBe("scripted");
    expect(s.question).toBe("checkout 5xx at 12%");
    expect(s.service).toBe("Service:checkout");
    expect(s.lastSeq).toBe(events.length - 1);
  });

  it("orders the timeline: user, memory, triage, investigator, expert, actions, scribe, finished", () => {
    expect(s.timeline.map((t) => (t.kind === "agent" ? t.agent : t.kind))).toEqual([
      "user",
      "memory",
      "triage",
      "investigator",
      "expert",
      "actions",
      "scribe",
      "finished",
    ]);
  });

  it("groups tool calls per agent with results", () => {
    const triage = s.agents.triage!;
    expect(triage.toolCalls.map((id) => s.toolCalls[id]!.tool)).toEqual(["blast_radius", "critical_services", "on_call"]);
    for (const id of triage.toolCalls) expect(s.toolCalls[id]!.status).toBe("done");
    expect(s.toolCalls[triage.toolCalls[0]!]!.result?.rows).toHaveLength(3);
    expect(Object.values(s.agents).every((a) => a?.status === "done")).toBe(true);
  });

  it("records handoffs as a chain triage → investigator → expert → scribe", () => {
    expect(s.handoffs.map((h) => `${h.from}->${h.to}`)).toEqual([
      "triage->investigator",
      "investigator->expert",
      "investigator->scribe",
      "expert->scribe",
    ]);
    for (const h of s.handoffs) expect(s.findings[h.findingId]?.handTo).toBe(h.to);
  });

  it("links every claim to existing findings", () => {
    expect(s.claimOrder).toHaveLength(4);
    for (const id of s.claimOrder) {
      const fs = findingsForClaim(s, id);
      expect(fs.length).toBeGreaterThan(0);
      expect(fs.length).toBe(s.claims[id]!.findingIds.length);
    }
  });

  it("matches every finding's cypher to a tool_result by exact string", () => {
    for (const id of s.findingOrder) {
      const f = s.findings[id]!;
      const ev = evidenceForFinding(s, f);
      expect(ev).toHaveLength(f.cypher.length);
      for (const e of ev) {
        expect(e.call, `${f.id}: ${e.cypher.slice(0, 40)}`).not.toBeNull();
        expect(e.call!.result!.cypher).toBe(e.cypher);
      }
    }
    // the cause finding points at suspect_changes
    const cause = findingsOfKind(s, "cause")[0]!;
    expect(evidenceForFinding(s, cause)[0]!.call!.tool).toBe("suspect_changes");
    expect(pathsForFinding(s, cause).some((p) => p.nodes.some((n) => n.id === "PR:2143"))).toBe(true);
  });

  it("prefers the same agent's call when one Cypher ran several times", () => {
    const handoffCypher = s.toolCalls[s.agents.expert!.toolCalls[0]!]!.result!.cypher;
    const fake = { ...s.findings[s.agents.expert!.findings[0]!]!, cypher: [handoffCypher] };
    expect(evidenceForFinding(s, fake)[0]!.call!.agent).toBe("expert");
  });

  it("merges paths and finding uids into the run graph, deduped by uid", () => {
    expect(s.nodes["Service:frontend"]?.label).toBe("Service");
    expect(s.nodes["PR:2143"]?.props.number).toBe(2143); // real node from a path, not a placeholder
    expect(s.edges["Service:frontend-DEPENDS_ON->Service:checkout"]).toBeDefined();
    const ids = Object.keys(s.nodes);
    expect(new Set(ids).size).toBe(ids.length);
    // every edge endpoint exists
    for (const e of Object.values(s.edges)) {
      expect(s.nodes[e.source]).toBeDefined();
      expect(s.nodes[e.target]).toBeDefined();
    }
  });

  it("collects memories and actions", () => {
    expect(s.memories.map((m) => m.kind)).toEqual(["incident", "finding"]);
    expect(s.actionOrder.map((id) => s.actions[id]!.status)).toEqual(["done", "dry_run", "dry_run"]);
  });
});

describe("streaming vs replay", () => {
  it("replay of all events equals incremental reduction", () => {
    let live = initialRunState();
    for (const e of events) live = reduce(live, e);
    expect(buildState(events)).toEqual(live);
  });

  it("is order-insensitive (sorted by seq) and idempotent on duplicates", () => {
    const shuffled = [...events].reverse();
    const dup = [...events, ...events.slice(5, 15)];
    const ref = buildState(events);
    expect(buildState(shuffled)).toEqual(ref);
    let live = initialRunState();
    for (const e of dup) live = reduce(live, e);
    expect(live).toEqual(ref);
  });

  it("does not mutate the previous state", () => {
    const half = buildState(events.slice(0, 10));
    const snapshot = JSON.stringify(half);
    reduce(half, events[10]!);
    expect(JSON.stringify(half)).toBe(snapshot);
  });

  it("splits a multi-run session by runId", () => {
    const runs = buildSession([...events, ...askEvents]);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.mode).toBe("incident");
    expect(runs[1]!.mode).toBe("ask");
  });

  it("pulses only recently added elements", () => {
    const partial = buildState(events.slice(0, 5)); // through blast_radius result
    const recent = recentIds(partial, 1);
    expect(recent.has("Service:load-generator")).toBe(true);
    expect(recent.has("Incident:INC-2025-031")).toBe(false);
  });
});

describe("error path", () => {
  it("a fatal falkordb error marks the run as errored and closes running tool calls", () => {
    const head = events.slice(0, 4); // run_started, memory, triage started, tool_call blast_radius
    const base = head[0]!;
    const tail: AgentEvent[] = [
      { ...base, type: "error", seq: 4, agent: "triage", where: "falkordb", message: "connect ECONNREFUSED 127.0.0.1:6380", fatal: true },
      { ...base, type: "run_finished", seq: 5, status: "error", findingIds: [], ms: 120 },
    ] as AgentEvent[];
    const s = buildState([...head, ...tail]);
    expect(s.status).toBe("error");
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]!.where).toBe("falkordb");
    expect(s.timeline.some((t) => t.kind === "error")).toBe(true);
    const call = s.toolCalls[s.agents.triage!.toolCalls[0]!]!;
    expect(call.status).toBe("error");
  });

  it("a tool_result with error marks just that call", () => {
    const base = events[3]! as Extract<AgentEvent, { type: "tool_call" }>;
    const s = buildState([
      ...events.slice(0, 4),
      { ...base, type: "tool_result", seq: 4, error: "Query timed out" } as unknown as AgentEvent,
    ]);
    const call = s.toolCalls[base.callId]!;
    expect(call.status).toBe("error");
    expect(call.error).toBe("Query timed out");
    expect(s.status).toBe("running");
  });
});

describe("ask fixture", () => {
  it("yields a navigator answer with claims linked to findings", () => {
    const s = buildState(askEvents);
    expect(s.mode).toBe("ask");
    expect(s.agents.navigator?.messages).toHaveLength(1);
    const ask = s.toolCalls[s.agents.navigator!.toolCalls[0]!]!;
    expect(ask.tool).toBe("ask_company");
    expect(ask.result!.rows.length).toBeGreaterThanOrEqual(3);
    for (const id of s.claimOrder) expect(findingsForClaim(s, id).length).toBeGreaterThan(0);
  });
});
