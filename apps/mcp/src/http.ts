/**
 * Streamable HTTP transport on `:${MCP_PORT}/mcp`, plus `GET /health`.
 *
 * Session handling follows the SDK's recommended stateful pattern:
 *   - A POST without `mcp-session-id` that carries an `initialize` request
 *     creates a new transport + McpServer pair; the SDK generates the session
 *     id and returns it in the `mcp-session-id` response header.
 *   - Every later POST / GET (SSE stream) / DELETE (end session) carries that
 *     header and is routed to the same transport.
 * Plain node:http keeps the dependency list short.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { falkorHealth } from "@blastradius/graph";
import { log as defaultLog, type Logger } from "./log.ts";
import { allowWritesFromEnv, createMcpServer } from "./server.ts";

export interface HttpServerOptions {
  /** 0 = random free port (tests). */
  port: number;
  host?: string;
  allowWrites?: boolean;
  log?: Logger;
}

export interface RunningHttpServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length ? JSON.parse(text) : undefined;
}

export async function startHttpServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  const log = opts.log ?? defaultLog;
  const allowWrites = opts.allowWrites ?? allowWritesFromEnv();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(header) ? header[0] : header;

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: `Parse error: ${String(err)}` }, id: null });
        return;
      }

      const existing = sessionId ? transports.get(sessionId) : undefined;
      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }
      if (sessionId) {
        jsonRpcError(res, 404, `Unknown or expired session ${sessionId}; re-initialize.`);
        return;
      }
      if (!isInitializeRequest(body)) {
        jsonRpcError(res, 400, "Bad Request: no mcp-session-id header and the body is not an initialize request.");
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          log("session opened", { sessionId: id, open: transports.size });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId && transports.delete(transport.sessionId)) {
          log("session closed", { sessionId: transport.sessionId, open: transports.size });
        }
      };
      const server = createMcpServer({ allowWrites, log: () => {} });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        jsonRpcError(res, sessionId ? 404 : 400, "Missing or unknown mcp-session-id header.");
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { allow: "GET, POST, DELETE" }).end();
  }

  const httpServer: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const done = (p: Promise<void>) =>
      p.catch((err) => {
        log("request failed", { path, error: String(err) });
        if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
        else res.end();
      });

    if (path === "/health" && req.method === "GET") {
      done(
        falkorHealth().then((falkordb) => {
          sendJson(res, falkordb.ok ? 200 : 503, { ok: falkordb.ok, falkordb, writes: allowWrites });
        }),
      );
      return;
    }
    if (path === "/mcp") {
      done(handleMcp(req, res));
      return;
    }
    sendJson(res, 404, { error: "not found; MCP endpoint is /mcp, health is /health" });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => resolve());
  });
  const port = (httpServer.address() as AddressInfo).port;
  const url = `http://${opts.host && opts.host !== "0.0.0.0" ? opts.host : "localhost"}:${port}/mcp`;

  // Log the mode once at startup (per-session servers are created silently).
  createMcpServer({ allowWrites, log });
  log(`Streamable HTTP listening on ${url} (health: /health)`);

  return {
    port,
    url,
    async close() {
      for (const t of transports.values()) await t.close().catch(() => {});
      transports.clear();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
