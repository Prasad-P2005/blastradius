/**
 * The Blastradius MCP server: the SAME tool registry the agents use
 * (`toolSpecs` from @blastradius/graph), exposed over the Model Context
 * Protocol so any MCP client (Claude Desktop, Claude Code, Cursor…) can run
 * the graph tools against a tenant's FalkorDB graph.
 *
 * This file builds an `McpServer` instance. Transports live in main.ts
 * (stdio) and http.ts (Streamable HTTP).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { counts, runCypher, runTool, toolSpecs } from "@blastradius/graph";
import {
  TENANTS,
  TENANT_INFO,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  graphName,
  isWriteTool,
  type AgentName,
  type Json,
  type Tenant,
  type ToolContext,
  type ToolName,
} from "@blastradius/shared";
import { log as defaultLog, type Logger } from "./log.ts";
import { exposedToolNames, requiresSession, staticSchema, toolInputShape } from "./schema.ts";

export const SERVER_NAME = "blastradius";
export const SERVER_VERSION = "0.1.0";

export interface ServerOptions {
  /** Register write tools (record_finding). Default: MCP_ALLOW_WRITES === 'true'. */
  allowWrites?: boolean;
  log?: Logger;
}

export function allowWritesFromEnv(): boolean {
  return process.env.MCP_ALLOW_WRITES === "true";
}

/** Tool names present in the graph package's registry, in contract order. */
export function availableToolNames(): ToolName[] {
  return TOOL_NAMES.filter((t) => t in toolSpecs);
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build one McpServer. Streamable HTTP creates one per session (an McpServer
 * connects to exactly one transport); stdio creates exactly one.
 */
export function createMcpServer(opts: ServerOptions = {}): McpServer {
  const allowWrites = opts.allowWrites ?? allowWritesFromEnv();
  const log = opts.log ?? defaultLog;
  const exposed = exposedToolNames(allowWrites, availableToolNames());

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Blastradius incident and company-knowledge tools over a FalkorDB graph. Every tool needs `tenant` (acme or globex). " +
        "Node references are uids like 'Service:checkout' or 'PR:4087'; use search_nodes to resolve a name. " +
        "Read blastradius://schema for the graph model.",
    },
  );

  for (const name of exposed) {
    const readOnly = toolSpecs[name]?.readOnly ?? !isWriteTool(name);
    server.registerTool(
      name,
      {
        title: name,
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: toolInputShape(name),
        annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const { tenant, sessionId, agent, ...input } = args as {
          tenant: Tenant;
          sessionId?: string;
          agent?: AgentName;
        } & Record<string, unknown>;

        if (requiresSession(name) && (!sessionId || !agent)) {
          return errorResult(
            `${name} needs both "sessionId" and "agent" (one of triage, investigator, expert, scribe, navigator). ` +
              "Over MCP there is no injected session context, so pass them explicitly.",
          );
        }
        const ctx: ToolContext = { tenant };
        if (sessionId) ctx.sessionId = sessionId;
        if (agent) ctx.agent = agent;

        try {
          const result = await runTool(name, ctx, input);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (err) {
          const msg = errorMessage(err);
          log(`tool ${name} failed`, { tenant, error: msg });
          return errorResult(`${name} failed on tenant ${tenant}: ${msg}`);
        }
      },
    );
  }

  server.registerResource(
    "tenants",
    "blastradius://tenants",
    {
      title: "Tenants",
      description: "The tenants (one FalkorDB graph each) with display info and live node counts.",
      mimeType: "application/json",
    },
    async (uri) => {
      const tenants = await Promise.all(
        TENANTS.map(async (t) => {
          // Mirrors graphKey() in packages/graph (not part of its public API).
          const ns = process.env.BLASTRADIUS_GRAPH_NAMESPACE;
          const base = { id: t, graph: ns ? `${ns}_${graphName(t)}` : graphName(t), ...TENANT_INFO[t] };
          try {
            return { ...base, counts: await counts(t) };
          } catch (err) {
            return { ...base, counts: null, countsError: errorMessage(err) };
          }
        }),
      );
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(tenants, null, 2) }] };
    },
  );

  server.registerResource(
    "schema",
    "blastradius://schema",
    {
      title: "Graph schema",
      description: "Node labels, relationship types with directions, indexes, and the exposed tools.",
      mimeType: "application/json",
    },
    async (uri) => {
      const body: Record<string, unknown> = staticSchema(exposed);
      body.liveIndexes = await liveIndexes();
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
    },
  );

  log(`server ready: ${exposed.length} tools, writes ${allowWrites ? "ENABLED" : "disabled"}`, { tools: exposed });
  return server;
}

/** Indexes as FalkorDB reports them, per tenant (`CALL db.indexes()`); an error string if unreachable. */
async function liveIndexes(): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};
  for (const t of TENANTS) {
    try {
      const { rows } = await runCypher(
        t,
        `// Which indexes exist in this tenant graph?
CALL db.indexes() YIELD label, properties, types, entitytype, status
RETURN label, properties, types, entitytype, status`,
        {},
        { readOnly: true },
      );
      out[t] = rows;
    } catch (err) {
      out[t] = { error: errorMessage(err) };
    }
  }
  return out;
}
