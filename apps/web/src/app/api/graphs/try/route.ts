import { runTool } from "@blastradius/graph";
import { ToolNameSchema, isWriteTool } from "@blastradius/shared";
import { z } from "zod";
import { HttpError, handle, json, readJson, tenantFrom } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ tool: ToolNameSchema, input: z.record(z.string(), z.unknown()) });

/** Runs one READ tool exactly as an agent would, so the builder can show what each step unlocks. */
export function POST(req: Request) {
  return handle(async () => {
    const tenant = tenantFrom(req.url);
    const { tool, input } = Body.parse(await readJson(req));
    if (isWriteTool(tool)) throw new HttpError(400, `${tool} writes to the graph; only read tools can be tried here`);
    return json(await runTool(tool, { tenant }, input));
  });
}
