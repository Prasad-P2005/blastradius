/**
 * reads.ts — read models for the UI: the service map, a node's neighbourhood,
 * label/relationship counts and the Memory inspector. Every id is a uid.
 */
import {
  type AgentName,
  type EpisodeView,
  type GNode,
  type Json,
  type MemoryInspectorData,
  type NodeLabel,
  type ProceduralMemory,
  type RelType,
  type Subgraph,
  type Tenant,
} from "@blastradius/shared";
import { runCypher } from "./connection.ts";
import { isRawNode, mergePaths, pathsFromRaw, toGNode } from "./convert.ts";
import { findingFromProps, listGraphSessions, LIST_SESSIONS_CYPHER } from "./memory.ts";
import { labelOfUid, num, str } from "./tools/common.ts";

/** Builds a Subgraph from raw rows: standalone node columns + path columns. */
export function subgraphFromRaw(raw: unknown[], nodeColumns: string[], pathColumns: string[]): Subgraph {
  const merged = mergePaths(pathsFromRaw(raw, pathColumns));
  const nodes = new Map<string, GNode>(merged.nodes.map((n) => [n.id, n]));
  for (const row of raw) {
    for (const c of nodeColumns) {
      const v = (row as Record<string, unknown>)[c];
      if (isRawNode(v)) {
        const n = toGNode(v);
        if (!nodes.has(n.id)) nodes.set(n.id, n);
      }
    }
  }
  return { nodes: [...nodes.values()], edges: merged.edges };
}

export const OVERVIEW_CYPHER = `// The service map: every Service, its DEPENDS_ON edges and the Team that OWNS it
MATCH (s:Service)
OPTIONAL MATCH dp = (s)-[:DEPENDS_ON]->(:Service)
WITH s, collect(dp) AS deps
OPTIONAL MATCH op = (:Team)-[:OWNS]->(s)
RETURN s, deps, collect(op) AS owns`;

export async function overview(tenant: Tenant): Promise<Subgraph> {
  const { raw } = await runCypher(tenant, OVERVIEW_CYPHER, {}, { readOnly: true });
  return subgraphFromRaw(raw, ["s"], ["deps", "owns"]);
}

export function neighborhoodCypher(label: NodeLabel): string {
  return `// Everything one hop from $uid (any relationship, either direction)
MATCH (n:${label} {uid: $uid})
OPTIONAL MATCH p = (n)-[]-()
RETURN n, p
LIMIT $limit`;
}

export async function neighborhood(tenant: Tenant, uid: string, opts: { limit?: number } = {}): Promise<Subgraph> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  const { raw } = await runCypher(tenant, neighborhoodCypher(labelOfUid(uid)), { uid, limit }, { readOnly: true });
  return subgraphFromRaw(raw, ["n"], ["p"]);
}

export const COUNT_LABELS_CYPHER = `// Node count per label
MATCH (n)
RETURN labels(n)[0] AS label, count(n) AS count`;
export const COUNT_RELS_CYPHER = `// Relationship count per type
MATCH ()-[r]->()
RETURN type(r) AS type, count(r) AS count`;

export async function counts(
  tenant: Tenant,
): Promise<{ labels: Partial<Record<NodeLabel, number>>; rels: Partial<Record<RelType, number>> }> {
  const [l, r] = await Promise.all([
    runCypher(tenant, COUNT_LABELS_CYPHER, {}, { readOnly: true, timeoutMs: 5000 }),
    runCypher(tenant, COUNT_RELS_CYPHER, {}, { readOnly: true, timeoutMs: 5000 }),
  ]);
  const labels: Partial<Record<NodeLabel, number>> = {};
  for (const row of l.rows) labels[str(row.label) as NodeLabel] = num(row.count);
  const rels: Partial<Record<RelType, number>> = {};
  for (const row of r.rows) rels[str(row.type) as RelType] = num(row.count);
  return { labels, rels };
}

export const SESSION_EPISODES_CYPHER = `// A session's episode chain, each with the findings it PRODUCED
MATCH (s:Session {sessionId: $sessionId})-[:HAS_EPISODE]->(e:Episode)
OPTIONAL MATCH (e)-[:PRODUCED]->(f:Finding)
WITH e, f ORDER BY f.createdAt ASC
RETURN e, collect(f) AS findings
ORDER BY e.seq ASC`;

export const SESSION_HANDOFFS_CYPHER = `// Handoffs inside a session: Finding -[:HANDED_TO]-> Agent
MATCH (f:Finding {sessionId: $sessionId})-[:HANDED_TO]->(to:Agent)
RETURN f.id AS findingId, f.agent AS from, to.name AS to, f.claim AS claim
ORDER BY f.createdAt ASC`;

export const SESSION_SUBGRAPH_CYPHER = `// The memory subgraph of a session: Session → Episodes → Findings → domain nodes,
// plus the agents that wrote / received the findings
MATCH sp = (s:Session {sessionId: $sessionId})-[:HAS_EPISODE]->(e:Episode)
OPTIONAL MATCH np = (e)-[:NEXT]->(:Episode)
OPTIONAL MATCH pp = (e)-[:PRODUCED]->(f:Finding)
OPTIONAL MATCH dp = (f)-[:ABOUT|SUPPORTED_BY|HANDED_TO]->()
OPTIONAL MATCH wp = (:Agent)-[:WROTE]->(f)
OPTIONAL MATCH ip = (s)-[:INVESTIGATES]->()
RETURN s, collect(DISTINCT sp) + collect(DISTINCT np) + collect(DISTINCT pp) + collect(DISTINCT dp)
       + collect(DISTINCT wp) + collect(DISTINCT ip) AS paths`;

export const PROCEDURAL_CYPHER = `// Procedural memory: incidents per service with cause PR and runbook
MATCH (i:Incident)-[:AFFECTED]->(s:Service)
OPTIONAL MATCH (i)-[:RESOLVED_BY]->(rb:Runbook)
OPTIONAL MATCH (i)-[:CAUSED_BY]->(pr:PR)
WITH s, i, collect(rb)[0] AS rb, collect(pr.uid)[0] AS causedBy
ORDER BY coalesce(i.resolvedAt, i.startedAt) DESC
RETURN s.uid AS service,
       collect({uid: i.uid, title: i.title, severity: i.severity, resolvedAt: i.resolvedAt,
                synthetic: coalesce(i.synthetic, false), sessionId: i.sessionId, causedBy: causedBy,
                runbook: CASE WHEN rb IS NULL THEN null ELSE {uid: rb.uid, title: rb.title, steps: rb.steps} END}) AS incidents
ORDER BY service`;

export async function memoryInspector(tenant: Tenant, sessionId?: string): Promise<MemoryInspectorData> {
  const cypher: string[] = [LIST_SESSIONS_CYPHER, PROCEDURAL_CYPHER];
  const [sessions, proc] = await Promise.all([
    listGraphSessions(tenant, 50),
    runCypher(tenant, PROCEDURAL_CYPHER, {}, { readOnly: true }),
  ]);
  const procedural: ProceduralMemory[] = proc.rows.map((r) => ({
    service: str(r.service),
    incidents: (Array.isArray(r.incidents) ? r.incidents : []).map((x) => {
      const i = x as Record<string, Json>;
      const inc: ProceduralMemory["incidents"][number] = {
        uid: str(i.uid),
        title: str(i.title),
        severity: str(i.severity),
        synthetic: i.synthetic === true,
      };
      if (i.resolvedAt !== null && i.resolvedAt !== undefined) inc.resolvedAt = num(i.resolvedAt);
      if (i.sessionId) inc.sessionId = str(i.sessionId);
      if (i.causedBy) inc.causedBy = str(i.causedBy);
      if (i.runbook && typeof i.runbook === "object" && !Array.isArray(i.runbook)) {
        const rb = i.runbook as Record<string, Json>;
        inc.runbook = { uid: str(rb.uid), title: str(rb.title), steps: Array.isArray(rb.steps) ? rb.steps.map(String) : [] };
      }
      return inc;
    }),
  }));

  const data: MemoryInspectorData = { tenant, sessions, procedural, subgraph: { nodes: [], edges: [] }, cypher };
  if (!sessionId) return data;

  cypher.push(SESSION_EPISODES_CYPHER, SESSION_HANDOFFS_CYPHER, SESSION_SUBGRAPH_CYPHER);
  const [eps, hand, sub] = await Promise.all([
    runCypher(tenant, SESSION_EPISODES_CYPHER, { sessionId }, { readOnly: true }),
    runCypher(tenant, SESSION_HANDOFFS_CYPHER, { sessionId }, { readOnly: true }),
    runCypher(tenant, SESSION_SUBGRAPH_CYPHER, { sessionId }, { readOnly: true }),
  ]);
  const episodes: EpisodeView[] = eps.rows.map((r) => {
    const e = ((r.e as Record<string, Json>)?.props ?? {}) as Record<string, Json>;
    const fs = Array.isArray(r.findings) ? r.findings : [];
    return {
      uid: str(e.uid),
      seq: num(e.seq),
      agent: str(e.agent) as AgentName | "system",
      kind: str(e.kind),
      summary: str(e.summary),
      at: num(e.at),
      findings: fs.map((f) => findingFromProps(((f as Record<string, Json>).props ?? {}) as Record<string, Json>)),
    };
  });
  data.session = {
    sessionId,
    episodes,
    handoffs: hand.rows.map((r) => ({
      findingId: str(r.findingId),
      from: str(r.from) as AgentName,
      to: str(r.to) as AgentName,
      claim: str(r.claim),
    })),
  };
  data.subgraph = subgraphFromRaw(sub.raw, ["s"], ["paths"]);
  return data;
}

