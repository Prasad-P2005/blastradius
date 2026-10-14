/**
 * Logging for the MCP server.
 *
 * Everything goes to STDERR. In stdio mode, stdout carries the JSON-RPC
 * stream, so a single stray `console.log` would corrupt the protocol. Using
 * stderr in HTTP mode too keeps the two modes identical.
 */
export type Logger = (msg: string, extra?: Record<string, unknown>) => void;

export const log: Logger = (msg, extra) => {
  const line = extra ? `${msg} ${JSON.stringify(extra)}` : msg;
  process.stderr.write(`[blastradius-mcp] ${line}\n`);
};

/** For tests: a logger that swallows everything. */
export const silentLog: Logger = () => {};
