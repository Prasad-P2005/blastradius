/**
 * The graph builder: create and delete single nodes and relationships by hand.
 *
 * Writes use exactly the loader's queries (MERGE by uid, see load.ts), so a
 * hand-built graph has the same shape as a loaded one and every agent tool
 * works on it. After each write the derived edges are recomputed:
 *   - (PR)-[:TOUCHES]->(Service)            from PR-MODIFIES->File-PART_OF->Service
 *   - (Person)-[:COLLABORATES_WITH]->(Person) from shared files
 * and text nodes (Incident, Decision, Doc, Issue, Thread) are embedded.
 *
 * Every function returns the Cypher it ran, so the UI can teach with it.
 */
import {
  MEMORY_LABELS,
  NODE_FORMS,
  REL_SHAPES,
  assertLabel,
  assertRelType,
  isNodeLabel,
  parseUid,
  slugify,
  uid as makeUid,
  type BuilderField,
  type Json,
  type NodeLabel,
  type RelType,
  type SnapshotEdge,
  type SnapshotNode,
  type Subgraph,
  type Tenant,
} from "@blastradius/shared";
import { runCypher } from "./connection.ts";
import { COLLABORATION_CYPHER, deriveCollaboration, deriveTouches, edgeUpsertCypher, embedNodes, nodeUpsertCypher, touchesCypher, upsertEdges, upsertNodes } from "./load.ts";
import { subgraphFromRaw } from "./reads.ts";
import { str } from "./tools/common.ts";

export interface BuilderResult {
  uid?: string;
  /** the statements that ran, in order */
  cypher: string[];
  /** the parameters of the main statement (what $rows held) */
  params?: Json;
  ms: number;
}

/** Turns a form field's raw string into the stored value (epoch ms for dates, numbers, string lists). */
function coerce(field: BuilderField, raw: unknown): Json | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (field.kind === "lines") {
    const list = (Array.isArray(raw) ? raw.map(String) : String(raw).split("\n")).map((l) => l.trim()).filter(Boolean);
    return list.length ? list : undefined;
  }
  const s = String(raw).trim();
  if (s === "") return undefined;
  if (field.kind === "int" || (field.kind === "enum" && field.name === "tier")) {
    const n = Number(s);
    if (!Number.isInteger(n)) throw new Error(`${field.label} must be a whole number`);
    return n;
  }
  if (field.kind === "date") {
    const t = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
    if (!Number.isFinite(t)) throw new Error(`${field.label} must be a date`);
    return t;
  }
  if (field.kind === "enum" && field.options && !field.options.includes(s)) throw new Error(`${field.label} must be one of ${field.options.join(", ")}`);
  return s;
}

/** Builds the node exactly as the loader would store it. Exported for tests and seeding. */
export function buildNode(label: NodeLabel, values: Record<string, unknown>): SnapshotNode {
  const form = NODE_FORMS[label];
  if (!form) throw new Error(`${label} nodes can't be created by hand`);
  const props: Record<string, Json> = { synthetic: true, builder: true };
  for (const f of form.fields) {
    const v = coerce(f, values[f.name]);
    if (v === undefined) {
      if (f.required) throw new Error(`${f.label} is required`);
      continue;
    }
    props[f.name] = v;
  }
  const rawKey = props[form.key];
  const key = form.slug ? slugify(String(rawKey)) : String(rawKey);
  if (!key) throw new Error(`${form.key} can't make an id`);
  // properties the tools read that the form doesn't ask for
  if (label === "Service" || label === "Team" || label === "Person") props.slug = key;
  if (label === "Service") props.kind = "service";
  if (label === "Person") {
    props.isBot = false;
    props.persona = false; // hand-built people are ranked by who_knows like real authors
  }
  if (label === "File" && typeof values.service === "string") props.service = values.service;
  if (label === "Incident") props.status = "resolved";
  return { uid: makeUid(label, key), label, props };
}

/** Recomputes the derived edges from scratch (they may be stale after a delete). */
export async function refreshDerived(tenant: Tenant): Promise<string[]> {
  const clear = `// Drop derived edges; they are recomputed from the facts below
MATCH ()-[d:TOUCHES|COLLABORATES_WITH]->()
DELETE d`;
  await runCypher(tenant, clear, {}, { timeoutMs: 30_000 });
  await deriveTouches(tenant, null);
  await deriveCollaboration(tenant);
  return [clear, touchesCypher(false), COLLABORATION_CYPHER];
}

/** Adds (or updates) one node. */
export async function addNode(tenant: Tenant, label: string, values: Record<string, unknown>): Promise<BuilderResult> {
  const t0 = performance.now();
  const L = assertLabel(label);
  const node = buildNode(L, values);
  await upsertNodes(tenant, [node]);
  await embedNodes(tenant, [node]);
  return { uid: node.uid, cypher: [nodeUpsertCypher(L)], params: { rows: [{ uid: node.uid, props: node.props }] }, ms: Math.round(performance.now() - t0) };
}

const ENDPOINTS = `// Both ends must exist before we connect them
UNWIND $uids AS u
MATCH (n {uid: u})
RETURN n.uid AS uid`;

/** Adds one relationship after checking its direction and endpoints. */
export async function addEdge(tenant: Tenant, type: string, from: string, to: string, props: Record<string, Json> = {}): Promise<BuilderResult> {
  const t0 = performance.now();
  const T = assertRelType(type);
  const shape = REL_SHAPES[T];
  if (!shape) throw new Error(`${T} is derived or written by agents; it can't be drawn by hand`);
  const a = parseUid(from)?.label;
  const b = parseUid(to)?.label;
  if (!a || !b || !isNodeLabel(a) || !isNodeLabel(b)) throw new Error("both ends must be node uids like Service:cart");
  if (!shape.from.includes(a) || !shape.to.includes(b)) {
    throw new Error(`${T} goes from ${shape.from.join("|")} to ${shape.to.join("|")}, not ${a} → ${b}`);
  }
  if (from === to) throw new Error("a node can't point at itself");
  const { rows } = await runCypher(tenant, ENDPOINTS, { uids: [from, to] }, { readOnly: true });
  const found = new Set(rows.map((r) => str(r.uid)));
  for (const u of [from, to]) if (!found.has(u)) throw new Error(`${u} isn't in the graph yet`);
  const clean: Record<string, Json> = {};
  for (const [k, v] of Object.entries(props)) if (v !== "" && v !== null && v !== undefined && (shape.props ?? []).includes(k)) clean[k] = v;
  if (T === "ON_CALL_FOR") {
    const w = String(clean.weekStart ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w)) throw new Error("ON_CALL_FOR needs weekStart as YYYY-MM-DD");
    clean.weekStartTs = Date.parse(`${w}T00:00:00Z`);
  }
  const edge: SnapshotEdge = { type: T as RelType, from, to, props: clean };
  await upsertEdges(tenant, [edge]);
  const cypher = [edgeUpsertCypher(T, a, b)];
  // these feed the derived edges, so recompute them
  if (T === "MODIFIES" || T === "PART_OF" || T === "AUTHORED") cypher.push(...(await refreshDerived(tenant)));
  return { cypher, params: { rows: [{ from, to, props: clean }] }, ms: Math.round(performance.now() - t0) };
}

/** Deletes a node and all its relationships. The Workspace node is protected. */
export async function deleteNode(tenant: Tenant, uid: string): Promise<BuilderResult> {
  const t0 = performance.now();
  const L = assertLabel(parseUid(uid)?.label ?? "");
  if (L === "Workspace") throw new Error("delete the whole graph instead");
  const cypher = `// Delete one node and every relationship touching it
MATCH (n:${L} {uid: $uid})
DETACH DELETE n`;
  await runCypher(tenant, cypher, { uid });
  return { cypher: [cypher, ...(await refreshDerived(tenant))], params: { uid }, ms: Math.round(performance.now() - t0) };
}

export async function deleteEdge(tenant: Tenant, type: string, from: string, to: string): Promise<BuilderResult> {
  const t0 = performance.now();
  const T = assertRelType(type);
  const cypher = `// Delete the ${T} relationship(s) between two nodes
MATCH (a {uid: $from})-[r:${T}]->(b {uid: $to})
DELETE r`;
  await runCypher(tenant, cypher, { from, to });
  return { cypher: [cypher, ...(await refreshDerived(tenant))], params: { from, to }, ms: Math.round(performance.now() - t0) };
}

/** Nodes of one label for the builder's lists and pickers. */
export async function listNodes(tenant: Tenant, label: string, limit = 300): Promise<{ uid: string; name: string; props: Record<string, Json> }[]> {
  const L = assertLabel(label);
  const cypher = `// Every ${L} (for the builder)
MATCH (n:${L})
RETURN n.uid AS uid, coalesce(n.name, n.title, n.key, n.path, toString(n.number), n.uid) AS name, properties(n) AS props
ORDER BY name
LIMIT $limit`;
  const { rows } = await runCypher(tenant, cypher, { limit }, { readOnly: true });
  return rows.map((r) => {
    const props = { ...((r.props as Record<string, Json>) ?? {}) };
    delete props.embedding;
    return { uid: str(r.uid), name: str(r.name), props };
  });
}

const HIDDEN = [...MEMORY_LABELS, "Workspace"].map((l) => `n:${l}`).join(" OR ");

/** The whole domain graph (no memory, no Workspace node), capped, for the builder's live view. */
export async function graphDump(tenant: Tenant, limit = 600): Promise<Subgraph> {
  const cypher = `// The domain graph, for the live view (agent memory hidden)
MATCH (n)
WHERE NOT (${HIDDEN})
WITH n LIMIT $limit
OPTIONAL MATCH p = (n)-[]->(m)
WHERE NOT (${HIDDEN.replaceAll("n:", "m:")})
RETURN n, p`;
  const { raw } = await runCypher(tenant, cypher, { limit }, { readOnly: true, timeoutMs: 5000 });
  return subgraphFromRaw(raw, ["n"], ["p"]);
}

/** Bulk add for seeding a step's sample data: nodes, then edges, then derived edges. */
export async function addMany(tenant: Tenant, nodes: SnapshotNode[], edges: SnapshotEdge[]): Promise<BuilderResult & { nodes: number; edges: number }> {
  const t0 = performance.now();
  await upsertNodes(tenant, nodes);
  await upsertEdges(tenant, edges);
  const derived = await refreshDerived(tenant);
  await embedNodes(tenant, nodes);
  const labels = [...new Set(nodes.map((n) => n.label))];
  return {
    nodes: nodes.length,
    edges: edges.length,
    cypher: [...labels.map((l) => nodeUpsertCypher(l)), ...derived],
    ms: Math.round(performance.now() - t0),
  };
}

/** A builder sample: nodes as form values, edges by uid. Relative times are resolved at seed time. */
export interface BuilderSample {
  nodes: { label: string; values: Record<string, unknown> }[];
  edges: { type: string; from: string; to: string; props?: Record<string, Json> }[];
}

const DAY = 86_400_000;

/** "-3d" → 3 days ago (epoch ms); "thisWeek"/"lastWeek" → that week's Monday (YYYY-MM-DD). */
function resolveRelative(v: unknown, now: number): unknown {
  if (typeof v !== "string") return v;
  const m = /^-(\d+)d$/.exec(v);
  if (m) return String(now - Number(m[1]) * DAY);
  if (v === "thisWeek" || v === "lastWeek") {
    const d = new Date(now - (v === "lastWeek" ? 7 * DAY : 0));
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
    return monday.toISOString().slice(0, 10);
  }
  return v;
}

/** Seeds one sample (a builder step's data) through the same node builder the forms use. */
export async function addSample(tenant: Tenant, sample: BuilderSample, now = Date.now()): Promise<BuilderResult & { nodes: number; edges: number }> {
  const nodes = sample.nodes.map((n) => {
    const values = Object.fromEntries(Object.entries(n.values).map(([k, v]) => [k, resolveRelative(v, now)]));
    // files know their service from PART_OF in the same sample (the File form doesn't ask for it)
    if (n.label === "File") {
      const part = sample.edges.find((e) => e.type === "PART_OF" && e.from === `File:${String(values.path)}`);
      if (part) values.service = part.to.replace(/^Service:/, "");
    }
    return buildNode(assertLabel(n.label), values);
  });
  const edges: SnapshotEdge[] = sample.edges.map((e) => {
    const T = assertRelType(e.type);
    const props: Record<string, Json> = {};
    for (const [k, v] of Object.entries(e.props ?? {})) props[k] = resolveRelative(v, now) as Json;
    if (T === "ON_CALL_FOR" && typeof props.weekStart === "string") props.weekStartTs = Date.parse(`${props.weekStart}T00:00:00Z`);
    return { type: T, from: e.from, to: e.to, props };
  });
  return addMany(tenant, nodes, edges);
}
