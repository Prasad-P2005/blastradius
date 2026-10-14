/**
 * Applies the drizzle-kit generated migrations in packages/db/drizzle.
 * Run with `pnpm db:migrate` from the repo root.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { loadRootEnv } from "@blastradius/shared/env";

loadRootEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[db:migrate] DATABASE_URL is not set; nothing to migrate.");
  process.exit(1);
}

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
const client = postgres(url, { max: 1, onnotice: () => {} });

try {
  const t0 = Date.now();
  await migrate(drizzle(client), { migrationsFolder });
  console.log(`[db:migrate] migrations applied from ${migrationsFolder} in ${Date.now() - t0} ms`);
} catch (err) {
  console.error("[db:migrate] failed:", err);
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 2 });
}
