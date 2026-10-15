/**
 * `synthesize(real)` = the real snapshot + a SYNTHETIC org on top of it:
 * teams and ownership, fictional personas who staff them, a weekly on-call rotation, past incidents with alerts
 * and runbooks, ADRs, tickets and chat threads, and the demo scenarios.
 *
 * Determinism: the only inputs are the real snapshot (pinned SHA) and the
 * seed. "Now" is the newest PR's merge time. No Math.random, no Date.now.
 */
import type { Scenario, Snapshot } from "@blastradius/shared";
import { CONTENT } from "../content/index.ts";
import { GraphBuilder } from "../graph-builder.ts";
import { Rng } from "../prng.ts";
import type { RealSnapshot } from "../snapshot.ts";
import { writeBrain } from "./brain.ts";
import { RealIndex } from "./context.ts";
import { writeDecisions } from "./decisions.ts";
import { writeIncidents } from "./incidents.ts";
import { rotations, writeOnCall } from "./oncall.ts";
import { writePersonas } from "./personas.ts";
import { buildScenarios } from "./scenarios.ts";
import { deriveTeams, writeTeams } from "./teams.ts";
import { TextResolver } from "./text.ts";

export interface SynthStats {
  teams: Record<string, { services: string[]; members: string[]; personas: string[]; rotation: string[] }>;
  onCallEdges: number;
  incidents: number;
  decisions: number;
  issues: number;
  threads: number;
}

export function synthesize(real: RealSnapshot): { snapshot: Snapshot; scenarios: Scenario[]; stats: SynthStats } {
  const content = CONTENT[real.tenant];
  const ix = new RealIndex(real);
  const rng = new Rng(real.seed);
  const g = new GraphBuilder({ nodes: real.nodes, edges: real.edges });

  const teams = deriveTeams(ix, content.teams);
  writeTeams(g, teams);
  // Personas carry every fictional act involving a person (see personas.ts).
  const personas = writePersonas(g, ix, teams, content.personas);
  const rot = rotations(teams, personas, rng.fork("oncall"));
  const onCallEdges = writeOnCall(g, ix, teams, rot);

  const tr = new TextResolver(ix, personas.names);
  // Register keys up front so prose can reference any incident / ADR / ticket.
  content.incidents.forEach((s) => tr.incidents.add(s.key));
  content.decisions.forEach((s) => tr.decisions.add(s.key));
  const incidents = writeIncidents(g, ix, teams, personas, content.incidents, tr, rng.fork("incidents"));
  writeDecisions(g, ix, teams, personas, content.decisions, tr, rng.fork("decisions"));
  const brain = writeBrain({ g, ix, teams, personas, tr, incidents, rng: rng.fork("brain") }, content);
  const scenarios = buildScenarios(real.tenant, ix, g, incidents, content.scenarios);

  const { nodes, edges } = g.sorted();
  const snapshot: Snapshot = { tenant: real.tenant, generatedAt: real.generatedAt, seed: real.seed, sources: real.sources, nodes, edges };
  const stats: SynthStats = {
    teams: Object.fromEntries(
      teams.seeds.map((t) => [
        t.slug,
        {
          services: [...teams.ownerOf.entries()].filter(([, x]) => x === t.slug).map(([s]) => s).sort(),
          members: teams.members.get(t.slug) ?? [],
          personas: personas.byTeam.get(t.slug) ?? [],
          rotation: rot.get(t.slug) ?? [],
        },
      ]),
    ),
    onCallEdges,
    incidents: incidents.size,
    decisions: content.decisions.length,
    issues: brain.issues,
    threads: brain.threads,
  };
  return { snapshot, scenarios, stats };
}
