import { z } from "zod";
import { parseUid } from "@blastradius/shared";
import { personActivity } from "@/server/people";
import { HttpError, handle, json, tenantFrom } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Limit = z.coerce.number().int().min(1).max(500).default(100);

/** PersonActivity: the person's feed, newest first, including agent findings that name them. */
export function GET(req: Request) {
  return handle(async () => {
    const url = new URL(req.url);
    const tenant = tenantFrom(url);
    const uid = url.searchParams.get("uid");
    if (!uid || parseUid(uid)?.label !== "Person") throw new HttpError(400, "missing or malformed ?uid= (e.g. Person:dana-whitfield)");
    return json(await personActivity(tenant, uid, Limit.parse(url.searchParams.get("limit") ?? undefined)));
  });
}
