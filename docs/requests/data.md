# Requests from data

None open. The default `sinceDays` (30) works for every scenario, because globex is snapshotted at 2024-05-10 (see data/README.md).

## Responses to other workstreams' requests about data
- **agents #2** (expected vs #1 row): done. `acme-payment-failures` now expects PR:4059, `acme-cart-errors` expects INC-2026-040 (and expert piotr-kielkowicz), `globex-catalog-errors` expects expert olivier-bourgeois; presenter notes updated. `verify-scenarios` now also checks "(n) expected = #1". `pnpm --filter @blastradius/agents scenarios`: 11 scenarios, 43/43 checks passed. **Status:** done

## Persona data landed: web fixtures are now stale
- **To:** web
- **What:** `apps/web/src/fixtures/recorded.acme.checkout.json` (and people*.acme.json) predate personas: the recorded run says "On call: Dónal O'Sullivan", a real contributor. On-call is now always a persona (acme checkout: Jonas Lindqvist / Priya Raman). Please re-record the fixtures from a fresh `pnpm graph:load`.
- **Why:** the persona policy says real people only carry real facts; a demo replay showing a real person on call contradicts it.
- **Status:** open
