/**
 * tools/index.ts — the tool registry (STUB, being implemented).
 */
import {
  TOOL_DESCRIPTIONS, TOOL_NAMES, ToolInputSchemas, isWriteTool,
  type GraphToolResult, type Tenant, type ToolContext, type ToolName,
} from "@blastradius/shared";
import type { ToolSpec } from "./types.ts";

function stub<T extends ToolName>(name: T): ToolSpec<T> {
  return {
    name,
    description: TOOL_DESCRIPTIONS[name],
    input: ToolInputSchemas[name],
    readOnly: !isWriteTool(name),
    async run() { throw new Error("not implemented"); },
  };
}

export const toolSpecs = Object.fromEntries(TOOL_NAMES.map((n) => [n, stub(n)])) as { [T in ToolName]: ToolSpec<T> };

export async function runTool(name: ToolName, ctx: ToolContext, rawInput: unknown): Promise<GraphToolResult> {
  const spec = toolSpecs[name] as unknown as ToolSpec;
  return spec.run(ctx, rawInput as never);
}

export async function newestPrAt(_tenant: Tenant): Promise<number> { throw new Error("not implemented"); }
