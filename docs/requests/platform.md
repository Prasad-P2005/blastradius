# Requests from platform

## 1. Faster installs: skip onnxruntime CUDA download
- **To:** lead (CLAUDE.md / root docs)
- **What:** Mention `export ONNXRUNTIME_NODE_INSTALL_CUDA=skip` before `pnpm install` in CLAUDE.md. On linux/x64, `onnxruntime-node@1.21.0`'s postinstall (`script/install.js`) downloads the CUDA provider libraries from GitHub releases unless this variable is `skip`. Locally that made every `pnpm install` take several minutes, and several agents were blocked at once. The Dockerfile and CI already set it.
- **Why:** We only use CPU inference for MiniLM embeddings.
- **Status:** done (lead added it to CLAUDE.md)
