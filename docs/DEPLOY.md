# Deploying Blastradius

A deployment has four parts:

| Part | Where | Env vars it needs |
|---|---|---|
| FalkorDB (all graph data, vectors, agent memory) | FalkorDB Cloud | (sets `FALKORDB_URL`, `FALKORDB_PASSWORD`) |
| Postgres (transcript, event log, action audit) | Neon, or Render Postgres | (sets `DATABASE_URL`) |
| Web console (Next.js) | Render (Docker), from `render.yaml` | `FALKORDB_*`, `DATABASE_URL`, optional LLM / GitHub / webhook keys |
| MCP server | Render (Docker), from `render.yaml` | `FALKORDB_*`, `MCP_PORT` |

Status legend used below: **verified** means we ran it; **unverified** means it's written from the provider's docs and hasn't been run end to end by us yet.

> TODO(team): once deployed, put the live URLs here and in the README, and flip the unverified markers you've confirmed.

## 1. FalkorDB Cloud (unverified)

1. Sign up at https://app.falkordb.cloud and create a database (the free tier is enough for two small tenant graphs).
2. From the instance's connection details, copy the **host**, **port**, **username** (usually `default`) and **password**.
3. Set:
   ```bash
   FALKORDB_URL=redis://<host>:<port>
   FALKORDB_PASSWORD=<password>
   ```
   The graph package passes both to `FalkorDB.connect({ url, password })` (`packages/graph/src/connection.ts`). Putting the credentials in the URL also works with the underlying redis client: `redis://default:<password>@<host>:<port>`. If the instance requires TLS, use the `rediss://` scheme.
4. Check the connection from your machine:
   ```bash
   redis-cli -u "redis://default:<password>@<host>:<port>" PING
   redis-cli -u "redis://default:<password>@<host>:<port>" GRAPH.LIST
   ```

Check that the Cloud version has the procedures we depend on (`algo.pageRank`, `algo.betweenness`, `algo.labelPropagation`, `algo.WCC`, `db.idx.vector.queryNodes`). Locally we developed against FalkorDB 6.0.2. Run `CALL dbms.procedures()` on the cloud instance if anything fails.

## 2. Postgres: Neon or Render (unverified)

**Neon:** create a project at https://neon.tech, copy the connection string, and use it as `DATABASE_URL` (Neon strings end in `?sslmode=require`; keep that).

**Render Postgres:** create a PostgreSQL instance in the Render dashboard and copy its *External Database URL* (for running migrations from your laptop) or *Internal Database URL* (for services in the same Render region).

Apply the schema once (and after every migration change):

```bash
DATABASE_URL='postgres://…' pnpm db:migrate
```

Postgres is best-effort. If it's missing or down the product still investigates, but session replay and the action audit log are empty.

## 3. Seed the cloud graph (unverified against Cloud; verified locally)

Run the loader from your machine with the cloud credentials. It reads `data/acme.json` and `data/globex.json`, creates the indexes, computes embeddings and writes one graph per tenant:

```bash
FALKORDB_URL='redis://<host>:<port>' FALKORDB_PASSWORD='<password>' \
EMBEDDINGS=hash \
pnpm graph:load
```

**Use the same `EMBEDDINGS` backend for seeding and serving.** Vectors from the MiniLM model and from the hash fallback live in different spaces. If you seed with `model`, the services must also run with `model`. They then download the model (~90 MB) on first use into `HF_CACHE_DIR`, which on Render is lost on every deploy unless you attach a disk. `render.yaml` therefore defaults to `hash`.

## 4. Render (web + MCP) from `render.yaml` (unverified)

`render.yaml` defines two Docker web services built from the repo `Dockerfile`:

| Service | Image stage | Command | Health check |
|---|---|---|---|
| `blastradius-web` | `web` (last stage, default) | `next start -p $PORT` (Dockerfile `CMD`) | `/api/health` |
| `blastradius-mcp` | `web` (same image) | `pnpm --filter @blastradius/mcp start` (`dockerCommand`) | `/health` |

Steps:

1. Push the repo to GitHub.
2. In Render: **New → Blueprint**, pick the repo. Render reads `render.yaml`.
3. Fill in the `sync: false` secrets when prompted: `FALKORDB_URL`, `FALKORDB_PASSWORD`, `DATABASE_URL`, and optionally `ANTHROPIC_API_KEY` (enables llm mode), `GITHUB_TOKEN` + `GITHUB_SANDBOX_REPO` (real issues and rollback PRs), `WEBHOOK_URL`.
4. Deploy. The web service runs `pnpm db:migrate` as a **pre-deploy command**. Render only offers pre-deploy commands on paid instance types; on the free tier, run `pnpm db:migrate` from your laptop instead (section 2).
5. Seed the graph (section 3) if you haven't.

Render routes traffic to the port in `PORT` (set to 3000 for web and 3333 for MCP in `render.yaml`).

**Railway** works the same way: two services from the same Dockerfile, the MCP one with the start command overridden to `pnpm --filter @blastradius/mcp start`. We haven't written a Railway config.

## 5. The MCP endpoint

Once deployed, the MCP server is at:

```
https://<blastradius-mcp>.onrender.com/mcp      # Streamable HTTP
https://<blastradius-mcp>.onrender.com/health   # { ok, falkordb }
```

Connect from Claude Code:

```bash
claude mcp add --transport http blastradius https://<blastradius-mcp>.onrender.com/mcp
```

The public endpoint runs with `MCP_ALLOW_WRITES=false`, so `record_finding` isn't exposed and MCP clients can't write to the graph. The server has **no authentication**: anyone with the URL can run the read tools against the demo data. That's acceptable for public demo data, but not for anything private.

## 6. Running the whole stack in Docker locally (verified: see docs/progress/platform.md)

```bash
docker compose --profile app up --build
```

This starts FalkorDB and Postgres, runs the one-shot `seed` service (`pnpm seed` = `db:migrate` + `graph:load`), then starts `mcp` on `:3333` and `web` on `:3000`. Inside the network the containers use `falkordb:6379` and `postgres:5432`. Set `EMBEDDINGS=hash` in `.env` if the containers can't download the model.

Build a single image:

```bash
docker build --target mcp -t blastradius-mcp .
docker build --target web -t blastradius-web .
```
