/**
 * SYNTHETIC architecture decision records grounded in REAL PRs.
 *
 * The decisions themselves happened (e.g. opentelemetry-demo really replaced
 * Redis with Valkey in PR #1619); the ADR text — context, wording, who
 * "decided" — is written by us and marked synthetic. Per ADR we write:
 *   Decision -[:DOCUMENTED_IN]-> Doc (kind 'adr')
 *   Decision -[:JUSTIFIES]-> PR (real)
 *   Decision -[:ABOUT]-> Service, Doc -[:ABOUT]-> Service
 *   Decision -[:DECIDED_BY]-> Person (fictional PERSONAS) and Team
 *   (real PR authors are linked only through the real PRs: Decision
 *    -[:JUSTIFIES]->PR<-[:AUTHORED]-Person. We never claim they "decided".)
 *   Decision/Doc -[:MENTIONS]-> whatever the prose references
 * decidedAt = a few days before the first justifying PR merged.
 */
import { uid } from "@blastradius/shared";
import type { GraphBuilder } from "../graph-builder.ts";
import type { Rng } from "../prng.ts";
import { DAY, isoDate } from "../time.ts";
import type { RealIndex } from "./context.ts";
import { personaUid, type Personas } from "./personas.ts";
import type { Teams } from "./teams.ts";
import type { TextResolver } from "./text.ts";
import type { DecisionSpec } from "./types.ts";

export function writeDecisions(g: GraphBuilder, ix: RealIndex, teams: Teams, personas: Personas, specs: DecisionSpec[], tr: TextResolver, rng: Rng): Map<string, { uid: string; docUid: string; decidedAt: number }> {
  const out = new Map<string, { uid: string; docUid: string; decidedAt: number }>();
  for (const s of specs) tr.decisions.add(s.key);
  for (const s of specs) {
    const r = rng.fork(s.key);
    const prs = s.justifies.map((n) => ix.pr(n));
    const first = Math.min(...prs.map((p) => p.mergedAt));
    const decidedAt = first - r.int(2, 9) * DAY - r.int(0, 23) * 3_600_000;
    const title = tr.resolve(s.title);
    const context = tr.resolve(s.context);
    const decision = tr.resolve(s.decision);
    const consequences = tr.resolve(s.consequences);
    const decUid = g.node("Decision", s.key, {
      key: s.key, title: title.text, status: s.status, context: context.text, decision: decision.text,
      consequences: consequences.text, decidedAt, synthetic: true,
    });
    const ownerTeam = teams.ownerOf.get(s.about[0]!)!;
    const deciders = s.decidedBy ? s.decidedBy.map(personaUid) : (personas.byTeam.get(ownerTeam) ?? []).slice(0, 2);
    for (const p of deciders) {
      if (!personas.names.has(p)) throw new Error(`${s.key}: unknown persona ${p}`);
      g.edge("DECIDED_BY", decUid, p);
    }
    if (s.decidedByTeam !== false) g.edge("DECIDED_BY", decUid, uid("Team", ownerTeam));
    for (const p of prs) g.edge("JUSTIFIES", decUid, p.uid);
    for (const svc of s.about) g.edge("ABOUT", decUid, ix.serviceUid(svc));

    const md = [
      `# ${s.key}: ${title.text}`,
      ``,
      `Status: ${s.status} · Decided: ${isoDate(decidedAt)} by ${deciders.map((u) => personas.names.get(u)).join(", ")} (fictional personas) · Synthetic ADR written for the Blastradius demo, grounded in real PRs: ${prs.map((p) => `#${p.number}`).join(", ")}.`,
      ``,
      `## Context`,
      context.text,
      ``,
      `## Decision`,
      decision.text,
      ``,
      `## Consequences`,
      consequences.text,
      ``,
      `## Pull requests`,
      ...prs.map((p) => `- #${p.number} ${p.title}`),
    ].join("\n");
    const docUid = g.node("Doc", s.docSlug, { title: `${s.key}: ${title.text}`, kind: "adr", text: md, synthetic: true });
    g.edge("DOCUMENTED_IN", decUid, docUid);
    for (const svc of s.about) g.edge("ABOUT", docUid, ix.serviceUid(svc));
    const mentions = new Set([...title.mentions, ...context.mentions, ...decision.mentions, ...consequences.mentions]);
    for (const m of mentions) if (m !== decUid) {
      g.edge("MENTIONS", decUid, m);
      g.edge("MENTIONS", docUid, m);
    }
    for (const p of prs) g.edge("MENTIONS", docUid, p.uid);
    out.set(s.key, { uid: decUid, docUid, decidedAt });
  }
  return out;
}
