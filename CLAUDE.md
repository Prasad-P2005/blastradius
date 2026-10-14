# Blastradius: read this first

Blastradius is our submission to **Graph Hacks: Context for AI Agents** (FalkorDB × WeMakeDevs, Oct 15 12:01 AM IST → Oct 18 11:59 PM IST, 2026). We are entering **all three tracks**.

When an alert fires ("checkout 5xx at 12%"), a team of agents works over **one FalkorDB graph per tenant**. The graph holds services, code, PRs, people, teams, incidents, runbooks, decisions, tickets and chat threads, **plus all agent memory**. The agents answer four questions:

1. **What else breaks?** A multi-hop `DEPENDS_ON` walk, ranked by betweenness centrality.
2. **What probably caused it?** Recent PRs on the service or its dependencies, plus similar past incidents found by vector search in FalkorDB.
3. **Who can fix it?** PageRank over authorship, filtered by team and on-call.
4. **What worked last time?** Incidents and runbooks recalled from earlier sessions.

Every claim has a **Why?** chip showing the exact Cypher and the graph path behind it. The agents also act: they open a GitHub issue in a sandbox repo, send a webhook ping, and draft a rollback PR in the sandbox repo.

Full spec: `docs/SPEC.md`. Contract: `packages/shared/src/index.ts`.

---

## Hackathon rules (hard constraints)

Source: https://www.wemakedevs.org/hackathons/falkordb/rules

- **FalkorDB is the primary graph database and runs a central function.** If FalkorDB is removed, the product must stop working. A visualisation drawn on top of ordinary storage does not count. In practice: no agent reasoning and no tool result may come from Postgres or from an in-memory copy of the graph.
- **Data:** public, synthetic or our own only. No private or login-protected data and **no email addresses**. Git authors are keyed by slugified name only.
- **Main coding started after Oct 15 12:01 AM IST.** (Ideas and sketches from before are fine.)
- **The submission needs:** a public repo; a README with setup steps and the graph data model; the Cypher queries and graph algorithms we depend on (`docs/CYPHER.md`); a demo video; a live deployment or complete local setup; and the tracks entered.
- **AI-assistant use must be disclosed** (README "How we used AI").
- **Every teammate must be able to explain** the graph model, the queries, the architecture and the decisions. Projects generated entirely by AI without understanding can be rejected. So **write code and docs a human can learn from**: name things clearly, say *why* in comments where it isn't obvious, and keep Cypher readable (multi-line, with comments).

## Tracks, and the features each must show in the demo

| Track | Features |
|---|---|
| 01 Agents That Act on Connected Data | Multi-hop reasoning; graph algorithms (PageRank, betweenness, shortest path, CDLP/WCC) as agent tools; the same tools over MCP; real actions (GitHub issue, webhook, sandbox rollback PR); a Why? path on every claim |
| 02 Agent Memory and Coordination | Episodic memory (`Session-[:HAS_EPISODE]->Episode-[:NEXT]->Episode`); semantic memory (domain graph + `Finding`); procedural memory (`Incident` + `Runbook` written by the Scribe on close); handoffs **only** through graph state (`Finding-[:HANDED_TO]->Agent`); recall across sessions; one graph per tenant; Memory inspector page; a concurrency script |
| 03 Company Brain | Tickets, threads, ADRs and docs in the same graph as code; "who owns or knows X"; decision tracing (Doc ← Decision → PR → Incident); **Ask the company** mode with sources; **incremental re-ingest** of new PRs |

Priority: a polished core over breadth. These must be flawless first: **blast radius, suspect PR, Why? paths, cross-session recall, one real action, and Ask the company.**

---

## Tech decisions (fixed; don't re-debate)

- **TypeScript everywhere**, ESM, Node 22, **pnpm workspaces**. Packages are consumed as TS source (`"exports": {".": "./src/index.ts"}`), with no build step. Next.js uses `transpilePackages`; scripts run with `tsx`. `tsconfig.base.json` is strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax` (use `import type`). Relative imports use the `.ts` extension.
- **FalkorDB** through the official `falkordb` npm client. It holds all domain data **and all agent memory**, one graph per tenant: `graphName(tenant)` = `blastradius_<tenant>`.
- **Vectors live in FalkorDB.** Use `CREATE VECTOR INDEX FOR (n:Label) ON (n.embedding) OPTIONS {dimension:384, similarityFunction:'cosine'}`, store values as `vecf32($vec)`, and query with `CALL db.idx.vector.queryNodes(label, 'embedding', k, vecf32($vec)) YIELD node, score`. No pgvector, Pinecone or other vector store.
  - Embeddings: `@huggingface/transformers` with `Xenova/all-MiniLM-L6-v2` (384 dims), computed locally and cached after the first download. Fallback: a deterministic hashed bag-of-words (384 dims). `EMBEDDINGS=hash` forces the fallback.
  - Embedded labels: Incident, Decision, Doc, Issue, Thread, Finding (`EMBED_TEXT_FIELDS` in shared).
  - **Cosine scores are distances (lower = closer).** Convert them with `cosineDistanceToSimilarity()` before showing them.
- **Postgres 16 + Drizzle** (`drizzle-orm`, `postgres`, `drizzle-kit generate` + `migrate`) for **app bookkeeping only**: tenants, sessions, chat transcript, agent runs and the event log for replay, the action audit log, and ingest jobs. Nothing an agent reasons over lives in Postgres. Postgres writes are **best-effort**: the product degrades if Postgres is down, but it dies if FalkorDB is down.
- **Agents:** Vercel AI SDK **v5** (`ai@^5`, `@ai-sdk/anthropic@^2`, `@ai-sdk/openai@^2`) with zod tool schemas. A **scripted mode** calls the same tools in a fixed order and templates claims from rows, so the product and CI work with no API key. The UI shows a badge for the active mode.
- **MCP:** `@modelcontextprotocol/sdk` ^1.32 (1.x stable, not 2.0 alpha). It serves the same tool registry over stdio and Streamable HTTP on `:3333/mcp`. `inputSchema` takes a zod **raw shape**, so pass `ToolInputSchemas[t].shape` plus a required `tenant` enum. Write tools (`WRITE_TOOLS`) stay disabled unless `MCP_ALLOW_WRITES=true`.
- **Web:** Next.js **15** App Router, React 19, Tailwind v4, `react-force-graph-2d` (dynamic import with `ssr:false`). SSE for the agent event stream.
- **zod v4** everywhere (`zod@^4.1`). Tool input schemas are plain `z.object`s, with no refine or transform at the top level, so `.shape` works.
- **Versions:** typescript 5.9.3, vitest 3.2, next 15.5, ai 5.0, @ai-sdk/* 2.0, @modelcontextprotocol/sdk 1.32, falkordb 6.x, drizzle-orm 0.45, drizzle-kit 0.31.
- **Infra:** `docker-compose.yml` runs `falkordb/falkordb` and `postgres:16`. GitHub Actions CI uses service containers.
- **Deploy:** FalkorDB Cloud, Render or Railway (web + MCP), and Neon or Render Postgres.

### Local ports (deviation from the original plan, deliberate)

The dev machine already runs Redis on 6379 and Postgres on 5432, so docker maps:

| Service | Host port | Env |
|---|---|---|
| FalkorDB (redis protocol) | **6380** | `FALKORDB_URL=redis://localhost:6380` |
| FalkorDB browser UI | 3001 | `FALKORDB_UI_PORT` |
| Postgres | **5434** | `DATABASE_URL=postgres://blast:blast@localhost:5434/blastradius` |
| Next.js | 3000 | |
| MCP HTTP | 3333 | `MCP_PORT` |

Use `redis-cli -p 6380` and `PGPASSWORD=blast psql -h localhost -p 5434 -U blast blastradius`. **Never hardcode ports in code; read env.**

### FalkorDB facts verified against the live container (FalkorDB 6.0.2, Redis 8.10)

Checked by the lead in Phase 0. Re-check anything else before building on it.

- Procedures present: `algo.pageRank`, `algo.betweenness`, `algo.WCC`, `algo.labelPropagation`, `algo.BFS`, `algo.SPpaths`, `algo.SSpaths`, `algo.HarmonicCentrality`, `algo.MSF`, `algo.maxFlow`, `db.idx.vector.queryNodes`, `db.idx.fulltext.queryNodes`, `db.indexes`, `db.labels`, `db.relationshipTypes`.
- `CALL algo.pageRank('Label','REL') YIELD node, score` takes **positional** label and relationship type.
- `CALL algo.betweenness({nodeLabels:['Service'], relationshipTypes:['DEPENDS_ON']}) YIELD node, score` takes a config map.
- `CALL algo.WCC({nodeLabels:[...], relationshipTypes:[...]}) YIELD node, componentId`
- `CALL algo.labelPropagation({nodeLabels:[...], relationshipTypes:[...]}) YIELD node, communityId` (CDLP)
- `shortestPath(...)` is **only allowed in WITH or RETURN**, not in `MATCH p = shortestPath(...)`. Use `MATCH (a {uid:$from}), (b {uid:$to}) WITH a, b, shortestPath((a)-[*..6]-(b)) AS p RETURN p`.
- Full-text: `CREATE FULLTEXT INDEX FOR (n:Service) ON (n.name)`, queried with `CALL db.idx.fulltext.queryNodes('Service', 'cart') YIELD node, score`. The old `db.idx.fulltext.createNodeIndex('L','prop')` form errors on this version.
- Vector: `CREATE VECTOR INDEX FOR (t:T) ON (t.embedding) OPTIONS {dimension:384, similarityFunction:'cosine'}` works. The `queryNodes` score is a cosine **distance** (identical vectors give ≈0).
- `GRAPH.RO_QUERY` rejects writes. Use the client's read-only query for read tools.
- The server default query **TIMEOUT is 1000 ms**. Keep tool queries bounded (`LIMIT`, hop caps). Pass a per-query timeout if one must run longer (e.g. bulk loads).

---

## Lessons from the practice run (bake these in)

1. On-call is one `ON_CALL_FOR {weekStart}` edge **per week**. MERGE on `(person, service, weekStart)` (`MERGE (p)-[r:ON_CALL_FOR {weekStart:$w}]->(s)`), or all weeks collapse into one edge.
2. "Recent" (`sinceDays`) is measured from **the newest PR in the tenant's graph**, not from today's date, so the demo keeps working for weeks.
3. Bots (dependabot, renovate, github-actions, otelbot…) are real history, but `who_knows` must down-weight or exclude them (`Person.isBot`). Demo scenarios point at **human** PRs. globex's recent history is mostly bots, so look further back for its scenarios.
4. Every node and edge id the UI sees is the node's `uid` (`Service:checkout`, `PR:4087`). **Never expose FalkorDB internal ids.**
5. A finding's `cypher[]` must be **exactly** the Cypher string that ran (`GraphToolResult.cypher`), so the Why? drawer can match them.
6. `investigate` saves the user's message **before** emitting `run_started`, so session replay shows it.
7. Next.js only reads `.env` from `apps/web`. Load the repo-root `.env` explicitly (`loadRootEnv()` from `@blastradius/shared/env`) in `next.config.ts` and in **every Node entrypoint**.
8. Check every FalkorDB procedure name, argument shape and YIELD column against https://docs.falkordb.com **and the live container** before building on it.
9. Sub-agents can hit usage limits and stop. **Commit after each working milestone** and keep `docs/progress/<workstream>.md` current (done / in progress / next / blockers), so a resumed agent can continue.

---

## File ownership

A sub-agent edits **only** its own files. Cross-team needs go in `docs/requests/<your-workstream>.md`, addressed to the owner. The lead resolves them in Phase 2. Reading anything is fine.

| Workstream | Owns |
|---|---|
| lead | `packages/shared`, `CLAUDE.md`, `docs/SPEC.md`, root configs (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`), `docs/LEARN.md` |
| graph | `packages/graph`, `docs/CYPHER.md` |
| data | `packages/ingest`, `data/` |
| agents | `packages/agents`, `packages/db` |
| web | `apps/web` |
| platform | `apps/mcp`, `docker-compose.yml`, `.env.example`, `Dockerfile`, `render.yaml`, `.github/`, `README.md`, `docs/ARCHITECTURE.md`, `docs/DEMO.md`, `docs/DEPLOY.md` |

Shared files everyone may append to (never rewrite others' lines): `docs/progress/<you>.md` (yours alone) and `docs/requests/<you>.md` (yours alone).

**Adding a dependency** to your own package's `package.json` is fine. Run `pnpm install` from the repo root. Always `export ONNXRUNTIME_NODE_INSTALL_CUDA=skip` first: otherwise `onnxruntime-node`'s postinstall downloads CUDA libraries for minutes, and we only run CPU inference. If `pnpm-lock.yaml` conflicts, re-run `pnpm install` rather than hand-editing it.

**Git:** several agents commit to the same `main` branch in parallel. Stage **only your own paths** (`git add packages/graph docs/CYPHER.md docs/progress/graph.md`) plus `pnpm-lock.yaml` when you changed deps, and never `git add -A`. Write messages as `feat(graph): …`, `fix(web): …`. If a commit races, run `git pull --rebase` (no remote; just retry) or simply commit again. Never rewrite history and never `--force`.

## Conventions

- **uids:** `uid(label, key)` from shared. Service keys are slugs (`Service:checkout`), PR keys are numbers (`PR:4087`), Person keys are slugified names (`Person:jane-doe`), File keys are repo paths (`File:src/cart/Program.cs`).
- **Times** are stored as **epoch-millisecond integers** in `*At` properties (`mergedAt`, `startedAt`…), except `ON_CALL_FOR.weekStart`, which is an ISO `YYYY-MM-DD` string (the MERGE key) with a sibling `weekStartTs` integer.
- **Synthetic nodes** carry `synthetic: true`. Real ones carry `synthetic: false`.
- **Cypher hygiene:** parameterise every value (`$service`). Only labels and relationship types are interpolated, and only after `assertLabel` / `assertRelType`. Keep queries multi-line with a comment saying what each one answers. Read tools use read-only queries.
- **Tests:** vitest. Unit tests run with no DB (`pnpm test`). Integration tests that need FalkorDB or Postgres live in `*.int.test.ts` and run via `test:integration`.
- **Never fake a result.** If something couldn't be verified, write that in your progress log and report.
