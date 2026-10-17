import { counts, getWorkspace, graphDump, workspaceExists } from "@blastradius/graph";
import { HttpError, handle, json, tenantFrom } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Everything the builder shows for one graph: its description, label/type counts and the live domain graph. */
export function GET(req: Request) {
  return handle(async () => {
    const tenant = tenantFrom(req.url);
    if (!(await workspaceExists(tenant))) throw new HttpError(404, `no graph called "${tenant}"`);
    const [workspace, c, graph] = await Promise.all([getWorkspace(tenant), counts(tenant), graphDump(tenant)]);
    return json({ workspace, counts: c, graph });
  });
}
