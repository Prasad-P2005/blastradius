/**
 * convert.ts — THE single place FalkorDB client values become uids / plain JSON.
 *
 * The falkordb client returns:
 *   Node: { id: number, labels: string[], properties: {...} }
 *   Edge: { id: number, relationshipType: string, sourceId: number, destinationId: number, properties: {...} }
 *   Path: { nodes: Node[], edges: Edge[] }
 *
 * `id`, `sourceId` and `destinationId` are FalkorDB INTERNAL ids. They are
 * reused after deletes and differ between graphs, so they must never leave
 * this package. Everything we hand out is keyed by the node's `uid` property,
 * and edges reference their endpoints by uid.
 */
import {
  EMBEDDING_PROP,
  edgeId,
  isNodeLabel,
  isRelType,
  parseUid,
  type GEdge,
  type GNode,
  type GraphPath,
  type Json,
  type NodeLabel,
  type RelType,
} from "@blastradius/shared";

interface RawNode {
  id: number;
  labels: string[];
  properties: Record<string, unknown>;
}
interface RawEdge {
  id: number;
  relationshipType: string;
  sourceId: number;
  destinationId: number;
  properties: Record<string, unknown>;
}
interface RawPath {
  nodes: RawNode[];
  edges: RawEdge[];
}

export function isRawNode(v: unknown): v is RawNode {
  return (
    typeof v === "object" && v !== null && Array.isArray((v as RawNode).labels) && typeof (v as RawNode).properties === "object"
  );
}
export function isRawEdge(v: unknown): v is RawEdge {
  return (
    typeof v === "object" &&
    v !== null &&
    "relationshipType" in v &&
    "sourceId" in v &&
    "destinationId" in v &&
    typeof (v as RawEdge).properties === "object"
  );
}
export function isRawPath(v: unknown): v is RawPath {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as RawPath).nodes) &&
    Array.isArray((v as RawPath).edges) &&
    !("labels" in v)
  );
}

/** Plain-JSON props: drops the embedding (huge, useless to humans) and anything non-JSON. */
function plainProps(props: Record<string, unknown>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === EMBEDDING_PROP) continue;
    out[k] = toPlain(v);
  }
  return out;
}

/** Display name: name ?? title ?? key of the uid. */
function displayName(uid: string, props: Record<string, unknown>): string {
  for (const k of ["name", "title", "key", "claim", "summary"]) {
    const v = props[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return parseUid(uid)?.key ?? uid;
}

/** Converts a raw client Node into a GNode keyed by its uid. */
export function toGNode(raw: unknown): GNode {
  if (!isRawNode(raw)) throw new Error("toGNode: not a FalkorDB node");
  const props = raw.properties ?? {};
  const label = (raw.labels.find((l) => isNodeLabel(l)) ?? raw.labels[0] ?? "Service") as NodeLabel;
  const uid = typeof props.uid === "string" ? props.uid : `${label}:?`;
  return { id: uid, label, name: displayName(uid, props), props: plainProps(props) };
}

/**
 * Converts a raw client Edge. Its endpoints are internal ids, so the caller
 * supplies the internal-id → uid map built from the nodes it has (e.g. the
 * nodes of the same path). An endpoint we cannot resolve becomes "?".
 */
export function toGEdge(raw: unknown, nodesByInternalId: Map<number, string>): GEdge {
  if (!isRawEdge(raw)) throw new Error("toGEdge: not a FalkorDB edge");
  const source = nodesByInternalId.get(raw.sourceId) ?? "?";
  const target = nodesByInternalId.get(raw.destinationId) ?? "?";
  const type = (isRelType(raw.relationshipType) ? raw.relationshipType : raw.relationshipType) as RelType;
  const props = plainProps(raw.properties ?? {});
  // Parallel ON_CALL_FOR edges (one per week) must stay distinct.
  const suffix = typeof props.weekStart === "string" ? `#${props.weekStart}` : "";
  return { id: edgeId(source, type, target) + suffix, source, target, type, props };
}

/** Converts a raw client Path into an ordered GraphPath of uids. */
export function toGraphPath(raw: unknown): GraphPath {
  if (!isRawPath(raw)) throw new Error("toGraphPath: not a FalkorDB path");
  const nodes = raw.nodes.map(toGNode);
  const byId = new Map<number, string>();
  raw.nodes.forEach((n, i) => byId.set(n.id, nodes[i]!.id));
  const edges = raw.edges.map((e) => toGEdge(e, byId));
  return { nodes, edges };
}

/**
 * Any client value → plain JSON. Nodes become `{uid, label, name, props}`,
 * edges `{type, props}` (endpoints unknown without context), paths
 * `{nodes:[uid…], rels:[type…]}`. Use the path converters for evidence.
 */
export function toPlain(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(toPlain);
  if (isRawNode(value)) {
    const n = toGNode(value);
    return { uid: n.id, label: n.label, name: n.name, props: n.props };
  }
  if (isRawEdge(value)) return { type: value.relationshipType, props: plainProps(value.properties) };
  if (isRawPath(value)) {
    const p = toGraphPath(value);
    return { nodes: p.nodes.map((n) => n.id), rels: p.edges.map((e) => e.type) };
  }
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === EMBEDDING_PROP) continue;
      out[k] = toPlain(v);
    }
    return out;
  }
  return String(value);
}

/**
 * Collects every Path found in raw result rows (any column, nested in arrays)
 * and converts them, de-duplicated by their uid/edge signature.
 */
export function pathsFromRaw(rawRows: unknown[], columns?: string[]): GraphPath[] {
  const out: GraphPath[] = [];
  const seen = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (isRawPath(v)) {
      const p = toGraphPath(v);
      if (p.nodes.length === 0) return;
      const sig = p.nodes.map((n) => n.id).join(">") + "|" + p.edges.map((e) => e.id).join(",");
      if (!seen.has(sig)) {
        seen.add(sig);
        out.push(p);
      }
    }
  };
  for (const row of rawRows) {
    if (typeof row !== "object" || row === null) continue;
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (columns && !columns.includes(k)) continue;
      visit(v);
    }
  }
  return out;
}

/** Merges paths into one de-duplicated Subgraph-shaped node/edge set. */
export function mergePaths(paths: GraphPath[]): { nodes: GNode[]; edges: GEdge[] } {
  const nodes = new Map<string, GNode>();
  const edges = new Map<string, GEdge>();
  for (const p of paths) {
    for (const n of p.nodes) nodes.set(n.id, n);
    for (const e of p.edges) edges.set(e.id, e);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
