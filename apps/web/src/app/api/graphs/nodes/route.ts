import { addNode, deleteNode } from "@blastradius/graph";
import { z } from "zod";
import { requireUser } from "@/server/user";
import { HttpError, handle, json, readJson, tenantFrom } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ label: z.string(), values: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])) });

/** Adds one node from builder form values (validated against NODE_FORMS in @blastradius/graph). */
export function POST(req: Request) {
  return handle(async () => {
    requireUser(req);
    const tenant = tenantFrom(req.url);
    const { label, values } = Body.parse(await readJson(req));
    try {
      return json(await addNode(tenant, label, values), 201);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
  });
}

/** Deletes one node (?uid=) and its relationships. */
export function DELETE(req: Request) {
  return handle(async () => {
    requireUser(req);
    const url = new URL(req.url);
    const uid = url.searchParams.get("uid");
    if (!uid) throw new HttpError(400, "missing ?uid=");
    return json(await deleteNode(tenantFrom(url), uid));
  });
}
