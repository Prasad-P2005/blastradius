import { loadScenarios } from "@blastradius/agents";
import { getWorkspace } from "@blastradius/graph";
import { isSeedPack } from "@blastradius/shared";
import { handle, json, tenantFrom } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Demo scenarios that apply to this graph: those of every seed pack loaded into it. */
export function GET(req: Request) {
  return handle(async () => {
    const tenant = tenantFrom(req.url);
    const packs = new Set((await getWorkspace(tenant)).seeded as string[]);
    if (isSeedPack(tenant)) packs.add(tenant);
    const lists = await Promise.all([...packs].map((p) => loadScenarios(p)));
    return json(lists.flat());
  });
}
