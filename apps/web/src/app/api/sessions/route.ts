import { z } from "zod";
import { TenantSchema, type SessionSummary } from "@blastradius/shared";
import { listGraphSessions } from "@blastradius/graph";
import { createSession, listSessions } from "@blastradius/db";
import { handle, json, readJson, tenantFrom } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sessions come from the graph (Session nodes are the memory); Postgres only adds
 * display titles. A FalkorDB failure is a 503, not an empty list.
 */
export function GET(req: Request) {
  return handle(async () => {
    const tenant = tenantFrom(req.url);
    const [graphSessions, pgSessions] = await Promise.all([listGraphSessions(tenant, 50), listSessions(tenant, 200)]);
    const titles = new Map(pgSessions.map((s) => [s.id, s.title]));
    const out: (SessionSummary & { title?: string })[] = graphSessions.map((s) => {
      const title = titles.get(s.sessionId);
      return title ? { ...s, title } : s;
    });
    return json(out);
  });
}

const CreateSessionSchema = z.object({ tenant: TenantSchema, mode: z.enum(["incident", "ask"]).optional() });

/** Reserve a session id (pg row, best-effort). The graph Session node is created by the first investigate call. */
export function POST(req: Request) {
  return handle(async () => {
    const body = CreateSessionSchema.parse(await readJson(req));
    const sessionId = `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await createSession({ id: sessionId, tenant: body.tenant, mode: body.mode ?? "incident", title: "New session" });
    return json({ sessionId }, 201);
  });
}
