import { defineConfig } from "drizzle-kit";
import { loadRootEnv } from "@blastradius/shared/env";

loadRootEnv();

// `pnpm --filter @blastradius/db generate` writes SQL migrations into ./drizzle (committed).
// DATABASE_URL is only needed for `drizzle-kit push/studio`, not for `generate`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
