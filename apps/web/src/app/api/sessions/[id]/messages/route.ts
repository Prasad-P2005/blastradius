import { listEvents, listMessages } from "@blastradius/db";
import { HttpError, handle, json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Transcript + the full AgentEvent log for replay through the same reducer the live stream uses. */
export function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    if (!id || id.length > 200) throw new HttpError(400, "bad session id");
    const [messages, events] = await Promise.all([listMessages(id), listEvents({ sessionId: id })]);
    return json({ messages, events });
  });
}
