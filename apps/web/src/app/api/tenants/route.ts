import { TENANTS, TENANT_INFO } from "@blastradius/shared";
import { counts } from "@blastradius/graph";
import { handle, json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tenants with live node/relationship counts from each tenant's FalkorDB graph (503 if FalkorDB is down). */
export function GET() {
  return handle(async () => {
    const out = await Promise.all(
      TENANTS.map(async (id) => ({ id, ...TENANT_INFO[id], counts: await counts(id) })),
    );
    return json(out);
  });
}
