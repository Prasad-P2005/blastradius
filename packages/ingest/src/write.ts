/**
 * Deterministic JSON output: object keys sorted recursively, and every node /
 * edge / scenario on its own line. Diffs stay readable, files stay small, and
 * the same input always produces the same bytes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortKeys(o[k]);
    return out;
  }
  return v;
}

/** Top-level keys in the given order; arrays of objects one element per line. */
export function stableStringify(obj: Record<string, unknown>, keyOrder?: string[]): string {
  const keys = keyOrder ?? Object.keys(obj).sort();
  const parts = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => {
      const v = obj[k];
      if (Array.isArray(v) && v.length && typeof v[0] === "object") {
        return `  ${JSON.stringify(k)}: [\n${v.map((x) => `    ${JSON.stringify(sortKeys(x))}`).join(",\n")}\n  ]`;
      }
      return `  ${JSON.stringify(k)}: ${JSON.stringify(sortKeys(v))}`;
    });
  return `{\n${parts.join(",\n")}\n}\n`;
}

/** Scenario arrays: one scenario per line. */
export function stableArray(xs: unknown[]): string {
  return `[\n${xs.map((x) => `  ${JSON.stringify(sortKeys(x))}`).join(",\n")}\n]\n`;
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export const SNAPSHOT_KEY_ORDER = ["tenant", "generatedAt", "seed", "sources", "nodes", "edges"];
