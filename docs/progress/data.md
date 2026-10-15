# data workstream progress

## Done
- `packages/ingest`: clone, snapshot, synth, validate, data:build, load, add-prs (+ --from-git), verify-scenarios, typecheck, test.
- Pinned sources (`src/sources.ts`): acme opentelemetry-demo @ 1fbf2a8d (2026-10-08) with delta to 6dc0b606; globex microservices-demo @ 912468a8 (2024-05-10) with delta to 8846a458. Reasons in sources.ts and data/README.md.
- data/acme.json (1,100 nodes / 5,368 edges), data/globex.json (1,362 / 6,784), data/scenarios.json (11), data/deltas/*.json, data/README.md.
- `data:build` twice → byte-identical (hashes in data/README.md). Validator passes; 17 unit tests pass.
- `pnpm graph:load` loads both tenants into FalkorDB (~2.4 s + 1.2 s with model embeddings) and writes ingest_jobs rows.
- verify-scenarios (real tools via runTool, model embeddings): 11/11 PASS on the canonical snapshot incl. "expected = #1"; also 11/11 with EMBEDDINGS=hash. acme still meets the SPEC bar after deltas; globex incident scenarios do not (window moves 6 weeks); documented.
- agents request #2 resolved (expected = what ranks #1); agents' `scenarios` script: 43/43 checks pass.

- Personas (2026-10-15): synth/personas.ts; 10 fictional personas per tenant carry threads, tickets, on-call, ADR sign-off
  and incident response. Validator enforces the policy (persona-only edges, personas never AUTHORED, no name collisions).
  On-call pool = SRE/engineer roles (word-boundary regex; "Engineering manager" excluded). Re-pinned two scenario experts
  to who_knows #1 under real-facts-only ranking: acme-cart-errors → florian-bourgey, globex-catalog-errors → mathieu-benoit.
  data:build deterministic; validate ✓; verify-scenarios 11/11; agents scenarios 43/43.

- COLLABORATES_WITH is derived at load (graph); the validator rejects it in snapshots like TOUCHES. Scenario experts under
  the new ranking: acme-cart-errors → florian-bourgey, globex-catalog-errors → olivier-bourgeois (ties mathieu-benoit on
  PRs, wins on PageRank). verify-scenarios 11/11; add-prs beat verified (#3988 → #4087 → reset).

## In progress
- nothing

## Next (optional)
- More templated variety in tickets/threads if the UI wants more.

## Decisions
- Scenarios are defined on the canonical snapshot; `add-prs` is the "after" demo, `graph:load` resets.
- DEPENDS_ON excludes service→otel-collector / flagd / opamp-server (control plane, telemetry).
- Team ownership: curated anchor services per team; leftovers (acme agent/mcp/chatbot) by author overlap.

## Blockers
- none
