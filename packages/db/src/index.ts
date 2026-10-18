/**
 * @blastradius/db — Postgres bookkeeping (Drizzle). SPEC §5 + §8.
 *
 * EVERY helper here is best-effort: it catches, logs (once per failure
 * streak), and returns null / [] / false. The product degrades when Postgres
 * is down (no replay, no audit log), but it must never fail because of it.
 * Only FalkorDB is allowed to take the product down.
 *
 * A tiny circuit breaker keeps a dead Postgres from adding a connect timeout
 * to every call: after a failure, helpers skip the database for COOLDOWN_MS.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ActionRecord, AgentEvent, AgentMode, InvestigationMode, Json, Tenant } from "@blastradius/shared";
import * as schema from "./schema.ts";

export { schema };
export type Db = PostgresJsDatabase<typeof schema>;
export type SessionRow = typeof schema.sessions.$inferSelect;
export type MessageRow = typeof schema.messages.$inferSelect;
export type RunRow = typeof schema.agentRuns.$inferSelect;
export type IngestJobRow = typeof schema.ingestJobs.$inferSelect;
export type MessageRole = "user" | "assistant" | "system";
export type RunStatus = "running" | "ok" | "error" | "aborted";

/* ── connection ─────────────────────────────────────────────────────────── */

let client: ReturnType<typeof postgres> | null = null;
let db: Db | null = null;
let dbUrl: string | undefined;

/** Returns the Drizzle handle, or null when DATABASE_URL is unset (all helpers become no-ops). */
export function getDb(): Db | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (db && url === dbUrl) return db;
  client = postgres(url, {
    max: 10,
    // seconds — fail fast; Postgres is optional. Serverless Postgres (Neon free tier)
    // suspends when idle and can take longer to wake, so deploys raise it via env.
    connect_timeout: Number(process.env.PG_CONNECT_TIMEOUT) || 3,
    idle_timeout: 20,
    onnotice: () => {},
  });
  db = drizzle(client, { schema });
  dbUrl = url;
  return db;
}

/** Closes the pool (scripts call this so the process can exit). */
export async function closeDb(): Promise<void> {
  const c = client;
  client = null;
  db = null;
  dbUrl = undefined;
  if (c) await c.end({ timeout: 2 }).catch(() => {});
}

/* ── best-effort wrapper ────────────────────────────────────────────────── */

const COOLDOWN_MS = 10_000;
let downUntil = 0;
const loggedFailure = new Set<string>();

/**
 * Runs `fn` against the db. On any error: log once per helper per failure
 * streak, open the breaker, return `fallback`. Never throws.
 */
async function safe<T>(name: string, fallback: T, fn: (d: Db) => Promise<T>): Promise<T> {
  const d = getDb();
  if (!d) return fallback;
  if (Date.now() < downUntil) return fallback;
  try {
    const out = await fn(d);
    loggedFailure.delete(name);
    return out;
  } catch (err) {
    if (isConnectionError(err)) downUntil = Date.now() + COOLDOWN_MS;
    if (!loggedFailure.has(name)) {
      loggedFailure.add(name);
      console.warn(`[db] ${name} failed (best-effort, continuing): ${errMessage(err)}`);
    }
    return fallback;
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}

function isConnectionError(err: unknown): boolean {
  const s = errMessage(err);
  const code = (err as { code?: string } | null)?.code ?? (err as { cause?: { code?: string } } | null)?.cause?.code;
  return (
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|CONNECT_TIMEOUT|CONNECTION_|EAI_AGAIN|ECONNRESET/.test(s) ||
    (typeof code === "string" && /^(ECONN|ENOTFOUND|ETIMEDOUT|CONNECT_TIMEOUT|CONNECTION_)/.test(code))
  );
}

/** For tests: forget breaker + log state. */
export function _resetBreaker(): void {
  downUntil = 0;
  loggedFailure.clear();
}

/* ── health ─────────────────────────────────────────────────────────────── */

export async function pgHealth(): Promise<{ ok: boolean; ms?: number; error?: string }> {
  const d = getDb();
  if (!d) return { ok: false, error: "DATABASE_URL not set" };
  const t0 = Date.now();
  try {
    await d.execute(sql`select 1`);
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: errMessage(err) };
  }
}

/* ── tenants + sessions ─────────────────────────────────────────────────── */

export async function ensureTenant(id: Tenant, name?: string): Promise<boolean> {
  return safe("ensureTenant", false, async (d) => {
    await d
      .insert(schema.tenants)
      .values({ id, name: name ?? id })
      .onConflictDoNothing();
    return true;
  });
}

/** Creates the session row if missing (idempotent). Returns the row, or null. */
export async function createSession(s: {
  id: string;
  tenant: Tenant;
  mode: InvestigationMode;
  title: string;
}): Promise<SessionRow | null> {
  return safe("createSession", null, async (d) => {
    await d.insert(schema.sessions).values(s).onConflictDoNothing();
    const rows = await d.select().from(schema.sessions).where(eq(schema.sessions.id, s.id)).limit(1);
    return rows[0] ?? null;
  });
}

/** Bumps updated_at (and optionally status/title). */
export async function touchSession(
  id: string,
  patch: { status?: "open" | "closed"; title?: string } = {},
): Promise<boolean> {
  return safe("touchSession", false, async (d) => {
    await d
      .update(schema.sessions)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.sessions.id, id));
    return true;
  });
}

export async function listSessions(tenant: Tenant, limit = 50): Promise<SessionRow[]> {
  return safe("listSessions", [], (d) =>
    d.select().from(schema.sessions).where(eq(schema.sessions.tenant, tenant)).orderBy(desc(schema.sessions.updatedAt)).limit(limit),
  );
}

export async function getSession(id: string): Promise<SessionRow | null> {
  return safe("getSession", null, async (d) => {
    const rows = await d.select().from(schema.sessions).where(eq(schema.sessions.id, id)).limit(1);
    return rows[0] ?? null;
  });
}

/* ── transcript ─────────────────────────────────────────────────────────── */

export async function addMessage(m: {
  sessionId: string;
  role: MessageRole;
  content: string;
  runId?: string;
}): Promise<MessageRow | null> {
  return safe("addMessage", null, async (d) => {
    const rows = await d
      .insert(schema.messages)
      .values({ sessionId: m.sessionId, role: m.role, content: m.content, runId: m.runId ?? null })
      .returning();
    return rows[0] ?? null;
  });
}

export async function listMessages(sessionId: string): Promise<MessageRow[]> {
  return safe("listMessages", [], (d) =>
    d.select().from(schema.messages).where(eq(schema.messages.sessionId, sessionId)).orderBy(asc(schema.messages.id)),
  );
}

/* ── runs + event log ───────────────────────────────────────────────────── */

export async function startRun(r: {
  id: string;
  sessionId: string;
  tenant: Tenant;
  mode: InvestigationMode;
  agentMode: AgentMode;
  model?: string;
}): Promise<boolean> {
  return safe("startRun", false, async (d) => {
    await d
      .insert(schema.agentRuns)
      .values({ ...r, model: r.model ?? null, status: "running" })
      .onConflictDoNothing();
    return true;
  });
}

export async function finishRun(id: string, status: Exclude<RunStatus, "running">, error?: string): Promise<boolean> {
  return safe("finishRun", false, async (d) => {
    await d
      .update(schema.agentRuns)
      .set({ status, error: error ?? null, finishedAt: new Date() })
      .where(eq(schema.agentRuns.id, id));
    return true;
  });
}

export async function getRun(id: string): Promise<RunRow | null> {
  return safe("getRun", null, async (d) => {
    const rows = await d.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)).limit(1);
    return rows[0] ?? null;
  });
}

/** Appends one event (idempotent on (run_id, seq)). */
export async function appendEvent(event: AgentEvent): Promise<boolean> {
  return safe("appendEvent", false, async (d) => {
    await d
      .insert(schema.agentEvents)
      .values({ runId: event.runId, sessionId: event.sessionId, seq: event.seq, type: event.type, payload: event })
      .onConflictDoNothing();
    return true;
  });
}

/** Events for replay, in insertion order. Filter by session and/or run. */
export async function listEvents(q: { sessionId?: string; runId?: string }): Promise<AgentEvent[]> {
  return safe("listEvents", [], async (d) => {
    const conds = [];
    if (q.sessionId) conds.push(eq(schema.agentEvents.sessionId, q.sessionId));
    if (q.runId) conds.push(eq(schema.agentEvents.runId, q.runId));
    const rows = await d
      .select({ payload: schema.agentEvents.payload })
      .from(schema.agentEvents)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(schema.agentEvents.id))
      .limit(5000);
    return rows.map((r) => r.payload as AgentEvent);
  });
}

/* ── action audit log ───────────────────────────────────────────────────── */

export async function recordAction(a: ActionRecord, runId?: string): Promise<boolean> {
  return safe("recordAction", false, async (d) => {
    await d
      .insert(schema.actions)
      .values({
        id: a.id,
        sessionId: a.sessionId,
        runId: runId ?? null,
        tenant: a.tenant,
        kind: a.kind,
        status: a.status,
        title: a.title,
        url: a.url ?? null,
        payload: a.payload,
        error: a.error ?? null,
        findingIds: a.findingIds,
        createdAt: new Date(a.createdAt),
      })
      .onConflictDoNothing();
    return true;
  });
}

export async function listActions(tenant: Tenant, sessionId?: string): Promise<ActionRecord[]> {
  return safe("listActions", [], async (d) => {
    const cond = sessionId
      ? and(eq(schema.actions.tenant, tenant), eq(schema.actions.sessionId, sessionId))
      : eq(schema.actions.tenant, tenant);
    const rows = await d.select().from(schema.actions).where(cond).orderBy(desc(schema.actions.createdAt)).limit(200);
    return rows.map(
      (r): ActionRecord => ({
        id: r.id,
        sessionId: r.sessionId,
        tenant: r.tenant as Tenant,
        kind: r.kind as ActionRecord["kind"],
        status: r.status as ActionRecord["status"],
        title: r.title,
        ...(r.url ? { url: r.url } : {}),
        payload: (r.payload ?? {}) as Record<string, Json>,
        ...(r.error ? { error: r.error } : {}),
        findingIds: (r.findingIds ?? []) as string[],
        createdAt: r.createdAt.toISOString(),
      }),
    );
  });
}

/* ── ingest jobs ────────────────────────────────────────────────────────── */

/** Returns the new job id, or null. */
export async function startIngestJob(j: { tenant: Tenant; kind: "snapshot" | "delta" }): Promise<number | null> {
  return safe("startIngestJob", null, async (d) => {
    const rows = await d
      .insert(schema.ingestJobs)
      .values({ tenant: j.tenant, kind: j.kind, status: "running" })
      .returning({ id: schema.ingestJobs.id });
    return rows[0]?.id ?? null;
  });
}

export async function finishIngestJob(
  id: number | null,
  r: { status: "ok" | "error"; stats?: Record<string, Json>; error?: string },
): Promise<boolean> {
  if (id == null) return false;
  return safe("finishIngestJob", false, async (d) => {
    await d
      .update(schema.ingestJobs)
      .set({ status: r.status, stats: r.stats ?? null, error: r.error ?? null, finishedAt: new Date() })
      .where(eq(schema.ingestJobs.id, id));
    return true;
  });
}

export async function listIngestJobs(tenant?: Tenant, limit = 20): Promise<IngestJobRow[]> {
  return safe("listIngestJobs", [], (d) =>
    d
      .select()
      .from(schema.ingestJobs)
      .where(tenant ? eq(schema.ingestJobs.tenant, tenant) : undefined)
      .orderBy(desc(schema.ingestJobs.id))
      .limit(limit),
  );
}
