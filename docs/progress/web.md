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

## In progress
- Waiting for data to be loaded to verify the UI against real graph data.

## Next
- Integrate with real packages as they land; verify every route with curl; screenshots against real data.

## Blockers
- none yet
