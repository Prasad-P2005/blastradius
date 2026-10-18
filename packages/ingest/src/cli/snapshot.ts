/**
 * `pnpm --filter @blastradius/ingest snapshot [--tenant acme]`
 * Reads REAL git history at the pinned commit and writes the real half of the
 * snapshot to .cache/snapshots/<tenant>.real.json, plus the held-back delta
 * PRs to data/deltas/<tenant>.json. `synth` adds the synthetic org on top.
 */
import { loadRootEnv } from "@blastradius/shared/env";
loadRootEnv();

import { join } from "node:path";
import { cloneDirFor, git } from "../git.ts";
import { buildDelta, buildRealSnapshot } from "../snapshot.ts";
import { REAL_DIR, SOURCES } from "../sources.ts";
import { SNAPSHOT_KEY_ORDER, stableStringify, writeText } from "../write.ts";
import { GIT_PACKS } from "@blastradius/shared";
import { ROOT, dataPath, fail, parseArgs, tenantsFromArgs } from "./common.ts";

try {
  for (const tenant of tenantsFromArgs(parseArgs(), GIT_PACKS)) {
    const src = SOURCES[tenant];
    const dir = cloneDirFor(src, ROOT);
    let head = "";
    try {
      head = git(dir, ["rev-parse", "origin/HEAD"]).trim();
    } catch {
      head = src.deltaSha;
    }
    const real = buildRealSnapshot(tenant, src, dir, head);
    writeText(join(ROOT, REAL_DIR, `${tenant}.real.json`), stableStringify(real as unknown as Record<string, unknown>, [...SNAPSHOT_KEY_ORDER, "meta"]));
    const count = (l: string) => real.nodes.filter((n) => n.label === l).length;
    console.log(
      `[snapshot] ${tenant}: ${count("PR")} PRs (${real.meta.humanPrs} human, ${real.meta.botPrs} bot) of ${real.meta.prsInHistory} in history; ` +
        `${count("Person")} people, ${count("File")} files, ${count("Service")} services, ${real.edges.length} edges; newest PR ${real.generatedAt}` +
        (real.meta.missingLandmarks.length ? `; MISSING landmarks ${real.meta.missingLandmarks.join(",")}` : ""),
    );

    const delta = buildDelta(tenant, src, dir, { from: src.snapshotSha, to: src.deltaSha }, real.nodes);
    writeText(dataPath("deltas", `${tenant}.json`), stableStringify({ nodes: delta.nodes, edges: delta.edges }, ["nodes", "edges"]));
    const humans = delta.nodes.filter((n) => n.label === "PR" && n.props.isBot === false).map((n) => `#${n.props.number}`);
    console.log(`[snapshot] ${tenant}: delta ${delta.prs.length} PRs (human: ${humans.join(" ")}) → data/deltas/${tenant}.json`);
  }
} catch (e) {
  fail(e);
}
