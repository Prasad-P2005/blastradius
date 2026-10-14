import { overview } from "@blastradius/graph";
import { handle, json, tenantFrom } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** All Services + DEPENDS_ON + Teams/OWNS: the graph the console starts from. */
export function GET(req: Request) {
  return handle(async () => json(await overview(tenantFrom(req.url))));
}
