# Platform progress

Owner: platform workstream (`apps/mcp`, infra, CI, README + docs).

## Done
- **`apps/mcp`**: `server.ts` (McpServer; every tool in `toolSpecs`; `inputSchema = {tenant, ...shape}`; memory tools get optional `sessionId`/`agent`; `read_handoffs`/`record_finding` return a tool error without them; `record_finding` only with `MCP_ALLOW_WRITES=true`; resources `blastradius://tenants` + `blastradius://schema`), `http.ts` (Streamable HTTP, stateful sessions keyed by `mcp-session-id`, `GET /health` → 200/503), `main.ts` (`--stdio` or HTTP; `loadRootEnv()` first; stderr-only logging), `schema.ts`, `log.ts`.
- **Verified:** `pnpm --filter @blastradius/mcp typecheck` clean; unit tests (6) pass; integration test against live FalkorDB on :6380: health, tools/list (record_finding hidden/shown by mode), read_handoffs error, resources, and stdio client all pass. The `critical_services` call failed with "not implemented" because the graph tools are still stubs; it surfaces correctly as `isError`. With `FALKORDB_URL` pointing at a dead port, `/health` returned 503 `{ok:false,…ECONNREFUSED}`. The CI curl sequence (initialize → session id → tools/list) was run by hand against a local server and works.
- `docker-compose.yml`: `app` profile (`seed`, `mcp`, `web`); falkordb/postgres untouched. `docker compose config` passes for both profiles.
- `Dockerfile` (multi-stage; targets `mcp`, `web`), `.dockerignore`, `render.yaml`, `.github/workflows/ci.yml` (validated with `@action-validator/cli`, exit 0), `LICENSE` (MIT).
- `.env.example`: added `MCP_HOST`, `WEB_PORT`.
- Drafts: README, ARCHITECTURE, DEPLOY, DEMO (DEMO has TODO placeholders for scenario ids).

## In progress
- `docker build --target mcp .` The first try failed at `corepack install` (network timeout fetching the pnpm tarball; this machine's network is flaky, and Docker Hub pulls also time out). Switched to `npm install -g pnpm@10.33.0` (with retries) and rebuilding.

## Next
- Re-run the MCP int test once graph tools and data land (`critical_services` must return rows).
- Re-read graph/data/agents/web code + progress logs; update README/ARCHITECTURE/DEMO with real names, scenario ids, commands; grep `process.env.` for `.env.example`.
- Dry-run the CI sequence locally (`db:migrate` → `graph:load` → `smoke` → graph `test:integration` → MCP).

## Blockers
- None (graph tools are stubs for now; that's expected).
