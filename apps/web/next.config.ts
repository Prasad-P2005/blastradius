import type { NextConfig } from "next";
import { loadRootEnv } from "@blastradius/shared/env";

// Lesson 7: Next only reads apps/web/.env. Load the repo-root .env so the
// route handlers see FALKORDB_URL, DATABASE_URL, AGENT_MODE, keys, etc.
loadRootEnv();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: ["@blastradius/shared", "@blastradius/graph", "@blastradius/agents", "@blastradius/db"],
  // Native / heavy deps stay as runtime requires instead of being bundled.
  // They must also be direct deps of apps/web: with pnpm's strict layout Next can only
  // externalise a package it can resolve from the app directory (otherwise it bundles it,
  // and webpack chokes on onnxruntime's .wasm/.mjs side files).
  serverExternalPackages: ["falkordb", "@huggingface/transformers", "onnxruntime-node", "postgres", "drizzle-orm"],
  // The repo is a pnpm workspace; trace files from the root for `next start` / standalone.
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
  // TS source packages use `.ts` extensions in relative imports.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ...config.resolve.extensionAlias,
    };
    return config;
  },
};

export default nextConfig;
