/**
 * `pnpm --filter @blastradius/ingest synth [--tenant acme]`
 * Reads .cache/snapshots/<tenant>.real.json (from `snapshot`), adds the
 * seeded SYNTHETIC org on top and writes data/<tenant>.json. Scenarios for
 * all tenants go to data/scenarios.json (other tenants' entries are kept
 * when only one tenant is rebuilt).
 */
import { loadRootEnv } from "@blastradius/shared/env";
loadRootEnv();

import { existsSync } from "node:fs";
import { join } from "node:path";
import { TENANTS, type Scenario } from "@blastradius/shared";
import type { RealSnapshot } from "../snapshot.ts";
import { REAL_DIR } from "../sources.ts";
import { synthesize } from "../synth/index.ts";
import { SNAPSHOT_KEY_ORDER, readJson, stableArray, stableStringify, writeText } from "../write.ts";
import { ROOT, dataPath, fail, parseArgs, tenantsFromArgs } from "./common.ts";

try {
  const tenants = tenantsFromArgs(parseArgs());
  const scenariosFile = dataPath("scenarios.json");
  const scenarios: Scenario[] = existsSync(scenariosFile) ? readJson<Scenario[]>(scenariosFile).filter((s) => !tenants.includes(s.tenant)) : [];
  for (const tenant of tenants) {
    const real = readJson<RealSnapshot>(join(ROOT, REAL_DIR, `${tenant}.real.json`));
    const { snapshot, scenarios: sc, stats } = synthesize(real);
    writeText(dataPath(`${tenant}.json`), stableStringify(snapshot as unknown as Record<string, unknown>, SNAPSHOT_KEY_ORDER));
    scenarios.push(...sc);
    const count = (l: string) => snapshot.nodes.filter((n) => n.label === l).length;
    console.log(`[synth] ${tenant}: ${snapshot.nodes.length} nodes, ${snapshot.edges.length} edges; ${stats.incidents} incidents, ${stats.decisions} ADRs, ${stats.issues} issues, ${stats.threads} threads, ${stats.onCallEdges} on-call edges; ${count("Person")} people`);
    for (const [team, t] of Object.entries(stats.teams)) console.log(`  team ${team}: services=${t.services.join(",")} members=${t.members.length} rotation=${t.rotation.join(",")}`);
  }
  scenarios.sort((a, b) => TENANTS.indexOf(a.tenant) - TENANTS.indexOf(b.tenant) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  writeText(scenariosFile, stableArray(scenarios));
  console.log(`[synth] ${scenarios.length} scenarios → data/scenarios.json`);
} catch (e) {
  fail(e);
}
