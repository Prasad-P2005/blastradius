import { counts, listWorkspaces } from "@blastradius/graph";
import { handle, json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every graph with live node/relationship counts (503 if FalkorDB is down). */
export function GET() {
  return handle(async () => {
    const all = await listWorkspaces();
    return json(await Promise.all(all.map(async (w) => ({ id: w.id, name: w.name, description: w.description, sourceRepo: "", counts: await counts(w.id) }))));
  });
}
