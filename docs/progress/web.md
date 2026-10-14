# web — progress

## Done
- `apps/web` scaffold: Next 15.5.28 App Router, React 19.2, Tailwind v4 (`@tailwindcss/postcss`), TS strict, vitest.
  `next.config.ts` calls `loadRootEnv()`, sets `transpilePackages` + `serverExternalPackages`.
- Pure reducer `src/lib/run-state.ts` (`reduce`, `buildState`, `buildSession`, `reduceSession`, selectors
  `evidenceForFinding` (exact-Cypher matching), `pathsForFinding`, `findingsForClaim`, …) + tests.
- Hand-written fixtures in `src/fixtures/`: `run.acme.json` (incident "checkout 5xx at 12%"), `run.acme.ask.json`,
  `overview.acme.json`, `memory.acme.json`. `?fixture=1` replays them with no backend (`&instant=1` for no pacing).
- Console UI (`/`): top bar (tenant, sessions, mode, health dots, llm/scripted badge, memory link), timeline
  (memory card, agent cards with tool calls/findings/handoffs/actions/claims + Why? chips, errors), force graph
  (overview + run paths, pulse, dim, focus, neighbourhood expand, legend, details), Why? drawer, close-incident dialog.
- Memory inspector (`/memory`) against the fixture.

- Route handlers (SPEC §6) wired to the real packages; all verified with curl against live FalkorDB/Postgres
  (graph still empty at the time): health, tenants, scenarios, sessions GET/POST, sessions/[id]/messages,
  investigate (SSE end-to-end with the real scripted pipeline; client disconnect → run `aborted` in pg),
  graph/overview, graph/neighborhood, actions, memory. Validation errors → 400.
- FalkorDB down (prod build with `FALKORDB_URL=redis://localhost:6399`): health shows `falkordb.ok=false`,
  graph routes return 503 `backend unavailable: connect ECONNREFUSED…`, investigate streams `error{falkordb,fatal}` +
  `run_finished{error}`. Missing tenant graph → 503 "tenant graph not loaded".
- `next build` passes (`NEXT_DIST_DIR=.next-build pnpm build` to build next to a running dev server).

- Verified against REAL data (snapshots loaded into an isolated `web_` namespace with
  `BLASTRADIUS_GRAPH_NAMESPACE=web`, dev server on :3002): acme overview/neighbourhood, live scripted incident
  run "Checkout 5xx at 12%" (suspect PR #4059, expert, precedent INC-2026-037, 3 dry-run actions), Why? drawer
  (cypher matched, rows, evidence paths, Focus on graph), close incident (Incident `INC-<session>` + runbook written),
  new session recalls it (cross-session recall card), session replay from the dropdown, memory inspector on the
  closed session, live ask "Why did we move cart to Valkey?" (sources ADR-001 / t-0001 / doc). globex incident via curl.
- `src/fixtures/recorded.acme.checkout.json`: a real recorded run used as a regression test.

## In progress
- nothing

## Next
- llm mode is untested in the UI (no API key on this machine); the badge reads `run_started.agentMode/model`.
- If agents/graph change event shapes, re-record `recorded.acme.checkout.json` from `/api/sessions/<id>/messages`.

## Blockers
- none
