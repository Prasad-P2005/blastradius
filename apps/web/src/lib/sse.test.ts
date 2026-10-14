import { describe, expect, it } from "vitest";
import { createSseDecoder, SSE_PING } from "./sse.ts";

describe("createSseDecoder", () => {
  it("splits messages across chunk boundaries and drops pings", () => {
    const d = createSseDecoder();
    expect(d.push('data: {"a":')).toEqual([]);
    expect(d.push('1}\n\n' + SSE_PING + 'data: {"b":2}\n')).toEqual(['{"a":1}']);
    expect(d.push("\n")).toEqual(['{"b":2}']);
  });
});
