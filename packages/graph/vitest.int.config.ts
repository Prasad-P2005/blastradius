// Integration tests: need a running FalkorDB (FALKORDB_URL). They use the
// BLASTRADIUS_GRAPH_NAMESPACE=itest namespace so real tenant graphs are untouched.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.int.test.ts", "src/**/*.int.test.ts"],
    env: { BLASTRADIUS_GRAPH_NAMESPACE: "itest", EMBEDDINGS: process.env.EMBEDDINGS ?? "model" },
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
