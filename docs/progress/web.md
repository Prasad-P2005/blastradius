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

## In progress
- Route handlers (SPEC §6) against `@blastradius/graph`, `@blastradius/agents`, `@blastradius/db`.

## Next
- Integrate with real packages as they land; verify every route with curl; screenshots against real data.

## Blockers
- none yet
