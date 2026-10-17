import { addSample, ensureWorkspaceNode, loadSnapshot, markSeeded } from "@blastradius/graph";
import { SEED_PACKS } from "@blastradius/shared";
import { z } from "zod";
import { readPack, readStarter } from "@/server/builder";
import { requireUser } from "@/server/user";
import { HttpError, handle, json, readJson, tenantFrom } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.union([z.object({ step: z.string() }), z.object({ pack: z.enum(SEED_PACKS) })]);

/**
 * Seeds sample data into ?tenant=, on demand:
 *   {step}  one builder step of the small starter company (data/samples/starter.json),
 *           plus the earlier steps it builds on
 *   {pack}  a whole sample company built from real git history (data/<pack>.json), merged in
 */
export function POST(req: Request) {
  return handle(async () => {
    requireUser(req);
    const tenant = tenantFrom(req.url);
    const body = Body.parse(await readJson(req));
    if ("step" in body) {
      // a step's edges need the earlier steps' nodes (DEPENDS_ON needs the services),
      // so seed every sample step up to this one; MERGE makes repeats harmless
      const steps = Object.entries(readStarter().steps);
      const upto = steps.findIndex(([id]) => id === body.step);
      if (upto < 0) throw new HttpError(404, `no sample for step ${body.step}`);
      const nodes = steps.slice(0, upto + 1).flatMap(([, s]) => s.nodes);
      const edges = steps.slice(0, upto + 1).flatMap(([, s]) => s.edges);
      return json(await addSample(tenant, { nodes, edges }));
    }
    const stats = await loadSnapshot(tenant, readPack(body.pack), { reset: false });
    await ensureWorkspaceNode(tenant, tenant);
    await markSeeded(tenant, body.pack);
    return json({ ...stats, cypher: [] });
  });
}
