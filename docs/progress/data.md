# data workstream progress

## Done
- `packages/ingest` scaffold (package.json scripts, tsconfig).
- `sources.ts`: pinned SHAs. acme = opentelemetry-demo @ 1fbf2a8d (2026-10-08), delta to 6dc0b606 (5 human PRs held back: #3966 #4083 #4084 #4087 #4088).
  globex = microservices-demo @ 912468a8 (2024-05-10; latest 30 days of HEAD have no human service PRs, so we cut where humans were active), delta to 8846a458 (#2538 #2568 #2578 #2588 #2598 #2599).
- `git.ts` (squash + merge-commit PR parsing, numstat, full clones), `services.ts` (alias tables incl. acme legacy `src/*service/` dirs), `deps.ts` (curated DEPENDS_ON with source citations), `people.ts` (slug, aliases, bots), `prng.ts` (mulberry32), `time.ts`, `graph-builder.ts`, `write.ts` (stable JSON), `snapshot.ts` (real half + delta builder).
- CLIs `clone`, `snapshot` run: acme 605 PRs (227 human), globex 1101 PRs (175 human).
- Synth modules written (not yet run): `synth/context.ts teams.ts oncall.ts text.ts incidents.ts decisions.ts brain.ts scenarios.ts index.ts`.

## In progress
- `content/acme.ts`, `content/globex.ts` (hand-written incidents, ADRs, tickets, threads, scenarios).

## Next
- synth CLI → data/acme.json, data/globex.json, data/scenarios.json; validator + tests; load; add-prs; verify-scenarios; data/README.md.

## Decisions
- Scenarios are defined on the canonical snapshot (without deltas). acme scenarios are chosen to also hold after `add-prs` (window moves 6 days); globex's delta moves the window 6 weeks, so globex scenarios hold pre-delta only. verify-scenarios reports both.
- DEPENDS_ON excludes service→otel-collector / flagd / opamp-server (control plane, telemetry).

## Blockers
- none
