/**
 * Integration test against the real Postgres (DATABASE_URL, migrated with `pnpm db:migrate`).
 * Run: pnpm --filter @blastradius/db test:integration
 */
import { afterAll, describe, expect, it } from "vitest";
import { loadRootEnv } from "@blastradius/shared/env";
import type { ActionRecord, AgentEvent } from "@blastradius/shared";

loadRootEnv();
const db = await import("./index.ts");

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const sessionId = `itest_${suffix}`;
const runId = `run_${suffix}`;

afterAll(async () => {
  await db.closeDb();
});

describe("@blastradius/db against live Postgres", () => {
  it("is healthy", async () => {
    const h = await db.pgHealth();
    expect(h.error).toBeUndefined();
    expect(h.ok).toBe(true);
  });

  it("round-trips tenants, sessions, messages", async () => {
    expect(await db.ensureTenant("acme", "Acme Shop")).toBe(true);
    expect(await db.ensureTenant("acme", "Acme Shop")).toBe(true); // idempotent
    const s = await db.createSession({ id: sessionId, tenant: "acme", mode: "incident", title: "checkout 5xx" });
    expect(s?.id).toBe(sessionId);
    expect(s?.status).toBe("open");
    // idempotent create keeps the original title
    const again = await db.createSession({ id: sessionId, tenant: "acme", mode: "incident", title: "other" });
    expect(again?.title).toBe("checkout 5xx");

    expect(await db.addMessage({ sessionId, role: "user", content: "checkout is failing" })).not.toBeNull();
    expect(await db.addMessage({ sessionId, role: "assistant", content: "on it", runId })).not.toBeNull();
    const msgs = await db.listMessages(sessionId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]?.runId).toBe(runId);

    expect(await db.touchSession(sessionId, { status: "closed" })).toBe(true);
    expect((await db.getSession(sessionId))?.status).toBe("closed");
    const list = await db.listSessions("acme");
    expect(list.some((x) => x.id === sessionId)).toBe(true);
  });

  it("records runs and an idempotent, ordered event log", async () => {
    expect(
      await db.startRun({ id: runId, sessionId, tenant: "acme", mode: "incident", agentMode: "scripted" }),
    ).toBe(true);
    const base = { runId, sessionId, tenant: "acme" as const, ts: new Date().toISOString() };
    const events: AgentEvent[] = [
      { ...base, seq: 0, type: "run_started", mode: "incident", agentMode: "scripted", question: "q" },
      { ...base, seq: 1, type: "agent_started", agent: "triage", goal: "scope" },
      { ...base, seq: 2, type: "run_finished", status: "ok", findingIds: [], ms: 12 },
    ];
    for (const e of events) expect(await db.appendEvent(e)).toBe(true);
    expect(await db.appendEvent(events[1]!)).toBe(true); // duplicate (run_id, seq) is ignored
    const got = await db.listEvents({ runId });
    expect(got.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(got[0]).toEqual(events[0]);
    expect((await db.listEvents({ sessionId })).length).toBe(3);

    expect(await db.finishRun(runId, "ok")).toBe(true);
    const run = await db.getRun(runId);
    expect(run?.status).toBe("ok");
    expect(run?.finishedAt).toBeInstanceOf(Date);
  });

  it("records and lists actions", async () => {
    const a: ActionRecord = {
      id: `act_${suffix}`,
      sessionId,
      tenant: "acme",
      kind: "webhook",
      status: "dry_run",
      title: "Ping #incidents",
      payload: { text: "hello", nested: { n: 1 } },
      findingIds: ["f_1", "f_2"],
      createdAt: new Date().toISOString(),
    };
    expect(await db.recordAction(a, runId)).toBe(true);
    const list = await db.listActions("acme", sessionId);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(a);
    expect(await db.listActions("globex", sessionId)).toEqual([]);
  });

  it("tracks ingest jobs", async () => {
    const id = await db.startIngestJob({ tenant: "globex", kind: "delta" });
    expect(typeof id).toBe("number");
    expect(await db.finishIngestJob(id, { status: "ok", stats: { nodes: 3 } })).toBe(true);
    const jobs = await db.listIngestJobs("globex");
    expect(jobs.find((j) => j.id === id)?.status).toBe("ok");
  });

  it("is best-effort when Postgres is unreachable", async () => {
    const saved = process.env.DATABASE_URL;
    await db.closeDb();
    process.env.DATABASE_URL = "postgres://blast:blast@127.0.0.1:1/nope";
    try {
      db._resetBreaker();
      const t0 = Date.now();
      expect(await db.addMessage({ sessionId, role: "user", content: "x" })).toBeNull();
      expect(await db.listEvents({ sessionId })).toEqual([]);
      // breaker is open: the second call returns immediately
      expect(Date.now() - t0).toBeLessThan(5000);
      expect((await db.pgHealth()).ok).toBe(false);
    } finally {
      await db.closeDb();
      process.env.DATABASE_URL = saved;
      db._resetBreaker();
    }
  });

  it("is a no-op without DATABASE_URL", async () => {
    const saved = process.env.DATABASE_URL;
    await db.closeDb();
    delete process.env.DATABASE_URL;
    try {
      expect(db.getDb()).toBeNull();
      expect(await db.appendEvent({ runId, sessionId, tenant: "acme", seq: 99, ts: "", type: "agent_started", agent: "triage", goal: "" })).toBe(false);
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
});
