/**
 * SYNTHETIC weekly on-call rotation, carried by PERSONAS (never real people).
 *
 * Each team rotates one persona per week across ALL the services it owns:
 * one `(Person {persona:true})-[:ON_CALL_FOR {weekStart, weekStartTs}]->(Service)`
 * edge per persona, service and week. The loader MERGEs on weekStart
 * (CLAUDE.md lesson 1), so weeks never collapse into one edge.
 *
 * Range: from 12 weeks before the newest PR through 2027-12-31, so the real
 * "this week" is covered whenever we demo, with no wall-clock dependence.
 * The pool is the team's SRE / engineer personas; the order is a seeded
 * shuffle, so the rotation is deterministic but not alphabetical.
 */
import type { GraphBuilder } from "../graph-builder.ts";
import type { Rng } from "../prng.ts";
import { WEEK, isoDate, mondaysBetween } from "../time.ts";
import type { RealIndex } from "./context.ts";
import type { Personas } from "./personas.ts";
import type { Teams } from "./teams.ts";

export const ONCALL_UNTIL = "2027-12-31";

/** team → rotation order (persona uids). */
export function rotations(teams: Teams, personas: Personas, rng: Rng): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of teams.seeds) out.set(t.slug, rng.fork(t.slug).shuffle(personas.pagerByTeam.get(t.slug) ?? []));
  return out;
}

/** Who is on call for `team` in the week starting `monday` (epoch ms). */
export function onCallFor(rot: Map<string, string[]>, team: string, monday: number): string | null {
  const pool = rot.get(team) ?? [];
  if (!pool.length) return null;
  const weekNo = Math.floor(monday / WEEK); // stable absolute week number
  return pool[((weekNo % pool.length) + pool.length) % pool.length]!;
}

export function writeOnCall(g: GraphBuilder, ix: RealIndex, teams: Teams, rot: Map<string, string[]>): number {
  let n = 0;
  for (const monday of mondaysBetween(ix.now - 12 * WEEK, ONCALL_UNTIL)) {
    const weekStart = isoDate(monday);
    for (const [svc, team] of [...teams.ownerOf.entries()].sort()) {
      const persona = onCallFor(rot, team, monday);
      if (!persona) continue;
      g.edge("ON_CALL_FOR", persona, `Service:${svc}`, { weekStart, weekStartTs: monday });
      n++;
    }
  }
  return n;
}
