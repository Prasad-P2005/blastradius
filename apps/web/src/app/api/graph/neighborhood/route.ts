import { z } from "zod";
import { neighborhood } from "@blastradius/graph";
import { parseUid } from "@blastradius/shared";
import { HttpError, handle, json, tenantFrom } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Limit = z.coerce.number().int().min(1).max(200).default(40);

/** 1-hop neighbourhood of a node (by uid) for click-to-expand. */
export function GET(req: Request) {
  return handle(async () => {
    const url = new URL(req.url);
    const tenant = tenantFrom(url);
    const uid = url.searchParams.get("uid");
    if (!uid || !parseUid(uid)) throw new HttpError(400, "missing or malformed ?uid= (e.g. Service:checkout)");
    const limit = Limit.parse(url.searchParams.get("limit") ?? undefined);
    return json(await neighborhood(tenant, uid, { limit }));
  });
}
