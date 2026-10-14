/**
 * tools/types.ts — the ToolSpec shape shared by every tool module.
 */
import type { GraphToolResult, ToolContext, ToolInput, ToolInputSchemas, ToolName } from "@blastradius/shared";

export interface ToolSpec<T extends ToolName = ToolName> {
  name: T;
  description: string;
  /** the zod input schema (without tenant/sessionId/agent, which code injects) */
  input: (typeof ToolInputSchemas)[T];
  readOnly: boolean;
  /** Validates `input` with `this.input.parse()` (applying defaults), then runs. */
  run(ctx: ToolContext, input: ToolInput<T>): Promise<GraphToolResult>;
}
