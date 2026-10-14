# graph workstream progress

## Done
- M1: `packages/graph` package with the full SPEC §3 public API exported from `src/index.ts` (typechecks).
  connection, convert, embed, schema are real; tools/memory/reads/load are stubs that throw `not implemented`.

## In progress
- Tools, memory, reads, load + fixture integration test.

## Next
- docs/CYPHER.md with real output.

## Blockers
- none

## Notes for other workstreams
- Set `BLASTRADIUS_GRAPH_NAMESPACE=<ns>` to prefix graph keys (`<ns>_blastradius_acme`). Integration tests use `itest`.
