/**
 * load.ts — snapshot loading (STUB, being implemented).
 */
import type { Snapshot, SnapshotEdge, SnapshotNode, Tenant } from "@blastradius/shared";

export interface LoadStats { nodes: number; edges: number; touches: number; embedded: number; ms: number }
const ni = (): never => { throw new Error("not implemented"); };

export async function loadSnapshot(
  _tenant: Tenant,
  _snap: Snapshot,
  _opts?: { reset?: boolean; embed?: boolean },
): Promise<LoadStats> { return ni(); }
export async function ingestDelta(_tenant: Tenant, _nodes: SnapshotNode[], _edges: SnapshotEdge[]): Promise<LoadStats> { return ni(); }
export async function resetGraph(_tenant: Tenant): Promise<void> { return ni(); }
