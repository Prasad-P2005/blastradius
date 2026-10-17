/**
 * `pnpm --filter @blastradius/ingest validate`
 * Validates data/<tenant>.json, data/deltas/<tenant>.json and
 * data/scenarios.json. Exits 1 on any error.
 */
import { loadRootEnv } from "@blastradius/shared/env";
loadRootEnv();

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { TENANTS, type Scenario, type Snapshot, type SnapshotEdge, type SnapshotNode, type SeedPack as Tenant } from "@blastradius/shared";
import { emailErrors, validateGraph, validateScenarios, validateSnapshot } from "../validate.ts";
import { dataPath } from "./common.ts";

let failed = false;
const report = (what: string, errors: string[], extra = "") => {
  if (errors.length) {
    failed = true;
    console.error(`[validate] ✗ ${what}: ${errors.length} error(s)`);
    for (const e of errors.slice(0, 30)) console.error(`    - ${e}`);
  } else console.log(`[validate] ✓ ${what}${extra}`);
};

const snaps: Partial<Record<Tenant, Snapshot>> = {};
for (const t of TENANTS) {
  const file = dataPath(`${t}.json`);
  if (!existsSync(file)) {
    report(`data/${t}.json`, ["missing (run data:build)"]);
    continue;
  }
  const raw = readFileSync(file, "utf8");
  const snap = JSON.parse(raw) as Snapshot;
  snaps[t] = snap;
  const sha = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  report(`data/${t}.json`, validateSnapshot(snap, raw), ` (${snap.nodes.length} nodes, ${snap.edges.length} edges, ${(raw.length / 1e6).toFixed(2)} MB, sha256 ${sha})`);

  const dfile = dataPath("deltas", `${t}.json`);
  if (existsSync(dfile)) {
    const draw = readFileSync(dfile, "utf8");
    const d = JSON.parse(draw) as { nodes: SnapshotNode[]; edges: SnapshotEdge[] };
    const overlap = d.nodes.filter((n) => n.label === "PR" && snap.nodes.some((m) => m.uid === n.uid));
    const errs = [...validateGraph(d.nodes, d.edges, { baseNodes: snap.nodes, skipOnCall: true }), ...emailErrors(draw), ...overlap.map((n) => `${n.uid} is already in the snapshot`)];
    report(`data/deltas/${t}.json`, errs, ` (${d.nodes.filter((n) => n.label === "PR").length} PRs)`);
  }
}
const sfile = dataPath("scenarios.json");
if (existsSync(sfile)) {
  const raw = readFileSync(sfile, "utf8");
  const sc = JSON.parse(raw) as Scenario[];
  report("data/scenarios.json", [...validateScenarios(sc, snaps), ...emailErrors(raw)], ` (${sc.length} scenarios)`);
} else report("data/scenarios.json", ["missing"]);

process.exit(failed ? 1 : 0);
