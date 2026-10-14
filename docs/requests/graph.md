# Requests from the graph workstream

## 1. Facts for CLAUDE.md (verified on FalkorDB 6.0.2)
**To:** lead  **Status:** open
**What:** consider adding to "FalkorDB facts":
- `CALL { … UNION ALL … }` subqueries work, including one `db.idx.vector.queryNodes` / `db.idx.fulltext.queryNodes` per label in a single query (used by ask_company, search_nodes, recall_memory).
- Multi-property full-text indexes work: `CREATE FULLTEXT INDEX FOR (n:Service) ON (n.name, n.slug, n.description)`.
- **Bug:** a pattern comprehension that binds a relationship variable (`[(s)-[d:DEPENDS_ON]->(x) | d.protocol]`) makes LATER pattern comprehensions in the same RETURN return `[]`. Collect edge properties with OPTIONAL MATCH + collect instead.
- `algo.pageRank` is directed; on Person-AUTHORED->PR alone every Person gets the same score, so `who_knows` runs PageRank over the whole graph (`null, null`) and multiplies by authorship activity (documented in docs/CYPHER.md and tools/people.ts).
- The falkordb client inlines params into the query text (`CYPHER k=v …`); vectors are rounded to 6 decimals to avoid exponent notation.
**Why:** so other agents don't rediscover them.

## 2. Embedding model download
**To:** platform (README / Dockerfile)  **Status:** open
**What:** transformers.js's own download of `Xenova/all-MiniLM-L6-v2/onnx/model.onnx` (90 MB) failed here with "terminated" after ~3 min. Fetching it with
`curl -L -o .cache/hf/Xenova/all-MiniLM-L6-v2/onnx/model.onnx https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx`
fixed it (the tokenizer/config files had already been cached by the library). A setup step / Docker build step that pre-fetches the model would make first runs reliable. Without it, embeddings silently fall back to `hash` (a console warning is printed; `embeddingBackend()` reports it).
**Why:** a graph loaded with hash vectors cannot be queried with model vectors (and vice versa): never mix backends in one graph.

## 3. Snapshot expectations
**To:** data  **Status:** open (FYI)
**What:** `loadSnapshot` requires: property keys matching `^[A-Za-z_][A-Za-z0-9_]*$`; every `ON_CALL_FOR` edge with a `weekStart` (YYYY-MM-DD) prop; edge endpoints as valid uids (`Label:key`) — the label prefix is used to pick the index. Null props are dropped. TOUCHES edges in the snapshot are ignored (derived). Load with `loadSnapshot(tenant, snap, { reset: true })`; it computes embeddings itself.

## 4. API notes (no signature changes)
**To:** agents, platform (MCP), web  **Status:** FYI
- `recall_memory` needs neither `ctx.agent` nor (strictly) `ctx.sessionId`; without a session nothing is excluded. `read_handoffs` and `record_finding` throw if `ctx.sessionId` / `ctx.agent` are missing.
- `GraphToolResult.params.vec` is reported as `"<384-dim embedding of $text>"`; the real vector was sent. `$text` is in params.
- Extra type exports beyond SPEC §3: `ToolSpec` (type) and `LoadStats` (type).
