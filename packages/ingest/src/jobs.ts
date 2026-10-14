/**
 * Best-effort bookkeeping of loads in Postgres (`ingest_jobs`). Postgres is
 * app bookkeeping only: if it is down or DATABASE_URL is unset, the db helpers
 * return null/false and we just log; the FalkorDB load itself never depends on it.
 */
import type { Json, Tenant } from "@blastradius/shared";
import { ensureTenant, finishIngestJob, startIngestJob } from "@blastradius/db";

export async function withIngestJob<T extends Record<string, unknown>>(tenant: Tenant, kind: "snapshot" | "delta", run: () => Promise<T>): Promise<T> {
  await ensureTenant(tenant);
  const id = await startIngestJob({ tenant, kind });
  if (id == null) console.log(`[jobs] postgres unavailable: not recording the ${kind} job for ${tenant} (best-effort)`);
  try {
    const stats = await run();
    await finishIngestJob(id, { status: "ok", stats: stats as unknown as Record<string, Json> });
    return stats;
  } catch (e) {
    await finishIngestJob(id, { status: "error", error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
