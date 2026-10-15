/**
 * load.ts — loading snapshots (and incremental deltas) into a tenant graph.
 *
 * Steps (SPEC §1/§2):
 *   1. (optional) reset: delete the graph key.
 *   2. ensureSchema: indexes first, so the MERGEs below use the uid index.
 *   3. Nodes, grouped by label, in batches:
 *        UNWIND $rows AS row MERGE (n:Label {uid: row.uid}) SET n += row.props
 *   4. Relationships, grouped by (type, source label, target label), in batches.
 *      Labels on both endpoints let MATCH use the uid range index.
 *      ON_CALL_FOR is MERGEd on weekStart: one edge per person/service/week.
 *   5. Derive (PR)-[:TOUCHES {files}]->(Service) from PR-MODIFIES->File-PART_OF->Service.
 *   6. Derive (Person)-[:COLLABORATES_WITH {files}]->(Person) between human authors
 *      whose PRs modified the same files (who_knows runs PageRank on it).
 *   7. Embeddings for EMBEDDED_LABELS from EMBED_TEXT_FIELDS, stored with vecf32().
 *
 * Labels and relationship types are the only interpolated identifiers, and
 * only after assertLabel / assertRelType.
 */
import {
  EMBEDDED_LABELS,
  EMBED_TEXT_FIELDS,
  assertLabel,
  assertRelType,
  isNodeLabel,
  parseUid,
  type EmbeddedLabel,
  type Json,
  type NodeLabel,
  type Snapshot,
  type SnapshotEdge,
  type SnapshotNode,
  type Tenant,
} from "@blastradius/shared";
import { getFalkor, graphKey, runCypher } from "./connection.ts";
import { embedMany, vecParam } from "./embed.ts";
import { ensureSchema } from "./schema.ts";

export interface LoadStats {
  nodes: number;
  edges: number;
  touches: number;
  collaborations: number;
  embedded: number;
  ms: number;
}

/** Rows per UNWIND batch. Small enough to stay well under the per-query timeout. */
const NODE_BATCH = 500;
const EDGE_BATCH = 1000;
const VEC_BATCH = 50;
/** Bulk loads may legitimately take longer than the 1000 ms server default. */
const LOAD_TIMEOUT_MS = 60_000;

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Drops nulls/undefined (FalkorDB cannot store null properties) and the uid (it is the MERGE key). */
function cleanProps(props: Record<string, Json> | undefined): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || k === "uid" || k === "embedding") continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid property key: ${k}`);
    out[k] = v;
  }
  return out;
}

/** The node-upsert query for one label. */
export function nodeUpsertCypher(label: NodeLabel): string {
  const L = assertLabel(label);
  return `// Upsert ${L} nodes by uid (batched)
UNWIND $rows AS row
MERGE (n:${L} {uid: row.uid})
SET n += row.props`;
}

/** The relationship-upsert query for one (type, from label, to label) group. */
export function edgeUpsertCypher(type: string, fromLabel: NodeLabel, toLabel: NodeLabel): string {
  const T = assertRelType(type);
  const A = assertLabel(fromLabel);
  const B = assertLabel(toLabel);
  // ON_CALL_FOR is one edge per week, so weekStart is part of the MERGE key (lesson 1).
  const mergeKey = T === "ON_CALL_FOR" ? " {weekStart: row.props.weekStart}" : "";
  return `// Upsert ${A}-[:${T}]->${B} relationships (batched)
UNWIND $rows AS row
MATCH (a:${A} {uid: row.from})
MATCH (b:${B} {uid: row.to})
MERGE (a)-[r:${T}${mergeKey}]->(b)
SET r += row.props`;
}

/** Derives TOUCHES for all PRs (prUids = null) or only for the given PRs. */
export function touchesCypher(onlySome: boolean): string {
  return onlySome
    ? `// Derive (PR)-[:TOUCHES {files}]->(Service) for the given PRs
UNWIND $prs AS prUid
MATCH (pr:PR {uid: prUid})-[:MODIFIES]->(f:File)-[:PART_OF]->(s:Service)
WITH pr, s, count(DISTINCT f) AS files
MERGE (pr)-[t:TOUCHES]->(s)
SET t.files = files
RETURN count(t) AS touches`
    : `// Derive (PR)-[:TOUCHES {files}]->(Service) for every PR
MATCH (pr:PR)-[:MODIFIES]->(f:File)-[:PART_OF]->(s:Service)
WITH pr, s, count(DISTINCT f) AS files
MERGE (pr)-[t:TOUCHES]->(s)
SET t.files = files
RETURN count(t) AS touches`;
}

/**
 * Derives the co-authorship graph that who_knows runs PageRank on:
 * (a)-[:COLLABORATES_WITH {files}]->(b) for every pair of human authors whose
 * PRs modified at least one common file, in both directions, with `files` =
 * how many files they share. Real facts only: bots and personas are left out.
 *
 * Why derive it: authorship edges point Person → PR, so PageRank can never
 * flow INTO a person over AUTHORED. Person-to-Person edges let
 * algo.pageRank('Person', 'COLLABORATES_WITH') rank people by how central
 * they are in who-works-with-whom.
 *
 * Always recomputed for the whole graph (MERGE + SET, so it is idempotent):
 * a few hundred edges, milliseconds, and a delta can connect any two people.
 */
export const COLLABORATION_CYPHER = `// Derive (Person)-[:COLLABORATES_WITH {files}]->(Person): human authors who changed the same files
MATCH (a:Person)-[:AUTHORED]->(:PR)-[:MODIFIES]->(f:File)<-[:MODIFIES]-(:PR)<-[:AUTHORED]-(b:Person)
WHERE a <> b
  AND NOT coalesce(a.isBot, false) AND NOT coalesce(b.isBot, false)
  AND NOT coalesce(a.persona, false) AND NOT coalesce(b.persona, false)
WITH a, b, count(DISTINCT f) AS files
MERGE (a)-[c:COLLABORATES_WITH]->(b)
SET c.files = files
RETURN count(c) AS collaborations`;

/** The query that stores embeddings for one embedded label. */
export function setEmbeddingCypher(label: EmbeddedLabel): string {
  const L = assertLabel(label);
  return `// Store embeddings as vecf32 (feeds the ${L} vector index)
UNWIND $rows AS row
MATCH (n:${L} {uid: row.uid})
SET n.embedding = vecf32(row.vec)`;
}

/** The text that gets embedded for a node: EMBED_TEXT_FIELDS joined by newlines. */
export function embedText(label: EmbeddedLabel, props: Record<string, Json>): string {
  return EMBED_TEXT_FIELDS[label]
    .map((f) => props[f])
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map((v) => (Array.isArray(v) ? v.join(" ") : String(v)))
    .join("\n");
}

async function upsertNodes(tenant: Tenant, nodes: SnapshotNode[]): Promise<number> {
  const byLabel = new Map<NodeLabel, SnapshotNode[]>();
  for (const node of nodes) {
    const label = assertLabel(node.label);
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label)!.push(node);
  }
  let count = 0;
  for (const [label, group] of byLabel) {
    const cypher = nodeUpsertCypher(label);
    for (const batch of chunks(group, NODE_BATCH)) {
      const rows = batch.map((nd) => ({ uid: nd.uid, props: cleanProps(nd.props) }));
      await runCypher(tenant, cypher, { rows }, { timeoutMs: LOAD_TIMEOUT_MS });
      count += batch.length;
    }
  }
  return count;
}

async function upsertEdges(tenant: Tenant, edges: SnapshotEdge[]): Promise<number> {
  const groups = new Map<string, { type: string; from: NodeLabel; to: NodeLabel; rows: SnapshotEdge[] }>();
  for (const edge of edges) {
    const type = assertRelType(edge.type);
    if (type === "TOUCHES" || type === "COLLABORATES_WITH") continue; // derived, never loaded
    const a = parseUid(edge.from)?.label;
    const b = parseUid(edge.to)?.label;
    if (!a || !b || !isNodeLabel(a) || !isNodeLabel(b)) throw new Error(`bad edge endpoints: ${edge.from} -> ${edge.to}`);
    const key = `${type}|${a}|${b}`;
    if (!groups.has(key)) groups.set(key, { type, from: a, to: b, rows: [] });
    groups.get(key)!.rows.push(edge);
  }
  let count = 0;
  for (const g of groups.values()) {
    const cypher = edgeUpsertCypher(g.type, g.from, g.to);
    for (const batch of chunks(g.rows, EDGE_BATCH)) {
      const rows = batch.map((ed) => {
        const props = cleanProps(ed.props);
        if (g.type === "ON_CALL_FOR" && typeof props.weekStart !== "string") {
          throw new Error(`ON_CALL_FOR edge without weekStart: ${ed.from} -> ${ed.to}`);
        }
        return { from: ed.from, to: ed.to, props };
      });
      await runCypher(tenant, cypher, { rows }, { timeoutMs: LOAD_TIMEOUT_MS });
      count += batch.length;
    }
  }
  return count;
}

async function deriveTouches(tenant: Tenant, prUids: string[] | null): Promise<number> {
  if (prUids && prUids.length === 0) return 0;
  const { rows } = await runCypher(tenant, touchesCypher(prUids !== null), prUids ? { prs: prUids } : {}, {
    timeoutMs: LOAD_TIMEOUT_MS,
  });
  return Number(rows[0]?.touches ?? 0);
}

async function deriveCollaboration(tenant: Tenant): Promise<number> {
  const { rows } = await runCypher(tenant, COLLABORATION_CYPHER, {}, { timeoutMs: LOAD_TIMEOUT_MS });
  return Number(rows[0]?.collaborations ?? 0);
}

async function embedNodes(tenant: Tenant, nodes: SnapshotNode[]): Promise<number> {
  let count = 0;
  for (const label of EMBEDDED_LABELS) {
    const group = nodes.filter((nd) => nd.label === label);
    if (group.length === 0) continue;
    const vecs = await embedMany(group.map((nd) => embedText(label, nd.props)));
    const cypher = setEmbeddingCypher(label);
    const rows = group.map((nd, i) => ({ uid: nd.uid, vec: vecParam(vecs[i]!) }));
    for (const batch of chunks(rows, VEC_BATCH)) {
      await runCypher(tenant, cypher, { rows: batch }, { timeoutMs: LOAD_TIMEOUT_MS });
      count += batch.length;
    }
  }
  return count;
}

/** Deletes the tenant graph (all data, all memory, all indexes). */
export async function resetGraph(tenant: Tenant): Promise<void> {
  const db = await getFalkor();
  try {
    await db.selectGraph(graphKey(tenant)).delete();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Deleting a graph that does not exist is fine.
    if (!/empty key|does not exist|Invalid graph operation on empty key/i.test(msg)) throw err;
  }
}

/** Loads a full snapshot. `reset` (default false) wipes the graph first; `embed` (default true) computes vectors. */
export async function loadSnapshot(
  tenant: Tenant,
  snap: Snapshot,
  opts: { reset?: boolean; embed?: boolean } = {},
): Promise<LoadStats> {
  const t0 = performance.now();
  if (opts.reset) await resetGraph(tenant);
  await ensureSchema(tenant);
  const nodes = await upsertNodes(tenant, snap.nodes);
  const edges = await upsertEdges(tenant, snap.edges);
  const touches = await deriveTouches(tenant, null);
  const collaborations = await deriveCollaboration(tenant);
  const embedded = opts.embed === false ? 0 : await embedNodes(tenant, snap.nodes);
  return { nodes, edges, touches, collaborations, embedded, ms: Math.round(performance.now() - t0) };
}

/**
 * Incremental re-ingest (Track 03): upserts new nodes/edges without a reset,
 * derives TOUCHES only for PRs in the delta (plus PRs whose MODIFIES edges are
 * in the delta), refreshes COLLABORATES_WITH, and embeds only the delta's text nodes.
 */
export async function ingestDelta(tenant: Tenant, nodes: SnapshotNode[], edges: SnapshotEdge[]): Promise<LoadStats> {
  const t0 = performance.now();
  await ensureSchema(tenant);
  const n = await upsertNodes(tenant, nodes);
  const e = await upsertEdges(tenant, edges);
  const prUids = new Set<string>(nodes.filter((nd) => nd.label === "PR").map((nd) => nd.uid));
  for (const ed of edges) if (ed.type === "MODIFIES") prUids.add(ed.from);
  const touches = await deriveTouches(tenant, [...prUids]);
  const collaborations = await deriveCollaboration(tenant);
  const embedded = await embedNodes(tenant, nodes);
  return { nodes: n, edges: e, touches, collaborations, embedded, ms: Math.round(performance.now() - t0) };
}
