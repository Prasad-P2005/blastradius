CREATE TABLE "actions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"run_id" text,
	"tenant" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"payload" jsonb NOT NULL,
	"error" text,
	"finding_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"tenant" text NOT NULL,
	"mode" text NOT NULL,
	"agent_mode" text NOT NULL,
	"model" text,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "ingest_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"stats" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"mode" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "actions_tenant_session_idx" ON "actions" USING btree ("tenant","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_events_run_seq_uq" ON "agent_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "agent_events_session_idx" ON "agent_events" USING btree ("session_id","id");--> statement-breakpoint
CREATE INDEX "agent_runs_session_idx" ON "agent_runs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "messages_session_idx" ON "messages" USING btree ("session_id","id");--> statement-breakpoint
CREATE INDEX "sessions_tenant_updated_idx" ON "sessions" USING btree ("tenant","updated_at");