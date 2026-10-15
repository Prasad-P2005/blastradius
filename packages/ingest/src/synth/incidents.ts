/**
 * SYNTHETIC past incidents grounded in REAL PRs.
 *
 * Each incident in the content file names the real human PR that "caused" it.
 * We check that the PR exists, is human, and touches the affected service,
 * then write:
 *   Incident (synthetic:true) -[:CAUSED_BY]-> PR (real)
 *            -[:AFFECTED]-> Service(s)
 *            -[:RESOLVED_BY]-> Runbook -[:APPLIES_TO]-> Service
 *            -[:RESPONDED_BY]-> Person (fictional PERSONAS of the owning team;
 *                               never the real PR author — prose describes the
 *                               change, not who wrote it)
 *            -[:TRIGGERED_BY]-> Alert -[:FIRED_ON]-> Service
 *            -[:MENTIONS]-> whatever the prose references
 * Times: the incident starts a seeded number of hours after the PR merged.
 */
import type { GraphBuilder } from "../graph-builder.ts";
import type { Rng } from "../prng.ts";
import { HOUR } from "../time.ts";
import type { RealIndex } from "./context.ts";
import { personaUid, type Personas } from "./personas.ts";
import type { Teams } from "./teams.ts";
import type { TextResolver } from "./text.ts";
import type { IncidentSpec } from "./types.ts";

export interface IncidentFacts {
  key: string;
  uid: string;
  service: string;
  startedAt: number;
  resolvedAt: number;
  responders: string[]; // persona uids, incident commander first
  causedBy: number;
  title: string;
  runbookUid: string;
}

export function writeIncidents(g: GraphBuilder, ix: RealIndex, teams: Teams, personas: Personas, specs: IncidentSpec[], tr: TextResolver, rng: Rng): Map<string, IncidentFacts> {
  const out = new Map<string, IncidentFacts>();
  for (const spec of specs) tr.incidents.add(spec.key);
  for (const spec of specs) {
    const r = rng.fork(spec.key);
    const pr = ix.pr(spec.causedBy);
    if (pr.isBot) throw new Error(`${spec.key}: cause PR #${pr.number} is a bot PR`);
    if (!pr.services.includes(spec.service)) throw new Error(`${spec.key}: PR #${pr.number} does not touch ${spec.service} (touches ${pr.services.join(", ")})`);

    const [h0, h1] = spec.startedHoursAfterMerge ?? [4, 72];
    const [d0, d1] = spec.durationMinutes ?? [25, 240];
    const startedAt = pr.mergedAt + r.int(h0, h1) * HOUR + r.int(0, 59) * 60_000;
    const resolvedAt = startedAt + r.int(d0, d1) * 60_000;
    if (resolvedAt > ix.now) throw new Error(`${spec.key}: would end after the newest PR; pick an older cause PR`);

    // Responders: the owning team's pager personas (shuffled), plus one more
    // persona from the team (e.g. the manager) half the time.
    const team = teams.ownerOf.get(spec.service)!;
    const pager = r.shuffle(personas.pagerByTeam.get(team) ?? []);
    const others = (personas.byTeam.get(team) ?? []).filter((u) => !pager.includes(u));
    const responders = [...pager.slice(0, 2), ...(spec.responders ?? []).map(personaUid), ...(others.length && r.chance(0.5) ? [r.pick(others)] : [])].filter((p, i, a) => a.indexOf(p) === i);
    for (const p of responders) if (!personas.names.has(p)) throw new Error(`${spec.key}: unknown persona ${p}`);

    const title = tr.resolve(spec.title);
    const summary = tr.resolve(spec.summary);
    const rootCause = tr.resolve(spec.rootCause);
    const incUid = g.node("Incident", spec.key, {
      key: spec.key, title: title.text, summary: summary.text, rootCause: rootCause.text, severity: spec.severity,
      status: "resolved", startedAt, resolvedAt, synthetic: true,
    });
    for (const svc of [spec.service, ...(spec.neighbors ?? [])]) g.edge("AFFECTED", incUid, ix.serviceUid(svc));
    g.edge("CAUSED_BY", incUid, pr.uid);
    for (const p of responders) g.edge("RESPONDED_BY", incUid, p);
    for (const m of [...title.mentions, ...summary.mentions, ...rootCause.mentions]) if (m !== incUid) g.edge("MENTIONS", incUid, m);

    const alertId = `alert-${spec.key.toLowerCase()}`;
    const alertUid = g.node("Alert", alertId, {
      title: spec.alert.title, metric: spec.alert.metric, value: spec.alert.value, message: spec.alert.message,
      firedAt: startedAt + 2 * 60_000, synthetic: true,
    });
    g.edge("TRIGGERED_BY", incUid, alertUid);
    g.edge("FIRED_ON", alertUid, ix.serviceUid(spec.service));

    const rbUid = g.node("Runbook", spec.runbook.slug, {
      title: spec.runbook.title,
      steps: spec.runbook.steps.map((s) => tr.resolve(s).text),
      createdAt: resolvedAt + r.int(1, 48) * HOUR,
      synthetic: true,
    });
    g.edge("RESOLVED_BY", incUid, rbUid);
    g.edge("APPLIES_TO", rbUid, ix.serviceUid(spec.service));

    out.set(spec.key, { key: spec.key, uid: incUid, service: spec.service, startedAt, resolvedAt, responders, causedBy: pr.number, title: title.text, runbookUid: rbUid });
  }
  return out;
}
