# Platform progress

Owner: platform workstream (`apps/mcp`, infra, CI, README + docs).

## Done
- `apps/mcp` scaffold: `server.ts` (McpServer, every tool in `toolSpecs`, write gating, resources), `http.ts` (Streamable HTTP, stateful sessions, `/health`), `main.ts` (`--stdio` or HTTP; `loadRootEnv()` first), `schema.ts` (input shapes, relationship directions, documented indexes), `log.ts` (stderr only).
- Tests written: `schema.test.ts` (unit), `server.int.test.ts` (HTTP + stdio, live FalkorDB).
- `docker-compose.yml`: `app` profile (`seed`, `mcp`, `web`); falkordb/postgres untouched. `docker compose config` passes for both profiles.
- `Dockerfile` (multi-stage, targets `mcp` and `web`), `.dockerignore`, `render.yaml`, `.github/workflows/ci.yml`, `LICENSE` (MIT).
- `.env.example`: added `MCP_HOST`, `WEB_PORT`.

## In progress
- Waiting for `pnpm install` (onnxruntime-node download) and the graph package skeleton to typecheck/run the MCP server.

## Next
- Typecheck + run tests against live FalkorDB once `@blastradius/graph` exports exist and data is loaded.
- `docker build --target mcp .`
- README, ARCHITECTURE, DEMO, DEPLOY drafts; re-read other workstreams near the end.

## Blockers
- None yet.
