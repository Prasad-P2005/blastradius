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
# Debian slim). The `model` stage bakes Xenova/all-MiniLM-L6-v2 (~90 MB) into
# /opt/hf at build time (apps/mcp/scripts/fetch-model.sh), so containers never
# download it at runtime. Build with `--build-arg FETCH_MODEL=false` to skip
# that and run with EMBEDDINGS=hash instead.
# Never mix backends in one graph: seed and serve with the same EMBEDDINGS
# value, and reload (`pnpm graph:load`, which resets) if you change it.

ARG NODE_VERSION=22
# Keep in sync with "packageManager" in package.json.
ARG PNPM_VERSION=10.33.0
ARG FETCH_MODEL=true

# ── base: node + pnpm ─────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    ONNXRUNTIME_NODE_INSTALL_CUDA=skip
# ONNXRUNTIME_NODE_INSTALL_CUDA=skip: onnxruntime-node's postinstall otherwise
# downloads several hundred MB of CUDA provider libraries on linux/x64. We run on CPU.
# ca-certificates: HTTPS to Hugging Face (model download), GitHub (actions), FalkorDB Cloud (TLS).
# pnpm is installed with npm (which retries downloads) rather than corepack.
ARG PNPM_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --fetch-retries=5 "pnpm@${PNPM_VERSION}" \
 && pnpm --version
WORKDIR /app

# ── model: pre-fetched embedding model (own stage, so it caches independently) ─
FROM base AS model
ARG FETCH_MODEL
COPY apps/mcp/scripts/fetch-model.sh /tmp/fetch-model.sh
RUN mkdir -p /opt/hf \
 && if [ "$FETCH_MODEL" = "true" ]; then HF_CACHE_DIR=/opt/hf sh /tmp/fetch-model.sh; \
    else echo "FETCH_MODEL=$FETCH_MODEL: skipping model download (use EMBEDDINGS=hash)"; fi

# ── deps: install the whole workspace from the lockfile ───────────────────────
# `pnpm fetch` needs only the lockfile, so this layer is cached until deps change.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --offline

# ── mcp: MCP server; also used for one-shot seed/migrate jobs ────────────────
FROM deps AS mcp
COPY --from=model /opt/hf /opt/hf
ENV NODE_ENV=production \
    MCP_PORT=3333 \
    MCP_HOST=0.0.0.0 \
    HF_CACHE_DIR=/opt/hf
EXPOSE 3333
CMD ["pnpm", "--filter", "@blastradius/mcp", "start"]

# ── web-build: next build ────────────────────────────────────────────────────
FROM deps AS web-build
RUN pnpm --filter @blastradius/web build

# ── web: Next.js console (last stage = default target) ───────────────────────
FROM web-build AS web
COPY --from=model /opt/hf /opt/hf
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    HF_CACHE_DIR=/opt/hf
EXPOSE 3000
CMD ["sh", "-c", "pnpm --filter @blastradius/web exec next start -H 0.0.0.0 -p ${PORT:-3000}"]
