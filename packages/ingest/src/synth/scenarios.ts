/**
 * Demo scenarios (data/scenarios.json), built from the content file and
 * checked OFFLINE against the snapshot before anything is written:
 *   - blastRadius = every service that depends on the alert service within
 *     3 hops (what blast_radius returns with default args);
 *   - suspectPr must be a human PR inside the default suspect_changes window
 *     (30 days back from the newest PR) on the service or a dependency within
 *     2 hops, and rank top 3 in our offline mirror of that tool;
 *   - pastIncident must have AFFECTED the alert service;
 *   - expert defaults to the top human author on the alert service.
 * The authoritative check runs the real tools: `verify-scenarios`.
 */
import { uid, type Scenario, type GitPack as Tenant } from "@blastradius/shared";
import type { GraphBuilder } from "../graph-builder.ts";
import type { RealIndex } from "./context.ts";
import type { IncidentFacts } from "./incidents.ts";
import type { ScenarioSpec } from "./types.ts";

export function buildScenarios(tenant: Tenant, ix: RealIndex, g: GraphBuilder, incidents: Map<string, IncidentFacts>, specs: ScenarioSpec[]): Scenario[] {
  const out: Scenario[] = [];
  for (const s of specs) {
    if (s.mode === "ask") {
      for (const src of s.sources ?? []) if (!g.has(src)) throw new Error(`${s.id}: source ${src} does not exist`);
      out.push({ id: s.id, tenant, title: s.title, mode: "ask", question: s.question, expected: { sources: s.sources ?? [] }, presenterNote: s.presenterNote });
      continue;
    }
    const alert = s.alert!;
    const svc = alert.service;
    const blast = [...ix.dependentsWithin(svc, 3).entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([x]) => uid("Service", x));
    if (blast.length < 2) throw new Error(`${s.id}: blast radius of ${svc} is only ${blast.length}`);

    const ranking = ix.suspectRanking(svc);
    const pos = ranking.findIndex((p) => p.number === s.suspectPr);
    if (pos < 0) throw new Error(`${s.id}: PR #${s.suspectPr} is not a recent human PR on ${svc} or its dependencies. Window: ${ranking.map((p) => `#${p.number}`).join(" ")}`);
    if (pos > 2) throw new Error(`${s.id}: PR #${s.suspectPr} ranks #${pos + 1} for ${svc}; top 3: ${ranking.slice(0, 3).map((p) => `#${p.number}`).join(" ")}`);

    const inc = incidents.get(s.pastIncident ?? "");
    if (!inc) throw new Error(`${s.id}: unknown past incident ${s.pastIncident}`);
    const affected = g.allEdges().some((e) => e.type === "AFFECTED" && e.from === inc.uid && e.to === uid("Service", svc));
    if (!affected) throw new Error(`${s.id}: ${inc.key} did not affect ${svc}`);

    const expert = s.expert ?? ix.expertsOn(svc)[0]?.slug;
    if (!expert) throw new Error(`${s.id}: no human expert on ${svc}`);
    if (ix.person(expert).isBot) throw new Error(`${s.id}: expert ${expert} is a bot`);

    out.push({
      id: s.id,
      tenant,
      title: s.title,
      mode: "incident",
      question: s.question,
      alert: { service: svc, metric: alert.metric, value: alert.value, message: alert.message },
      expected: { blastRadius: blast, suspectPr: ix.pr(s.suspectPr!).uid, expert: uid("Person", expert), pastIncident: inc.uid },
      presenterNote: s.presenterNote,
    });
  }
  return out;
}
