/**
 * SYNTHETIC teams, derived from REAL authorship.
 *
 * Open-source repos have no org chart, so we invent one that is consistent
 * with who actually touches what:
 *   1. Each tenant's content file names 3–5 teams and a couple of "anchor"
 *      services per team (e.g. Cart & Catalog anchors cart + product-catalog).
 *   2. Every other service joins the team whose services share the most
 *      human authors with it (Jaccard similarity of author sets). Services
 *      with no human authors (stock datastores) join the team of a service
 *      that calls them.
 *   3. Every human who touched a service becomes MEMBER_OF the team whose
 *      services they touched most. Teams left with fewer than two members
 *      borrow the people who touched them most from the largest teams.
 * Output: Team nodes (synthetic:true), OWNS and MEMBER_OF edges.
 */
import { uid } from "@blastradius/shared";
import type { GraphBuilder } from "../graph-builder.ts";
import type { RealIndex } from "./context.ts";

export interface TeamSeed {
  slug: string;
  name: string;
  slack: string;
  anchors: string[];
}

export interface Teams {
  /** service slug → team slug */
  ownerOf: Map<string, string>;
  /** team slug → member person slugs (sorted by PRs on the team's services, desc) */
  members: Map<string, string[]>;
  /** person slug → team slug */
  teamOf: Map<string, string>;
  seeds: TeamSeed[];
}

export function deriveTeams(ix: RealIndex, seeds: TeamSeed[]): Teams {
  const ownerOf = new Map<string, string>();
  for (const t of seeds) for (const a of t.anchors) ownerOf.set(ix.serviceUid(a).slice(8), t.slug);

  const authorsOf = (svc: string) => new Set(ix.humanPrsOn(svc).map((p) => p.author));
  const jaccard = (a: Set<string>, b: Set<string>) => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  };

  // 2a. services with human authors: most similar team (author overlap).
  const unassigned = ix.serviceSlugs.filter((s) => !ownerOf.has(s));
  for (const svc of unassigned) {
    const mine = authorsOf(svc);
    if (!mine.size) continue;
    let best: { team: string; score: number } | null = null;
    for (const t of seeds) {
      const teamAuthors = new Set<string>();
      for (const [s, owner] of ownerOf) if (owner === t.slug) for (const a of authorsOf(s)) teamAuthors.add(a);
      const score = jaccard(mine, teamAuthors);
      if (!best || score > best.score) best = { team: t.slug, score };
    }
    ownerOf.set(svc, best!.team);
  }
  // 2b. services without human authors: follow a caller (then a callee), else the last team.
  for (let pass = 0; pass < 3; pass++) {
    for (const svc of ix.serviceSlugs) {
      if (ownerOf.has(svc)) continue;
      const near = [...(ix.dependents.get(svc) ?? []), ...(ix.dependsOn.get(svc) ?? [])].sort().find((s) => ownerOf.has(s));
      if (near) ownerOf.set(svc, ownerOf.get(near)!);
    }
  }
  for (const svc of ix.serviceSlugs) if (!ownerOf.has(svc)) ownerOf.set(svc, seeds[seeds.length - 1]!.slug);

  // 3. membership by where each human's PRs land.
  const score = new Map<string, Map<string, number>>(); // person → team → touches
  for (const pr of ix.prs.values()) {
    if (pr.isBot) continue;
    for (const svc of pr.services) {
      const team = ownerOf.get(svc)!;
      const m = score.get(pr.author) ?? new Map<string, number>();
      m.set(team, (m.get(team) ?? 0) + 1);
      score.set(pr.author, m);
    }
  }
  const teamOf = new Map<string, string>();
  for (const [person, m] of [...score.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1] || seeds.findIndex((s) => s.slug === a[0]) - seeds.findIndex((s) => s.slug === b[0]))[0]!;
    teamOf.set(person, best[0]);
  }
  const membersOf = (t: string) => [...teamOf.entries()].filter(([, team]) => team === t).map(([p]) => p);
  for (const t of seeds) {
    while (membersOf(t.slug).length < 2) {
      const donor = [...score.entries()]
        .filter(([p, m]) => teamOf.get(p) !== t.slug && (m.get(t.slug) ?? 0) > 0 && membersOf(teamOf.get(p)!).length > 3)
        .sort((a, b) => (b[1].get(t.slug) ?? 0) - (a[1].get(t.slug) ?? 0) || (a[0] < b[0] ? -1 : 1))[0];
      const fallback = donor ?? [...teamOf.entries()].filter(([, team]) => membersOf(team).length > 3).map(([p]) => [p] as const).sort()[0];
      if (!fallback) break;
      teamOf.set(fallback[0], t.slug);
    }
  }
  const members = new Map<string, string[]>();
  for (const t of seeds) {
    const ms = membersOf(t.slug);
    ms.sort((a, b) => (score.get(b)?.get(t.slug) ?? 0) - (score.get(a)?.get(t.slug) ?? 0) || ix.person(b).lastSeenAt - ix.person(a).lastSeenAt || (a < b ? -1 : 1));
    members.set(t.slug, ms);
  }
  return { ownerOf, members, teamOf, seeds };
}

export function writeTeams(g: GraphBuilder, teams: Teams): void {
  for (const t of teams.seeds) g.node("Team", t.slug, { name: t.name, slug: t.slug, slack: t.slack, synthetic: true });
  for (const [svc, team] of teams.ownerOf) g.edge("OWNS", uid("Team", team), uid("Service", svc));
  for (const [person, team] of teams.teamOf) g.edge("MEMBER_OF", uid("Person", person), uid("Team", team));
}
