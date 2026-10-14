import { getHealth } from "@blastradius/agents";
import { handle, json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** HealthStatus: FalkorDB + Postgres pings, agent mode/model, embeddings backend, tool transport. */
export function GET() {
  return handle(async () => json(await getHealth()));
}
