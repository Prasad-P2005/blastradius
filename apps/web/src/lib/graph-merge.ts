import type { GEdge, GNode, GraphPath, Subgraph } from "@blastradius/shared";
import type { RunState } from "./run-state.ts";

const isPlaceholder = (n: GNode) => Object.keys(n.props).length === 0;

/** Union of subgraphs, deduped by uid / edge id. Real nodes win over uid-only placeholders. */
export function mergeSubgraphs(parts: (Subgraph | null | undefined)[]): Subgraph {
  const nodes = new Map<string, GNode>();
  const edges = new Map<string, GEdge>();
  for (const p of parts) {
    if (!p) continue;
    for (const n of p.nodes) {
      const prev = nodes.get(n.id);
      if (!prev || (isPlaceholder(prev) && !isPlaceholder(n))) nodes.set(n.id, n);
    }
    for (const e of p.edges) if (!edges.has(e.id)) edges.set(e.id, e);
  }
  // drop dangling edges (an endpoint we never received)
  const outEdges = [...edges.values()].filter((e) => nodes.has(e.source) && nodes.has(e.target));
  return { nodes: [...nodes.values()], edges: outEdges };
}

export function runSubgraph(r: RunState): Subgraph {
  return { nodes: Object.values(r.nodes), edges: Object.values(r.edges) };
}

export function pathsToIds(paths: GraphPath[], extra: string[] = []): Set<string> {
  const s = new Set(extra);
  for (const p of paths) {
    for (const n of p.nodes) s.add(n.id);
    for (const e of p.edges) s.add(e.id);
  }
  return s;
}
