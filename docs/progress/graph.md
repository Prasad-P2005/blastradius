# graph workstream progress

## Done
- M1: `packages/graph` package with the full SPEC §3 public API exported from `src/index.ts` (typechecks).
  connection, convert, embed, schema are real; tools/memory/reads/load are stubs that throw `not implemented`.

- M2: all 16 tools, loadSnapshot/ingestDelta/resetGraph, memory, UI reads implemented. `scripts/try-tools.ts`
  loads `test/fixture.ts` into `itest_blastradius_acme` and runs every tool against live FalkorDB (works; output being checked).
- Real embedding model (Xenova/all-MiniLM-L6-v2) loads; the in-library download got "terminated", so model.onnx was fetched
  with curl into `.cache/hf/Xenova/all-MiniLM-L6-v2/onnx/model.onnx`.

- M3: `pnpm --filter @blastradius/graph test` (18 unit tests, no DB) and `test:integration` (24 tests, live FalkorDB,
  `itest` namespace): every tool with content assertions, memory flow incl. cross-session recall, UI reads, ingestDelta. All pass.

## In progress
- docs/CYPHER.md with real output from the fixture.

## Next
- Run tools against the data agent's real snapshot when it lands; check timings vs the 1000 ms default.

## Blockers
- none

## Notes for other workstreams
- Set `BLASTRADIUS_GRAPH_NAMESPACE=<ns>` to prefix graph keys (`<ns>_blastradius_acme`). Integration tests use `itest`.
