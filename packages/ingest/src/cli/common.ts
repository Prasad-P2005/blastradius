/**
 * Shared CLI plumbing: repo-root paths and `--flag value` parsing.
 * Every entrypoint calls loadRootEnv() before anything else (CLAUDE.md lesson 7).
 */
import { join } from "node:path";
import { TENANTS, isSeedPack as isTenant, type SeedPack as Tenant } from "@blastradius/shared";
import { findRepoRoot } from "@blastradius/shared/env";

export const ROOT = findRepoRoot();
export const DATA_DIR = join(ROOT, "data");

export function dataPath(...p: string[]): string {
  return join(DATA_DIR, ...p);
}

/** Parses `--key value`, `--key=value` and bare `--flag` (true). */
export function parseArgs(argv = process.argv.slice(2)): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) {
      out[a.slice(2)] = argv[++i]!;
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

/**
 * `--tenant acme` → ['acme']; absent → every pack in `packs`.
 * The git pipeline (clone, snapshot, synth) passes GIT_PACKS; load, validate
 * and verify-scenarios take every seed pack, hand-written ones included.
 */
export function tenantsFromArgs<T extends Tenant>(args: Record<string, string | boolean>, packs: readonly T[] = TENANTS as readonly Tenant[] as readonly T[]): T[] {
  const t = args.tenant;
  if (t === undefined || t === true) return [...packs];
  if (typeof t === "string" && isTenant(t) && (packs as readonly string[]).includes(t)) return [t as T];
  throw new Error(`--tenant must be one of ${packs.join(", ")}`);
}

/** `--reset false` / `--no-reset` → false; default true. */
export function boolArg(args: Record<string, string | boolean>, name: string, dflt: boolean): boolean {
  if (args[`no-${name}`] === true) return false;
  const v = args[name];
  if (v === undefined) return dflt;
  if (v === true) return true;
  return !/^(false|0|no|off)$/i.test(String(v));
}

export function fail(err: unknown): never {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
}
