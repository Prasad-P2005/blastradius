import { createWorkspace, deleteWorkspace, listWorkspaces } from "@blastradius/graph";
import { TenantSchema } from "@blastradius/shared";
import { z } from "zod";
import { requireUser } from "@/server/user";
import { handle, json, readJson, tenantFrom } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every graph (FalkorDB GRAPH.LIST), newest first. */
export function GET() {
  return handle(async () => json(await listWorkspaces()));
}

const CreateBody = z.object({ id: TenantSchema, name: z.string().trim().min(2).max(60), description: z.string().trim().max(300).optional() });

/** Creates an empty graph: indexes + its Workspace node. Returns the statements that ran. */
export function POST(req: Request) {
  return handle(async () => {
    const user = requireUser(req);
    const body = CreateBody.parse(await readJson(req));
    return json(await createWorkspace(body.id, { name: body.name, description: body.description ?? "", createdBy: user.name }), 201);
  });
}

/** Deletes a whole graph (?tenant=): data, agent memory and indexes. */
export function DELETE(req: Request) {
  return handle(async () => {
    requireUser(req);
    const tenant = tenantFrom(req.url);
    await deleteWorkspace(tenant);
    return json({ deleted: tenant });
  });
}
