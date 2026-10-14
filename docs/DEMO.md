# Demo script (3 minutes)

The goal is to show **every row of the track table in the README** in three minutes, with nothing faked. Rehearse it with the exact commands below.

> TODO(platform): replace the bracketed placeholders with the real scenario ids, services, PRs and questions from `data/scenarios.json` once the data workstream ships them.

## Before you record

```bash
docker compose up -d
pnpm db:migrate
pnpm graph:load                 # fresh graphs, so recall starts empty
pnpm dev                        # http://localhost:3000
pnpm mcp                        # second terminal: MCP on :3333
claude mcp add --transport http blastradius http://localhost:3333/mcp   # once
```

- Decide on scripted or llm mode and keep it fixed for the take (the badge shows which).
- Configure `GITHUB_TOKEN` + `GITHUB_SANDBOX_REPO` and `WEBHOOK_URL` if you want real actions on camera. Otherwise the action cards say `dry_run`, so say so out loud.
- Open three windows: browser (console), terminal (concurrency, ingest, docker), and Claude Code.

## Script

| Time | Show | Say | Track row |
|---|---|---|---|
| 0:00–0:15 | Console home, tenant `acme`, graph view | "One FalkorDB graph per tenant: real services, files, PRs and authors from the OpenTelemetry demo's git history, plus synthetic teams, incidents, tickets, threads and ADRs, plus all agent memory." | One graph per tenant; company brain in the same graph |
| 0:15–0:50 | Run incident scenario **[scenario id, e.g. `acme-…`]**: alert "[service] [metric]" | Narrate the timeline: triage → blast radius (**[n] services**, ranked by betweenness); investigator → suspect PR **[PR:####]**; expert → **[person]** by PageRank plus on-call | Multi-hop reasoning; algorithms as tools |
| 0:50–1:05 | Click a **Why?** chip | "This is the exact Cypher that ran, its parameters, and the path it returned." | Why? on every claim |
| 1:05–1:15 | Handoff events in the timeline | "Agents don't pass text to each other. Each one writes a Finding with HANDED_TO, and the next one reads it from the graph." | Handoffs through graph state |
| 1:15–1:30 | Action cards: GitHub issue, webhook, rollback PR (open one link) | "Real actions in a sandbox repo, each audit-logged." | Real actions |
| 1:30–1:45 | **Close incident** → start a **new session** on the same service | The "Memory recalled" card shows the incident and runbook the Scribe just wrote, with the connecting path | Procedural memory; recall across sessions |
| 1:45–2:00 | `/memory` (Memory inspector) | Session → Episode chain (episodic), Findings linked to domain nodes (semantic), Incident + Runbook (procedural) | Episodic / semantic / procedural memory; Memory inspector |
| 2:00–2:15 | Claude Code: *"Using blastradius on tenant acme, what breaks if [service] fails and who knows it best?"* | "The same tools over MCP, from any MCP client." | Same tools over MCP |
| 2:15–2:30 | Ask mode: **[ask scenario question, e.g. "why did we move cart to Valkey?"]** | Answer with sources: Decision → Doc, the PR it justified, the incident that followed | Ask the company; decision tracing; who owns/knows X |
| 2:30–2:40 | Terminal: `pnpm concurrency` | "[n] sessions writing memory to one graph at once; every session's episode chain stays intact." | Concurrency script |
| 2:40–2:50 | Terminal: **[incremental re-ingest command, e.g. `pnpm --filter @blastradius/ingest add-prs acme`]**, then rerun suspect changes | "New PRs merged after the snapshot are ingested incrementally and show up as suspects." | Incremental re-ingest |
| 2:50–3:00 | Terminal: `docker compose stop falkordb`, rerun a scenario | Red health banner; the run fails with a FalkorDB error. "No FalkorDB, no product." Then `docker compose start falkordb`. | FalkorDB is central |

## Backup lines

- If llm mode misbehaves, switch to scripted with `AGENT_MODE=scripted`. It runs the same tools with the same Why? evidence.
- If an action fails on camera, the card shows `failed` with the error, and the audit log has the payload.
- After the FalkorDB stop, run `docker compose start falkordb` and wait for `/api/health` to go green before continuing.
