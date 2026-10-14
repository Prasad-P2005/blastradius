import { memoryInspector } from "@blastradius/graph";
import { handle, json, tenantFrom } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** MemoryInspectorData: sessions, the episode chain + findings + handoffs, procedural memory, subgraph, cypher. */
export function GET(req: Request) {
  return handle(async () => {
    const url = new URL(req.url);
    return json(await memoryInspector(tenantFrom(url), url.searchParams.get("sessionId") ?? undefined));
  });
}
