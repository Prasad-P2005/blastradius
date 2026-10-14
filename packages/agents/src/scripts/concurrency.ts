/**
 * pnpm concurrency: 10 investigations at once across both tenants (scripted),
 * then proves isolation and integrity by reading the stores back:
 *
 *   - no cross-tenant leaks: every finding's about/evidence uid exists in ITS
 *     tenant's graph, and none of the other tenant's session ids appear there;
 *   - every session's Episode chain is intact (seq 0..n-1, one NEXT per step,
 *     no forks, no duplicates) — including one session shared by two
 *     concurrent runs, the real race;
 *   - no event seq gaps in Postgres, and every run's normal checks pass.
 * Prints timing. Exits non-zero on failure.
 *
 * Isolation and options are the same as smoke (namespace "concurrency" by
 * default, loaded from data/<tenant>.json): --tenants, --scenarios, --live, --no-load, --runs N.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findRepoRoot, loadRootEnv } from "@blastradius/shared/env";
import { TENANTS, isTenant, type InvestigateRequest, type Scenario, type Snapshot, type Tenant } from "@blastradius/shared";

loadRootEnv();
const live = process.argv.includes("--live");
const noLoad = live || process.argv.includes("--no-load");
if (!live) process.env.BLASTRADIUS_GRAPH_NAMESPACE ||= "concurrency";

const { investigate, loadScenarios, closeDefaultExecutor } = await import("../index.ts");
const graph = await import("@blastradius/graph");
const db = await import("@blastradius/db");
const { Checker, checkEpisodeChain, checkNoForeignSessions, checkRun, checkUidsExist, report, runOne } = await import("./checks.ts");

const args = process.argv.slice(2).filter((a) => a !== "--");
const argOf = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const tenants = (argOf("--tenants")?.split(",") ?? [...TENANTS]).filter(isTenant) as Tenant[];
const runs = Number(argOf("--runs") ?? 10);
const scenarios: Scenario[] = argOf("--scenarios")
  ? (JSON.parse(await readFile(argOf("--scenarios")!, "utf8")) as Scenario[])
  : await loadScenarios();

const c = new Checker();
const tAll = Date.now();

function toRequest(s: Scenario, sessionId?: string): InvestigateRequest {
  return {
    tenant: s.tenant,
    mode: s.mode,
    message: s.question,
    scenarioId: s.id,
    ...(s.alert ? { alert: s.alert } : {}),
    ...(sessionId ? { sessionId } : {}),
    agentMode: "scripted",
  };
}

try {
  if (!(await graph.falkorHealth()).ok) throw new Error("FalkorDB is not reachable");
  console.log(`graph namespace: ${process.env.BLASTRADIUS_GRAPH_NAMESPACE || "(none: live demo graph)"}`);
  if (!noLoad) {
    for (const tenant of tenants) {
      const snap = JSON.parse(await readFile(join(findRepoRoot(), "data", `${tenant}.json`), "utf8")) as Snapshot;
      const stats = await graph.loadSnapshot(tenant, snap, { reset: true });
      console.log(`loaded data/${tenant}.json: ${stats.nodes} nodes, ${stats.edges} edges in ${stats.ms} ms`);
    }
  }

  // Build the batch: round-robin over tenants and their scenarios (incident + ask).
  const pool = tenants.map((t) => scenarios.filter((s) => s.tenant === t && (s.mode === "ask" || s.alert?.service)));
  for (const [i, t] of tenants.entries()) if (!pool[i]!.length) throw new Error(`no scenarios for ${t}`);
  const reqs: InvestigateRequest[] = [];
  for (let i = 0; reqs.length < runs - 1; i++) {
    const p = pool[i % tenants.length]!;
    reqs.push(toRequest(p[Math.floor(i / tenants.length) % p.length]!));
  }
  // The last run CONTINUES the first run's session concurrently: two writers, one Episode chain.
  const sharedSession = `s_conc_${Date.now().toString(36)}`;
  reqs[0] = { ...reqs[0]!, sessionId: sharedSession };
  reqs.push({ ...reqs[0]!, message: `${reqs[0]!.message} (follow-up)` });

  console.log(`running ${reqs.length} investigations at once: ${reqs.map((r) => `${r.tenant}/${r.mode}`).join(", ")}`);
  const t0 = Date.now();
  const outcomes = await Promise.all(reqs.map((r) => runOne(investigate, r)));
  const wall = Date.now() - t0;
  const each = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  console.log(`wall ${wall} ms; per run min ${each[0]} / median ${each[Math.floor(each.length / 2)]} / max ${each.at(-1)} ms; ${outcomes.reduce((n, o) => n + o.events.length, 0)} events`);

  // Per-run checks (findings, handoffs, claims, exact cypher, pg events). The shared
  // session holds two runs' findings, so its per-run checks are done on the run level only.
  const findingsByTenant = new Map<Tenant, Map<string, import("@blastradius/shared").Finding[]>>();
  for (const o of outcomes) {
    const fs = await checkRun(c, o, graph, db, { expectActions: o.req.mode === "incident" });
    const m = findingsByTenant.get(o.req.tenant) ?? new Map();
    m.set(o.sessionId, fs);
    findingsByTenant.set(o.req.tenant, m);
  }
  c.ok(outcomes[0]!.sessionId === sharedSession && outcomes.at(-1)!.sessionId === sharedSession, "two runs shared one session");

  // Episode chains (the shared session must have both runs' episodes in one clean chain).
  const sessions = [...new Map(outcomes.map((o) => [o.sessionId, o])).values()];
  for (const o of sessions) {
    const perRun = o.req.mode === "incident" ? 8 : 2; // incident: user_message, recall, 3 agents, ≥2 actions, scribe; ask: user_message, navigator
    const min = o.sessionId === sharedSession ? perRun * 2 : perRun;
    await checkEpisodeChain(c, graph, o.req.tenant, o.sessionId, min);
  }

  // Cross-tenant isolation.
  for (const tenant of tenants) {
    const mine = findingsByTenant.get(tenant) ?? new Map();
    const all = [...mine.values()].flat();
    await checkUidsExist(c, graph, tenant, all, `${tenant} findings`);
    for (const f of all) c.ok(mine.has(f.sessionId), `${tenant}: finding ${f.id} belongs to one of ${tenant}'s sessions`);
    const others = sessions.filter((o) => o.req.tenant !== tenant).map((o) => o.sessionId);
    await checkNoForeignSessions(c, graph, tenant, others);
  }
  console.log(`checked ${sessions.length} sessions across ${tenants.join(", ")}`);
} catch (err) {
  c.ok(false, `concurrency crashed: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  await closeDefaultExecutor();
  await graph.closeFalkor().catch(() => {});
  await db.closeDb();
}

const passed = report(c, `concurrency (${runs} runs) in ${Date.now() - tAll} ms`);
process.exit(passed ? 0 : 1);
