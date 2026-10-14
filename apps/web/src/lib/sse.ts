/**
 * Minimal SSE framing, shared by the server (encode) and the browser (decode).
 * We use fetch + ReadableStream instead of EventSource because /api/investigate is a POST.
 */
import type { AgentEvent } from "@blastradius/shared";

export function encodeEvent(ev: AgentEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

export const SSE_PING = ": ping\n\n";

/**
 * Incremental decoder: feed it text chunks, get back complete `data:` payloads.
 * Comment lines (`: ping`) are dropped. A message may span several chunks.
 */
export function createSseDecoder() {
  let buffer = "";
  return {
    push(chunk: string): string[] {
      buffer += chunk.replace(/\r\n/g, "\n");
      const out: string[] = [];
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) out.push(data);
      }
      return out;
    },
  };
}
