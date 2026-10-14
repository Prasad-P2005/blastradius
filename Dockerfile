# syntax=docker/dockerfile:1.7
#
# Multi-stage image for the Blastradius pnpm monorepo.
#
# Packages are consumed as TypeScript source (no build step), so the runtime
# keeps the full workspace + node_modules and runs scripts with `tsx`. Only the
# Next.js app has a real build (`next build`).
#
# Targets:
#   docker build --target mcp -t blastradius-mcp .   # MCP server (+ seed/migrate scripts)
#   docker build --target web -t blastradius-web .   # Next.js console (default/last stage)
#
# Embeddings: @huggingface/transformers runs onnxruntime-node (glibc, works on
# Debian slim). The model (~90 MB) downloads on first use into HF_CACHE_DIR;
# mount a volume there to keep it. If the model can't run or download in your
# environment, set EMBEDDINGS=hash (deterministic fallback, no network).

ARG NODE_VERSION=22

# ── base: node + pnpm via corepack ────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    ONNXRUNTIME_NODE_INSTALL_CUDA=skip
# ONNXRUNTIME_NODE_INSTALL_CUDA=skip: onnxruntime-node's postinstall otherwise
# downloads several hundred MB of CUDA provider libraries on linux/x64. We run on CPU.
# ca-certificates: HTTPS to Hugging Face (model download), GitHub (actions), FalkorDB Cloud (TLS).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /app

# ── deps: install the whole workspace from the lockfile ───────────────────────
# `pnpm fetch` needs only the lockfile, so this layer is cached until deps change.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --offline

# ── mcp: MCP server; also used for one-shot seed/migrate jobs ────────────────
FROM deps AS mcp
ENV NODE_ENV=production \
    MCP_PORT=3333 \
    MCP_HOST=0.0.0.0 \
    HF_CACHE_DIR=/app/.cache/hf
EXPOSE 3333
CMD ["pnpm", "--filter", "@blastradius/mcp", "start"]

# ── web-build: next build ────────────────────────────────────────────────────
FROM deps AS web-build
RUN pnpm --filter @blastradius/web build

# ── web: Next.js console (last stage = default target) ───────────────────────
FROM web-build AS web
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    HF_CACHE_DIR=/app/.cache/hf
EXPOSE 3000
CMD ["sh", "-c", "pnpm --filter @blastradius/web exec next start -H 0.0.0.0 -p ${PORT:-3000}"]
