# agents workstream progress (packages/agents, packages/db)

## Done
- `packages/db`: Drizzle schema per SPEC §8, drizzle-kit migration `drizzle/0000_init.sql` (generated), `src/migrate.ts` (`pnpm db:migrate`), best-effort repo helpers with a 10 s circuit breaker, `pgHealth()`. Integration test `src/db.int.test.ts` passes against the live Postgres on :5434 (7 tests, incl. unreachable-Postgres and no-DATABASE_URL cases).

- `packages/agents` (typechecks, 27 unit tests pass with a fake executor, no DB): runtime (AsyncQueue, RunState, AgentScope), call ledger (callId → exact cypher, evidence harvest, MODEL_ROW_CAP view), scripted planner + claim templates, AI SDK v5 LLM loop (`src/llm.ts`, per-agent prompts in `src/agents/`), actions (GitHub issue, rollback PR, webhook, dry_run fallback), ToolExecutor (direct + MCP), closeIncident/loadScenarios/listActions/getHealth.

## In progress
- smoke + concurrency scripts against the real graph (graph package landed in d5f1c85).

## Next
- Integrate with the real graph once `packages/graph` lands; smoke + concurrency scripts.

## Blockers / notes
- No `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in env or root `.env`: llm mode cannot be tested live.
