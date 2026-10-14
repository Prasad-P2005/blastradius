import { InvestigateRequestSchema, type AgentEvent } from "@blastradius/shared";
import { investigate } from "@blastradius/agents";
import { handle, readJson, errorMessage } from "@/server/http";
import { encodeEvent, SSE_PING } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

/**
 * POST InvestigateRequest → text/event-stream.
 *   data: <AgentEvent JSON>\n\n   per event
 *   : ping\n\n                     every 15 s (keeps proxies from closing an idle stream)
 * When the client disconnects (request.signal aborts) we abort the agent loop,
 * which stops at the next step boundary and emits run_finished{aborted}.
 */
export function POST(request: Request) {
  return handle(async () => {
    const req = InvestigateRequestSchema.parse(await readJson(request));
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    request.signal.addEventListener("abort", onAbort);

    const enc = new TextEncoder();
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const write = (s: string) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(s));
          } catch {
            closed = true; // client went away mid-write
          }
        };
        heartbeat = setInterval(() => write(SSE_PING), HEARTBEAT_MS);

        let last: AgentEvent | null = null;
        try {
          for await (const ev of investigate(req, { signal: ac.signal })) {
            last = ev;
            write(encodeEvent(ev));
          }
        } catch (e) {
          // investigate() should report failures as events; if it throws anyway,
          // surface it as an error event on the same run so the UI shows a red card.
          if (!ac.signal.aborted) {
            const base = last ?? {
              runId: "unknown",
              sessionId: req.sessionId ?? "unknown",
              tenant: req.tenant,
              seq: -1,
              ts: new Date().toISOString(),
            };
            const errEv: AgentEvent = {
              runId: base.runId,
              sessionId: base.sessionId,
              tenant: base.tenant,
              seq: base.seq + 1,
              ts: new Date().toISOString(),
              type: "error",
              where: "internal",
              message: errorMessage(e),
              fatal: true,
            };
            write(encodeEvent(errEv));
            write(
              encodeEvent({ ...errEv, seq: errEv.seq + 1, type: "run_finished", status: "error", findingIds: [], ms: 0 } as AgentEvent),
            );
          }
        } finally {
          clearInterval(heartbeat);
          request.signal.removeEventListener("abort", onAbort);
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        clearInterval(heartbeat);
        ac.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });
}
