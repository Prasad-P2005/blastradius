#!/bin/sh
# Pre-fetch the embedding model (Xenova/all-MiniLM-L6-v2, fp32 ONNX, ~90 MB)
# into the transformers.js cache, so the first `pnpm graph:load` does not
# depend on transformers.js's own download (which has failed on slow links).
#
#   pnpm --filter @blastradius/mcp fetch-model          # from anywhere in the repo
#   HF_CACHE_DIR=/opt/hf sh apps/mcp/scripts/fetch-model.sh
#
# Layout matches what packages/graph/src/embed.ts reads (tf.env.cacheDir):
#   $HF_CACHE_DIR/Xenova/all-MiniLM-L6-v2/{config.json,tokenizer.json,tokenizer_config.json,onnx/model.onnx}
# HF_CACHE_DIR defaults to .cache/hf; a relative path is resolved against the repo root.
# Files that already exist (non-empty) are skipped. Exits non-zero if any download fails.
set -eu

MODEL="Xenova/all-MiniLM-L6-v2"
BASE="https://huggingface.co/${MODEL}/resolve/main"

# Repo root = nearest ancestor with pnpm-workspace.yaml (this script lives in apps/mcp/scripts).
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="${HF_CACHE_DIR:-.cache/hf}"
case "$DIR" in
  /*) ;;
  *) DIR="$ROOT/$DIR" ;;
esac
DEST="$DIR/$MODEL"
mkdir -p "$DEST/onnx"

for f in config.json tokenizer.json tokenizer_config.json onnx/model.onnx; do
  if [ -s "$DEST/$f" ]; then
    echo "fetch-model: have $f"
    continue
  fi
  echo "fetch-model: downloading $f"
  curl -fL --retry 5 --retry-delay 3 --retry-all-errors -o "$DEST/$f.part" "$BASE/$f"
  mv "$DEST/$f.part" "$DEST/$f"
done
echo "fetch-model: model ready in $DEST"
