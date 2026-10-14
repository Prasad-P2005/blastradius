/**
 * SYNTHETIC weekly on-call rotation.
 *
 * Each team rotates one human per week across ALL the services it owns:
 * one `(Person)-[:ON_CALL_FOR {weekStart, weekStartTs}]->(Service)` edge per
 * person, service and week. The loader MERGEs on weekStart (CLAUDE.md lesson 1),
 * so weeks never collapse into one edge.
 *
 * Range: from 12 weeks before the newest PR through 2027-12-31, so the real
 * "this week" is covered whenever we demo, with no wall-clock dependence.
 * The pool is the team's most active members (up to 5); the order is a
 * seeded shuffle, so the rotation is deterministic but not alphabetical.
 */
import { uid } from "@blastradius/shared";
import type { GraphBuilder } from "../graph-builder.ts";
import type { Rng } from "../prng.ts";
import { WEEK, isoDate, mondaysBetween } from "../time.ts";
import type { RealIndex } from "./context.ts";
import type { Teams } from "./teams.ts";

export const ONCALL_UNTIL = "2027-12-31";
export const ONCALL_POOL_SIZE = 5;

/** team → rotation order (person slugs). */
export function rotations(teams: Teams, rng: Rng): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of teams.seeds) {
    const pool = (teams.members.get(t.slug) ?? []).slice(0, ONCALL_POOL_SIZE);
    out.set(t.slug, rng.fork(t.slug).shuffle(pool));
  }
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
      const person = onCallFor(rot, team, monday);
      if (!person) continue;
      g.edge("ON_CALL_FOR", uid("Person", person), uid("Service", svc), { weekStart, weekStartTs: monday });
      n++;
    }
  }
  return n;
}
