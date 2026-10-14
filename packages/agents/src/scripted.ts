/**
 * Scripted mode: the same agents, tools and graph writes as LLM mode, but the
 * "brain" is a fixed plan. Tool inputs come from the request (alert service,
 * question) or from graph state (handoffs); claims are templated from the
 * rows (templates.ts). Deterministic for a given graph, no API key needed.
 *
 * Each plan returns the agent's final message text. Findings are recorded
 * through AgentScope.recordFinding exactly like the LLM path.
 */
import { parseUid, type Finding, type GraphToolResult, type Row } from "@blastradius/shared";
import { ToolCallError, type AgentScope } from "./runtime.ts";
import {
  answerClaim,
  causeClaim,
  cellUid,
  criticalityClaim,
  decisionClaim,
  expertClaim,
  impactClaim,
  keyOf,
  num,
  precedentClaim,
  str,
  summaryClaim,
  topicExpertsClaim,
} from "./templates.ts";

const STOPWORDS = new Set(
  "a an the is are was were be been of on in at to for from by with and or not no why what who whom which how when where does do did can could should would will service services our we us it its this that these those failing failed fails down error errors alert latency high spike 5xx 500 timeout timeouts p99 broken slow outage incident please about owns own knows know".split(
    " ",
  ),
);

/** Candidate search terms from free text: content words, longest first, max 5. */
export function searchTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\- ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 5);
}

/** Runs a tool; a recoverable tool error yields null (fatal errors propagate). */
async function tryTool(scope: AgentScope, tool: Parameters<AgentScope["callTool"]>[0], input: Record<string, unknown>) {
  try {
    return await scope.callTool(tool, input);
  } catch (err) {
    if (err instanceof ToolCallError) return null;
    throw err;
  }
}

/** Service uid from read_handoffs rows (graph state), falling back to the run's service. */
export function serviceFromHandoffs(rows: Row[], fallback?: string): string | undefined {
  for (const r of rows) {
    for (const u of Array.isArray(r.about) ? r.about : []) {
      if (typeof u === "string" && parseUid(u)?.label === "Service") return u;
    }
  }
  return fallback;
}

/** Resolves a service from free text via search_nodes (one call per candidate term, stops at the first hit). */
async function resolveService(scope: AgentScope, text: string): Promise<string | undefined> {
  for (const term of searchTerms(text)) {
    const r = await tryTool(scope, "search_nodes", { query: term, labels: ["Service"], limit: 5 });
    const hit = r?.result.rows.find((row) => parseUid(str(row.uid) ?? "")?.label === "Service");
    if (hit) return str(hit.uid);
  }
  return undefined;
}

function rows(r: { result: GraphToolResult } | null): Row[] {
  return r?.result.rows ?? [];
}

/* ── triage ─────────────────────────────────────────────────────────────── */

export async function scriptedTriage(scope: AgentScope, question: string): Promise<string> {
  const run = scope.run;
  if (!run.service) run.service = await resolveService(scope, question);
  const service = run.service;
  if (!service) {
    // Nothing to scope: record what we searched so the claim is still backed by real queries.
    const cites = scope.ownEntries().map((e) => e.callId);
    if (cites.length) {
      await scope.recordFinding({
        kind: "impact",
        claim: `No service in the graph matched "${question}", so the blast radius could not be scoped.`,
        confidence: 0.3,
        cites,
      });
    }
    return `I could not resolve a service from "${question}".`;
  }
  const maxHops = 3;
  const blast = await tryTool(scope, "blast_radius", { service, maxHops, direction: "dependents" });
  const critical = await tryTool(scope, "critical_services", { limit: 10 });
  const communities = await tryTool(scope, "failure_communities", { algorithm: "cdlp" });

  const out: string[] = [];
  if (blast) {
    const claim = impactClaim(service, blast.result.rows, maxHops);
    const affected = blast.result.rows.map((r) => str(r.service)).filter((u): u is string => !!u);
    await scope.recordFinding({
      kind: "impact",
      claim,
      confidence: 0.9,
      about: [service, ...affected.slice(0, 10)],
      cites: [blast.callId],
    });
    out.push(claim);
  }
  if (critical || communities) {
    const claim = criticalityClaim(service, rows(critical), rows(communities));
    await scope.recordFinding({
      kind: "risk",
      claim,
      confidence: 0.8,
      about: [service],
      cites: [critical?.callId, communities?.callId].filter((c): c is string => !!c),
    });
    out.push(claim);
  }
  return out.join(" ") || `No blast-radius data was available for ${keyOf(service)}.`;
}

/* ── investigator ───────────────────────────────────────────────────────── */

export async function scriptedInvestigator(scope: AgentScope, question: string): Promise<string> {
  const handoffs = await scope.callTool("read_handoffs", {});
  const service = serviceFromHandoffs(handoffs.result.rows, scope.run.service);
  if (!service) return "No service was handed to me, so I could not look for a cause.";
  scope.run.service ??= service;

  const suspects = await tryTool(scope, "suspect_changes", { service });
  const past = await tryTool(scope, "past_incidents", { service });
  const similar = await tryTool(scope, "similar_incidents", { text: question.length >= 3 ? question : `${keyOf(service)} incident`, service });

  const out: string[] = [];
  if (suspects) {
    const top = suspects.result.rows.find((r) => r.isBot !== true) ?? suspects.result.rows[0];
    const prUid = top ? (str(top.pr) ?? (num(top.number) !== undefined ? `PR:${num(top.number)}` : undefined)) : undefined;
    const author = top ? cellUid(top.author) : undefined;
    const claim = causeClaim(service, suspects.result.rows);
    await scope.recordFinding({
      kind: "cause",
      claim,
      confidence: top ? 0.7 : 0.4,
      about: [prUid, service].filter((u): u is string => !!u),
      evidence: [prUid, author, cellUid(top?.service)].filter((u): u is string => !!u),
      cites: [suspects.callId],
    });
    out.push(claim);
  }
  if (past || similar) {
    const claim = precedentClaim(service, rows(past), rows(similar));
    const best = rows(past)[0] ?? rows(similar)[0];
    await scope.recordFinding({
      kind: "precedent",
      claim,
      confidence: best ? 0.75 : 0.3,
      about: [str(best?.incident), service].filter((u): u is string => !!u),
      evidence: [str(best?.incident), cellUid(best?.causedBy), cellUid(best?.runbook)].filter((u): u is string => !!u),
      cites: [past?.callId, similar?.callId].filter((c): c is string => !!c),
    });
    out.push(claim);
  }
  return out.join(" ") || `No change or incident data was available for ${keyOf(service)}.`;
}

/* ── expert ─────────────────────────────────────────────────────────────── */

export async function scriptedExpert(scope: AgentScope): Promise<string> {
  const handoffs = await scope.callTool("read_handoffs", {});
  const service = serviceFromHandoffs(handoffs.result.rows, scope.run.service);
  if (!service) return "No service was handed to me, so I could not find an expert.";

  const who = await tryTool(scope, "who_knows", { service });
  const onCall = await tryTool(scope, "on_call", { service });
  if (!who && !onCall) return `No expert data was available for ${keyOf(service)}.`;
  const top = rows(who)[0];
  const oc = rows(onCall)[0];
  const claim = expertClaim(service, rows(who), rows(onCall));
  await scope.recordFinding({
    kind: "expert",
    claim,
    confidence: top ? 0.8 : 0.4,
    about: [cellUid(top?.person) ?? str(top?.person), cellUid(oc?.person) ?? str(oc?.person), service].filter((u): u is string => !!u),
    cites: [who?.callId, onCall?.callId].filter((c): c is string => !!c),
  });
  return claim;
}

/* ── scribe ─────────────────────────────────────────────────────────────── */

/** The four questions, in reading order: what breaks, cause, who fixes, what worked last time. */
const SUMMARY_ORDER = ["impact", "cause", "expert", "precedent"] as const;

export async function scriptedScribe(scope: AgentScope, sessionFindings: Finding[]): Promise<string> {
  const handoffs = await scope.callTool("read_handoffs", {});
  const service = serviceFromHandoffs(handoffs.result.rows, scope.run.service) ?? "the service";
  // One finding per kind, in reading order, from this session's findings in the graph (oldest first).
  const picked: Finding[] = [];
  for (const kind of SUMMARY_ORDER) {
    // newest of each kind: in a continued session, summarise the latest run's work
    const f = sessionFindings.findLast((x) => x.kind === kind && x.cypher.length > 0);
    if (f) picked.push(f);
  }
  const claim = summaryClaim(service, picked.map((f) => f.claim));
  await scope.recordFinding({
    kind: "summary",
    claim,
    confidence: 0.8,
    about: [service, ...picked.flatMap((f) => f.about).slice(0, 10)],
    cites: [handoffs.callId],
    citeFindings: picked,
    handTo: null,
  });
  return claim;
}

/* ── navigator (ask mode) ───────────────────────────────────────────────── */

const WHY = /\b(why|decid|decision|adr|chose|choose|rationale)\b/i;
const WHO = /\b(who|whom|owner|owns|expert|knows)\b/i;

export async function scriptedNavigator(scope: AgentScope, question: string): Promise<string> {
  const ask = await tryTool(scope, "ask_company", { question, k: 6 });
  const out: string[] = [];
  if (ask) {
    const claim = answerClaim(question, ask.result.rows);
    const sources = ask.result.rows.slice(0, 3).map((r) => str(r.source)).filter((u): u is string => !!u);
    await scope.recordFinding({
      kind: "answer",
      claim,
      confidence: ask.result.rows.length ? 0.75 : 0.3,
      about: sources,
      evidence: sources,
      cites: [ask.callId],
      handTo: null,
    });
    out.push(claim);
  }
  const topDecision = rows(ask).find((r) => str(r.label) === "Decision");
  if (WHY.test(question) || topDecision) {
    const trace = await tryTool(scope, "decision_trace", topDecision ? { uid: str(topDecision.source) } : { query: question });
    const claim = trace ? decisionClaim(trace.result.rows) : undefined;
    if (trace && claim) {
      await scope.recordFinding({
        kind: "answer",
        claim,
        confidence: 0.75,
        about: [str(trace.result.rows[0]?.decision)].filter((u): u is string => !!u),
        cites: [trace.callId],
        handTo: null,
      });
      out.push(claim);
    }
  }
  if (WHO.test(question)) {
    const svc = await serviceInQuestion(scope, question);
    const who = await tryTool(scope, "who_knows", svc ? { service: svc } : { topic: question });
    const claim = who ? topicExpertsClaim(svc ? keyOf(svc) : question, who.result.rows) : undefined;
    if (who && claim) {
      await scope.recordFinding({
        kind: "expert",
        claim,
        confidence: 0.7,
        about: who.result.rows.slice(0, 3).map((r) => str(r.person)).filter((u): u is string => !!u),
        cites: [who.callId],
        handTo: null,
      });
      out.push(claim);
    }
  }
  return out.join(" ") || `I found nothing in the company graph for "${question}".`;
}

/** A Service mentioned by name in an ask-mode question (via search_nodes), if any. */
async function serviceInQuestion(scope: AgentScope, question: string): Promise<string | undefined> {
  for (const term of searchTerms(question).slice(0, 3)) {
    const r = await tryTool(scope, "search_nodes", { query: term, labels: ["Service"], limit: 3 });
    const hit = r?.result.rows.find((row) => {
      const u = str(row.uid);
      return parseUid(u ?? "")?.label === "Service" && (keyOf(u!) === term || str(row.name)?.toLowerCase() === term);
    });
    if (hit) return str(hit.uid);
  }
  return undefined;
}
