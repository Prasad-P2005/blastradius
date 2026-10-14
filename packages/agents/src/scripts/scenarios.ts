/**
 * pnpm --filter @blastradius/agents scenarios: runs EVERY scenario in
 * data/scenarios.json through the scripted pipeline and checks that the
 * agents' findings (read back from the graph) name what `expected` says:
 *   incident: suspectPr in the cause finding, expert in the expert finding,
 *             pastIncident in the precedent finding, blast radius coverage;
 *   ask:      an expected source among the answer's sources.
 * Prints each run's claims, so a presenter can see the exact demo output.
 * Same isolation flags as smoke (namespace "smoke" by default): --live, --no-load, --tenants.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findRepoRoot, loadRootEnv } from "@blastradius/shared/env";
import { TENANTS, isTenant, type Finding, type Scenario, type Snapshot } from "@blastradius/shared";

loadRootEnv();
const live = process.argv.includes("--live");
const noLoad = live || process.argv.includes("--no-load");
if (!live) process.env.BLASTRADIUS_GRAPH_NAMESPACE ||= "smoke";

const { investigate, loadScenarios, closeDefaultExecutor } = await import("../index.ts");
const graph = await import("@blastradius/graph");
const db = await import("@blastradius/db");
const { Checker, report, runOne } = await import("./checks.ts");

const args = process.argv.slice(2);
const ti = args.indexOf("--tenants");
const tenants = (ti >= 0 ? args[ti + 1]!.split(",") : [...TENANTS]).filter(isTenant);
const scenarios = (await loadScenarios()).filter((s) => tenants.includes(s.tenant));
const c = new Checker();
const warnings: string[] = [];

const has = (fs: Finding[], kind: string, u: string) => fs.some((f) => f.kind === kind && (f.about.includes(u) || f.evidence.includes(u)));

try {
  if (!noLoad) {
    for (const t of tenants) {
      const snap = JSON.parse(await readFile(join(findRepoRoot(), "data", `${t}.json`), "utf8")) as Snapshot;
      await graph.loadSnapshot(t, snap, { reset: true });
    }
  }
  for (const s of scenarios as Scenario[]) {
    const o = await runOne(investigate, {
      tenant: s.tenant,
      mode: s.mode,
      message: s.question,
      scenarioId: s.id,
      ...(s.alert ? { alert: s.alert } : {}),
      agentMode: "scripted",
    });
    const ok = o.events.at(-1)?.type === "run_finished" && (o.events.at(-1) as { status: string }).status === "ok";
    c.ok(ok, `${s.id}: run finished ok`);
    const findings = o.events.flatMap((e) => (e.type === "finding" ? [e.finding] : []));
    console.log(`\n── ${s.id} (${s.tenant}/${s.mode}, ${o.ms} ms) "${s.question}"`);
    for (const f of findings) console.log(`   [${f.agent}/${f.kind}] ${f.claim}`);
    const ex = s.expected ?? {};
    if (s.mode === "incident") {
      // SPEC §10 quality bar (failures): expected items in the top 3 of the tool the agent used.
      const top3 = (tool: string, col: string) => {
        const e = o.events.find((x) => x.type === "tool_result" && x.tool === tool);
        return e?.type === "tool_result" ? (e.result?.rows ?? []).slice(0, 3).map((r) => String(r[col])) : [];
      };
      if (ex.suspectPr) c.ok(top3("suspect_changes", "pr").includes(ex.suspectPr), `${s.id}: ${ex.suspectPr} in suspect_changes top 3 (${top3("suspect_changes", "pr").join(", ")})`);
      if (ex.expert) c.ok(top3("who_knows", "person").includes(ex.expert), `${s.id}: ${ex.expert} in who_knows top 3 (${top3("who_knows", "person").join(", ")})`);
      if (ex.pastIncident) {
        const seen = [...top3("past_incidents", "incident"), ...top3("similar_incidents", "incident")];
        c.ok(seen.includes(ex.pastIncident), `${s.id}: ${ex.pastIncident} in past/similar incidents top 3`);
      }
      if (ex.blastRadius?.length) {
        const impact = findings.find((f) => f.kind === "impact");
        const covered = ex.blastRadius.filter((u) => impact?.about.includes(u) || impact?.evidence.includes(u));
        c.ok(covered.length >= Math.min(2, ex.blastRadius.length), `${s.id}: impact covers ${covered.length}/${ex.blastRadius.length} expected services`);
      }
      // Stricter, informational: did the agent's finding NAME the expected item?
      const warn = (cond: boolean, what: string) => {
        if (!cond) warnings.push(`${s.id}: ${what}`);
      };
      if (ex.suspectPr) warn(has(findings, "cause", ex.suspectPr), `cause finding names ${findings.find((f) => f.kind === "cause")?.about[0]}, expected ${ex.suspectPr}`);
      if (ex.expert) warn(has(findings, "expert", ex.expert), `expert finding does not name ${ex.expert}`);
      if (ex.pastIncident) warn(has(findings, "precedent", ex.pastIncident), `precedent finding names ${findings.find((f) => f.kind === "precedent")?.about[0]}, expected ${ex.pastIncident}`);
    } else if (ex.sources?.length) {
      const answer = findings.filter((f) => f.kind === "answer");
      c.ok(ex.sources.some((u) => answer.some((f) => f.evidence.includes(u) || f.about.includes(u))), `${s.id}: answer cites an expected source`);
    }
  }
} catch (err) {
  c.ok(false, `scenarios crashed: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  await closeDefaultExecutor();
  await graph.closeFalkor().catch(() => {});
  await db.closeDb();
}
if (warnings.length) console.log(`\n! ${warnings.length} findings name a different item than scenarios.json expects (allowed by SPEC §10, worth a look):\n${warnings.map((w) => `  - ${w}`).join("\n")}`);
process.exit(report(c, `scenarios (${scenarios.length})`) ? 0 : 1);
