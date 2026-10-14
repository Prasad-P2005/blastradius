# Platform progress

Owner: platform workstream (`apps/mcp`, infra, CI, README + docs).

## Done
- **`apps/mcp`**: `server.ts` (McpServer; every tool in `toolSpecs`; `inputSchema = {tenant, ...shape}`; memory tools get optional `sessionId`/`agent`; `read_handoffs`/`record_finding` return a tool error without them; `record_finding` only with `MCP_ALLOW_WRITES=true`; resources `blastradius://tenants` + `blastradius://schema`), `http.ts` (Streamable HTTP, stateful sessions keyed by `mcp-session-id`, `GET /health` → 200/503), `main.ts` (`--stdio` or HTTP; `loadRootEnv()` first; stderr-only logging), `schema.ts`, `log.ts`.
- **Verified:** `pnpm --filter @blastradius/mcp typecheck` clean; unit tests (6) pass; integration test against live FalkorDB on :6380: health, tools/list (record_finding hidden/shown by mode), read_handoffs error, resources, and stdio client all pass. The `critical_services` call failed with "not implemented" because the graph tools are still stubs; it surfaces correctly as `isError`. With `FALKORDB_URL` pointing at a dead port, `/health` returned 503 `{ok:false,…ECONNREFUSED}`. The CI curl sequence (initialize → session id → tools/list) was run by hand against a local server and works.
- `docker-compose.yml`: `app` profile (`seed`, `mcp`, `web`); falkordb/postgres untouched. `docker compose config` passes for both profiles.
- `Dockerfile` (multi-stage; targets `mcp`, `web`), `.dockerignore`, `render.yaml`, `.github/workflows/ci.yml` (validated with `@action-validator/cli`, exit 0), `LICENSE` (MIT).
- `.env.example`: added `MCP_HOST`, `WEB_PORT`.
- Drafts: README, ARCHITECTURE, DEPLOY, DEMO (DEMO has TODO placeholders for scenario ids).

- **`docker build --target mcp .` succeeds** (image 1.28 GB). The first try failed at `corepack install` (network timeout), so pnpm is now installed with `npm i -g` and retries. A second try failed at `--frozen-lockfile` while the web agent's install was mid-flight (lockfile out of sync), and passed once it settled. I ran the image on `blastradius_default` (`-p 3334:3333`, `FALKORDB_URL=redis://falkordb:6379`): `/health` 200, tools/list returned 15 tools; the container was removed afterwards. Running falkordb/postgres untouched.
- Int test now also covers FalkorDB unreachable → `isError` (stdio subprocess with `FALKORDB_URL=redis://127.0.0.1:1`). 7/8 pass; `critical_services` returns 0 rows only because no snapshot is loaded yet (the tool itself is implemented).

- **Real data via MCP:** loaded `data/acme.json` + `globex.json` with `loadSnapshot` into **namespaced** graphs (`BLASTRADIUS_GRAPH_NAMESPACE=platform`, `EMBEDDINGS=hash`; acme 1100 nodes / 5368 edges, globex 1362 / 6784) so the shared `blastradius_*` graphs stay untouched. MCP int test **8/8 pass** with that namespace. Probed over MCP: blast_radius(checkout) = 6 services, suspect_changes top = PR #4059 (matches the acme-checkout-5xx scenario), who_knows top = Piotr Kiełkowicz, ask_company(Valkey) best = Doc:adr-001-cart-store-valkey, failure_communities = 8 CDLP communities.
- **`docker build --target web .` succeeds** (next build). I ran it on `blastradius_default` with the platform namespace: `/api/health` reported falkordb+postgres ok (scripted, hash, direct), `/api/tenants` returned live counts, `/` returned 200. The container was removed afterwards.

- **Graph request #2 (embedding model download) handled:** `apps/mcp/scripts/fetch-model.sh` (`pnpm --filter @blastradius/mcp fetch-model`) curls config/tokenizer/`onnx/model.onnx` into `$HF_CACHE_DIR/Xenova/all-MiniLM-L6-v2/` with retries and is idempotent. I tested it on the warm repo cache (skips) and on a fresh dir (86 MB downloaded). The Dockerfile `model` stage bakes it into `/opt/hf` (`HF_CACHE_DIR=/opt/hf`; `--build-arg FETCH_MODEL=false` opts out). The compose hf-cache volume was removed. **Verified:** `docker run --network none -e EMBEDDINGS=model blastradius-mcp:local` → `embeddingBackend()=model`, 384-dim unit vector, with no network. CI and render.yaml use `EMBEDDINGS=hash` consistently. README, DEPLOY and .env.example now say: never mix backends in one graph; reload with `pnpm graph:load` if the backend changes. (Graph owns `docs/requests/graph.md`, so the status flip there is theirs or the lead's.)

- **CI dry-run, local, full sequence** (graph namespace `ci`, separate database `blastradius_ci`, `EMBEDDINGS=hash`, `AGENT_MODE=scripted`): `pnpm install --frozen-lockfile --offline` ok; `pnpm typecheck` exit 0; `pnpm test` exit 0 (103 unit tests across 6 packages); `pnpm db:migrate` ok; `pnpm graph:load` ok (acme 1100/5368, globex 1362/6784); `pnpm smoke` (234 checks passed); graph `test:integration` 24/24; MCP background start + `/health` + curl initialize/tools/list (blast_radius present, record_finding hidden) ok; MCP `test:integration` 8/8. The only differences from GitHub Actions are the ports (6380/5434 here vs 6379/5432 there) and the namespace. GitHub Actions itself was **not** run.
- **Compose `seed` verified** with `docker compose --profile app build seed` + `BLASTRADIUS_GRAPH_NAMESPACE=compose docker compose --profile app run --rm --no-deps seed`: migrate + load inside the container with **model** embeddings (baked) succeeded. The running falkordb/postgres containers were untouched (still "Up 5 hours"). Test graphs and the `blastradius_ci` database were deleted afterwards.
- **Not verified:** a full `docker compose --profile app up` (it would attach to the shared falkordb/postgres; skipped on purpose), and the `mcp` + `web` compose services as compose services (each image *was* run by hand on the same network, see above).

- **Final docs pass** (re-read the graph/data/agents/web progress logs and code): ARCHITECTURE now uses the real memory Cypher from packages/graph, the real pipeline order (`run_started` before `startSession`) and the concurrency checks; DEMO uses real scenario ids (acme-checkout-5xx: 6-service blast radius, PR #4059, Piotr Kiełkowicz, INC-2026-037; acme-ask-valkey: ADR-001; acme-cart-errors + `add-prs`: #3988 → #4087). I verified recall and add-prs live in the throwaway namespace `democheck` (deleted afterwards). README track table and scripts table match the real commands and UI labels. `.env.example` gained `NEXT_PUBLIC_ENABLE_FIXTURES` and a commented-out `NEXT_DIST_DIR`.

## In progress
- Nothing.

## Open TODOs left in docs (for the team)
- README: demo GIF/video, live URL, team names, each teammate's contribution, `docs/LEARN.md` (lead).
- DEPLOY: FalkorDB Cloud / Neon / Render steps are **unverified** (no accounts used).

## Blockers
- None.
