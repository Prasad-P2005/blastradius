# agents workstream progress (packages/agents, packages/db)

## Done
- `packages/db`: Drizzle schema per SPEC §8, drizzle-kit migration `drizzle/0000_init.sql` (generated), `src/migrate.ts` (`pnpm db:migrate`), best-effort repo helpers with a 10 s circuit breaker, `pgHealth()`. Integration test `src/db.int.test.ts` passes against the live Postgres on :5434 (7 tests, incl. unreachable-Postgres and no-DATABASE_URL cases).

## In progress
- `packages/agents`: runtime (event queue, ledger, AgentScope), scripted planner, LLM loop, actions, MCP executor.

## Next
- Integrate with the real graph once `packages/graph` lands; smoke + concurrency scripts.

## Blockers / notes
- No `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in env or root `.env`: llm mode cannot be tested live.
