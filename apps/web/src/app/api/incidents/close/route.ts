import { CloseIncidentRequestSchema } from "@blastradius/shared";
import { closeIncident } from "@blastradius/agents";
import { handle, json, readJson } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Scribe writes Incident + Runbook into procedural memory. */
export function POST(req: Request) {
  return handle(async () => {
    const body = CloseIncidentRequestSchema.parse(await readJson(req));
    return json(await closeIncident(body));
  });
}
