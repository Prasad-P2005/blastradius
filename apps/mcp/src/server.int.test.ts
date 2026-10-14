/**
 * Integration tests: real HTTP server on a random port, real SDK client, real
 * FalkorDB (FALKORDB_URL from the repo-root .env or the environment).
 * The read-tool test needs data loaded first (`pnpm graph:load`).
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadRootEnv } from "@blastradius/shared/env";
import { closeFalkor } from "@blastradius/graph";
import type { GraphToolResult } from "@blastradius/shared";
import { startHttpServer, type RunningHttpServer } from "./http.ts";
import { silentLog } from "./log.ts";

loadRootEnv();

const here = dirname(fileURLToPath(import.meta.url));

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: "blastradius-int-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

describe("Streamable HTTP, writes disabled", () => {
  let srv: RunningHttpServer;
  let client: Client;

  beforeAll(async () => {
    srv = await startHttpServer({ port: 0, host: "127.0.0.1", allowWrites: false, log: silentLog });
    client = await connect(srv.url);
  });
  afterAll(async () => {
    await client?.close();
    await srv?.close();
    await closeFalkor();
  });

  it("serves /health with FalkorDB status", async () => {
    const res = await fetch(srv.url.replace(/\/mcp$/, "/health"));
    const body = (await res.json()) as { ok: boolean; falkordb: { ok: boolean } };
    expect(body.falkordb.ok).toBe(true);
    expect(body.ok).toBe(true);
  });

  it("lists read tools and hides record_finding", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("blast_radius");
    expect(names).toContain("critical_services");
    expect(names).toContain("read_handoffs");
    expect(names).not.toContain("record_finding");
    const br = tools.find((t) => t.name === "blast_radius")!;
    expect(br.inputSchema.required).toContain("tenant");
    expect(br.annotations?.readOnlyHint).toBe(true);
  });

  it("runs critical_services against live FalkorDB", async () => {
    const res = await client.callTool({ name: "critical_services", arguments: { tenant: "acme", limit: 5 } });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    const result = res.structuredContent as unknown as GraphToolResult;
    expect(result.tool).toBe("critical_services");
    expect(result.cypher).toMatch(/algo\.betweenness/);
    expect(result.rows.length).toBeGreaterThan(0); // needs `pnpm graph:load`
    expect(String(result.rows[0]!.service)).toMatch(/^Service:/);
  });

  it("returns a tool error when read_handoffs lacks sessionId/agent", async () => {
    const res = await client.callTool({ name: "read_handoffs", arguments: { tenant: "acme" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/sessionId/);
  });

  it("serves the tenants and schema resources", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(["blastradius://schema", "blastradius://tenants"]);
    const schema = await client.readResource({ uri: "blastradius://schema" });
    const body = JSON.parse(String((schema.contents[0] as { text: string }).text));
    expect(body.relationships.find((r: { type: string }) => r.type === "DEPENDS_ON").from).toEqual(["Service"]);
    const tenants = await client.readResource({ uri: "blastradius://tenants" });
    const list = JSON.parse(String((tenants.contents[0] as { text: string }).text));
    expect(list.map((t: { id: string }) => t.id)).toEqual(["acme", "globex"]);
  });
});

describe("Streamable HTTP, writes enabled", () => {
  it("exposes record_finding when MCP_ALLOW_WRITES is on", async () => {
    const srv = await startHttpServer({ port: 0, host: "127.0.0.1", allowWrites: true, log: silentLog });
    const client = await connect(srv.url);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("record_finding");
    } finally {
      await client.close();
      await srv.close();
    }
  });
});

/** Spawns `main.ts --stdio` as a subprocess (its own FalkorDB client singleton). */
async function connectStdio(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: join(here, "..", "node_modules", ".bin", "tsx"),
    args: [join(here, "main.ts"), "--stdio"],
    env: { ...(process.env as Record<string, string>), MCP_ALLOW_WRITES: "false", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "blastradius-stdio-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("stdio transport", () => {
  it("lists tools over stdio with a clean stdout", async () => {
    const client = await connectStdio({});
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("search_nodes");
      expect(tools.map((t) => t.name)).not.toContain("record_finding");
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe("FalkorDB unreachable", () => {
  it("returns isError tool results instead of crashing", async () => {
    // Port 1 refuses connections: the graph layer must throw and MCP must report it.
    const client = await connectStdio({ FALKORDB_URL: "redis://127.0.0.1:1" });
    try {
      const res = await client.callTool({ name: "blast_radius", arguments: { tenant: "acme", service: "checkout" } });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/blast_radius failed on tenant acme/);
    } finally {
      await client.close();
    }
  }, 30_000);
});
