/**
 * Workspaces: the graphs users create. One FalkorDB graph per workspace
 * (key `blastradius_<slug>`), and the graph describes itself with a single
 * (:Workspace {uid: 'Workspace:meta'}) node: display name, description, who
 * created it, and which seed packs were loaded into it.
 *
 * The list of workspaces is FalkorDB's own GRAPH.LIST, so it works even when
 * Postgres is down.
 */
import { MEMORY_LABELS, TenantSchema, isSeedPack, type SeedPack, type Tenant } from "@blastradius/shared";
import { getFalkor, graphKey, runCypher } from "./connection.ts";
import { resetGraph } from "./load.ts";
import { ensureSchema, schemaStatements } from "./schema.ts";
import { num, str } from "./tools/common.ts";

export interface WorkspaceInfo {
  id: Tenant;
  name: string;
  description: string;
  createdBy: string | null;
  createdAt: number | null;
  /** seed packs loaded into this graph (scenarios of these packs apply) */
  seeded: SeedPack[];
  nodes: number;
  edges: number;
}

export const WORKSPACE_UID = "Workspace:meta";

/** Labels that aren't domain data: agent memory and this metadata node. */
const NOT_DOMAIN = (v: string) => [...MEMORY_LABELS, "Workspace"].map((l) => `${v}:${l}`).join(" OR ");

const READ_WORKSPACE = `// The graph's own description, plus the size of its domain data (agent memory excluded)
OPTIONAL MATCH (w:Workspace {uid: $uid})
WITH w
OPTIONAL MATCH (n) WHERE NOT (${NOT_DOMAIN("n")})
WITH w, count(n) AS nodes
OPTIONAL MATCH (a)-[r]->(b) WHERE NOT (${NOT_DOMAIN("a")}) AND NOT (${NOT_DOMAIN("b")})
RETURN w.name AS name, w.description AS description, w.createdBy AS createdBy,
       w.createdAt AS createdAt, w.seeded AS seeded, nodes, count(r) AS edges`;

function prefix(): string {
  // graphKey('x') ends in "blastradius_x": strip the "x" to get the prefix, namespace included
  return graphKey("x").slice(0, -1);
}

export async function getWorkspace(tenant: Tenant): Promise<WorkspaceInfo> {
  const { rows } = await runCypher(tenant, READ_WORKSPACE, { uid: WORKSPACE_UID }, { readOnly: true, timeoutMs: 5000 });
  const r = rows[0] ?? {};
  const seeded = Array.isArray(r.seeded) ? r.seeded.filter(isSeedPack) : [];
  return {
    id: tenant,
    name: str(r.name) || tenant,
    description: str(r.description),
    createdBy: str(r.createdBy) || null,
    createdAt: r.createdAt === null || r.createdAt === undefined ? null : num(r.createdAt),
    seeded,
    nodes: num(r.nodes),
    edges: num(r.edges),
  };
}

const COUNT_INDEXES = `// How many indexes does this graph have? (0 = nobody ever set it up)
CALL db.indexes() YIELD label
RETURN count(label) AS n`;

/**
 * A "ghost" is a graph key that a write-capable read query created by
 * accident (GRAPH.QUERY on a missing key creates it): no Workspace node, no
 * nodes, no indexes. Real graphs always get their indexes first (createWorkspace,
 * loadSnapshot), so they are never mistaken for one.
 */
async function isGhost(w: WorkspaceInfo): Promise<boolean> {
  if (w.createdAt !== null || w.nodes > 0) return false;
  const { rows } = await runCypher(w.id, COUNT_INDEXES, {}, { readOnly: true });
  return num(rows[0]?.n) === 0;
}

/** Every workspace graph on the server, newest first. Accidental empty "ghost" keys are removed. */
export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  const db = await getFalkor();
  const p = prefix();
  const ids = (await db.list()).filter((k) => k.startsWith(p)).map((k) => k.slice(p.length)).filter((id) => TenantSchema.safeParse(id).success);
  const all = await Promise.all(ids.map((id) => getWorkspace(id)));
  const real: WorkspaceInfo[] = [];
  for (const w of all) {
    if (await isGhost(w)) await resetGraph(w.id);
    else real.push(w);
  }
  return real.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function workspaceExists(tenant: Tenant): Promise<boolean> {
  const db = await getFalkor();
  return (await db.list()).includes(graphKey(tenant));
}

const UPSERT_WORKSPACE = `// Create the graph's description node (creating the node creates the graph)
MERGE (w:Workspace {uid: $uid})
ON CREATE SET w.createdAt = $now, w.createdBy = $createdBy, w.seeded = []
SET w.name = $name, w.description = $description, w.synthetic = true`;

/**
 * Creates an empty graph: indexes first (uid, full-text, vector), then the
 * Workspace node. Returns the statements that ran so the builder can show them.
 */
export async function createWorkspace(
  tenant: Tenant,
  meta: { name: string; description?: string; createdBy?: string },
): Promise<{ workspace: WorkspaceInfo; cypher: string[] }> {
  TenantSchema.parse(tenant);
  if (await workspaceExists(tenant)) throw new Error(`a graph called "${tenant}" already exists`);
  await ensureSchema(tenant);
  await runCypher(tenant, UPSERT_WORKSPACE, {
    uid: WORKSPACE_UID,
    now: Date.now(),
    name: meta.name,
    description: meta.description ?? "",
    createdBy: meta.createdBy ?? "",
  });
  return { workspace: await getWorkspace(tenant), cypher: [...schemaStatements(), UPSERT_WORKSPACE] };
}

/** Makes sure a graph has its Workspace node (graphs loaded by the CLI don't). */
export async function ensureWorkspaceNode(tenant: Tenant, name: string): Promise<void> {
  await runCypher(tenant, UPSERT_WORKSPACE.replace("SET w.name = $name, w.description = $description", "SET w.name = coalesce(w.name, $name), w.description = coalesce(w.description, $description)"), {
    uid: WORKSPACE_UID,
    now: Date.now(),
    name,
    description: "",
    createdBy: "",
  });
}

const MARK_SEEDED = `// Remember that a seed pack was loaded into this graph
MATCH (w:Workspace {uid: $uid})
SET w.seeded = CASE WHEN $pack IN coalesce(w.seeded, []) THEN w.seeded ELSE coalesce(w.seeded, []) + $pack END`;

export async function markSeeded(tenant: Tenant, pack: SeedPack): Promise<void> {
  await runCypher(tenant, MARK_SEEDED, { uid: WORKSPACE_UID, pack });
}

/** Deletes the whole graph: data, agent memory and indexes. */
export async function deleteWorkspace(tenant: Tenant): Promise<void> {
  await resetGraph(tenant);
}
