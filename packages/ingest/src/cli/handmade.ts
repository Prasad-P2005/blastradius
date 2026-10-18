/**
 * `pnpm --filter @blastradius/ingest handmade`
 * Writes the hand-written, fully synthetic packs (today: slice) to
 * data/<pack>.json and puts their scenarios into data/scenarios.json,
 * keeping every other tenant's scenarios. No git, no network.
 */
import { loadRootEnv } from "@blastradius/shared/env";
loadRootEnv();

import { existsSync } from "node:fs";
import { TENANTS, type Scenario } from "@blastradius/shared";
import { buildSlice } from "../handmade/slice.ts";
import { SNAPSHOT_KEY_ORDER, readJson, stableArray, stableStringify, writeText } from "../write.ts";
import { dataPath, fail } from "./common.ts";

try {
  const { snapshot, scenarios: mine } = buildSlice();
  writeText(dataPath(`${snapshot.tenant}.json`), stableStringify(snapshot as unknown as Record<string, unknown>, SNAPSHOT_KEY_ORDER));
  console.log(`[handmade] ${snapshot.tenant}: ${snapshot.nodes.length} nodes, ${snapshot.edges.length} edges`);

  const file = dataPath("scenarios.json");
  const others = existsSync(file) ? readJson<Scenario[]>(file).filter((s) => s.tenant !== snapshot.tenant) : [];
  const all = [...others, ...mine];
  // same order as synth.ts: by tenant, then id
  all.sort((a, b) => TENANTS.indexOf(a.tenant) - TENANTS.indexOf(b.tenant) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  writeText(file, stableArray(all));
  console.log(`[handmade] ${mine.length} ${snapshot.tenant} scenarios; ${all.length} total → data/scenarios.json`);
} catch (e) {
  fail(e);
}
