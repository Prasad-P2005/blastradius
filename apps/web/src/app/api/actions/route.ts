import { listActions } from "@blastradius/agents";
import { handle, json, tenantFrom } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handle(async () => {
    const url = new URL(req.url);
    return json(await listActions(tenantFrom(url), url.searchParams.get("sessionId") ?? undefined));
  });
}
