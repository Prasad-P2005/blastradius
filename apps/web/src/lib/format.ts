import { LABEL_COLORS, parseUid, type Json, type NodeLabel } from "@blastradius/shared";

export function labelColor(label: string): string {
  return (LABEL_COLORS as Record<string, string>)[label] ?? "#94a3b8";
}

export function uidLabel(uid: string): NodeLabel | null {
  return parseUid(uid)?.label ?? null;
}

export function uidKey(uid: string): string {
  return parseUid(uid)?.key ?? uid;
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function fmtTime(ts: string | number | undefined): string {
  if (ts === undefined) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function fmtDate(ts: string | number | undefined): string {
  if (ts === undefined || ts === null) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toISOString().slice(0, 10);
}

export function fmtAgo(ts: number | string, now = Date.now()): string {
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Compact one-line rendering of a JSON cell for tables. */
export function fmtCell(v: Json | undefined): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map((x) => fmtCell(x)).join(", ");
  return JSON.stringify(v);
}

/** Heuristic: epoch-ms values in *At columns render as dates. */
export function fmtColumn(key: string, v: Json | undefined): string {
  if (typeof v === "number" && /At$/.test(key) && v > 1e11) return fmtDate(v);
  return fmtCell(v);
}

export function compactInput(input: Record<string, Json>): string {
  return Object.entries(input)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ");
}
