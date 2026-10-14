# agents workstream progress (packages/agents, packages/db)

## Done
- `packages/db`: Drizzle schema per SPEC §8, drizzle-kit migration `drizzle/0000_init.sql` (generated), `src/migrate.ts` (`pnpm db:migrate`), best-effort repo helpers with a 10 s circuit breaker, `pgHealth()`. Integration test `src/db.int.test.ts` passes against the live Postgres on :5434 (7 tests, incl. unreachable-Postgres and no-DATABASE_URL cases).

- `packages/agents` (typechecks, 27 unit tests pass with a fake executor, no DB): runtime (AsyncQueue, RunState, AgentScope), call ledger (callId → exact cypher, evidence harvest, MODEL_ROW_CAP view), scripted planner + claim templates, AI SDK v5 LLM loop (`src/llm.ts`, per-agent prompts in `src/agents/`), actions (GitHub issue, rollback PR, webhook, dry_run fallback), ToolExecutor (direct + MCP), closeIncident/loadScenarios/listActions/getHealth.

- Verified against live FalkorDB + Postgres with the real data (data/acme.json, data/globex.json, scenarios.json as of 04:45), in isolated graph namespaces (`smoke`, `concurrency`) so the demo graph is never polluted:
  - `pnpm smoke`: 234 checks pass (both tenants: incident run, closeIncident, second run recalls the closed incident; one ask run).
  - `pnpm concurrency`: 10 concurrent runs (incl. 2 runs sharing one session), 473 checks pass, wall ~1 s.
  - `pnpm --filter @blastradius/agents scenarios`: all 11 scenarios meet the SPEC §10 bar (43 checks); 2 warnings filed to data (docs/requests/agents.md #2).
  - MCP transport: full scripted run over `AGENT_TOOL_TRANSPORT=mcp` against apps/mcp (`MCP_ALLOW_WRITES=true`), incl. record_finding. MCP down → `error{mcp,fatal}` + `run_finished{error}`; FalkorDB down → `error{falkordb,fatal}` + `run_finished{error}`.
  - LLM tool-loop wiring unit-tested with AI SDK `MockLanguageModelV2` (allowed tools only, no injected fields in schemas, cites → exact cypher, row cap, fatal stop). **Not tested against a real model: no API key.**

## In progress
- nothing blocking; polish.

## Next
- Re-run smoke/scenarios when data updates scenarios.json; try llm mode if a key appears.

## Usage
- `pnpm smoke` / `pnpm concurrency` (flags: `--tenants acme`, `--scenarios <file>`, `--live` = use the configured graph, `--no-load` = keep namespace contents).
- `pnpm --filter @blastradius/agents investigate -- acme incident checkout "checkout 5xx at 12%"` prints one run's events.
- Scripted mode when no key; `AGENT_MODE=llm|scripted|auto`; `AGENT_TOOL_TRANSPORT=mcp` + `MCP_URL`.

## Blockers / notes
- No `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in env or root `.env`: llm mode cannot be tested live. Default model id `claude-sonnet-5-5` (SPEC §9); no temperature is sent and tool_choice stays `auto` (Sonnet 5.5 rejects forced tool choice).
- Root `.env` `WEBHOOK_URL=   # comment` parses to the comment text (shared parseDotenv); agents guard against it (request #1).
