/**
 * connection.ts — the one FalkorDB client, graph handles and `runCypher`.
 *
 * - `getFalkor()` is a lazily created singleton built from FALKORDB_URL /
 *   FALKORDB_PASSWORD (the repo-root .env is loaded on first use, so plain
 *   tsx scripts work without extra setup).
 * - `graphKey(tenant)` is `graphName(tenant)`, or `${ns}_${graphName(tenant)}`
 *   when BLASTRADIUS_GRAPH_NAMESPACE is set. Integration tests set it (to
 *   `itest`) so they never clobber the real `blastradius_acme` / `_globex`.
 * - `runCypher()` is the only place a query is sent. It returns plain-JSON rows
 *   (via the converter) plus the raw client values, which the tools use to
 *   build evidence paths.
 */
import { FalkorDB, type Graph } from "falkordb";
import { graphName, type Json, type Row, type Tenant } from "@blastradius/shared";
import { loadRootEnv } from "@blastradius/shared/env";
import { toPlain } from "./convert.ts";

let clientPromise: Promise<FalkorDB> | null = null;

/**
 * FalkorDB Cloud shows its URL as `redis://falkordb@host:port`: a user, no password.
 * node-redis lets credentials parsed from the URL override the options, so that
 * URL silently drops FALKORDB_PASSWORD (WRONGPASS). Move a password-less user out
 * of the URL into the `username` option instead. URLs with a password are kept as is.
 */
export function splitUrlUser(raw: string): { url: string; username?: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: raw };
  }
  if (!parsed.username || parsed.password) return { url: raw };
  const username = decodeURIComponent(parsed.username);
  parsed.username = "";
  return { url: parsed.toString(), username };
}

/** The FalkorDB client singleton. Throws (rejects) if the server is unreachable. */
export function getFalkor(): Promise<FalkorDB> {
  if (!clientPromise) {
    loadRootEnv();
    const { url, username } = splitUrlUser(process.env.FALKORDB_URL || "redis://localhost:6380");
    const password = process.env.FALKORDB_PASSWORD || undefined;
    clientPromise = FalkorDB.connect({
      url,
      username,
      password,
      socket: {
        connectTimeout: 5000,
        // Fail fast instead of retrying forever: a dead FalkorDB must surface
        // as an error (SPEC: "if FalkorDB is down, the functions throw").
        reconnectStrategy: (retries: number) => (retries >= 3 ? new Error("FalkorDB unreachable") : 200 * (retries + 1)),
      } as never,
    })
      .then((db) => {
        // Without a listener an 'error' event would crash the process.
        db.on("error", () => {
          clientPromise = null;
        });
        return db;
      })
      .catch((err: unknown) => {
        // Do not cache a failed connection: the next call retries.
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

/** Closes the singleton (scripts and tests call this so the process can exit). */
export async function closeFalkor(): Promise<void> {
  const p = clientPromise;
  clientPromise = null;
  if (p) {
    try {
      await (await p).close();
    } catch {
      /* already closed */
    }
  }
}

/** The FalkorDB key for a tenant graph, honouring BLASTRADIUS_GRAPH_NAMESPACE. */
export function graphKey(tenant: Tenant): string {
  loadRootEnv();
  const ns = process.env.BLASTRADIUS_GRAPH_NAMESPACE;
  return ns ? `${ns}_${graphName(tenant)}` : graphName(tenant);
}

/**
 * A client graph handle for the tenant.
 *
 * We deliberately return a FRESH handle each time instead of caching one: the
 * client caches label / relationship-type / property-key names by internal id
 * per handle, and that cache goes stale when another process resets and
 * reloads the graph (ids get reassigned). A fresh handle costs three tiny
 * metadata procedure calls the first time a result contains nodes or edges.
 */
export async function graphFor(tenant: Tenant): Promise<Graph> {
  const db = await getFalkor();
  return db.selectGraph(graphKey(tenant));
}

export interface RunOptions {
  /** Use GRAPH.RO_QUERY (the server rejects writes). Read tools always set this. */
  readOnly?: boolean;
  /** Per-query timeout in ms. The server default is 1000 ms. */
  timeoutMs?: number;
}

/**
 * Runs one parameterised Cypher query. `rows` are plain JSON (nodes become
 * `{uid,label,name,props}` objects via the converter); `raw` keeps the client's
 * values so callers can turn `MATCH p = …` paths into GraphPaths.
 */
export async function runCypher(
  tenant: Tenant,
  cypher: string,
  params: Record<string, Json> = {},
  opts: RunOptions = {},
): Promise<{ rows: Row[]; raw: unknown[]; ms: number }> {
  const graph = await graphFor(tenant);
  const options: { params?: Record<string, Json>; TIMEOUT?: number } = {};
  if (Object.keys(params).length > 0) options.params = params;
  if (opts.timeoutMs !== undefined) options.TIMEOUT = opts.timeoutMs;
  const t0 = performance.now();
  const reply = opts.readOnly
    ? await graph.roQuery<Record<string, unknown>>(cypher, options as never)
    : await graph.query<Record<string, unknown>>(cypher, options as never);
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  const raw = (reply.data ?? []) as unknown[];
  const rows = raw.map((r) => toPlain(r) as Row);
  return { rows, raw, ms };
}

/** Pings FalkorDB and measures the round trip. Never throws. */
export async function falkorHealth(): Promise<{ ok: boolean; ms?: number; error?: string }> {
  const t0 = performance.now();
  try {
    const db = await withTimeout(getFalkor(), 3000);
    const conn = await db.connection;
    await withTimeout((conn as unknown as { ping(): Promise<string> }).ping(), 3000);
    return { ok: true, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
