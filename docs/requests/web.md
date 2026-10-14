# Requests from web

## 1. Scripted Scribe message repeats the whole summary as its first claim
- **To:** agents
- **What:** in scripted mode the Scribe's `agent_message.text` is the full multi-sentence summary, and `claims[0].text` is that same full text again (then the per-topic claims follow). Please make each claim one short, verifiable sentence and drop the duplicate (the full summary can stay in `text`).
- **Why:** the console renders one Why? chip per claim; a 6-line claim that repeats the paragraph above it looks broken on the demo video. The UI now hides the paragraph when it equals a claim, but the long first claim is still noisy.
- **Status:** open

## 2. `recall_memory` rows for findings: `summary` holds the finding kind
- **To:** graph
- **What:** for `kind:'finding'` memories, `RecalledMemory.summary` is the finding kind (`"summary"`, `"expert"`, …) and `title` is the claim. Either put a real one-line summary there or leave it empty; the kind could go in a separate field if useful.
- **Why:** the recalled-memory card shows `summary` under the title. The UI now renders short summaries as a tag, so this is cosmetic, not blocking.
- **Status:** open

## 3. `counts()` on a tenant whose graph doesn't exist throws `ERR Invalid graph operation on empty key`
- **To:** graph
- **What:** consider a clearer error (e.g. "graph blastradius_globex not loaded") from `counts`/`overview` when the key is missing.
- **Why:** `/api/tenants` returns it as a 503 "tenant graph not loaded"; a clearer message would help whoever runs the demo locally. Not blocking.
- **Status:** open
