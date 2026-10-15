/**
 * SYNTHETIC "company brain": tickets (Issue) and chat threads (Thread).
 *
 * Every ticket and thread is written by a fictional PERSONA:
 *   (Person {persona:true})-[:POSTED]->(Issue|Thread)
 * and personas are the only speakers inside Thread.text. Real contributors
 * never speak and are never named; prose refers to their PRs by number and
 * title only (public facts).
 *
 * Three sources, all synthetic:true:
 *   1. hand-written tickets/threads from the tenant content file — these carry
 *      the decision arguments and the answers for "Ask the company";
 *   2. one incident-channel thread per seeded incident, voiced by its
 *      responder personas and naming the real cause PR;
 *   3. templated filler grounded in real data: follow-up tickets for real PRs
 *      and incidents, "who knows X?" threads that point at the real PRs on X
 *      (and at who_knows), and heads-up threads about real recent PRs.
 * Every placeholder becomes a MENTIONS edge; `about` becomes ABOUT edges.
 */
import type { GraphBuilder } from "../graph-builder.ts";
import type { Rng } from "../prng.ts";
import { DAY, HOUR } from "../time.ts";
import type { RealIndex } from "./context.ts";
import type { IncidentFacts } from "./incidents.ts";
import { personaUid, type Personas } from "./personas.ts";
import type { Teams } from "./teams.ts";
import type { TextResolver } from "./text.ts";
import type { IssueSpec, TenantContent, ThreadSpec, When } from "./types.ts";

interface Ctx {
  g: GraphBuilder;
  ix: RealIndex;
  teams: Teams;
  personas: Personas;
  tr: TextResolver;
  incidents: Map<string, IncidentFacts>;
  rng: Rng;
}

function whenToMs(c: Ctx, w: When, r: Rng): number {
  let t: number;
  if ("daysAgo" in w) t = c.ix.now - w.daysAgo * DAY;
  else if ("pr" in w) t = c.ix.pr(w.pr).mergedAt + w.offsetDays * DAY;
  else {
    const inc = c.incidents.get(w.incident);
    if (!inc) throw new Error(`unknown incident ${w.incident}`);
    t = inc.startedAt + w.offsetHours * HOUR;
  }
  // jitter within the working day, never past "now"
  return Math.min(c.ix.now - HOUR, t + r.int(0, 6) * HOUR + r.int(0, 59) * 60_000);
}

function teamSlack(c: Ctx, svc: string): string {
  const team = c.teams.ownerOf.get(svc)!;
  return c.teams.seeds.find((t) => t.slug === team)!.slack;
}

/** `{{persona:slug}}` for a persona uid. */
const ph = (personaUidStr: string) => `{{persona:${personaUidStr.slice("Person:persona-".length)}}}`;

/** Round-robin over a team's personas, so posting activity is spread out. */
class Rota {
  private readonly i = new Map<string, number>();
  constructor(private readonly c: Ctx) {}
  next(team: string, exclude: string[] = []): string {
    const roster = (this.c.personas.byTeam.get(team) ?? []).filter((u) => !exclude.includes(u));
    const all = roster.length ? roster : [...this.c.personas.names.keys()].sort();
    const k = this.i.get(team) ?? 0;
    this.i.set(team, k + 1);
    return all[k % all.length]!;
  }
  forService(svc: string, exclude: string[] = []): string {
    return this.next(this.c.teams.ownerOf.get(svc)!, exclude);
  }
  /** someone from another team (for "who knows X?") */
  outsider(svc: string): string {
    const team = this.c.teams.ownerOf.get(svc)!;
    const others = this.c.teams.seeds.map((t) => t.slug).filter((t) => t !== team);
    const k = this.i.get(`out:${team}`) ?? 0;
    this.i.set(`out:${team}`, k + 1);
    return this.next(others[k % others.length]!);
  }
}

/* ───────────────────────────── issues ───────────────────────────── */

function writeIssue(c: Ctx, rota: Rota, key: string, spec: IssueSpec, r: Rng): void {
  const title = c.tr.resolve(spec.title);
  const body = c.tr.resolve(spec.body);
  const createdAt = whenToMs(c, spec.when, r);
  const props: Record<string, string | number | boolean> = {
    key, title: title.text, body: body.text, status: spec.status, priority: spec.priority, createdAt, synthetic: true,
  };
  if (spec.status === "done") props.resolvedAt = Math.min(c.ix.now, createdAt + (spec.resolvedAfterDays ?? r.int(1, 14)) * DAY);
  const u = c.g.node("Issue", key, props);
  const poster = spec.postedBy ? personaUid(spec.postedBy) : rota.forService(spec.about[0]!);
  if (!c.personas.names.has(poster)) throw new Error(`${key}: unknown persona ${poster}`);
  c.g.edge("POSTED", poster, u);
  for (const svc of spec.about) c.g.edge("ABOUT", u, c.ix.serviceUid(svc));
  for (const m of new Set([...title.mentions, ...body.mentions])) if (m !== u) c.g.edge("MENTIONS", u, m);
}

/** Real-data-grounded ticket templates. Each returns null when it doesn't apply. */
function templatedIssues(c: Ctx, count: number, r: Rng): IssueSpec[] {
  const humanRecent = [...c.ix.prs.values()].filter((p) => !p.isBot && p.services.length > 0 && p.services.length <= 3 && p.mergedAt > c.ix.now - 150 * DAY).sort((a, b) => b.number - a.number);
  const botRecent = [...c.ix.prs.values()].filter((p) => p.isBot && p.services.length === 1 && p.mergedAt > c.ix.now - 90 * DAY).sort((a, b) => b.number - a.number);
  const incs = [...c.incidents.values()];
  const makers: (() => IssueSpec | null)[] = [
    () => {
      const pr = r.pick(humanRecent);
      const svc = pr.services[0]!;
      return { title: `{{svc:${svc}}}: add a regression test for {{prn:${pr.number}}}`, body: `{{pr:${pr.number}}} changed ${pr.files.slice(0, 3).join(", ") || svc}. We have no test that would catch a regression here. Which level fits best: unit or integration?`, status: r.pick(["open", "in_progress", "done"] as const), priority: r.pick(["P3", "P4"] as const), about: [svc], when: { pr: pr.number, offsetDays: r.int(1, 6) } };
    },
    () => {
      if (!incs.length) return null;
      const inc = r.pick(incs);
      return { title: `Follow-up from {{inc:${inc.key}}}: alert earlier on {{svc:${inc.service}}}`, body: `Action item from the {{inc:${inc.key}}} review ("${inc.title}"). The alert fired only after customers noticed. Add a burn-rate alert for {{svc:${inc.service}}} and link the runbook in the alert annotation.`, status: r.pick(["open", "done"] as const), priority: "P2", about: [inc.service], when: { incident: inc.key, offsetHours: r.int(24, 96) } };
    },
    () => {
      if (!botRecent.length) return null;
      const pr = r.pick(botRecent);
      const svc = pr.services[0]!;
      return { title: `Review dependency bump {{prn:${pr.number}}} on {{svc:${svc}}}`, body: `{{pr:${pr.number}}} was merged by a bot. Bots are not on call: someone from the owning team should confirm nothing in ${svc} depends on the old behaviour.`, status: r.pick(["open", "done"] as const), priority: "P4", about: [svc], when: { pr: pr.number, offsetDays: r.int(0, 3) } };
    },
    () => {
      const svc = r.pick(c.ix.serviceSlugs.filter((s) => c.ix.expertsOn(s).length >= 2));
      const prs = c.ix.humanPrsOn(svc).slice(0, 3);
      return { title: `Bus factor: {{svc:${svc}}} knowledge sits with very few contributors`, body: `Most recent changes to {{svc:${svc}}} (${prs.map((p) => `{{prn:${p.number}}}`).join(", ")}) come from a small group; who_knows shows who. Pair someone from the team on the next two changes and write a short how-to.`, status: "open", priority: "P3", about: [svc], when: { daysAgo: r.int(5, 60) } };
    },
    () => {
      const pr = r.pick(humanRecent);
      const svc = pr.services[0]!;
      return { title: `Grafana panel for {{svc:${svc}}} after {{prn:${pr.number}}}`, body: `{{pr:${pr.number}}} added or changed behaviour we cannot see on a dashboard yet. Add a panel (request rate, error rate, p99) for {{svc:${svc}}} to the team dashboard.`, status: r.pick(["open", "in_progress", "done"] as const), priority: "P4", about: [svc], when: { pr: pr.number, offsetDays: r.int(1, 10) } };
    },
  ];
  const out: IssueSpec[] = [];
  for (let i = 0; out.length < count && i < count * 10; i++) {
    const s = makers[i % makers.length]!();
    if (s && !out.some((o) => o.title === s.title)) out.push(s);
  }
  return out;
}

/* ───────────────────────────── threads ───────────────────────────── */

function writeThread(c: Ctx, id: string, spec: ThreadSpec, r: Rng): void {
  const title = c.tr.resolve(spec.title);
  const mentions = new Set(title.mentions);
  const speakers: string[] = [];
  const lines = spec.lines.map(([speaker, msg]) => {
    const s = c.tr.resolve(speaker);
    const sp = s.mentions[0];
    if (!sp || !c.personas.names.has(sp) || s.mentions.length !== 1) throw new Error(`${id}: speaker "${speaker}" must be exactly one {{persona:…}}`);
    speakers.push(sp);
    const m = c.tr.resolve(msg);
    for (const x of m.mentions) mentions.add(x);
    return `${s.text}: ${m.text}`;
  });
  const u = c.g.node("Thread", id, { channel: spec.channel, title: title.text, text: lines.join("\n"), createdAt: whenToMs(c, spec.when, r), synthetic: true });
  c.g.edge("POSTED", speakers[0]!, u);
  for (const svc of spec.about) c.g.edge("ABOUT", u, c.ix.serviceUid(svc));
  for (const m of mentions) if (m !== u) c.g.edge("MENTIONS", u, m);
}

/** One #inc channel thread per incident, voiced by its responder personas. */
function incidentThread(inc: IncidentFacts): ThreadSpec {
  const [ic, sre, third] = [inc.responders[0]!, inc.responders[1] ?? inc.responders[0]!, inc.responders[2] ?? inc.responders[0]!];
  return {
    channel: `#inc-${inc.key.toLowerCase()}`,
    title: `{{inc:${inc.key}}}: ${inc.title}`,
    about: [inc.service],
    when: { incident: inc.key, offsetHours: 0 },
    lines: [
      [ph(ic), `Paging for {{inc:${inc.key}}}. Alerts firing on {{svc:${inc.service}}}; I'm incident commander.`],
      [ph(sre), `Looking at what changed recently on {{svc:${inc.service}}} and its dependencies.`],
      [ph(ic), `Top suspect is {{pr:${inc.causedBy}}}. Rolling it back and following the runbook.`],
      [ph(sre), `Rollback is out. Error rate back to baseline; keeping the incident open for 30 minutes.`],
      [ph(third), `I'll draft the postmortem: what the change did, why our checks missed it, and the follow-up tickets.`],
      [ph(ic), `Resolved. Runbook updated; postmortem notes go in the incident record.`],
    ],
  };
}

function templatedThreads(c: Ctx, rota: Rota, count: number, r: Rng): ThreadSpec[] {
  const out: ThreadSpec[] = [];
  const withPrs = c.ix.serviceSlugs.filter((s) => c.ix.humanPrsOn(s).length >= 2);
  const recentHuman = [...c.ix.prs.values()].filter((p) => !p.isBot && p.services.length > 0 && p.services.length <= 3 && p.mergedAt > c.ix.now - 60 * DAY).sort((a, b) => b.number - a.number);
  const svcs = r.shuffle(withPrs);
  for (let i = 0; out.length < count && i < svcs.length + recentHuman.length; i++) {
    if (i % 2 === 0 && svcs.length) {
      const svc = svcs[(i / 2) % svcs.length]!;
      const asker = rota.outsider(svc);
      const owner = rota.forService(svc, [asker]);
      const prs = c.ix.humanPrsOn(svc).slice(0, 2);
      out.push({
        channel: "#engineering",
        title: `Who knows {{svc:${svc}}} well?`,
        about: [svc],
        when: { daysAgo: r.int(2, 80) },
        lines: [
          [ph(asker), `Who knows {{svc:${svc}}} well? I need a reviewer for a change that touches it.`],
          [ph(owner), `Our team owns it (${teamSlack(c, svc)}). For the code itself, ask Blastradius who_knows: the latest human changes were ${prs.map((p) => `{{pr:${p.number}}}`).join(" and ")}.`],
          [ph(asker), `Thanks, I'll tag the channel and the people who_knows suggests.`],
        ],
      });
    } else if (recentHuman.length) {
      const pr = recentHuman[(i - 1) % recentHuman.length]!;
      const svc = pr.services[0]!;
      const a = rota.forService(svc);
      const b = rota.forService(svc, [a]);
      out.push({
        channel: teamSlack(c, svc),
        title: `Heads-up: {{prn:${pr.number}}} ${pr.title}`,
        about: [svc],
        when: { pr: pr.number, offsetDays: 0 },
        lines: [
          [ph(a), `Heads-up: {{pr:${pr.number}}} just landed and touches {{svc:${svc}}}. Anything we should watch after the next deploy?`],
          [ph(b), `I'll keep an eye on the {{svc:${svc}}} error rate and p99 for a day. If it misbehaves, rollback first, questions later.`],
        ],
      });
    }
  }
  return out;
}

export function writeBrain(c: Ctx, content: TenantContent): { issues: number; threads: number } {
  const r = c.rng;
  const rota = new Rota(c);
  // Issues: hand-written first (stable keys), then templated.
  const issues = [...content.issues, ...templatedIssues(c, content.templatedIssues, r.fork("issue-templates"))];
  issues.forEach((_s, i) => c.tr.issues.add(`${content.issuePrefix}-${101 + i}`));
  issues.forEach((s, i) => writeIssue(c, rota, `${content.issuePrefix}-${101 + i}`, s, r.fork(`issue-${i}`)));
  // Threads: hand-written, one per incident, then templated.
  const threads = [
    ...content.threads,
    ...[...c.incidents.values()].map((inc) => incidentThread(inc)),
    ...templatedThreads(c, rota, content.templatedThreads, r.fork("thread-templates")),
  ];
  threads.forEach((s, i) => writeThread(c, `t-${String(i + 1).padStart(4, "0")}`, s, r.fork(`thread-${i}`)));
  return { issues: issues.length, threads: threads.length };
}
