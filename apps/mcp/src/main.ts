/**
 * Entrypoint.
 *   pnpm --filter @blastradius/mcp start    → Streamable HTTP on :${MCP_PORT:-3333}/mcp
 *   pnpm --filter @blastradius/mcp stdio    → stdio (for Claude Desktop / Claude Code / Cursor)
 *
 * In stdio mode stdout is the protocol channel: all logging goes to stderr.
 */
import { loadRootEnv } from "@blastradius/shared/env";

// Must run before anything reads process.env (the graph package reads FALKORDB_URL lazily).
loadRootEnv();

const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { closeFalkor } = await import("@blastradius/graph");
const { log } = await import("./log.ts");
const { createMcpServer } = await import("./server.ts");
const { startHttpServer } = await import("./http.ts");

const stdio = process.argv.includes("--stdio");

let shutdown: () => Promise<void>;

if (stdio) {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("stdio transport connected");
  shutdown = async () => {
    await server.close();
  };
} else {
  const port = Number(process.env.MCP_PORT ?? 3333);
  const host = process.env.MCP_HOST ?? "127.0.0.1";
  const running = await startHttpServer({ port, host });
  shutdown = () => running.close();
}

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: shutting down`);
  await shutdown().catch(() => {});
  await closeFalkor().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
if (stdio) process.stdin.on("close", () => void stop("stdin closed"));
