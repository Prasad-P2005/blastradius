/**
 * SYNTHETIC "company brain": tickets (Issue) and chat threads (Thread).
 *
 * Three sources, all marked synthetic:true:
 *   1. hand-written tickets/threads from the tenant content file — these carry
 *      the decision arguments and the answers for "Ask the company";
 *   2. one incident-channel thread per seeded incident, voiced by its real
 *      responders and naming the real cause PR;
 *   3. templated filler grounded in real data: "who knows X?" threads that
 *      name the actual top authors of X, review requests for real recent PRs,
 *      and follow-up tickets for real PRs and incidents.
 * Every placeholder becomes a MENTIONS edge; `about` becomes ABOUT edges.
 */
import type { GraphBuilder } from "../graph-builder.ts";
import type { Rng } from "../prng.ts";
import { DAY, HOUR } from "../time.ts";
import type { RealIndex } from "./context.ts";
import type { IncidentFacts } from "./incidents.ts";
import type { Teams } from "./teams.ts";
import type { TextResolver } from "./text.ts";
import type { IssueSpec, TenantContent, ThreadSpec, When } from "./types.ts";

interface Ctx {
  g: GraphBuilder;
  ix: RealIndex;
  teams: Teams;
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

/* ───────────────────────────── issues ───────────────────────────── */

function writeIssue(c: Ctx, key: string, spec: IssueSpec, r: Rng): void {
  const title = c.tr.resolve(spec.title);
  const body = c.tr.resolve(spec.body);
  const createdAt = whenToMs(c, spec.when, r);
  const props: Record<string, string | number | boolean> = {
    key, title: title.text, body: body.text, status: spec.status, priority: spec.priority, createdAt, synthetic: true,
  };
  if (spec.status === "done") props.resolvedAt = Math.min(c.ix.now, createdAt + (spec.resolvedAfterDays ?? r.int(1, 14)) * DAY);
  const u = c.g.node("Issue", key, props);
  for (const svc of spec.about) c.g.edge("ABOUT", u, c.ix.serviceUid(svc));
  for (const m of new Set([...title.mentions, ...body.mentions])) if (m !== u) c.g.edge("MENTIONS", u, m);
}

/** Real-data-grounded ticket templates. Each returns null when it doesn't apply. */
function templatedIssues(c: Ctx, count: number, r: Rng): IssueSpec[] {
  const humanRecent = [...c.ix.prs.values()].filter((p) => !p.isBot && p.services.length > 0 && p.services.length <= 3 && p.mergedAt > c.ix.now - 150 * DAY).sort((a, b) => b.number - a.number);
  const botRecent = [...c.ix.prs.values()].filter((p) => p.isBot && p.services.length === 1 && p.mergedAt > c.ix.now - 90 * DAY).sort((a, b) => b.number - a.number);
  const incs = [...c.incidents.values()];
  const makers: ((i: number) => IssueSpec | null)[] = [
    () => {
      const pr = r.pick(humanRecent);
      const svc = pr.services[0]!;
      return { title: `{{svc:${svc}}}: add a regression test for {{prn:${pr.number}}}`, body: `{{pr:${pr.number}}} changed ${pr.files.slice(0, 3).join(", ") || svc}. We have no test that would catch a regression here. {{author:${pr.number}}}, can you suggest the right level (unit vs. integration)?`, status: r.pick(["open", "in_progress", "done"] as const), priority: r.pick(["P3", "P4"] as const), about: [svc], when: { pr: pr.number, offsetDays: r.int(1, 6) } };
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
      return { title: `Review dependency bump {{prn:${pr.number}}} on {{svc:${svc}}}`, body: `{{pr:${pr.number}}} was merged by {{author:${pr.number}}}. Bots are not on call: someone from the owning team should confirm nothing in ${svc} depends on the old behaviour.`, status: r.pick(["open", "done"] as const), priority: "P4", about: [svc], when: { pr: pr.number, offsetDays: r.int(0, 3) } };
    },
    () => {
      const svc = r.pick(c.ix.serviceSlugs.filter((s) => c.ix.expertsOn(s).length >= 2));
      return { title: `Bus factor: {{svc:${svc}}} knowledge sits with two people`, body: `Most changes to {{svc:${svc}}} come from {{expert:${svc}}} and {{expert2:${svc}}}. Pair someone else from the team on the next two changes and write a short how-to.`, status: "open", priority: "P3", about: [svc], when: { daysAgo: r.int(5, 60) } };
    },
    () => {
      const pr = r.pick(humanRecent);
      const svc = pr.services[0]!;
      return { title: `Grafana panel for {{svc:${svc}}} after {{prn:${pr.number}}}`, body: `{{pr:${pr.number}}} added or changed behaviour we cannot see on a dashboard yet. Add a panel (request rate, error rate, p99) for {{svc:${svc}}} to the team dashboard.`, status: r.pick(["open", "in_progress", "done"] as const), priority: "P4", about: [svc], when: { pr: pr.number, offsetDays: r.int(1, 10) } };
    },
  ];
  const out: IssueSpec[] = [];
  for (let i = 0; out.length < count && i < count * 10; i++) {
    const s = makers[i % makers.length]!(i);
    if (s && !out.some((o) => o.title === s.title)) out.push(s);
  }
  return out;
}

/* ───────────────────────────── threads ───────────────────────────── */

function writeThread(c: Ctx, id: string, spec: ThreadSpec, r: Rng): void {
  const title = c.tr.resolve(spec.title);
  const mentions = new Set(title.mentions);
  const lines = spec.lines.map(([speaker, msg]) => {
    const s = c.tr.resolve(speaker);
    const m = c.tr.resolve(msg);
    for (const x of [...s.mentions, ...m.mentions]) mentions.add(x);
    return `${s.text}: ${m.text}`;
  });
  const u = c.g.node("Thread", id, { channel: spec.channel, title: title.text, text: lines.join("\n"), createdAt: whenToMs(c, spec.when, r), synthetic: true });
  for (const svc of spec.about) c.g.edge("ABOUT", u, c.ix.serviceUid(svc));
  for (const m of mentions) if (m !== u) c.g.edge("MENTIONS", u, m);
}

/** One #inc channel thread per incident, voiced by its real responders. */
function incidentThread(c: Ctx, inc: IncidentFacts): ThreadSpec {
  const [a, b, d] = [inc.responders[0]!, inc.responders[1] ?? inc.responders[0]!, inc.responders[2] ?? inc.responders[0]!];
  const p = (s: string) => `{{person:${s}}}`;
  return {
    channel: `#inc-${inc.key.toLowerCase()}`,
    title: `{{inc:${inc.key}}}: ${inc.title}`,
    about: [inc.service],
    when: { incident: inc.key, offsetHours: 0 },
    lines: [
      [p(b), `Paging for {{inc:${inc.key}}}. Alerts firing on {{svc:${inc.service}}}; I'm incident commander.`],
      [p(d), `Looking at what changed recently on {{svc:${inc.service}}} and its dependencies.`],
      [p(b), `Top suspect is {{pr:${inc.causedBy}}}. {{author:${inc.causedBy}}}, can you take a look?`],
      [p(a), `Yes, that's mine. Rolling back now and I'll write up the root cause.`],
      [p(d), `Error rate back to baseline after the rollback. Keeping the incident open for 30 minutes.`],
      [p(b), `Resolved. Runbook updated; postmortem notes go in the incident record.`],
    ],
  };
}

function templatedThreads(c: Ctx, count: number, r: Rng): ThreadSpec[] {
  const out: ThreadSpec[] = [];
  const withExperts = c.ix.serviceSlugs.filter((s) => c.ix.expertsOn(s).length >= 2);
  const recentHuman = [...c.ix.prs.values()].filter((p) => !p.isBot && p.services.length > 0 && p.services.length <= 3 && p.mergedAt > c.ix.now - 60 * DAY).sort((a, b) => b.number - a.number);
  const askers = (svc: string) => {
    const team = c.teams.ownerOf.get(svc)!;
    const outsiders = [...c.teams.teamOf.entries()].filter(([, t]) => t !== team).map(([p]) => p).sort();
    return outsiders.length ? r.pick(outsiders) : r.pick([...c.teams.teamOf.keys()].sort());
  };
  const svcs = r.shuffle(withExperts);
  for (let i = 0; out.length < count && i < svcs.length + recentHuman.length; i++) {
    if (i % 2 === 0 && svcs.length) {
      const svc = svcs[(i / 2) % svcs.length]!;
      const asker = askers(svc);
      out.push({
        channel: "#engineering",
        title: `Who knows {{svc:${svc}}} well?`,
        about: [svc],
        when: { daysAgo: r.int(2, 80) },
        lines: [
          [`{{person:${asker}}}`, `Who knows {{svc:${svc}}} well? I need a reviewer for a change that touches it.`],
          [`{{expert2:${svc}}}`, `{{expert:${svc}}} has written most of {{svc:${svc}}} lately; I can back up.`],
          [`{{expert:${svc}}}`, `Happy to review. Ping me on the PR and tag the owning team channel ${teamSlack(c, svc)}.`],
        ],
      });
    } else if (recentHuman.length) {
      const pr = recentHuman[(i - 1) % recentHuman.length]!;
      const svc = pr.services[0]!;
      const reviewer = c.ix.expertsOn(svc).map((e) => e.slug).find((s) => s !== pr.author) ?? pr.author;
      out.push({
        channel: teamSlack(c, svc),
        title: `Review: {{prn:${pr.number}}} ${pr.title}`,
        about: [svc],
        when: { pr: pr.number, offsetDays: -1 },
        lines: [
          [`{{author:${pr.number}}}`, `Could someone review {{pr:${pr.number}}}? It touches {{svc:${svc}}}.`],
          [`{{person:${reviewer}}}`, `Looking now. Is this safe to roll out without a feature flag?`],
          [`{{author:${pr.number}}}`, `I think so; it's covered by the existing checks. I'll watch the dashboards after merge.`],
        ],
      });
    }
  }
  return out;
}

export function writeBrain(c: Ctx, content: TenantContent): { issues: number; threads: number } {
  const r = c.rng;
  // Issues: hand-written first (stable keys), then templated.
  const issues = [...content.issues, ...templatedIssues(c, content.templatedIssues, r.fork("issue-templates"))];
  issues.forEach((s, i) => c.tr.issues.add(`${content.issuePrefix}-${101 + i}`));
  issues.forEach((s, i) => writeIssue(c, `${content.issuePrefix}-${101 + i}`, s, r.fork(`issue-${i}`)));
  // Threads: hand-written, one per incident, then templated.
  const threads = [
    ...content.threads,
    ...[...c.incidents.values()].map((inc) => incidentThread(c, inc)),
    ...templatedThreads(c, content.templatedThreads, r.fork("thread-templates")),
  ];
  threads.forEach((s, i) => writeThread(c, `t-${String(i + 1).padStart(4, "0")}`, s, r.fork(`thread-${i}`)));
  return { issues: issues.length, threads: threads.length };
}

