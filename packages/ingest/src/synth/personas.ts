/**
 * SYNTHETIC personas: the fictional people of each tenant's organisation.
 *
 * Policy: real git authors only carry REAL facts (they AUTHORED PRs; we
 * derive which team their PRs land in). Anything we invent that involves a
 * person — chat messages, filed tickets, ADR sign-off, on-call weeks,
 * incident response — is done by a persona instead:
 *   Person {uid: 'Person:persona-<slug>', persona:true, synthetic:true, isBot:false, role}
 *   -[:MEMBER_OF]-> Team
 * Names are hand-picked to be clearly fictional; the build fails if one
 * matches a real author in the snapshot.
 */
import { uid } from "@blastradius/shared";
import type { GraphBuilder } from "../graph-builder.ts";
import type { RealIndex } from "./context.ts";
import type { Teams } from "./teams.ts";
import type { PersonaSpec } from "./types.ts";

/** Roles that carry a pager (on-call rotation, first responders). */
// word boundary: "Backend engineer" carries the pager, "Engineering manager" does not
export const ONCALL_ROLE_RE = /\bSRE\b|\bengineer\b/i;
const SRE_ISH_RE = /SRE|Platform/i;

export interface Personas {
  specs: PersonaSpec[];
  /** persona uid → display name */
  names: Map<string, string>;
  /** team slug → persona uids (roster order) */
  byTeam: Map<string, string[]>;
  /** team slug → persona uids who are on call (SREs / engineers) */
  pagerByTeam: Map<string, string[]>;
  role: Map<string, string>;
}

export function personaUid(slug: string): string {
  return uid("Person", `persona-${slug}`);
}

export function writePersonas(g: GraphBuilder, ix: RealIndex, teams: Teams, specs: PersonaSpec[]): Personas {
  const realNames = new Set([...ix.people.values()].map((p) => p.name.toLowerCase()));
  const names = new Map<string, string>();
  const byTeam = new Map<string, string[]>();
  const pagerByTeam = new Map<string, string[]>();
  const role = new Map<string, string>();
  for (const p of specs) {
    if (!teams.seeds.some((t) => t.slug === p.team)) throw new Error(`persona ${p.slug}: unknown team ${p.team}`);
    if (realNames.has(p.name.toLowerCase())) throw new Error(`persona ${p.name} collides with a real contributor`);
    if ([...names.values()].includes(p.name)) throw new Error(`duplicate persona name ${p.name}`);
    const u = g.node("Person", `persona-${p.slug}`, {
      name: p.name, slug: `persona-${p.slug}`, role: p.role, isBot: false, persona: true, synthetic: true,
    });
    g.edge("MEMBER_OF", u, uid("Team", p.team));
    names.set(u, p.name);
    role.set(u, p.role);
    byTeam.set(p.team, [...(byTeam.get(p.team) ?? []), u]);
    if (ONCALL_ROLE_RE.test(p.role)) pagerByTeam.set(p.team, [...(pagerByTeam.get(p.team) ?? []), u]);
  }
  for (const t of teams.seeds) {
    const roster = byTeam.get(t.slug) ?? [];
    if (roster.length < 2) throw new Error(`team ${t.slug} needs ≥2 personas`);
    if (!roster.some((u) => SRE_ISH_RE.test(role.get(u)!))) throw new Error(`team ${t.slug} needs an SRE or platform persona`);
    if ((pagerByTeam.get(t.slug) ?? []).length < 1) throw new Error(`team ${t.slug} has nobody to carry the pager`);
  }
  return { specs, names, byTeam, pagerByTeam, role };
}
