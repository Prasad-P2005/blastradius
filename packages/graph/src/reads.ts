/**
 * reads.ts — UI read models (STUB, being implemented).
 */
import type { MemoryInspectorData, NodeLabel, RelType, Subgraph, Tenant } from "@blastradius/shared";

const ni = (): never => { throw new Error("not implemented"); };

export async function overview(_tenant: Tenant): Promise<Subgraph> { return ni(); }
export async function neighborhood(_tenant: Tenant, _uid: string, _opts?: { limit?: number }): Promise<Subgraph> { return ni(); }
export async function counts(
  _tenant: Tenant,
): Promise<{ labels: Partial<Record<NodeLabel, number>>; rels: Partial<Record<RelType, number>> }> { return ni(); }
export async function memoryInspector(_tenant: Tenant, _sessionId?: string): Promise<MemoryInspectorData> { return ni(); }
