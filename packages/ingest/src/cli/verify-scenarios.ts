/**
 * `pnpm --filter @blastradius/ingest verify-scenarios [--tenant acme] [--no-load] [--with-deltas] [--markdown]`
 *
 * Checks every scenario in data/scenarios.json against the SPEC §10 quality
 * bar by running the REAL tools (runTool from @blastradius/graph) on a freshly
 * loaded graph:
 *   incident: (a) blast_radius ≥ 2 services
 *             (b) expected.suspectPr in the top 3 of suspect_changes (default args)
 *             (c) a human in the top 3 of who_knows (and whether expected.expert is)
 *             (d) ≥1 past incident/runbook from past_incidents or similar_incidents
 *   ask:      ask_company returns one of expected.sources in its top 3
 * --with-deltas then applies data/deltas/<tenant>.json (ingestDelta) and checks
 * again, and finally reloads the clean snapshot so the graph is left canonical.
 * Exits 1 if any scenario fails on the canonical snapshot.
 */
import { loadRootEnv } from "@blastradius/shared/env";
loadRootEnv();

import type { Scenario, Snapshot, SnapshotEdge, SnapshotNode, SeedPack as Tenant } from "@blastradius/shared";
import { closeFalkor, embeddingBackend, ingestDelta, loadSnapshot, runTool } from "@blastradius/graph";
import { readJson } from "../write.ts";
import { boolArg, dataPath, fail, parseArgs, tenantsFromArgs } from "./common.ts";

interface Result {
  id: string;
  tenant: Tenant;
  phase: "snapshot" | "with-deltas";
  checks: { name: string; pass: boolean; detail: string }[];
}

const top = <T>(xs: T[], n = 3) => xs.slice(0, n);

async function verify(s: Scenario, phase: Result["phase"]): Promise<Result> {
  const ctx = { tenant: s.tenant };
  const checks: Result["checks"] = [];
  if (s.mode === "ask") {
    const r = await runTool("ask_company", ctx, { question: s.question });
    const got = r.rows.map((x) => String(x.source));
    const hit = top(got).find((u) => (s.expected?.sources ?? []).includes(u));
    checks.push({ name: "ask top3", pass: !!hit, detail: `top3: ${top(got).join(", ")}` });
    checks.push({ name: "(n) #1 is a source", pass: (s.expected?.sources ?? []).includes(got[0] ?? ""), detail: `#1: ${got[0]}` });
    return { id: s.id, tenant: s.tenant, phase, checks };
  }
  const svc = s.alert!.service;
  const blast = await runTool("blast_radius", ctx, { service: svc });
  checks.push({ name: "(a) blast≥2", pass: blast.rows.length >= 2, detail: `${blast.rows.length}: ${blast.rows.map((x) => x.name).join(", ")}` });

  const sus = await runTool("suspect_changes", ctx, { service: svc });
  const prs = sus.rows.map((x) => String(x.pr));
  const pos = prs.indexOf(s.expected!.suspectPr!);
  checks.push({ name: "(b) suspect top3", pass: pos >= 0 && pos < 3, detail: `${s.expected!.suspectPr} ${pos >= 0 ? `at #${pos + 1}` : "not in window"}; top3: ${top(prs).join(", ")}` });

  const who = await runTool("who_knows", ctx, { service: svc });
  const people = who.rows.map((x) => ({ uid: String(x.person), bot: x.isBot === true }));
  const human = top(people).some((p) => !p.bot);
  const expertPos = people.findIndex((p) => p.uid === s.expected!.expert);
  checks.push({ name: "(c) human expert top3", pass: human, detail: `top3: ${top(people).map((p) => p.uid).join(", ")}; expected ${s.expected!.expert} at #${expertPos + 1}` });

  const past = await runTool("past_incidents", ctx, { service: svc });
  const sim = await runTool("similar_incidents", ctx, { text: s.question, service: svc });
  const incs = [...past.rows, ...sim.rows].map((x) => String(x.incident));
  const hasExpected = incs.includes(s.expected!.pastIncident!);
  checks.push({ name: "(d) past incident", pass: incs.length > 0, detail: `${past.rows.length} past + ${sim.rows.length} similar; expected ${s.expected!.pastIncident} ${hasExpected ? "found" : "NOT found"}` });

  // Narration: scripted agents name the #1 row of each tool, so the presenter
  // note only matches the screen if expected = #1 (agents request #2).
  const firstPast = String(past.rows[0]?.incident ?? "");
  const firstSim = String(sim.rows[0]?.incident ?? "");
  const n1 = [
    prs[0] === s.expected!.suspectPr ? null : `suspect #1 is ${prs[0]}`,
    people[0]?.uid === s.expected!.expert ? null : `expert #1 is ${people[0]?.uid}`,
    [firstPast, firstSim].includes(s.expected!.pastIncident!) ? null : `past #1 is ${firstPast} / similar #1 is ${firstSim}`,
  ].filter(Boolean);
  checks.push({ name: "(n) expected = #1", pass: n1.length === 0, detail: n1.length ? n1.join("; ") : "suspect, expert and incident are each the #1 row" });
  return { id: s.id, tenant: s.tenant, phase, checks };
}

function table(results: Result[]): string {
  const lines = ["| Scenario | Phase | Result | Checks |", "|---|---|---|---|"];
  for (const r of results) {
    const ok = r.checks.every((c) => c.pass);
    lines.push(`| ${r.id} | ${r.phase} | ${ok ? "PASS" : "FAIL"} | ${r.checks.map((c) => `${c.pass ? "✓" : "✗"} ${c.name}: ${c.detail.replace(/\|/g, "/")}`).join("<br>")} |`);
  }
  return lines.join("\n");
}

try {
  const args = parseArgs();
  const tenants = tenantsFromArgs(args);
  const doLoad = boolArg(args, "load", true);
  const withDeltas = boolArg(args, "with-deltas", false);
  const scenarios = readJson<Scenario[]>(dataPath("scenarios.json")).filter((s) => tenants.includes(s.tenant));
  const results: Result[] = [];
  for (const tenant of tenants) {
    const snap = readJson<Snapshot>(dataPath(`${tenant}.json`));
    if (doLoad) await loadSnapshot(tenant, snap, { reset: true });
    for (const s of scenarios.filter((x) => x.tenant === tenant)) results.push(await verify(s, "snapshot"));
    if (withDeltas) {
      const d = readJson<{ nodes: SnapshotNode[]; edges: SnapshotEdge[] }>(dataPath("deltas", `${tenant}.json`));
      await ingestDelta(tenant, d.nodes, d.edges);
      for (const s of scenarios.filter((x) => x.tenant === tenant)) results.push(await verify(s, "with-deltas"));
      await loadSnapshot(tenant, snap, { reset: true }); // leave the canonical state behind
    }
  }
  console.log(`embeddings: ${await embeddingBackend()}\n`);
  for (const r of results) {
    const ok = r.checks.every((c) => c.pass);
    console.log(`${ok ? "PASS" : "FAIL"}  ${r.id.padEnd(30)} ${r.phase}`);
    for (const c of r.checks) console.log(`      ${c.pass ? "✓" : "✗"} ${c.name.padEnd(22)} ${c.detail}`);
  }
  if (args.markdown) console.log(`\n${table(results)}`);
  await closeFalkor();
  const canonicalFail = results.some((r) => r.phase === "snapshot" && !r.checks.every((c) => c.pass));
  process.exit(canonicalFail ? 1 : 0);
} catch (e) {
  fail(e);
}
