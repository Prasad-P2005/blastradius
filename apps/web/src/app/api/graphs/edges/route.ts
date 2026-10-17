import { addEdge, deleteEdge } from "@blastradius/graph";
import { z } from "zod";
import { requireUser } from "@/server/user";
import { HttpError, handle, json, readJson, tenantFrom } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  type: z.string(),
  from: z.string(),
  to: z.string(),
  props: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

/** Draws one relationship; direction and endpoints are checked (REL_SHAPES). */
export function POST(req: Request) {
  return handle(async () => {
    requireUser(req);
    const tenant = tenantFrom(req.url);
    const b = Body.parse(await readJson(req));
    try {
      return json(await addEdge(tenant, b.type, b.from, b.to, b.props ?? {}), 201);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
  });
}

/** Deletes a relationship (?type=&from=&to=). */
export function DELETE(req: Request) {
  return handle(async () => {
    requireUser(req);
    const url = new URL(req.url);
    const [type, from, to] = ["type", "from", "to"].map((k) => url.searchParams.get(k));
    if (!type || !from || !to) throw new HttpError(400, "missing ?type=&from=&to=");
    return json(await deleteEdge(tenantFrom(url), type, from, to));
  });
}
