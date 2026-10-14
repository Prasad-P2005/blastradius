/**
 * pnpm smoke: end-to-end check of the agent pipeline against the REAL graph
 * (FalkorDB) and Postgres, in scripted mode.
 *
 * For each tenant: one incident scenario, then closeIncident, then a second
 * run on the same service that must RECALL the closed incident (cross-session
 * memory). Plus one ask scenario. Asserts (reading the stores back):
 *   - every agent recorded ≥1 finding with evidence + cypher (in the graph)
 *   - every finding's cypher[] is exactly a query that ran (lesson 5)
 *   - the HANDED_TO chain triage → investigator → expert → scribe exists
 *   - agent_message claims reference real findings with cypher
 *   - ≥1 action recorded in Postgres (dry_run is fine)
 *   - all events persisted to Postgres with seq 0..n-1
 *   - the Episode chain is intact
 * Exits non-zero on any failure.
 *
 * Isolation: smoke writes sessions, findings and a closed "(smoke)" Incident.
 * So that it never pollutes the demo graph, it runs by default in the graph
 * namespace "smoke" (BLASTRADIUS_GRAPH_NAMESPACE, keys `smoke_blastradius_<tenant>`)
 * and first loads data/<tenant>.json into it. Same data, same queries.
 *
 * Options:
 *   --tenants acme,globex
 *   --scenarios <path>   Scenario[] JSON (default data/scenarios.json)
 *   --live               use the configured graph as is (no namespace, no load)
 *   --no-load            keep the namespace's current contents (skip loading)
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findRepoRoot, loadRootEnv } from "@blastradius/shared/env";
import { TENANTS, isTenant, type InvestigateRequest, type Scenario, type Snapshot, type Tenant } from "@blastradius/shared";

loadRootEnv();
const live = process.argv.includes("--live");
const noLoad = live || process.argv.includes("--no-load");
if (!live) process.env.BLASTRADIUS_GRAPH_NAMESPACE ||= "smoke";
const { investigate, closeIncident, loadScenarios, closeDefaultExecutor } = await import("../index.ts");
const graph = await import("@blastradius/graph");
const db = await import("@blastradius/db");
const { Checker, checkEpisodeChain, checkRun, report, runOne } = await import("./checks.ts");

const args = process.argv.slice(2).filter((a) => a !== "--");
const argOf = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const tenants = (argOf("--tenants")?.split(",") ?? [...TENANTS]).filter(isTenant);
const scenarios: Scenario[] = argOf("--scenarios")
  ? (JSON.parse(await readFile(argOf("--scenarios")!, "utf8")) as Scenario[])
  : await loadScenarios();

const c = new Checker();
const t0 = Date.now();

function toRequest(s: Scenario): InvestigateRequest {
  return {
    tenant: s.tenant,
    mode: s.mode,
    message: s.question,
    scenarioId: s.id,
    ...(s.alert ? { alert: s.alert } : {}),
    agentMode: "scripted",
  };
}

try {
  const health = await graph.falkorHealth();
  if (!health.ok) throw new Error(`FalkorDB is not reachable: ${health.error}`);
  if (!(await db.pgHealth()).ok) console.warn("! Postgres is not reachable: persistence checks will fail");
  if (!scenarios.length) throw new Error("no scenarios (data/scenarios.json missing?) — pass --scenarios <file>");
  console.log(`graph namespace: ${process.env.BLASTRADIUS_GRAPH_NAMESPACE || "(none: live demo graph)"}`);
  if (!noLoad) {
    for (const tenant of tenants) {
      const snap = JSON.parse(await readFile(join(findRepoRoot(), "data", `${tenant}.json`), "utf8")) as Snapshot;
      const stats = await graph.loadSnapshot(tenant, snap, { reset: true });
      console.log(`loaded data/${tenant}.json: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.embedded} embedded in ${stats.ms} ms`);
    }
  }

  for (const tenant of tenants as Tenant[]) {
    const incident = scenarios.find((s) => s.tenant === tenant && s.mode === "incident" && s.alert?.service);
    if (!c.ok(incident, `${tenant}: has an incident scenario with an alert`)) continue;
    console.log(`\n── ${tenant} incident: ${incident!.id} "${incident!.question}"`);
    const first = await runOne(investigate, toRequest(incident!));
    console.log(`   session ${first.sessionId}: ${first.events.length} events in ${first.ms} ms`);
    const findings = await checkRun(c, first, graph, db, { expectActions: true });
    await checkEpisodeChain(c, graph, tenant, first.sessionId, 8);

    // Close it (procedural memory) and check the next session recalls it.
    const cause = findings.find((f) => f.kind === "cause");
    const expert = findings.find((f) => f.kind === "expert");
    const closed = await closeIncident({
      tenant,
      sessionId: first.sessionId,
      title: `${incident!.title} (smoke)`,
      summary: findings.find((f) => f.kind === "summary")?.claim ?? incident!.question,
      severity: "SEV2",
      service: incident!.alert!.service,
      ...(cause?.about.find((u) => u.startsWith("PR:")) ? { causedByPr: cause.about.find((u) => u.startsWith("PR:"))! } : {}),
      responders: (expert?.about ?? []).filter((u) => u.startsWith("Person:")),
      runbook: { title: `Smoke runbook for ${incident!.alert!.service}`, steps: ["Check the suspect PR", "Roll back if confirmed", "Watch the error rate"] },
      findingIds: findings.map((f) => f.id),
    });
    console.log(`   closed as ${closed.incidentUid}`);
    const second = await runOne(investigate, { ...toRequest(incident!), message: `${incident!.question} (again)` });
    const recalled = second.events.find((e) => e.type === "memory_recalled");
    const uids = recalled?.type === "memory_recalled" ? recalled.memories.map((m) => m.uid) : [];
    c.ok(uids.includes(closed.incidentUid), `${tenant}: next session recalls ${closed.incidentUid} (got ${uids.slice(0, 5).join(", ") || "nothing"})`);
    c.ok(
      recalled?.type === "memory_recalled" && recalled.memories.every((m) => m.sessionId !== second.sessionId),
      `${tenant}: recall excludes the current session`,
    );
    await checkRun(c, second, graph, db, { expectActions: true });
  }

  const ask = scenarios.find((s) => s.mode === "ask" && tenants.includes(s.tenant));
  if (c.ok(ask, "has an ask scenario")) {
    console.log(`\n── ${ask!.tenant} ask: ${ask!.id} "${ask!.question}"`);
    const o = await runOne(investigate, toRequest(ask!));
    console.log(`   session ${o.sessionId}: ${o.events.length} events in ${o.ms} ms`);
    await checkRun(c, o, graph, db, { expectActions: false });
    const msg = o.events.find((e) => e.type === "agent_message");
    if (msg?.type === "agent_message") console.log(`   navigator: ${msg.text.slice(0, 300)}`);
    if (ask!.expected?.sources?.length) {
      const ac = o.events.find((e) => e.type === "tool_result" && e.tool === "ask_company");
      const top3 = ac?.type === "tool_result" ? (ac.result?.rows ?? []).slice(0, 3).map((r) => String(r.source)) : [];
      c.ok(ask!.expected.sources.some((s) => top3.includes(s)), `ask_company top 3 contains an expected source (${top3.join(", ")})`);
    }
  }
} catch (err) {
  c.ok(false, `smoke crashed: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  await closeDefaultExecutor();
  await graph.closeFalkor().catch(() => {});
  await db.closeDb();
}

const passed = report(c, `smoke (${tenants.join(", ")}) in ${Date.now() - t0} ms`);
process.exit(passed ? 0 : 1);
