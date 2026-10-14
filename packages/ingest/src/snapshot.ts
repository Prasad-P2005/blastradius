/**
 * The REAL half of a tenant snapshot, built from git history:
 *
 *   Service  (curated catalog, services.ts)      synthetic:false
 *   File     (repo paths that map to a service)  synthetic:false
 *   PR       (merged PRs: title, sha, time, +/-) synthetic:false
 *   Person   (authors, by slugified name)        synthetic:false
 *   DEPENDS_ON (curated, deps.ts) · PART_OF · AUTHORED · MODIFIES
 *
 * TOUCHES (PR→Service) is NOT written here: packages/graph derives it at load.
 * The same PR→subgraph code is reused for delta files (`buildPrSubgraph`).
 */
import { uid, type Json, type Snapshot, type SnapshotEdge, type SnapshotNode, type Tenant } from "@blastradius/shared";
import { DEPENDENCIES } from "./deps.ts";
import { readMergedPrs, type RawPr } from "./git.ts";
import { GraphBuilder } from "./graph-builder.ts";
import { isBotName, personSlug } from "./people.ts";
import { prUrl, type SourceConfig } from "./sources.ts";
import { SERVICES, languageForPath, serviceForPath } from "./services.ts";

export interface PersonStats {
  slug: string;
  name: string;
  isBot: boolean;
  prCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** Aggregate authorship per person slug. Display name = most frequent spelling. */
export function personStats(prs: RawPr[], base?: Map<string, PersonStats>): Map<string, PersonStats> {
  const out = new Map<string, PersonStats>();
  for (const [k, v] of base ?? []) out.set(k, { ...v });
  const spellings = new Map<string, Map<string, number>>();
  for (const pr of prs) {
    const slug = personSlug(pr.authorName);
    const sp = spellings.get(slug) ?? new Map<string, number>();
    sp.set(pr.authorName, (sp.get(pr.authorName) ?? 0) + 1);
    spellings.set(slug, sp);
    const p = out.get(slug);
    if (!p) {
      out.set(slug, { slug, name: pr.authorName, isBot: isBotName(pr.authorName), prCount: 1, firstSeenAt: pr.mergedAt, lastSeenAt: pr.mergedAt });
    } else {
      p.prCount += 1;
      p.firstSeenAt = Math.min(p.firstSeenAt, pr.mergedAt);
      p.lastSeenAt = Math.max(p.lastSeenAt, pr.mergedAt);
    }
  }
  for (const [slug, sp] of spellings) {
    const p = out.get(slug)!;
    if (base?.has(slug)) continue; // keep the established display name
    const best = [...sp.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    p.name = best;
  }
  return out;
}

/**
 * PR, File, Person nodes and AUTHORED / MODIFIES / PART_OF edges for `prs`.
 * `people` must already include every author of `prs`.
 */
export function buildPrSubgraph(g: GraphBuilder, tenant: Tenant, src: SourceConfig, prs: RawPr[], people: Map<string, PersonStats>): void {
  for (const pr of prs) {
    const slug = personSlug(pr.authorName);
    const person = people.get(slug)!;
    const prUid = g.node("PR", pr.number, {
      number: pr.number,
      title: pr.title,
      sha: pr.sha,
      mergedAt: pr.mergedAt,
      additions: pr.additions,
      deletions: pr.deletions,
      filesChanged: pr.files.length,
      url: prUrl(src, pr.number),
      isBot: person.isBot,
      authorName: person.name,
      synthetic: false,
    });
    const personUid = g.node("Person", slug, personProps(person));
    g.edge("AUTHORED", personUid, prUid);
    for (const f of pr.files) {
      const svc = serviceForPath(tenant, f.path);
      if (!svc) continue; // only files that belong to a service become nodes
      const fileUid = g.node("File", f.path, { path: f.path, service: svc, language: languageForPath(f.path), synthetic: false });
      g.edge("PART_OF", fileUid, uid("Service", svc));
      g.edge("MODIFIES", prUid, fileUid, { additions: f.additions, deletions: f.deletions });
    }
  }
}

export function personProps(p: PersonStats): Record<string, Json> {
  return { name: p.name, slug: p.slug, isBot: p.isBot, prCount: p.prCount, firstSeenAt: p.firstSeenAt, lastSeenAt: p.lastSeenAt, synthetic: false };
}

export function addServices(g: GraphBuilder, tenant: Tenant): void {
  for (const s of SERVICES[tenant]) {
    const props: Record<string, Json> = {
      name: s.name, slug: s.slug, language: s.language, kind: s.kind, repoPath: s.repoPath,
      description: s.description, tier: s.tier, synthetic: false,
    };
    if (s.deployment) props.deployment = s.deployment;
    g.node("Service", s.slug, props);
  }
  for (const d of DEPENDENCIES[tenant]) {
    g.edge("DEPENDS_ON", uid("Service", d.from), uid("Service", d.to), { protocol: d.protocol, source: d.source });
  }
}

/** Selects the newest `prLimit` PRs plus any landmark PRs found further back. */
export function selectPrs(all: RawPr[], src: SourceConfig): { kept: RawPr[]; missingLandmarks: number[] } {
  const kept = all.slice(0, src.prLimit);
  const keptNums = new Set(kept.map((p) => p.number));
  const missing: number[] = [];
  for (const n of src.landmarkPrs) {
    if (keptNums.has(n)) continue;
    const pr = all.find((p) => p.number === n);
    if (pr) kept.push(pr);
    else missing.push(n);
  }
  return { kept, missingLandmarks: missing };
}

export interface RealSnapshot extends Snapshot {
  /** Extra bookkeeping for `synth` (not part of the contract; stripped from data/*.json). */
  meta: { headSha: string; prsInHistory: number; humanPrs: number; botPrs: number; missingLandmarks: number[] };
}

export function buildRealSnapshot(tenant: Tenant, src: SourceConfig, dir: string, headSha: string): RealSnapshot {
  const all = readMergedPrs(dir, { to: src.snapshotSha });
  const { kept, missingLandmarks } = selectPrs(all, src);
  const people = personStats(kept);
  const g = new GraphBuilder();
  addServices(g, tenant);
  buildPrSubgraph(g, tenant, src, kept, people);
  const newest = Math.max(...kept.map((p) => p.mergedAt));
  const humanPrs = kept.filter((p) => !people.get(personSlug(p.authorName))!.isBot).length;
  const { nodes, edges } = g.sorted();
  return {
    tenant,
    generatedAt: new Date(newest).toISOString(),
    seed: src.seed,
    sources: [{ repo: src.repo, url: src.url, sha: src.snapshotSha, license: src.license }],
    nodes,
    edges,
    meta: { headSha, prsInHistory: all.length, humanPrs, botPrs: kept.length - humanPrs, missingLandmarks },
  };
}

/**
 * Delta: real PRs in (from, to], mapped exactly like the snapshot. Person
 * props are CUMULATIVE (base snapshot + delta), so applying the delta leaves
 * correct prCount / lastSeenAt on existing people.
 */
export function buildDelta(
  tenant: Tenant,
  src: SourceConfig,
  dir: string,
  range: { from: string; to: string },
  baseNodes: SnapshotNode[],
  opts: { limit?: number } = {},
): { nodes: SnapshotNode[]; edges: SnapshotEdge[]; prs: RawPr[] } {
  let prs = readMergedPrs(dir, range);
  const baseNums = new Set(baseNodes.filter((n) => n.label === "PR").map((n) => Number(n.props.number)));
  prs = prs.filter((p) => !baseNums.has(p.number));
  if (opts.limit) prs = prs.slice(0, opts.limit);
  const base = new Map<string, PersonStats>();
  for (const n of baseNodes) {
    if (n.label !== "Person") continue;
    const p = n.props;
    base.set(String(p.slug), { slug: String(p.slug), name: String(p.name), isBot: Boolean(p.isBot), prCount: Number(p.prCount), firstSeenAt: Number(p.firstSeenAt), lastSeenAt: Number(p.lastSeenAt) });
  }
  const people = personStats(prs, base);
  const g = new GraphBuilder();
  buildPrSubgraph(g, tenant, src, prs, people);
  const { nodes, edges } = g.sorted();
  return { nodes, edges, prs };
}
