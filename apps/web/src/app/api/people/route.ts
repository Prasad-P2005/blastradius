import { listPeople } from "@/server/people";
import { HttpError, handle, json, tenantFrom } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PersonSummary[]: personas (fictional) and real git authors. `?persona=true|false` filters. */
export function GET(req: Request) {
  return handle(async () => {
    const url = new URL(req.url);
    const tenant = tenantFrom(url);
    const p = url.searchParams.get("persona");
    if (p !== null && p !== "true" && p !== "false") throw new HttpError(400, "?persona= must be true or false");
    return json(await listPeople(tenant, p === null ? {} : { persona: p === "true" }));
  });
}
