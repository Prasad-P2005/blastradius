/**
 * A read-only index over the REAL half of a snapshot, so the synthetic
 * generators can ground everything they write in real PRs, people and
 * services ("who touches what", "which PRs are recent", "who depends on X").
 */
import { uid, type SnapshotNode, type GitPack as Tenant } from "@blastradius/shared";
import type { RealSnapshot } from "../snapshot.ts";
import { DAY } from "../time.ts";

export interface PrInfo {
  number: number;
  uid: string;
  title: string;
  mergedAt: number;
  author: string; // person slug
  authorName: string;
  isBot: boolean;
  services: string[]; // slugs, via MODIFIES → File.service
  files: string[];
}

export interface PersonInfo {
  slug: string;
  uid: string;
  name: string;
  isBot: boolean;
  prCount: number;
  lastSeenAt: number;
}

export class RealIndex {
  readonly tenant: Tenant;
  /** "now" for all synthetic data = newest PR merge time (never the wall clock). */
  readonly now: number;
  readonly prs = new Map<number, PrInfo>();
  readonly people = new Map<string, PersonInfo>();
  readonly services: SnapshotNode[];
  readonly serviceSlugs: string[];
  /** caller slug → callee slugs */
  readonly dependsOn = new Map<string, string[]>();
  /** callee slug → caller slugs */
  readonly dependents = new Map<string, string[]>();

  constructor(readonly real: RealSnapshot) {
    this.tenant = real.tenant;
    this.now = Date.parse(real.generatedAt);
    const fileService = new Map<string, string>();
    for (const n of real.nodes) {
      if (n.label === "File") fileService.set(n.uid, String(n.props.service));
      if (n.label === "Person") {
        const p = n.props;
        this.people.set(String(p.slug), { slug: String(p.slug), uid: n.uid, name: String(p.name), isBot: Boolean(p.isBot), prCount: Number(p.prCount), lastSeenAt: Number(p.lastSeenAt) });
      }
    }
    this.services = real.nodes.filter((n) => n.label === "Service");
    this.serviceSlugs = this.services.map((s) => String(s.props.slug)).sort();
    for (const n of real.nodes) {
      if (n.label !== "PR") continue;
      const p = n.props;
      this.prs.set(Number(p.number), { number: Number(p.number), uid: n.uid, title: String(p.title), mergedAt: Number(p.mergedAt), author: "", authorName: String(p.authorName), isBot: Boolean(p.isBot), services: [], files: [] });
    }
    for (const e of real.edges) {
      if (e.type === "AUTHORED") {
        const pr = this.prs.get(Number(e.to.slice(3)));
        if (pr) pr.author = e.from.slice("Person:".length);
      } else if (e.type === "MODIFIES") {
        const pr = this.prs.get(Number(e.from.slice(3)));
        const svc = fileService.get(e.to);
        if (pr && svc) {
          pr.files.push(e.to.slice("File:".length));
          if (!pr.services.includes(svc)) pr.services.push(svc);
        }
      } else if (e.type === "DEPENDS_ON") {
        const a = e.from.slice(8);
        const b = e.to.slice(8);
        this.dependsOn.set(a, [...(this.dependsOn.get(a) ?? []), b]);
        this.dependents.set(b, [...(this.dependents.get(b) ?? []), a]);
      }
    }
    for (const pr of this.prs.values()) pr.services.sort();
  }

  pr(n: number): PrInfo {
    const p = this.prs.get(n);
    if (!p) throw new Error(`${this.tenant}: PR #${n} is not in the snapshot`);
    return p;
  }

  person(slug: string): PersonInfo {
    const p = this.people.get(slug);
    if (!p) throw new Error(`${this.tenant}: person ${slug} is not in the snapshot`);
    return p;
  }

  hasService(slug: string): boolean {
    return this.serviceSlugs.includes(slug);
  }

  /** Human PRs touching a service, newest first. */
  humanPrsOn(service: string): PrInfo[] {
    return [...this.prs.values()].filter((p) => !p.isBot && p.services.includes(service)).sort((a, b) => b.mergedAt - a.mergedAt || b.number - a.number);
  }

  /** Human authors of a service ranked by PR count (ties: most recent). */
  expertsOn(service: string): { slug: string; prs: number; last: number }[] {
    const m = new Map<string, { slug: string; prs: number; last: number }>();
    for (const p of this.humanPrsOn(service)) {
      const e = m.get(p.author) ?? { slug: p.author, prs: 0, last: 0 };
      e.prs += 1;
      e.last = Math.max(e.last, p.mergedAt);
      m.set(p.author, e);
    }
    return [...m.values()].sort((a, b) => b.prs - a.prs || b.last - a.last || (a.slug < b.slug ? -1 : 1));
  }

  /** Services reachable over DEPENDS_ON from `service` (callees) within maxHops, with hop count. */
  dependenciesWithin(service: string, maxHops: number): Map<string, number> {
    return this.bfs(service, maxHops, this.dependsOn);
  }

  /** Services that (transitively) call `service` within maxHops = its blast radius. */
  dependentsWithin(service: string, maxHops: number): Map<string, number> {
    return this.bfs(service, maxHops, this.dependents);
  }

  private bfs(start: string, maxHops: number, adj: Map<string, string[]>): Map<string, number> {
    const seen = new Map<string, number>([[start, 0]]);
    let frontier = [start];
    for (let hop = 1; hop <= maxHops; hop++) {
      const next: string[] = [];
      for (const s of frontier) for (const t of adj.get(s) ?? []) if (!seen.has(t)) (seen.set(t, hop), next.push(t));
      frontier = next;
    }
    seen.delete(start);
    return seen;
  }

  /**
   * Offline mirror of suspect_changes' default ranking (sinceDays=30,
   * includeDependencies, maxHops=2, humans only, newest first). Used to fail
   * the build early if a scenario's suspect would not be in the top 3; the
   * real check runs against FalkorDB in `verify-scenarios`.
   */
  suspectRanking(service: string, sinceDays = 30, maxHops = 2): PrInfo[] {
    const scope = new Set([service, ...this.dependenciesWithin(service, maxHops).keys()]);
    const since = this.now - sinceDays * DAY;
    return [...this.prs.values()]
      .filter((p) => !p.isBot && p.mergedAt >= since && p.services.some((s) => scope.has(s)))
      .sort((a, b) => b.mergedAt - a.mergedAt || b.number - a.number);
  }

  serviceUid(slug: string): string {
    if (!this.hasService(slug)) throw new Error(`${this.tenant}: unknown service ${slug}`);
    return uid("Service", slug);
  }
}
