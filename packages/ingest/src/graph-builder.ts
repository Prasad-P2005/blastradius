/**
 * A tiny in-memory node/edge collector with uid de-duplication and a stable,
 * deterministic output order. Used by both the real and the synthetic steps.
 */
import { isNodeLabel, isRelType, uid as mkUid, type Json, type NodeLabel, type RelType, type SnapshotEdge, type SnapshotNode } from "@blastradius/shared";

export class GraphBuilder {
  private readonly nodes = new Map<string, SnapshotNode>();
  private readonly edges = new Map<string, SnapshotEdge>();

  constructor(init?: { nodes: SnapshotNode[]; edges: SnapshotEdge[] }) {
    for (const n of init?.nodes ?? []) this.nodes.set(n.uid, n);
    for (const e of init?.edges ?? []) this.edges.set(edgeKey(e), e);
  }

  /** Adds (or merges props into) a node; returns its uid. */
  node(label: NodeLabel, key: string | number, props: Record<string, Json>): string {
    if (!isNodeLabel(label)) throw new Error(`bad label ${label}`);
    const u = mkUid(label, key);
    const prev = this.nodes.get(u);
    this.nodes.set(u, { label, uid: u, props: { ...(prev?.props ?? {}), ...props } });
    return u;
  }

  edge(type: RelType, from: string, to: string, props?: Record<string, Json>): void {
    if (!isRelType(type)) throw new Error(`bad rel type ${type}`);
    const e: SnapshotEdge = props && Object.keys(props).length ? { type, from, to, props } : { type, from, to };
    this.edges.set(edgeKey(e), e);
  }

  has(u: string): boolean {
    return this.nodes.has(u);
  }
  get(u: string): SnapshotNode | undefined {
    return this.nodes.get(u);
  }
  allNodes(): SnapshotNode[] {
    return [...this.nodes.values()];
  }
  allEdges(): SnapshotEdge[] {
    return [...this.edges.values()];
  }

  /** Nodes sorted by uid, edges by (type, from, to, weekStart). */
  sorted(): { nodes: SnapshotNode[]; edges: SnapshotEdge[] } {
    const nodes = [...this.nodes.values()].sort((a, b) => cmp(a.uid, b.uid));
    const edges = [...this.edges.entries()].sort((a, b) => cmp(a[0], b[0])).map(([, e]) => e);
    return { nodes, edges };
  }
}

/**
 * Edge identity. ON_CALL_FOR is one edge per week, so weekStart is part of
 * its identity (mirrors the loader's MERGE key). Other types: one per pair.
 */
export function edgeKey(e: SnapshotEdge): string {
  const extra = e.type === "ON_CALL_FOR" ? `|${String(e.props?.weekStart ?? "")}` : "";
  return `${e.type}|${e.from}|${e.to}${extra}`;
}

/** Plain code-unit comparison: locale-independent, so sorting is stable everywhere. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
