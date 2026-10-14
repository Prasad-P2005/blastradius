# Blastradius: technical spec

The vocabulary (labels, relationship types, tool names and input schemas, agents, events, request shapes) is defined in code in `packages/shared/src/index.ts`. This document covers everything else the workstreams must agree on. Where they disagree, **the contract wins**. File a request if it's wrong.

Contents:
1. Graph data model (node properties, relationships, indexes)
2. Snapshot JSON format
3. `@blastradius/graph` public API
4. Tools: semantics of each
5. `@blastradius/agents` and `@blastradius/db` public API, plus the agent pipeline
6. HTTP routes (`apps/web`)
7. MCP server
8. Postgres tables
9. Environment variables
10. Data sources and scenarios
11. Ownership

---

## 1. Graph data model

One FalkorDB graph per tenant: `blastradius_acme`, `blastradius_globex`. Every node has a `uid` (`Label:key`), unique within its graph. Node properties use FalkorDB-native types: string, integer, float, boolean, and arrays of these. Embeddings use `vecf32`. Times are **epoch-ms integers**.

`R` marks real data (from public git history). `S` marks synthetic data (seeded PRNG, `synthetic: true`). `M` marks memory written at runtime.

| Label | Src | uid key | Properties |
|---|---|---|---|
| Service | R (curated) | slug | `name`, `slug`, `language`, `kind` (`service`\|`frontend`\|`datastore`\|`queue`\|`proxy`\|`external`\|`tool`), `repoPath` (e.g. `src/cart`), `description`, `tier` (1 = customer-facing, 2, 3), `synthetic:false` |
| File | R | repo path | `path`, `service` (slug), `language` |
| PR | R | number | `number`, `title`, `sha` (merge/squash commit), `mergedAt`, `additions`, `deletions`, `filesChanged`, `url` (github PR url), `isBot`, `authorName`, `synthetic:false` |
| Person | R (+S for synthetic-only staff, avoid) | slug of name | `name`, `slug`, `isBot`, `prCount`, `firstSeenAt`, `lastSeenAt`, `synthetic`. **No emails, no logins scraped from private sources.** |
| Team | S | slug | `name`, `slug`, `slack` (channel name), `synthetic:true` |
| Issue | S | key e.g. `ACME-142` | `key`, `title`, `body`, `status` (`open`\|`in_progress`\|`done`), `priority` (`P1`..`P4`), `createdAt`, `resolvedAt?`, `synthetic:true`, `embedding` |
| Thread | S | id e.g. `t-0007` | `channel` (e.g. `#cart-team`), `title`, `text` (multi-message transcript, speakers by person name), `createdAt`, `synthetic:true`, `embedding` |
| Decision | S | key e.g. `ADR-007` | `key`, `title`, `status` (`accepted`\|`superseded`\|`proposed`), `context`, `decision`, `consequences`, `decidedAt`, `synthetic:true`, `embedding` |
| Doc | S (may link to real repo docs) | slug | `title`, `kind` (`adr`\|`design`\|`postmortem`\|`howto`\|`readme`), `text`, `url?`, `synthetic`, `embedding` |
| Incident | S (seed) / M (Scribe) | key e.g. `INC-2025-031` or `INC-<session>` | `key`, `title`, `summary`, `rootCause`, `severity` (`SEV1`..`SEV4`), `status` (`resolved`\|`open`), `startedAt`, `resolvedAt`, `sessionId?` (when written by the Scribe), `synthetic`, `embedding` |
| Runbook | S / M | slug | `title`, `steps` (string array), `createdAt`, `sessionId?`, `synthetic` |
| Alert | S / M | id | `title`, `metric`, `value`, `message`, `firedAt`, `synthetic` |
| Session | M | sessionId | `sessionId`, `mode` (`incident`\|`ask`), `question`, `service?` (uid), `startedAt`, `status` (`open`\|`closed`), `agentMode` |
| Episode | M | `<sessionId>:<seq>` | `sessionId`, `seq` (0-based), `agent` (AgentName or `system`), `kind` (`recall`\|`agent_run`\|`action`\|`close`\|`user_message`), `summary`, `at` |
| Finding | M | id | `id`, `sessionId`, `agent`, `kind`, `claim`, `confidence`, `about` (uid[]), `evidence` (uid[]), `cypher` (string[]), `handTo?`, `createdAt`, `embedding` |
| Agent | M (MERGEd) | name | `name`, `title` |

The relationship types and their directions are listed in `REL_TYPES` in the contract, with one comment per type. Edge properties:
- `DEPENDS_ON {protocol, source}`: `source` is the file the dependency was curated from (e.g. `docker-compose.yml`).
- `MODIFIES {additions, deletions}`
- `ON_CALL_FOR {weekStart: 'YYYY-MM-DD' (Monday), weekStartTs}`: **one edge per week**.
- `MENTIONS`, `ABOUT`, `SUPPORTED_BY` and the rest have no properties, unless stated otherwise.

**Derived at load time:** `(pr:PR)-[:TOUCHES]->(s:Service)` for every `PR-MODIFIES->File-PART_OF->Service`. It is derived in Cypher inside `loadSnapshot` and `ingestDelta`, not written by ingest.

### Indexes (created by `ensureSchema(tenant)`, idempotent)

- **Range indexes** on `uid` for **every** label; plus `Service.slug`, `PR.number`, `PR.mergedAt`, `Person.slug`, `Person.isBot`, `Incident.key`, `Decision.key`, `Issue.key`, `Session.sessionId`, `Episode.sessionId`, `Finding.sessionId`, `Finding.id`.
- **Full-text** (`CREATE FULLTEXT INDEX FOR (n:L) ON (n.prop…)`): Service(name, slug, description), PR(title), Person(name), Team(name), Decision(title), Doc(title), Incident(title), Issue(title), Thread(title), Runbook(title).
- **Vector** (`CREATE VECTOR INDEX FOR (n:L) ON (n.embedding) OPTIONS {dimension:384, similarityFunction:'cosine'}`): Incident, Decision, Doc, Issue, Thread, Finding.

`ensureSchema` must tolerate "already indexed" errors, because re-running it is normal.

---

## 2. Snapshot JSON format

`data/acme.json` and `data/globex.json` are written by `packages/ingest` and loaded by `packages/graph`. Their type is `Snapshot` in the contract:

```jsonc
{
  "tenant": "acme",
  "generatedAt": "2025-09-30T12:00:00.000Z", // = newest PR mergedAt; deterministic
  "seed": 1337,
  "sources": [{ "repo": "open-telemetry/opentelemetry-demo", "url": "https://github.com/open-telemetry/opentelemetry-demo", "sha": "<HEAD sha>", "license": "Apache-2.0" }],
  "nodes": [{ "label": "Service", "uid": "Service:checkout", "props": { "name": "checkout", "slug": "checkout", "language": "go", "kind": "service", "tier": 1, "synthetic": false } }],
  "edges": [{ "type": "DEPENDS_ON", "from": "Service:checkout", "to": "Service:cart", "props": { "protocol": "grpc", "source": "src/checkout/main.go" } }]
}
```

Rules:
- `nodes[].label` and `edges[].type` must be in the whitelists. `from` and `to` must reference existing node uids (the validator enforces both).
- **Embeddings are not stored in the snapshot.** `loadSnapshot` computes them.
- No `TOUCHES` edges (they are derived). No email addresses anywhere (the validator scans with a regex).
- The output is deterministic: same source SHAs + seed ⇒ byte-identical file. Sort nodes and edges.

`data/scenarios.json` is `Scenario[]`, covering both tenants and at least 3 per tenant. At least one per tenant must use `mode: "ask"`.

`data/deltas/<tenant>.json` (optional): `{ nodes: SnapshotNode[], edges: SnapshotEdge[] }`, the PRs held back for the "incremental re-ingest" demo. These are real PRs newer than the snapshot cut, applied through `ingestDelta`.

---

## 3. `@blastradius/graph` public API

`packages/graph/src/index.ts` exports exactly the following. Others may import nothing else.

```ts
// connection
getFalkor(): Promise<FalkorDB>                       // singleton from FALKORDB_URL / FALKORDB_PASSWORD
graphFor(tenant: Tenant): Promise<Graph>             // client graph handle for graphName(tenant)
closeFalkor(): Promise<void>
falkorHealth(): Promise<{ ok: boolean; ms?: number; error?: string }>
runCypher(tenant, cypher: string, params?: Record<string, Json>, opts?: { readOnly?: boolean; timeoutMs?: number })
  : Promise<{ rows: Row[]; raw: unknown[]; ms: number }>   // rows = plain JSON via the converter

// schema + embeddings
ensureSchema(tenant: Tenant): Promise<void>
embed(text: string): Promise<number[]>               // length EMBEDDING_DIM, L2-normalised
embedMany(texts: string[]): Promise<number[][]>
embeddingBackend(): Promise<'model' | 'hash'>

// converters (the ONE place FalkorDB values become uids/plain JSON)
toGNode(raw: unknown): GNode
toGEdge(raw: unknown, nodesByInternalId: Map<number, string>): GEdge
toGraphPath(raw: unknown): GraphPath
toPlain(value: unknown): Json

// tools
interface ToolSpec<T extends ToolName = ToolName> {
  name: T; description: string; input: (typeof ToolInputSchemas)[T];
  readOnly: boolean;
  run(ctx: ToolContext, input: ToolInput<T>): Promise<GraphToolResult>;   // validates with input.parse()
}
toolSpecs: { [T in ToolName]: ToolSpec<T> }
runTool(name: ToolName, ctx: ToolContext, rawInput: unknown): Promise<GraphToolResult>
newestPrAt(tenant: Tenant): Promise<number>          // epoch ms of the newest PR (the "now" for suspect_changes)

// memory
startSession(tenant, { sessionId?: string; mode: InvestigationMode; question: string; service?: string; agentMode: AgentMode })
  : Promise<{ sessionId: string; uid: string; created: boolean }>
recordEpisode(tenant, { sessionId: string; agent: AgentName | 'system'; kind: string; summary: string })
  : Promise<{ uid: string; seq: number }>
recordFinding(ctx: ToolContext & { sessionId: string; agent: AgentName }, input: ToolInput<'record_finding'>)
  : Promise<{ finding: Finding; result: GraphToolResult }>
readHandoffs(ctx): Promise<GraphToolResult>                       // = runTool('read_handoffs')
recallMemory(ctx, input): Promise<{ memories: RecalledMemory[]; result: GraphToolResult }>
getFindings(tenant, sessionId: string): Promise<Finding[]>
closeIncident(req: CloseIncidentRequest): Promise<CloseIncidentResult>
listGraphSessions(tenant, limit?: number): Promise<SessionSummary[]>

// UI reads (all ids are uids)
overview(tenant): Promise<Subgraph>                  // all Services + DEPENDS_ON + Teams/OWNS
neighborhood(tenant, uid: string, opts?: { limit?: number }): Promise<Subgraph>
counts(tenant): Promise<{ labels: Partial<Record<NodeLabel, number>>; rels: Partial<Record<RelType, number>> }>
memoryInspector(tenant, sessionId?: string): Promise<MemoryInspectorData>

// loading
loadSnapshot(tenant, snap: Snapshot, opts?: { reset?: boolean; embed?: boolean })
  : Promise<{ nodes: number; edges: number; touches: number; embedded: number; ms: number }>
ingestDelta(tenant, nodes: SnapshotNode[], edges: SnapshotEdge[])
  : Promise<{ nodes: number; edges: number; touches: number; embedded: number; ms: number }>
resetGraph(tenant): Promise<void>
```

Behaviour:
- `runTool` injects `ctx.tenant`. Memory tools require `ctx.sessionId` and `ctx.agent`, and throw a clear error if they're missing.
- Every tool returns `GraphToolResult` with `cypher` **exactly** as sent, the `params`, plain-JSON `rows`, and `paths` built from `MATCH p = …` (or `shortestPath` in `WITH`).
- `recall_memory` **excludes the current session** (`ctx.sessionId`).
- If FalkorDB is down, the functions **throw**. Callers surface that as an error event. There is no silent fallback.

---

## 4. Tools: semantics

Inputs are listed in `ToolInputSchemas`. Every row is plain JSON. Node references in rows are uids, plus a display `name` where useful.

| Tool | Algorithm / feature | Rows (minimum columns) | Paths |
|---|---|---|---|
| `blast_radius` | variable-length `DEPENDS_ON*1..maxHops` + `algo.betweenness` | `service, name, hops, betweenness, tier, team` sorted by betweenness desc, then hops | one `DEPENDS_ON` path per affected service |
| `critical_services` | `algo.betweenness` on Service/DEPENDS_ON | `service, name, betweenness, dependents, dependencies` | — |
| `suspect_changes` | time window from `newestPrAt`, `TOUCHES` + `DEPENDS_ON*0..maxHops` | `pr, number, title, mergedAt, author, isBot, service, hops, files, additions, deletions, url` newest first, humans first unless includeBots | `Person-AUTHORED->PR-TOUCHES->Service(<-DEPENDS_ON-…alert service)` |
| `who_knows` | `algo.pageRank` over Person/PR authorship. Score = pageRank × activity on the service; bots excluded unless `includeBots` (then ×0.1) | `person, name, score, prs, team, onCall, lastActiveAt` | `Person-AUTHORED->PR-TOUCHES->Service` (best PR) |
| `on_call` | `ON_CALL_FOR {weekStart}` ≤ `at`, latest | `person, name, weekStart, team, service` | `Person-ON_CALL_FOR->Service` |
| `service_context` | 1-hop expansion | one row: `service, team, owners[], dependsOn[], dependents[], runbooks[], docs[], recentIncidents[], decisions[]` | the 1-hop edges |
| `past_incidents` | `AFFECTED` (+ `DEPENDS_ON` neighbours) → `CAUSED_BY`, `RESOLVED_BY` | `incident, title, severity, startedAt, service, causedBy, runbook, runbookSteps[], responders[], synthetic, sessionId` | `Incident-AFFECTED->Service`, `Incident-CAUSED_BY->PR`, `Incident-RESOLVED_BY->Runbook` |
| `similar_incidents` | **vector index** on Incident, then expansion **in the same query** | `incident, title, similarity (converted), distance, service, causedBy, runbook, responders[]` | `Incident-CAUSED_BY->PR`, `-RESOLVED_BY->Runbook` |
| `decision_trace` | vector/full-text to a Decision, then `Doc<-DOCUMENTED_IN-Decision-JUSTIFIES->PR<-CAUSED_BY-Incident` | `decision, title, status, decidedAt, doc, prs[], incidents[], decidedBy[], services[]` | the trace chain |
| `explain_path` | `shortestPath` (in WITH) | `hops, nodes[]` | the path |
| `search_nodes` | full-text indexes | `uid, label, name, score` | — |
| `failure_communities` | `algo.labelPropagation` or `algo.WCC` on Service/DEPENDS_ON | `community, services[], size` | — |
| `ask_company` | **vector index** across the labels in `EMBEDDED_LABELS` (except Finding), top-k overall, then a 1–2 hop expansion to owners/PRs/decisions/docs/services | `source, label, title, similarity, snippet, related[] ({uid,label,name,rel})` | `hit-[ABOUT|JUSTIFIES|MENTIONS|DOCUMENTED_IN|DECIDED_BY]-…` |
| `recall_memory` | Findings from other sessions ABOUT the service (or vector-similar to `text`), plus resolved Incidents on the service with runbooks | `kind, uid, title, summary, sessionId, agent, runbook, similarity` | path from the current service to each memory |
| `read_handoffs` | `(f:Finding {sessionId})-[:HANDED_TO]->(:Agent {name})` | `finding, from, claim, confidence, about[], evidence[], cypher[]` | — |
| `record_finding` | write: `Finding` + `WROTE`/`ABOUT`/`SUPPORTED_BY`/`HANDED_TO`, `PRODUCED` from the latest Episode | `finding` (the Finding object) | — |

---

## 5. Agents (`@blastradius/agents`) and db (`@blastradius/db`)

### `@blastradius/agents` exports

```ts
investigate(req: InvestigateRequest, opts?: { signal?: AbortSignal }): AsyncIterable<AgentEvent>
closeIncident(req: CloseIncidentRequest): Promise<CloseIncidentResult>   // graph.closeIncident + audit + episode
resolveAgentMode(override?: AgentMode): { mode: AgentMode; model?: string }
loadScenarios(tenant?: Tenant): Promise<Scenario[]>                       // reads data/scenarios.json
listActions(tenant, sessionId?): Promise<ActionRecord[]>
getHealth(): Promise<HealthStatus>
```

### `@blastradius/db` exports

```ts
getDb(): Db | null              // null if DATABASE_URL unset; all helpers are no-ops then
schema                          // drizzle tables
pgHealth(): Promise<{ ok; ms?; error? }>
ensureTenant, createSession, touchSession, listSessions(tenant), getSession(id),
addMessage({ sessionId, role, content, runId? }), listMessages(sessionId),
startRun(...), finishRun(...), appendEvent(event: AgentEvent), listEvents({ sessionId? , runId? }),
recordAction(a: ActionRecord), listActions(tenant, sessionId?),
startIngestJob(...), finishIngestJob(...)
```

Every db helper is **best-effort**: it catches, logs, and returns null or an empty result. The agent pipeline never fails because Postgres failed.

### Pipeline (`investigate`)

```
request ─► save user message (pg) ─► startSession (graph) ─► emit run_started
  incident mode:
    recall_memory (system) ─► emit memory_recalled ─► Episode(kind=recall)
    triage        : blast_radius, critical_services/failure_communities, on_call   → findings(kind=impact), handTo investigator
    investigator  : read_handoffs, suspect_changes, similar_incidents/past_incidents → findings(kind=cause|precedent), handTo expert
    expert        : read_handoffs, who_knows, on_call                               → findings(kind=expert), handTo scribe
    actions       : github_issue, webhook, rollback_pr (dry_run if unconfigured)    → emit action, Episode(kind=action)
    scribe        : read_handoffs, summarise                                         → finding(kind=summary), agent_message with claims
  ask mode:
    navigator     : ask_company, decision_trace, who_knows …                         → finding(kind=answer), agent_message with claims
  ─► emit run_finished
```

- Each agent is an AI SDK `generateText`/`streamText` tool loop with **only its allowed tools** (`AGENT_TOOLS`), `stopWhen: stepCountIs(MAX_AGENT_STEPS)`.
- Code injects `tenant`, `sessionId` and `agent`. Tool schemas given to the model omit them.
- The model sees at most `MODEL_ROW_CAP` rows per result. The `tool_result` event carries the full result.
- Each agent start writes an Episode (`recordEpisode`). Its findings link from that Episode (`PRODUCED`).
- **Handoffs only through the graph:** agent N+1 starts by calling `read_handoffs`. Its prompt does not include agent N's text.
- `agent_message.claims[].findingIds` point at findings whose `cypher[]` came from real tool results. That is what powers the Why? chips.
- **Scripted mode** runs the same tools in a fixed order, with inputs derived from the request (alert service; extracted from the message with `search_nodes` otherwise), and templates claims from the rows. It is deterministic.
- Every event is appended to Postgres (best-effort). A graph error emits `error {where:'falkordb', fatal:true}`, then `run_finished {status:'error'}`.
- The abort signal (client disconnect) stops the loop at the next step boundary and emits `run_finished {status:'aborted'}`.

### Actions

| Kind | Real when | What it does | Dry run |
|---|---|---|---|
| `github_issue` | `GITHUB_TOKEN` + `GITHUB_SANDBOX_REPO` | `POST /repos/{repo}/issues`; body = findings with Why? Cypher | payload recorded, `status:'dry_run'` |
| `rollback_pr` | same | create branch `rollback/<incident>` from the default branch, commit `rollbacks/<incident>.md` (the `git revert <sha>` plan for the suspect PR, with blast radius and owners), open a PR | same |
| `webhook` | `WEBHOOK_URL` | Slack (`{text}`) or Discord (`{content}`) message | same |

All actions are written to the `actions` table and emitted as `action` events.

---

## 6. HTTP routes (`apps/web`, Next.js route handlers, `runtime = 'nodejs'`)

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/health` | — | `HealthStatus` |
| GET | `/api/tenants` | — | `{ id, name, description, sourceRepo, counts }[]` |
| GET | `/api/scenarios` | `?tenant=` | `Scenario[]` |
| GET | `/api/sessions` | `?tenant=` | `SessionSummary[]` (graph) merged with pg titles |
| POST | `/api/sessions` | `{ tenant }` | `{ sessionId }` |
| GET | `/api/sessions/[id]/messages` | — | `{ messages, events: AgentEvent[] }` for replay |
| POST | `/api/investigate` | `InvestigateRequest` | `text/event-stream`: `data: <AgentEvent JSON>\n\n` per event; `: ping\n\n` every 15 s; aborts on client disconnect |
| POST | `/api/incidents/close` | `CloseIncidentRequest` | `CloseIncidentResult` |
| GET | `/api/graph/overview` | `?tenant=` | `Subgraph` |
| GET | `/api/graph/neighborhood` | `?tenant=&uid=&limit=` | `Subgraph` |
| GET | `/api/actions` | `?tenant=&sessionId=` | `ActionRecord[]` |
| GET | `/api/memory` | `?tenant=&sessionId=` | `MemoryInspectorData` |

Pages: `/` (console), `/memory` (Memory inspector). Errors return `{ error: string }` with a 4xx or 5xx status. When FalkorDB is down, `/api/health` shows `falkordb.ok=false` and the UI shows a red banner.

---

## 7. MCP server (`apps/mcp`)

- It is the same `toolSpecs` registry from `@blastradius/graph`. Every tool's `inputSchema` = `{ tenant: z.enum(TENANTS), ...ToolInputSchemas[t].shape }`.
- Transports: stdio (`pnpm mcp -- --stdio`, or `pnpm --filter @blastradius/mcp stdio`) and Streamable HTTP `POST/GET/DELETE :${MCP_PORT}/mcp`, plus `GET /health`.
- Tool results come back as `content: [{type:'text', text: JSON.stringify(GraphToolResult)}]` and `structuredContent`.
- Resources: `blastradius://tenants` and `blastradius://schema` (labels, relationship types with directions, indexes).
- Write tools (`record_finding`) are registered only when `MCP_ALLOW_WRITES=true`. Memory tools over MCP need `sessionId` and `agent` in the input. The MCP server adds those optional fields to their shape.
- The agents' `AGENT_TOOL_TRANSPORT=mcp` mode uses `@modelcontextprotocol/sdk` Client + `StreamableHTTPClientTransport` to `MCP_URL` and parses `structuredContent` back into `GraphToolResult`.

---

## 8. Postgres tables (Drizzle, `packages/db`)

| Table | Columns |
|---|---|
| `tenants` | `id text pk`, `name text`, `created_at timestamptz default now()` |
| `sessions` | `id text pk`, `tenant text`, `mode text`, `title text`, `status text default 'open'`, `created_at`, `updated_at` |
| `messages` | `id bigserial pk`, `session_id text`, `role text` (`user`\|`assistant`\|`system`), `content text`, `run_id text null`, `created_at` |
| `agent_runs` | `id text pk`, `session_id`, `tenant`, `mode`, `agent_mode`, `model text null`, `status text` (`running`\|`ok`\|`error`\|`aborted`), `started_at`, `finished_at null`, `error text null` |
| `agent_events` | `id bigserial pk`, `run_id`, `session_id`, `seq int`, `type text`, `payload jsonb`, `created_at`; unique (`run_id`, `seq`); index (`session_id`, `id`) |
| `actions` | `id text pk`, `session_id`, `run_id null`, `tenant`, `kind`, `status`, `title`, `url null`, `payload jsonb`, `error null`, `finding_ids jsonb`, `created_at` |
| `ingest_jobs` | `id bigserial pk`, `tenant`, `kind` (`snapshot`\|`delta`), `status` (`running`\|`ok`\|`error`), `stats jsonb`, `error null`, `started_at`, `finished_at null` |

The migration is generated by `drizzle-kit generate` into `packages/db/drizzle/` and committed. It is applied by `pnpm db:migrate` (`packages/db/src/migrate.ts`, using drizzle's `migrate()`).

---

## 9. Environment variables

See `.env.example` (the platform workstream owns it). It is loaded from the repo root by `loadRootEnv()`.

| Var | Default | Used by |
|---|---|---|
| `FALKORDB_URL` | `redis://localhost:6380` | graph |
| `FALKORDB_PASSWORD` | — | graph |
| `DATABASE_URL` | `postgres://blast:blast@localhost:5434/blastradius` | db |
| `AGENT_MODE` | `auto` | agents |
| `LLM_PROVIDER` / `LLM_MODEL` | `anthropic` / `claude-sonnet-5-5` | agents |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | — | agents |
| `AGENT_TOOL_TRANSPORT` / `MCP_URL` | `direct` / `http://localhost:3333/mcp` | agents |
| `MCP_PORT` / `MCP_ALLOW_WRITES` | `3333` / `false` | mcp |
| `EMBEDDINGS` / `HF_CACHE_DIR` | `model` / `.cache/hf` | graph |
| `GITHUB_TOKEN`, `GITHUB_SANDBOX_REPO` | — | agents (actions) |
| `WEBHOOK_URL`, `WEBHOOK_KIND` | — / `slack` | agents (actions) |

---

## 10. Data sources and scenarios

| Tenant | Repo | License | Notes |
|---|---|---|---|
| acme | https://github.com/open-telemetry/opentelemetry-demo | Apache-2.0 | `src/<service>/` layout; many human PRs; services: frontend, checkout, cart (→ valkey-cart), payment, shipping, quote, currency, email, ad, recommendation, product-catalog, fraud-detection, accounting, kafka, flagd, load-generator, frontend-proxy, image-provider, product-reviews… (verify against the clone) |
| globex | https://github.com/GoogleCloudPlatform/microservices-demo | Apache-2.0 | `src/<service>/` layout; recent history is mostly bots (renovate), so **look further back** for human PRs |

Repos are cloned into `.cache/repos/<owner>__<repo>` (gitignored). Each snapshot records the HEAD sha.

**Scenario quality bar:** for each incident scenario, running the scripted pipeline must produce:
(a) a blast radius of ≥2 services,
(b) `expected.suspectPr` (a **human** PR) in the top 3 of `suspect_changes` with **default args**,
(c) a human expert in the top 3 of `who_knows`,
(d) at least one past incident or runbook from `past_incidents` / `similar_incidents`.

For each ask scenario, `ask_company` must return the intended Decision/Thread/Doc in its top 3.

The data workstream verifies all of this against the loaded graph and records the results in `data/README.md`.

---

## 11. Ownership

See the table in `CLAUDE.md`. Summary: lead → shared/CLAUDE/SPEC/root configs; graph → `packages/graph`, `docs/CYPHER.md`; data → `packages/ingest`, `data/`; agents → `packages/agents`, `packages/db`; web → `apps/web`; platform → `apps/mcp`, infra, CI, README and the other docs.
