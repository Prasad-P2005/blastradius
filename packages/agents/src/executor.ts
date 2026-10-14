/**
 * ToolExecutor: the one seam between the agent pipeline and the tools.
 *
 *   direct (default) → `runTool` from @blastradius/graph, in-process
 *   mcp              → the SAME registry served by apps/mcp, over Streamable HTTP
 *
 * The pipeline (LLM or scripted) never knows which one runs. Both return the
 * contract's GraphToolResult, so findings copy the same exact Cypher strings.
 */
import type { GraphToolResult, ToolContext, ToolName } from "@blastradius/shared";
import { toolTransport } from "./mode.ts";

export interface ToolExecutor {
  readonly transport: "direct" | "mcp";
  run(tool: ToolName, ctx: ToolContext, input: Record<string, unknown>): Promise<GraphToolResult>;
  close?(): Promise<void>;
}

/** Tools that need sessionId + agent (SPEC §7: over MCP they travel in the input). */
export const MEMORY_TOOLS: readonly ToolName[] = ["recall_memory", "read_handoffs", "record_finding"];

/** In-process executor over @blastradius/graph. */
export class DirectExecutor implements ToolExecutor {
  readonly transport = "direct" as const;
  async run(tool: ToolName, ctx: ToolContext, input: Record<string, unknown>): Promise<GraphToolResult> {
    const { runTool } = await import("@blastradius/graph");
    return runTool(tool, ctx, input);
  }
}

/** Raised for MCP transport problems (as opposed to tool errors). */
export class McpTransportError extends Error {
  override name = "McpTransportError";
}

/**
 * MCP executor: one lazily connected client per process (shared by
 * concurrent runs). Tool results are read from `structuredContent`, falling
 * back to parsing the JSON text block.
 */
export class McpExecutor implements ToolExecutor {
  readonly transport = "mcp" as const;
  private clientPromise: Promise<import("@modelcontextprotocol/sdk/client/index.js").Client> | null = null;

  constructor(private readonly url: string = process.env.MCP_URL || "http://localhost:3333/mcp") {}

  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
        const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
        const client = new Client({ name: "blastradius-agents", version: "0.1.0" });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
        } catch (err) {
          throw new McpTransportError(`cannot connect to MCP server at ${this.url}: ${(err as Error).message}`);
        }
        return client;
      })();
      this.clientPromise.catch(() => {
        this.clientPromise = null; // allow a retry on the next call
      });
    }
    return this.clientPromise;
  }

  async run(tool: ToolName, ctx: ToolContext, input: Record<string, unknown>): Promise<GraphToolResult> {
    const client = await this.client();
    const args: Record<string, unknown> = { ...input, tenant: ctx.tenant };
    if (MEMORY_TOOLS.includes(tool)) {
      if (ctx.sessionId) args.sessionId = ctx.sessionId;
      if (ctx.agent) args.agent = ctx.agent;
    }
    let res: Awaited<ReturnType<typeof client.callTool>>;
    try {
      res = await client.callTool({ name: tool, arguments: args });
    } catch (err) {
      throw new McpTransportError(`MCP call ${tool} failed: ${(err as Error).message}`);
    }
    return parseMcpToolResult(tool, res);
  }

  async close(): Promise<void> {
    const p = this.clientPromise;
    this.clientPromise = null;
    if (p) await (await p.catch(() => null))?.close().catch(() => {});
  }
}

/** Exported for tests: structuredContent first, else JSON text; isError → throw. */
export function parseMcpToolResult(tool: ToolName, res: unknown): GraphToolResult {
  const r = (res ?? {}) as { structuredContent?: unknown; content?: unknown; isError?: boolean };
  const text = Array.isArray(r.content)
    ? (r.content as { type?: string; text?: string }[])
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text!)
        .join("\n")
    : "";
  if (r.isError) throw new Error(text || `MCP tool ${tool} returned an error`);
  let out: unknown = r.structuredContent;
  if (!isToolResult(out) && text) {
    try {
      out = JSON.parse(text);
    } catch {
      throw new Error(`MCP tool ${tool} returned non-JSON content: ${text.slice(0, 200)}`);
    }
  }
  if (!isToolResult(out)) throw new Error(`MCP tool ${tool} returned no GraphToolResult`);
  return { ...out, paths: out.paths ?? [] };
}

function isToolResult(x: unknown): x is GraphToolResult {
  return !!x && typeof x === "object" && typeof (x as GraphToolResult).cypher === "string" && Array.isArray((x as GraphToolResult).rows);
}

let shared: ToolExecutor | null = null;
let sharedKind: string | null = null;

/** Process-wide executor chosen by AGENT_TOOL_TRANSPORT. */
export function defaultExecutor(): ToolExecutor {
  const kind = toolTransport();
  if (!shared || sharedKind !== kind) {
    shared = kind === "mcp" ? new McpExecutor() : new DirectExecutor();
    sharedKind = kind;
  }
  return shared;
}

export async function closeDefaultExecutor(): Promise<void> {
  const s = shared;
  shared = null;
  sharedKind = null;
  await s?.close?.();
}
