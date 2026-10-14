/**
 * Route-handler helpers: JSON responses, `{error}` bodies with real status codes,
 * and tenant/query validation with the contract's zod schemas.
 *
 * FalkorDB being down must be VISIBLE: graph errors become 503 with the driver's
 * message, never an empty 200.
 */
import { TenantSchema, type Tenant } from "@blastradius/shared";
import { z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

export function fail(status: number, error: string): Response {
  return json({ error }, status);
}

/** Connection-level failures (FalkorDB/Redis or Postgres unreachable) → 503. */
export function isUnavailable(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ""}` : String(e);
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|Socket closed|connection is closed|The client is closed|Connection timeout|connect ECONN/i.test(msg);
}

export function errorMessage(e: unknown): string {
  if (e instanceof z.ZodError) return e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
  return e instanceof Error ? e.message : String(e);
}

/** Wraps a handler: HttpError → its status, ZodError → 400, unreachable DB → 503, anything else → 500. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.message);
    if (e instanceof z.ZodError) return fail(400, errorMessage(e));
    if (isUnavailable(e)) return fail(503, `backend unavailable: ${errorMessage(e)}`);
    // FalkorDB answers this when the tenant's graph key doesn't exist yet (data not loaded).
    if (/empty key/i.test(errorMessage(e))) return fail(503, `tenant graph not loaded (run \`pnpm seed\`): ${errorMessage(e)}`);
    console.error("[web] route error:", e);
    return fail(500, errorMessage(e));
  }
}

export function tenantFrom(url: URL | string): Tenant {
  const u = typeof url === "string" ? new URL(url) : url;
  const raw = u.searchParams.get("tenant");
  if (!raw) throw new HttpError(400, "missing ?tenant= (acme | globex)");
  const parsed = TenantSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, `unknown tenant: ${raw}`);
  return parsed.data;
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}
