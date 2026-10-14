/**
 * `pnpm --filter @blastradius/ingest clone [--tenant acme]`
 * Clones (or fetches) each source repo into .cache/repos/ and checks out the
 * pinned snapshot commit from sources.ts. Prints the remote HEAD too, so you
 * can see how far upstream has moved since we pinned.
 */
import { loadRootEnv } from "@blastradius/shared/env";
loadRootEnv();

import { checkoutPinned, cloneOrFetch, git } from "../git.ts";
import { SOURCES } from "../sources.ts";
import { ROOT, fail, parseArgs, tenantsFromArgs } from "./common.ts";

try {
  for (const tenant of tenantsFromArgs(parseArgs())) {
    const src = SOURCES[tenant];
    const { dir, head, action } = cloneOrFetch(src, ROOT);
    checkoutPinned(dir, src.snapshotSha);
    const date = git(dir, ["log", "-1", "--format=%cI", src.snapshotSha]).trim();
    console.log(`[clone] ${tenant}: ${src.repo} ${action}; HEAD ${head.slice(0, 12)}; pinned ${src.snapshotSha.slice(0, 12)} (${date})`);
  }
} catch (e) {
  fail(e);
}
