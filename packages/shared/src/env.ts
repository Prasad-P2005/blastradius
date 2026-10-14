/**
 * Node-only: load the repo-root .env into process.env.
 *
 * Next.js only reads .env from apps/web, and tsx scripts read none, so EVERY
 * Node entrypoint (scripts, MCP server, next.config.ts) calls loadRootEnv()
 * first. Existing process.env values win (so CI/deploy env overrides .env).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Walks up from `start` to the directory containing pnpm-workspace.yaml. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** Minimal KEY=VALUE parser (supports quotes and # comments). */
export function parseDotenv(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[m[1]!] = value;
  }
  return out;
}

let loaded = false;

/** Idempotent. Returns the path it loaded, or null if there was no .env. */
export function loadRootEnv(start?: string): string | null {
  const file = join(findRepoRoot(start), ".env");
  if (loaded || !existsSync(file)) return loaded ? file : null;
  const vars = parseDotenv(readFileSync(file, "utf8"));
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  loaded = true;
  return file;
}
