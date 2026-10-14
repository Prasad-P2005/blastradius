import { loadScenarios } from "@blastradius/agents";
import { handle, json, tenantFrom } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handle(async () => json(await loadScenarios(tenantFrom(req.url))));
}
