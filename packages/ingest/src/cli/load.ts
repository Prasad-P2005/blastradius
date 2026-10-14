/**
 * `pnpm graph:load` = `pnpm --filter @blastradius/ingest load [--tenant acme] [--reset false] [--no-embed]`
 * Loads data/<tenant>.json into FalkorDB through @blastradius/graph
 * (ensureSchema + loadSnapshot). --reset (default true) drops the tenant graph
 * first, which also removes agent memory and any applied deltas.
 */
import { loadRootEnv } from "@blastradius/shared/env";
loadRootEnv();

import type { Snapshot } from "@blastradius/shared";
import { closeFalkor, ensureSchema, loadSnapshot } from "@blastradius/graph";
import { closeDb } from "@blastradius/db";
import { withIngestJob } from "../jobs.ts";
import { readJson } from "../write.ts";
import { boolArg, dataPath, fail, parseArgs, tenantsFromArgs } from "./common.ts";

try {
  const args = parseArgs();
  const reset = boolArg(args, "reset", true);
  const embed = boolArg(args, "embed", true);
  for (const tenant of tenantsFromArgs(args)) {
    const snap = readJson<Snapshot>(dataPath(`${tenant}.json`));
    const stats = await withIngestJob(tenant, "snapshot", async () => {
      await ensureSchema(tenant);
      return { ...(await loadSnapshot(tenant, snap, { reset, embed })) };
    });
    console.log(`[load] ${tenant}: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.touches} TOUCHES derived, ${stats.embedded} embedded in ${stats.ms} ms (reset=${reset})`);
  }
  await closeFalkor();
  await closeDb();
} catch (e) {
  fail(e);
}
