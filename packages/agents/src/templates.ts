/**
 * Claim templates for scripted mode. Each takes real tool rows (SPEC §4
 * columns) and produces one sentence a human can verify against the Why?
 * drawer. Pure functions: no I/O, deterministic, unit-tested.
 *
 * They are tolerant of missing columns (the graph package may add or omit
 * optional ones) and never invent facts: if the rows are empty they say so.
 */
import { parseUid, type Json, type Row } from "@blastradius/shared";

/* ── small helpers ──────────────────────────────────────────────────────── */

export function str(v: Json | undefined): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.length ? v : undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

export function num(v: Json | undefined): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function arr(v: Json | undefined): Json[] {
  return Array.isArray(v) ? v : [];
}

/** `Service:checkout` → `checkout`; anything else passes through. */
export function keyOf(u: string): string {
  return parseUid(u)?.key ?? u;
}

/** Display name of a row/value: prefer an explicit name/title, else the uid key. */
export function displayName(row: Row | undefined, uidCol: string, nameCol = "name"): string {
  if (!row) return "unknown";
  const n = str(row[nameCol]) ?? str(row.title);
  if (n) return n;
  const u = str(row[uidCol]);
  return u ? keyOf(u) : "unknown";
}

/** A Json cell that may be a uid string or a `{uid,name,title}` object → display name. */
export function cellName(v: Json | undefined): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return keyOf(v);
  if (typeof v === "object" && !Array.isArray(v)) {
    return str(v.name) ?? str(v.title) ?? (str(v.uid) ? keyOf(str(v.uid)!) : undefined);
  }
  return undefined;
}

/** A Json cell that may be a uid string or object → its uid. */
export function cellUid(v: Json | undefined): string | undefined {
  if (typeof v === "string") return parseUid(v) ? v : undefined;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const u = str(v.uid) ?? str(v.id);
    return u && parseUid(u) ? u : undefined;
  }
  return undefined;
}

export function fmt(n: number | undefined, digits = 2): string {
  if (n === undefined) return "n/a";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(digits);
}

export function isoDate(v: Json | undefined): string | undefined {
  const n = num(v);
  if (n !== undefined && n > 1e11) return new Date(n).toISOString().slice(0, 10);
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function listNames(names: string[], max = 3): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/* ── triage ─────────────────────────────────────────────────────────────── */

/** blast_radius rows → "If checkout fails, 4 services are affected within 3 hops; the most central is frontend (betweenness 0.42)." */
export function impactClaim(service: string, rows: Row[], maxHops: number): string {
  const svc = keyOf(service);
  if (rows.length === 0) return `No services depend on ${svc} within ${maxHops} hops, so a ${svc} failure should stay contained.`;
  const top = [...rows].sort((a, b) => (num(b.betweenness) ?? 0) - (num(a.betweenness) ?? 0) || (num(a.hops) ?? 0) - (num(b.hops) ?? 0))[0]!;
  const tier1 = rows.filter((r) => num(r.tier) === 1).map((r) => displayName(r, "service"));
  const tierNote = tier1.length ? ` Customer-facing (tier 1): ${listNames(tier1)}.` : "";
  return (
    `If ${svc} fails, ${plural(rows.length, "service")} ${rows.length === 1 ? "is" : "are"} affected within ${maxHops} hops; ` +
    `the most central is ${displayName(top, "service")} (betweenness ${fmt(num(top.betweenness))}).` +
    tierNote
  );
}

/** critical_services (+ optional failure_communities) rows → criticality of the alerted service. */
export function criticalityClaim(service: string, critical: Row[], communities: Row[] = []): string {
  const svc = keyOf(service);
  const uidFull = service.includes(":") ? service : `Service:${service}`;
  const idx = critical.findIndex((r) => str(r.service) === uidFull || str(r.name) === svc);
  let s: string;
  if (idx >= 0) {
    const r = critical[idx]!;
    s = `${svc} is chokepoint #${idx + 1} of the top ${critical.length} by betweenness (${fmt(num(r.betweenness))}, ${fmt(num(r.dependents))} dependents).`;
  } else if (critical.length) {
    const top = critical[0]!;
    s = `${svc} is not among the top ${critical.length} chokepoints; the biggest is ${displayName(top, "service")} (betweenness ${fmt(num(top.betweenness))}).`;
  } else {
    s = `No betweenness ranking was available for ${svc}.`;
  }
  const comm = communities.find((c) => arr(c.services).some((x) => cellUid(x) === uidFull || cellName(x) === svc));
  if (comm) {
    const peers = arr(comm.services)
      .map((x) => cellName(x))
      .filter((n): n is string => !!n && n !== svc);
    if (peers.length) s += ` It sits in a failure community of ${fmt(num(comm.size) ?? peers.length + 1)} services with ${listNames(peers)}.`;
  }
  return s;
}

/* ── investigator ───────────────────────────────────────────────────────── */

/** suspect_changes rows (already human-first, newest first) → the top suspect PR. */
export function causeClaim(service: string, rows: Row[], sinceDays = 30): string {
  const svc = keyOf(service);
  const humans = rows.filter((r) => r.isBot !== true);
  const top = humans[0] ?? rows[0];
  if (!top) return `No PRs touched ${svc} or its dependencies in the ${sinceDays} days before the newest PR in the graph.`;
  const number = str(top.number) ?? keyOf(str(top.pr) ?? "?");
  const title = str(top.title) ?? "untitled";
  const author = cellName(top.author) ?? str(top.authorName) ?? "unknown author";
  const when = isoDate(top.mergedAt);
  const touched = cellName(top.service) ?? svc;
  const hops = num(top.hops);
  const where = touched === svc || hops === 0 ? `touching ${svc} directly` : `touching ${touched}${hops !== undefined ? ` (${plural(hops, "hop")} from ${svc})` : ""}`;
  const others = Math.max(0, humans.length - 1);
  return (
    `The most likely cause is PR #${number} "${title}" by ${author}${when ? `, merged ${when}` : ""}, ${where}.` +
    (others ? ` ${plural(others, "other recent human PR")} also touched the dependency chain.` : "")
  );
}

/** past_incidents / similar_incidents rows → what happened last time. */
export function precedentClaim(service: string, past: Row[], similar: Row[] = []): string {
  const svc = keyOf(service);
  const best = past[0] ?? similar[0];
  if (!best) return `No past incidents on ${svc} or its neighbours were found.`;
  const key = keyOf(str(best.incident) ?? "incident");
  const title = str(best.title) ?? "";
  const sev = str(best.severity);
  const cause = cellName(best.causedBy);
  const runbook = cellName(best.runbook);
  const sim = num(best.similarity);
  const fromVector = !past[0] && sim !== undefined ? ` (vector similarity ${fmt(sim)})` : "";
  let s = `Last time: ${key}${title ? ` "${title}"` : ""}${sev ? ` (${sev})` : ""}${fromVector}`;
  s += cause ? ` was caused by ${/^\d+$/.test(cause) ? `PR #${cause}` : cause}` : " hit a similar path";
  s += runbook ? ` and resolved with runbook "${runbook}".` : ".";
  const more = past.length + similar.length - 1;
  if (more > 0) s += ` ${plural(more, "more related incident")} on record.`;
  return s;
}

/* ── expert ─────────────────────────────────────────────────────────────── */

/** who_knows + on_call rows → who can fix it. */
export function expertClaim(service: string, who: Row[], onCall: Row[] = []): string {
  const svc = keyOf(service);
  const top = who[0];
  const oc = onCall[0];
  let s: string;
  if (top) {
    const prs = num(top.prs);
    const team = cellName(top.team);
    const details = [`score ${fmt(num(top.score), 3)}`, prs !== undefined ? `${plural(prs, "PR")} on ${svc}` : undefined, team ? `team ${team}` : undefined]
      .filter(Boolean)
      .join(", ");
    s = `Best person to fix ${svc}: ${displayName(top, "person")} (${details}).`;
    const runnerUp = who[1];
    if (runnerUp) s += ` Backup: ${displayName(runnerUp, "person")}.`;
  } else {
    s = `No human authors of recent ${svc} changes were found.`;
  }
  if (oc) {
    const week = str(oc.weekStart);
    s += ` On call: ${displayName(oc, "person")}${week ? ` (week of ${week})` : ""}.`;
  }
  return s;
}

/* ── scribe + navigator ─────────────────────────────────────────────────── */

/** read_handoffs rows (claims of the findings handed to the scribe) → one summary sentence. */
export function summaryClaim(service: string, handoffClaims: string[]): string {
  const svc = keyOf(service);
  if (!handoffClaims.length) return `Investigation of ${svc}: no findings were handed to the scribe.`;
  return `Incident summary for ${svc}: ${handoffClaims.map((c) => c.replace(/\s+/g, " ").trim()).join(" ")}`;
}

/** ask_company rows → "Top sources: …" answer. */
export function answerClaim(question: string, rows: Row[]): string {
  if (!rows.length) return `No sources in the company graph matched "${question}".`;
  const parts = rows.slice(0, 3).map((r) => {
    const src = keyOf(str(r.source) ?? "");
    const title = str(r.title);
    const label = str(r.label);
    const sim = num(r.similarity);
    return `${src}${title ? ` "${title}"` : ""}${label ? ` (${label}${sim !== undefined ? `, similarity ${fmt(sim)}` : ""})` : ""}`;
  });
  const top = rows[0]!;
  const snippet = str(top.snippet);
  return `Top sources: ${parts.join("; ")}.` + (snippet ? ` Most relevant: "${snippet.replace(/\s+/g, " ").slice(0, 220).trim()}"` : "");
}

/** decision_trace rows → "ADR-007 … was decided by …, justified PR #…, linked to INC-…". */
export function decisionClaim(rows: Row[]): string | undefined {
  const top = rows[0];
  if (!top) return undefined;
  const key = keyOf(str(top.decision) ?? "decision");
  const title = str(top.title);
  const status = str(top.status);
  const when = isoDate(top.decidedAt);
  const by = arr(top.decidedBy).map(cellName).filter(Boolean) as string[];
  const prs = arr(top.prs).map(cellName).filter(Boolean) as string[];
  const incidents = arr(top.incidents).map(cellName).filter(Boolean) as string[];
  let s = `${key}${title ? ` "${title}"` : ""}${status ? ` (${status}${when ? `, ${when}` : ""})` : ""}`;
  if (by.length) s += ` was decided by ${listNames(by)}`;
  if (prs.length) s += `${by.length ? "," : ""} justified ${listNames(prs.map((p) => (/^\d+$/.test(p) ? `PR #${p}` : p)))}`;
  if (incidents.length) s += ` and is linked to ${listNames(incidents)}`;
  return `${s}.`;
}

/** who_knows rows for a topic → "People who know about X: …". */
export function topicExpertsClaim(topic: string, rows: Row[]): string | undefined {
  if (!rows.length) return undefined;
  return `People who know about ${topic}: ${listNames(rows.map((r) => displayName(r, "person")))}.`;
}
