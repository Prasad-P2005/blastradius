/**
 * `pnpm --filter @blastradius/ingest add-prs --tenant acme [--from-git] [--limit 50]`
 * The "keeping knowledge current" demo. Applies NEW real PRs to the loaded
 * graph via ingestDelta (MERGE, no reset): TOUCHES are derived for them, so
 * suspect_changes / who_knows change immediately.
 *   default     data/deltas/<tenant>.json: the PRs held back between the
 *               pinned snapshot SHA and deltaSha (sources.ts)
 *   --from-git  `git fetch` the clone and map every PR after the snapshot SHA
 *               up to origin/HEAD (newest --limit, default 50) the same way
 */
import { loadRootEnv } from "@blastradius/shared/env";
loadRootEnv();

import type { Snapshot, SnapshotEdge, SnapshotNode } from "@blastradius/shared";
import { closeFalkor, ingestDelta, newestPrAt } from "@blastradius/graph";
import { closeDb } from "@blastradius/db";
import { cloneDirFor, git } from "../git.ts";
import { withIngestJob } from "../jobs.ts";
import { buildDelta } from "../snapshot.ts";
import { SOURCES } from "../sources.ts";
import { emailErrors, validateGraph } from "../validate.ts";
import { readJson } from "../write.ts";
import { ROOT, dataPath, fail, parseArgs } from "./common.ts";

try {
  const args = parseArgs();
  const tenant = args.tenant;
  if (tenant !== "acme" && tenant !== "globex") throw new Error("--tenant acme|globex is required");
  const base = readJson<Snapshot>(dataPath(`${tenant}.json`));
  let delta: { nodes: SnapshotNode[]; edges: SnapshotEdge[] };
  if (args["from-git"]) {
    const src = SOURCES[tenant];
    const dir = cloneDirFor(src, ROOT);
    git(dir, ["fetch", "--quiet", "origin"]);
    const head = git(dir, ["rev-parse", "origin/HEAD"]).trim();
    const limit = Number(args.limit ?? 50);
    delta = buildDelta(tenant, src, dir, { from: src.snapshotSha, to: head }, base.nodes, { limit });
    console.log(`[add-prs] ${tenant}: from git ${src.snapshotSha.slice(0, 10)}..${head.slice(0, 10)} (newest ${limit})`);
  } else {
    delta = readJson(dataPath("deltas", `${tenant}.json`));
  }
  const errors = [...validateGraph(delta.nodes, delta.edges, { baseNodes: base.nodes, skipOnCall: true }), ...emailErrors(JSON.stringify(delta))];
  if (errors.length) throw new Error(`delta invalid:\n  ${errors.slice(0, 10).join("\n  ")}`);

  const prs = delta.nodes.filter((n) => n.label === "PR");
  const humans = prs.filter((n) => n.props.isBot === false).map((n) => `#${n.props.number} ${n.props.title} (${n.props.authorName})`);
  const before = await newestPrAt(tenant);
  const stats = await withIngestJob(tenant, "delta", async () => ({ ...(await ingestDelta(tenant, delta.nodes, delta.edges)) }));
  const after = await newestPrAt(tenant);
  console.log(`[add-prs] ${tenant}: ${prs.length} PRs applied (${stats.nodes} nodes, ${stats.edges} edges, ${stats.touches} TOUCHES, ${stats.collaborations} COLLABORATES_WITH) in ${stats.ms} ms`);
  console.log(`[add-prs] newest PR moved ${new Date(before).toISOString()} → ${new Date(after).toISOString()}`);
  for (const h of humans) console.log(`  + ${h}`);
  await closeFalkor();
  await closeDb();
} catch (e) {
  fail(e);
}
