/**
 * Postgres schema (Drizzle). SPEC §8.
 *
 * Postgres holds APP BOOKKEEPING ONLY: tenants, sessions, the chat transcript,
 * agent runs + their event log (for replay), the action audit log and ingest
 * jobs. Nothing an agent reasons over lives here — that is all in FalkorDB.
 */
import { sql } from "drizzle-orm";
import { bigserial, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    mode: text("mode").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("open"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_tenant_updated_idx").on(t.tenant, t.updatedAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
    /** user | assistant | system */
    role: text("role").notNull(),
    content: text("content").notNull(),
    runId: text("run_id"),
    createdAt: createdAt(),
  },
  (t) => [index("messages_session_idx").on(t.sessionId, t.id)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    tenant: text("tenant").notNull(),
    mode: text("mode").notNull(),
    agentMode: text("agent_mode").notNull(),
    model: text("model"),
    /** running | ok | error | aborted */
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [index("agent_runs_session_idx").on(t.sessionId)],
);

export const agentEvents = pgTable(
  "agent_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id").notNull(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    /** the full AgentEvent JSON */
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("agent_events_run_seq_uq").on(t.runId, t.seq), index("agent_events_session_idx").on(t.sessionId, t.id)],
);

export const actions = pgTable(
  "actions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    runId: text("run_id"),
    tenant: text("tenant").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    payload: jsonb("payload").notNull(),
    error: text("error"),
    findingIds: jsonb("finding_ids").notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("actions_tenant_session_idx").on(t.tenant, t.sessionId)],
);

export const ingestJobs = pgTable("ingest_jobs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  tenant: text("tenant").notNull(),
  /** snapshot | delta */
  kind: text("kind").notNull(),
  /** running | ok | error */
  status: text("status").notNull(),
  stats: jsonb("stats"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
