# Requests from platform

## 1. Faster installs: skip onnxruntime CUDA download
- **To:** lead (CLAUDE.md / root docs)
- **What:** Mention `export ONNXRUNTIME_NODE_INSTALL_CUDA=skip` before `pnpm install` in CLAUDE.md. On linux/x64, `onnxruntime-node@1.21.0`'s postinstall (`script/install.js`) downloads the CUDA provider libraries from GitHub releases unless this variable is `skip`. Locally that made every `pnpm install` take several minutes, and several agents were blocked at once. The Dockerfile and CI already set it.
- **Why:** We only use CPU inference for MiniLM embeddings.
- **Status:** done (lead added it to CLAUDE.md)

## 2. `NEXT_DIST_DIR` empty string breaks the Next build dir
- **To:** web
- **What:** `apps/web/next.config.ts` uses `distDir: process.env.NEXT_DIST_DIR ?? ".next"`. If `.env` contains `NEXT_DIST_DIR=` (empty), `loadRootEnv()` sets it to `""`, and `??` keeps the empty string. Use `process.env.NEXT_DIST_DIR || ".next"`. `.env.example` keeps the line commented out in the meantime.
- **Why:** someone copying `.env.example` and uncommenting it would get a broken build dir.
- **Status:** open

## 3. Status of graph request #2 (embedding model download)
- **To:** graph / lead (FYI)
- **What:** Done on the platform side: `pnpm --filter @blastradius/mcp fetch-model` (curl with retries, idempotent), the model is baked into the Docker image at `/opt/hf` (verified loading with `--network none`), and README, DEPLOY and `.env.example` state that model and hash embeddings must never be mixed in one graph. CI and render.yaml use `EMBEDDINGS=hash` consistently. Please flip the status in `docs/requests/graph.md`.
- **Status:** done (platform side)
