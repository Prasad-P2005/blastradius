# Demo script (3 minutes)

The goal is to show **every row of the track table in the README** in three minutes, with nothing faked. All ids below come from `data/scenarios.json`. Expected values are what `pnpm --filter @blastradius/agents scenarios` and `pnpm smoke` check against the loaded graph.

## Before you record

```bash
docker compose up -d
pnpm --filter @blastradius/mcp fetch-model   # once; or use EMBEDDINGS=hash for both load and serve
pnpm db:migrate
pnpm graph:load                 # RESETS both tenant graphs: no memory, no applied deltas
pnpm dev                        # terminal 1: http://localhost:3000
pnpm mcp                        # terminal 2: MCP on http://localhost:3333/mcp
claude mcp add --transport http blastradius http://localhost:3333/mcp   # once
```

- Run `pnpm graph:load` right before every take. The demo depends on a clean graph: no earlier sessions for recall, and the `add-prs` delta not yet applied.
- Pick scripted or llm mode and keep it fixed for the take (the badge in the top bar shows which). Scripted mode is deterministic.
- For real actions on camera, set `GITHUB_TOKEN` + `GITHUB_SANDBOX_REPO` and `WEBHOOK_URL`. Without them, the action cards show `dry_run` with the payload; say that out loud rather than implying they were sent.
- Windows: browser (console), a terminal, and Claude Code.

## Script

| Time | Show | Say | Track row |
|---|---|---|---|
| 0:00–0:15 | Console, tenant **acme**, graph view | "One FalkorDB graph per tenant: real services, files, PRs and authors from the OpenTelemetry demo's git history, synthetic teams, incidents, tickets, threads and ADRs on top, and all agent memory in the same graph." | One graph per tenant; company brain in the same graph |
| 0:15–0:50 | **Scenarios → "Checkout 5xx at 12%"** (`acme-checkout-5xx`, alert "checkout PlaceOrder 5xx at 12% since 14:05") | Narrate the timeline. Triage: blast radius of **6 services** (frontend → frontend-proxy → load-generator, react-native-app, agent, mcp), ranked by betweenness. Investigator: top suspect **PR #4059** "chore: regenerate lock files - fix vulns", which touched payment, email and shipping, all checkout dependencies. Expert: **Piotr Kiełkowicz** (a real contributor, ranked by PageRank over his real authorship), plus this week's on-call (a fictional persona). | Multi-hop reasoning; algorithms as tools |
| 0:50–1:05 | Click a **Why?** chip | "This is the exact Cypher that ran, its parameters, and the graph path it returned. The finding stores that string verbatim." | Why? on every claim |
| 1:05–1:15 | Handoff events in the timeline | "Agents don't pass text to each other. Each one writes a Finding with HANDED_TO, and the next one starts by reading it from the graph." | Handoffs through graph state |
| 1:15–1:30 | **Actions**: GitHub issue, webhook, rollback PR (open one link if real) | "Real actions against a sandbox repo, each one audit-logged." | Real actions |
| 1:30–1:45 | **Close incident** (dialog prefilled from the findings) → run the same scenario again | The new run opens with **Recalled memory**: the Incident and Runbook the Scribe just wrote, next to the seeded **INC-2026-037** ("checkout OOM-killed after OTLP exporter migration…"), each with the path to checkout | Procedural memory; recall across sessions |
| 1:45–2:00 | **Memory inspector** (`/memory`) | Session → Episode chain (episodic), Findings linked to services and PRs (semantic), Incident + Runbook (procedural) | Episodic / semantic / procedural memory; Memory inspector |
| 2:00–2:10 | **`/people`**: open the on-call persona for checkout | Their live activity feed now includes the finding the agents just recorded that names them, next to their posted threads and on-call weeks. "Real contributors only carry real facts, their PRs. Fictional people-content belongs to personas." **TODO(platform): `/people` and personas are not built yet; verify this beat before recording.** | Who owns/knows X; memory linked to people |
| 2:10–2:22 | Claude Code: *"Use the blastradius tools on tenant acme: what breaks if checkout fails, and who knows checkout best?"* | "The same tool registry over MCP, usable from any MCP client." | Same tools over MCP |
| 2:22–2:35 | Ask mode: **"Why did we move the cart cache from Redis to Valkey?"** (`acme-ask-valkey`) | The answer cites **ADR-001** "Move the cart store from Redis to Valkey", its doc, the real PR #1619 it justifies, and the team thread `t-0001`. Then ask who knows cart. | Ask the company; decision tracing; who owns/knows X |
| 2:35–2:42 | Terminal: `pnpm concurrency` | "10 investigations at once across both tenants, two of them sharing one session. Afterwards it checks that every episode chain is intact and nothing leaked across tenants." (It runs in its own `concurrency_…` graphs.) | Concurrency script |
| 2:42–2:53 | Run **"Cart errors (try add-prs after)"** (`acme-cart-errors`): top suspect **PR #3988**. Then in the terminal: `pnpm --filter @blastradius/ingest add-prs --tenant acme`, and run it again | "New real PRs merged after the snapshot are ingested incrementally, with no reload." The new top suspect is **PR #4087** (a new cart demo flag in ValkeyCartStore). | Incremental re-ingest |
| 2:53–3:00 | Terminal: `docker compose stop falkordb`, run any scenario | Red health banner; the run ends with a FalkorDB error. "No FalkorDB, no product." Afterwards: `docker compose start falkordb`. | FalkorDB is central |

## Backup lines

- If llm mode misbehaves, restart with `AGENT_MODE=scripted`. It runs the same tools with the same Why? evidence.
- If an action fails on camera, its card shows `failed` with the error, and the audit log keeps the payload.
- After the FalkorDB stop, run `docker compose start falkordb` and wait for the health dots to turn green before continuing.
- Fixture replay without any backend: open `http://localhost:3000/?fixture=1` (dev server only, or set `NEXT_PUBLIC_ENABLE_FIXTURES=1`). This is a recording, so don't present it as live.

## Other scenarios

| id | Tenant | Mode | Prompt |
|---|---|---|---|
| `acme-payment-failures` | acme | incident | payment Charge failing for 8% of orders since 09:40 |
| `acme-product-catalog-latency` | acme | incident | product-catalog p99 latency at 1.8s, home page slow |
| `acme-ask-locust` | acme | ask | Why did we go back to Locust instead of k6 for load generation? |
| `globex-ad-errors` | globex | incident | adservice GetAds error rate 15% since 10:20, no ads on product pages |
| `globex-assistant-timeouts` | globex | incident | shopping assistant returning 504s for 30% of requests |
| `globex-catalog-errors` | globex | incident | productcatalogservice ListProducts failing at 9%, home page partially empty |
| `globex-ask-assistant` | globex | ask | Who knows the shopping assistant and why does it need AlloyDB? |
| `globex-ask-cart-backends` | globex | ask | Why does cartservice support Spanner and AlloyDB if Redis is the default? |

globex scenarios hold on the snapshot only. Its delta moves the "recent" window by six weeks, so don't run `add-prs --tenant globex` before demoing them (see `data/README.md`).
