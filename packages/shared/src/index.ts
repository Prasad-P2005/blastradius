/**
 * @blastradius/shared — THE CONTRACT.
 *
 * Every package (graph, ingest, agents, db, web, mcp) imports its vocabulary
 * from here: tenants, node labels, relationship types, tool names + input
 * schemas, agent names, the SSE event union, and request/response shapes.
 *
 * Rules for changing this file (owned by the lead):
 *   - Changes are ADDITIVE only once Phase 1 starts. Never rename or remove.
 *   - Cross-team needs go to docs/requests/<workstream>.md, not here directly.
 *
 * This module must stay isomorphic (browser + Node): no `node:*` imports.
 * Node-only helpers live in `@blastradius/shared/env`.
 */
import { z } from "zod";

/* ────────────────────────────────────────────────────────────────────────
 * Tenants — one FalkorDB graph per tenant.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * A tenant is any graph a user created: a lowercase slug, stored as the
 * FalkorDB key `blastradius_<slug>`. The live list comes from FalkorDB
 * (`listWorkspaces` in @blastradius/graph), not from this file.
 */
export type Tenant = string;
export const TENANT_SLUG_RE = /^[a-z][a-z0-9-]{1,29}$/;
export const TenantSchema = z.string().regex(TENANT_SLUG_RE, "graph id: 2-30 chars, lowercase letters, digits and dashes, starting with a letter");

/**
 * Sample datasets that can be seeded into a graph on demand (data/<pack>.json,
 * built from real public git history). They are NOT loaded by default.
 * `TENANTS` is the old name, kept for the ingest/agents scripts that iterate the packs.
 */
export const SEED_PACKS = ["acme", "globex"] as const;
export type SeedPack = (typeof SEED_PACKS)[number];
export const TENANTS = SEED_PACKS;
export function isSeedPack(x: unknown): x is SeedPack {
  return typeof x === "string" && (SEED_PACKS as readonly string[]).includes(x);
}

export const TENANT_INFO: Record<SeedPack, { name: string; sourceRepo: string; description: string }> = {
  acme: {
    name: "Acme Shop",
    sourceRepo: "open-telemetry/opentelemetry-demo",
    description: "Polyglot astronomy shop (OpenTelemetry demo), real git history + synthetic org data.",
  },
  globex: {
    name: "Globex Boutique",
    sourceRepo: "GoogleCloudPlatform/microservices-demo",
    description: "Online Boutique (Google microservices demo), real git history + synthetic org data.",
  },
};

/** Display info for any tenant: the seed pack's info, or a title made from the slug. */
export function tenantInfo(tenant: Tenant): { name: string; sourceRepo?: string; description: string } {
  if (isSeedPack(tenant)) return TENANT_INFO[tenant];
  const name = tenant
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return { name, description: "A graph built by hand in the builder." };
}

/** FalkorDB graph key for a tenant. Never build graph names any other way. */
export function graphName(tenant: Tenant): string {
  return `blastradius_${tenant}`;
}

export function isTenant(x: unknown): x is Tenant {
  return typeof x === "string" && TENANT_SLUG_RE.test(x);
}

/* ────────────────────────────────────────────────────────────────────────
 * Graph vocabulary. Labels and relationship types are WHITELISTS: Cypher
 * may only interpolate a label/type that appears in these arrays.
 * ──────────────────────────────────────────────────────────────────────── */

export const NODE_LABELS = [
  // domain: code + org (real data from git history, except Team)
  "Service",
  "File",
  "PR",
  "Person",
  "Team",
  // company brain (synthetic)
  "Issue",
  "Thread",
  "Decision",
  "Doc",
  // incident world (synthetic seed + written by the Scribe at runtime)
  "Incident",
  "Runbook",
  "Alert",
  // graph metadata: one node per graph (name, description, seed packs loaded)
  "Workspace",
  // agent memory (written at runtime)
  "Session",
  "Episode",
  "Finding",
  "Agent",
] as const;
export type NodeLabel = (typeof NODE_LABELS)[number];
export const NodeLabelSchema = z.enum(NODE_LABELS);

/** Labels that are agent memory rather than domain knowledge. */
export const MEMORY_LABELS = ["Session", "Episode", "Finding", "Agent"] as const satisfies readonly NodeLabel[];

/**
 * Relationship types. Direction is part of the contract: always
 * (source)-[:TYPE]->(target) exactly as documented.
 */
export const REL_TYPES = [
  "DEPENDS_ON", //    (Service)-[:DEPENDS_ON {protocol}]->(Service)        caller → callee. protocol: 'grpc'|'http'|'redis'|'kafka'|'postgres'|'tcp'|...
  "OWNS", //          (Team)-[:OWNS]->(Service)
  "PART_OF", //       (File)-[:PART_OF]->(Service)
  "AUTHORED", //      (Person)-[:AUTHORED]->(PR)
  "MODIFIES", //      (PR)-[:MODIFIES {additions, deletions}]->(File)
  "TOUCHES", //       (PR)-[:TOUCHES]->(Service)                           derived at load: PR-MODIFIES->File-PART_OF->Service
  "MEMBER_OF", //     (Person)-[:MEMBER_OF]->(Team)
  "ON_CALL_FOR", //   (Person)-[:ON_CALL_FOR {weekStart}]->(Service)       one edge per week; MERGE on (person, service, weekStart)
  "MENTIONS", //      (Issue|Thread|Doc|Decision|Incident)-[:MENTIONS]->(Service|PR|Person|Incident|Decision|Issue)
  "JUSTIFIES", //     (Decision)-[:JUSTIFIES]->(PR)
  "DOCUMENTED_IN", // (Decision)-[:DOCUMENTED_IN]->(Doc)
  "DECIDED_BY", //    (Decision)-[:DECIDED_BY]->(Person|Team)
  "ABOUT", //         (Decision|Doc|Issue|Thread)-[:ABOUT]->(Service);  (Finding)-[:ABOUT]->(any domain node)
  "AFFECTED", //      (Incident)-[:AFFECTED]->(Service)
  "CAUSED_BY", //     (Incident)-[:CAUSED_BY]->(PR)
  "RESOLVED_BY", //   (Incident)-[:RESOLVED_BY]->(Runbook)
  "RESPONDED_BY", //  (Incident)-[:RESPONDED_BY]->(Person)
  "TRIGGERED_BY", //  (Incident)-[:TRIGGERED_BY]->(Alert)
  "APPLIES_TO", //    (Runbook)-[:APPLIES_TO]->(Service)
  "FIRED_ON", //      (Alert)-[:FIRED_ON]->(Service)
  "HAS_EPISODE", //   (Session)-[:HAS_EPISODE]->(Episode)
  "NEXT", //          (Episode)-[:NEXT]->(Episode)                         chain within one session, in order
  "PRODUCED", //      (Episode)-[:PRODUCED]->(Finding)
  "WROTE", //         (Agent)-[:WROTE]->(Finding)
  "SUPPORTED_BY", //  (Finding)-[:SUPPORTED_BY]->(any domain node)         the evidence behind a claim
  "HANDED_TO", //     (Finding)-[:HANDED_TO]->(Agent)                      the ONLY way agents hand off work
  "INVESTIGATES", //  (Session)-[:INVESTIGATES]->(Alert|Service|Incident)
  "COLLABORATES_WITH", // (Person)-[:COLLABORATES_WITH {files}]->(Person)  derived at load: human authors whose PRs modified the same files (both directions)
  "POSTED", //        (Person {persona:true})-[:POSTED]->(Thread|Issue)       a fictional persona wrote this chat thread / filed this ticket
] as const;
export type RelType = (typeof REL_TYPES)[number];
export const RelTypeSchema = z.enum(REL_TYPES);

export function isNodeLabel(x: unknown): x is NodeLabel {
  return typeof x === "string" && (NODE_LABELS as readonly string[]).includes(x);
}
export function isRelType(x: unknown): x is RelType {
  return typeof x === "string" && (REL_TYPES as readonly string[]).includes(x);
}
/** Throws unless `x` is a whitelisted label. Use before interpolating into Cypher. */
export function assertLabel(x: string): NodeLabel {
  if (!isNodeLabel(x)) throw new Error(`label not in whitelist: ${x}`);
  return x;
}
/** Throws unless `x` is a whitelisted relationship type. Use before interpolating into Cypher. */
export function assertRelType(x: string): RelType {
  if (!isRelType(x)) throw new Error(`relationship type not in whitelist: ${x}`);
  return x;
}

/* ────────────────────────────────────────────────────────────────────────
 * Ids. Every node the UI / agents / MCP see is identified by its `uid`
 * property: `${Label}:${key}`, e.g. `Service:checkout`, `PR:4087`.
 * FalkorDB internal ids NEVER leave packages/graph.
 * ──────────────────────────────────────────────────────────────────────── */

export function uid(label: NodeLabel, key: string | number): string {
  return `${label}:${key}`;
}

/** Splits `Service:checkout` → { label: 'Service', key: 'checkout' }. Returns null if malformed. */
export function parseUid(u: string): { label: NodeLabel; key: string } | null {
  const i = u.indexOf(":");
  if (i <= 0) return null;
  const label = u.slice(0, i);
  const key = u.slice(i + 1);
  if (!isNodeLabel(label) || key.length === 0) return null;
  return { label, key };
}

/** Lowercase, ASCII, dash-separated. `"Jane O'Neil"` → `"jane-o-neil"`. Deterministic. */
export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Accepts `checkout` or `Service:checkout`; returns `Service:checkout`. */
export function serviceUid(ref: string): string {
  return ref.startsWith("Service:") ? ref : uid("Service", slugify(ref));
}

/** Stable edge id used by the UI: `Service:a-DEPENDS_ON->Service:b`. */
export function edgeId(source: string, type: RelType | string, target: string): string {
  return `${source}-${type}->${target}`;
}

/* ────────────────────────────────────────────────────────────────────────
 * Embeddings (vectors live in FalkorDB: vecf32 + vector index).
 * ──────────────────────────────────────────────────────────────────────── */

export const EMBEDDING_DIM = 384;
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
/** Node property that holds the vecf32 embedding. */
export const EMBEDDING_PROP = "embedding";
export const EMBEDDED_LABELS = ["Incident", "Decision", "Doc", "Issue", "Thread", "Finding"] as const satisfies readonly NodeLabel[];
export type EmbeddedLabel = (typeof EMBEDDED_LABELS)[number];
/** Which properties are concatenated (in order, joined by "\n") to form the embedded text. */
export const EMBED_TEXT_FIELDS: Record<EmbeddedLabel, readonly string[]> = {
  Incident: ["title", "summary", "rootCause"],
  Decision: ["title", "context", "decision", "consequences"],
  Doc: ["title", "text"],
  Issue: ["title", "body"],
  Thread: ["title", "text"],
  Finding: ["claim"],
};
/**
 * FalkorDB cosine vector scores are DISTANCES in [0, 2]: lower = closer.
 * Always convert before showing a number to a human or a model.
 */
export function cosineDistanceToSimilarity(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance));
}

/* ────────────────────────────────────────────────────────────────────────
 * Graph shapes returned to the UI / agents. All ids are uids.
 * ──────────────────────────────────────────────────────────────────────── */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface GNode {
  /** uid, e.g. "Service:checkout" */
  id: string;
  label: NodeLabel;
  /** Human display name (name ?? title ?? key). */
  name: string;
  /** Plain-JSON properties. `embedding` is always stripped. */
  props: Record<string, Json>;
}

export interface GEdge {
  /** edgeId(source, type, target) — plus `#weekStart` etc. if parallel edges must stay distinct */
  id: string;
  source: string;
  target: string;
  type: RelType;
  props: Record<string, Json>;
}

/** An ordered path: nodes[i] —edges[i]— nodes[i+1]. Edge direction is given by source/target. */
export interface GraphPath {
  nodes: GNode[];
  edges: GEdge[];
}

export interface Subgraph {
  nodes: GNode[];
  edges: GEdge[];
}

export type Row = Record<string, Json>;

/**
 * What every graph tool returns. `cypher` is EXACTLY the string sent to
 * FalkorDB (Findings copy it verbatim so the Why? drawer can match them).
 * Tools should answer in ONE query; if a second query is unavoidable it is
 * listed in `extraQueries` (and Findings include it in `cypher[]` too).
 */
export interface GraphToolResult<R extends Row = Row> {
  tool: ToolName;
  tenant: Tenant;
  cypher: string;
  params: Record<string, Json>;
  extraQueries?: { cypher: string; params: Record<string, Json> }[];
  /** Plain-JSON rows (no FalkorDB Node objects; nodes appear as uids or small objects). */
  rows: R[];
  /** Evidence paths (from `MATCH p = …`), converted to uids by the single converter in packages/graph. */
  paths: GraphPath[];
  /** One-line human summary, e.g. "4 services within 3 hops of checkout; top: frontend (betweenness 0.42)". */
  summary: string;
  /** Wall-clock milliseconds for the query/queries. */
  ms: number;
}

/* ────────────────────────────────────────────────────────────────────────
 * Tools. One registry, three consumers: agents (AI SDK), MCP server, UI.
 * `tenant` is always injected by code; agents never choose it.
 * `sessionId` / `agent` are injected for memory tools.
 * Input schemas are plain z.object()s (no refine/transform) so MCP can use `.shape`.
 * ──────────────────────────────────────────────────────────────────────── */

export const TOOL_NAMES = [
  "blast_radius",
  "critical_services",
  "suspect_changes",
  "who_knows",
  "on_call",
  "service_context",
  "past_incidents",
  "similar_incidents",
  "decision_trace",
  "explain_path",
  "search_nodes",
  "failure_communities",
  "ask_company",
  "recall_memory",
  "read_handoffs",
  "record_finding",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export const ToolNameSchema = z.enum(TOOL_NAMES);

/** Tools that write to the graph. Disabled over MCP unless MCP_ALLOW_WRITES=true. */
export const WRITE_TOOLS = ["record_finding"] as const satisfies readonly ToolName[];
export function isWriteTool(t: ToolName): boolean {
  return (WRITE_TOOLS as readonly string[]).includes(t);
}

export const AGENT_NAMES = ["triage", "investigator", "expert", "scribe", "navigator"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
export const AgentNameSchema = z.enum(AGENT_NAMES);

/** `checkout` or `Service:checkout` — tools normalise with serviceUid(). */
const service = z.string().min(1).describe("Service slug (e.g. 'checkout') or uid ('Service:checkout')");
const nodeUid = z.string().min(3).describe("Node uid, e.g. 'Service:checkout', 'PR:4087', 'Person:jane-doe'");

/**
 * Input schemas (WITHOUT tenant / sessionId / agent — those are injected).
 * Defaults are applied by the tool implementation via `.parse()`.
 */
export const ToolInputSchemas = {
  /** Q1 "What else breaks?" Multi-hop DEPENDS_ON walk, ranked by betweenness centrality. */
  blast_radius: z.object({
    service,
    maxHops: z.number().int().min(1).max(6).default(3).describe("How many DEPENDS_ON hops to walk"),
    direction: z
      .enum(["dependents", "dependencies", "both"])
      .default("dependents")
      .describe("'dependents' = who calls this service (who breaks if it fails); 'dependencies' = what it calls (possible upstream cause)"),
  }),
  /** Betweenness centrality over DEPENDS_ON: which services are chokepoints. */
  critical_services: z.object({
    limit: z.number().int().min(1).max(50).default(10),
  }),
  /** Q2 "What probably caused it?" Recent PRs touching the service or its dependencies. */
  suspect_changes: z.object({
    service,
    sinceDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30)
      .describe("Window measured back from the NEWEST PR in the tenant graph, not from today"),
    includeDependencies: z.boolean().default(true).describe("Also consider PRs on services this one DEPENDS_ON"),
    maxHops: z.number().int().min(1).max(4).default(2),
    includeBots: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  /** Q3 "Who can fix it?" PRs on the service × PageRank over the co-authorship graph (Person-COLLABORATES_WITH->Person); bots down-weighted/excluded. */
  who_knows: z.object({
    service: service.optional(),
    topic: z.string().optional().describe("Free-text topic (resolved via full-text/vector search) when there is no service"),
    team: z.string().optional().describe("Restrict to members of this team (slug or uid)"),
    onCallOnly: z.boolean().default(false),
    includeBots: z.boolean().default(false),
    limit: z.number().int().min(1).max(25).default(5),
  }),
  /** Who is on call for a service at a time (default: now; falls back to the latest rotation week ≤ at). */
  on_call: z.object({
    service,
    at: z.string().optional().describe("ISO date; default now"),
  }),
  /** One-hop context card for a service: team, owners, deps, dependents, runbooks, docs, recent incidents. */
  service_context: z.object({
    service,
  }),
  /** Q4 "What worked last time?" Incidents on the service (or its neighbours) with cause PR and runbook. */
  past_incidents: z.object({
    service,
    includeNeighbors: z.boolean().default(true),
    limit: z.number().int().min(1).max(25).default(5),
  }),
  /** Vector search over Incident embeddings, then follow each hit to its PR, people and runbook in the same query. */
  similar_incidents: z.object({
    text: z.string().min(3),
    service: service.optional().describe("Optional: boost/limit to incidents that affected this service"),
    k: z.number().int().min(1).max(20).default(5),
  }),
  /** Decision tracing: Doc ← Decision → PR → Incident. Give a free-text query or a specific uid. */
  decision_trace: z.object({
    query: z.string().optional().describe("Free text, e.g. 'move cart to valkey'"),
    uid: z.string().optional().describe("Decision, PR, Service or Incident uid to trace from"),
    limit: z.number().int().min(1).max(10).default(3),
  }),
  /** Shortest path between any two nodes (any relationship, either direction). */
  explain_path: z.object({
    from: nodeUid,
    to: nodeUid,
    maxHops: z.number().int().min(1).max(8).default(6),
  }),
  /** Full-text search over names/titles. */
  search_nodes: z.object({
    query: z.string().min(1),
    labels: z.array(NodeLabelSchema).optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  /** Community detection over the service dependency graph (CDLP or WCC): which services fail together. */
  failure_communities: z.object({
    algorithm: z.enum(["cdlp", "wcc"]).default("cdlp"),
  }),
  /** "Ask the company": vector search across text-bearing labels + 1–2 hop expansion to sources. */
  ask_company: z.object({
    question: z.string().min(3),
    k: z.number().int().min(1).max(20).default(6),
    labels: z.array(z.enum(EMBEDDED_LABELS)).optional(),
  }),
  /** Memory from OTHER sessions: findings + resolved incidents with runbooks, each with the connecting path. */
  recall_memory: z.object({
    service: service.optional(),
    text: z.string().optional(),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  /** Findings in THIS session that were handed to the calling agent. */
  read_handoffs: z.object({}),
  /** Write a Finding (linked from the latest Episode). The only write tool; the only way to hand off. */
  record_finding: z.object({
    kind: z.enum(["impact", "cause", "expert", "precedent", "answer", "summary", "risk", "action"]),
    claim: z.string().min(3).describe("One sentence a human can verify"),
    confidence: z.number().min(0).max(1),
    about: z.array(nodeUid).default([]).describe("Nodes the claim is about"),
    evidence: z.array(nodeUid).default([]).describe("Nodes that support the claim (SUPPORTED_BY)"),
    cypher: z.array(z.string()).default([]).describe("Exact Cypher strings of the tool results backing this claim"),
    handTo: AgentNameSchema.optional().describe("Hand this finding to another agent (HANDED_TO)"),
  }),
} as const satisfies Record<ToolName, z.ZodObject>;

export type ToolInput<T extends ToolName> = z.input<(typeof ToolInputSchemas)[T]>;
export type ToolArgs<T extends ToolName> = z.output<(typeof ToolInputSchemas)[T]>;

/** Context injected by code into every tool call. Never model-controlled. */
export interface ToolContext {
  tenant: Tenant;
  sessionId?: string;
  agent?: AgentName;
}

/** Descriptions shown to models (AI SDK + MCP). Keep them crisp and action-oriented. */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  blast_radius:
    "Walk DEPENDS_ON several hops from a service and rank the affected services by betweenness centrality. Answers 'what else breaks?'.",
  critical_services: "Rank all services by betweenness centrality on the dependency graph (chokepoints).",
  suspect_changes:
    "Recent merged PRs that touched the service or its dependencies, newest first, with authors and files. 'Recent' is measured from the newest PR in the graph.",
  who_knows:
    "Rank people who can fix/know a service or topic: their PRs on it × PageRank over the co-authorship graph (people who changed the same files), filtered by team/on-call; bots excluded by default.",
  on_call: "Who is on call for a service this week (falls back to the latest rotation week).",
  service_context: "Owning team, dependencies, dependents, runbooks, docs and recent incidents for one service.",
  past_incidents: "Past incidents on a service (and optionally its neighbours) with the PR that caused them and the runbook that resolved them.",
  similar_incidents:
    "Vector-search past incidents similar to a description, then follow each match to its cause PR, responders and runbook.",
  decision_trace: "Trace a decision: Doc ← Decision → PR → Incident. Use for 'why did we…' questions.",
  explain_path: "Shortest path between two nodes in the company graph, to explain how they are connected.",
  search_nodes: "Full-text search over node names and titles. Use to resolve a name to a uid.",
  failure_communities: "Community detection (CDLP or WCC) over service dependencies: groups of services that tend to fail together.",
  ask_company:
    "Answer a company question: vector search over incidents, decisions, docs, tickets and chat threads, expanded to the owners, PRs and decisions behind each hit.",
  recall_memory:
    "Recall memory from earlier sessions: findings other investigations recorded and resolved incidents with their runbooks.",
  read_handoffs: "Read findings other agents in this session handed to you.",
  record_finding:
    "Record a finding with evidence (node uids + the exact Cypher that produced it). Set handTo to hand work to another agent.",
};

/**
 * Which agent may call which tool. Enforced in code by packages/agents
 * (the model is only ever given its allowed subset).
 */
export const AGENT_TOOLS: Record<AgentName, readonly ToolName[]> = {
  triage: [
    "blast_radius",
    "critical_services",
    "failure_communities",
    "service_context",
    "on_call",
    "explain_path",
    "search_nodes",
    "recall_memory",
    "read_handoffs",
    "record_finding",
  ],
  investigator: [
    "suspect_changes",
    "similar_incidents",
    "past_incidents",
    "decision_trace",
    "service_context",
    "explain_path",
    "search_nodes",
    "read_handoffs",
    "record_finding",
  ],
  expert: ["who_knows", "on_call", "service_context", "explain_path", "search_nodes", "read_handoffs", "record_finding"],
  scribe: ["past_incidents", "service_context", "recall_memory", "read_handoffs", "record_finding"],
  navigator: [
    "ask_company",
    "decision_trace",
    "who_knows",
    "search_nodes",
    "explain_path",
    "service_context",
    "similar_incidents",
    "past_incidents",
    "critical_services",
    "recall_memory",
    "record_finding",
  ],
};

export const AGENT_INFO: Record<AgentName, { title: string; role: string }> = {
  triage: { title: "Triage", role: "Scopes the blast radius: what else breaks, and how critical it is." },
  investigator: { title: "Investigator", role: "Finds the probable cause: recent changes and similar past incidents." },
  expert: { title: "Expert finder", role: "Finds who can fix it: authorship PageRank, team and on-call." },
  scribe: { title: "Scribe", role: "Summarises the run and, on close, writes Incident + Runbook into procedural memory." },
  navigator: { title: "Navigator", role: "Answers company questions with sources (Ask the company mode)." },
};

/* ────────────────────────────────────────────────────────────────────────
 * Memory + actions.
 * ──────────────────────────────────────────────────────────────────────── */

export type FindingKind = z.infer<(typeof ToolInputSchemas)["record_finding"]>["kind"];

export interface Finding {
  /** short id, e.g. "f_9k2j…"; node uid is `Finding:${id}` */
  id: string;
  uid: string;
  sessionId: string;
  agent: AgentName;
  kind: FindingKind;
  claim: string;
  confidence: number;
  about: string[];
  evidence: string[];
  /** exact Cypher strings that back the claim (match GraphToolResult.cypher / extraQueries) */
  cypher: string[];
  handTo?: AgentName;
  /** ISO timestamp */
  createdAt: string;
}

export interface RecalledMemory {
  kind: "finding" | "incident";
  uid: string;
  title: string;
  summary: string;
  /** session that produced it (findings) */
  sessionId?: string;
  agent?: AgentName;
  runbook?: { uid: string; title: string; steps: string[] };
  /** 0..1 similarity if it came from vector search */
  similarity?: number;
  /** path connecting the memory to the current service/question */
  path?: GraphPath;
  createdAt?: string;
}

export const ACTION_KINDS = ["github_issue", "rollback_pr", "webhook"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface ActionRecord {
  id: string;
  sessionId: string;
  tenant: Tenant;
  kind: ActionKind;
  /** done = really performed; dry_run = not configured, payload shown instead; failed = tried and errored */
  status: "done" | "dry_run" | "failed";
  title: string;
  url?: string;
  /** what was (or would have been) sent */
  payload: Record<string, Json>;
  error?: string;
  findingIds: string[];
  createdAt: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * The agent event stream (SSE). Every event carries runId/sessionId/seq/ts.
 * The web reducer is a pure function AgentEvent[] → UI state.
 * ──────────────────────────────────────────────────────────────────────── */

export type InvestigationMode = "incident" | "ask";
export type AgentMode = "llm" | "scripted";

/** A claim in an agent message, tied to the findings that back it (→ Why? chip). */
export interface Claim {
  text: string;
  findingIds: string[];
}

interface EventBase {
  runId: string;
  sessionId: string;
  tenant: Tenant;
  /** monotonically increasing within a run, starting at 0 */
  seq: number;
  /** ISO timestamp */
  ts: string;
}

export type AgentEvent =
  | (EventBase & {
      type: "run_started";
      mode: InvestigationMode;
      agentMode: AgentMode;
      model?: string;
      question: string;
      scenarioId?: string;
      service?: string;
    })
  | (EventBase & { type: "memory_recalled"; memories: RecalledMemory[]; result?: GraphToolResult })
  | (EventBase & { type: "agent_started"; agent: AgentName; goal: string })
  | (EventBase & { type: "tool_call"; agent: AgentName; callId: string; tool: ToolName; input: Record<string, Json> })
  | (EventBase & {
      type: "tool_result";
      agent: AgentName;
      callId: string;
      tool: ToolName;
      /** full result for the UI (the model only sees ≤25 rows) */
      result?: GraphToolResult;
      error?: string;
    })
  | (EventBase & { type: "finding"; agent: AgentName; finding: Finding })
  | (EventBase & { type: "handoff"; from: AgentName; to: AgentName; findingId: string; note: string })
  | (EventBase & { type: "action"; agent: AgentName; action: ActionRecord })
  | (EventBase & { type: "agent_message"; agent: AgentName; text: string; claims: Claim[] })
  | (EventBase & { type: "agent_finished"; agent: AgentName; summary: string; findingIds: string[] })
  | (EventBase & { type: "run_finished"; status: "ok" | "error" | "aborted"; findingIds: string[]; ms: number })
  | (EventBase & {
      type: "error";
      agent?: AgentName;
      where: "falkordb" | "postgres" | "llm" | "action" | "mcp" | "internal";
      message: string;
      fatal: boolean;
    });

export type AgentEventType = AgentEvent["type"];
/** Distributive Omit so each union member keeps its own fields. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before the runtime stamps runId/sessionId/tenant/seq/ts on it. */
export type AgentEventDraft = DistributiveOmit<AgentEvent, keyof EventBase>;

/* ────────────────────────────────────────────────────────────────────────
 * Requests, scenarios, snapshots.
 * ──────────────────────────────────────────────────────────────────────── */

export interface AlertInput {
  service: string;
  metric?: string;
  value?: string;
  message?: string;
}

export interface Scenario {
  id: string;
  tenant: SeedPack;
  title: string;
  mode: InvestigationMode;
  /** what the user types / what the alert says */
  question: string;
  alert?: AlertInput;
  /** what a good answer looks like — used by smoke tests and the presenter */
  expected?: {
    blastRadius?: string[];
    suspectPr?: string;
    expert?: string;
    pastIncident?: string;
    sources?: string[];
  };
  /** one or two sentences for whoever is demoing */
  presenterNote: string;
}

export const InvestigateRequestSchema = z.object({
  tenant: TenantSchema,
  sessionId: z.string().optional().describe("Continue a session; omitted = new session"),
  mode: z.enum(["incident", "ask"]),
  message: z.string().min(1),
  scenarioId: z.string().optional(),
  alert: z
    .object({ service: z.string(), metric: z.string().optional(), value: z.string().optional(), message: z.string().optional() })
    .optional(),
  agentMode: z.enum(["llm", "scripted"]).optional().describe("Override; default from env / key availability"),
});
export type InvestigateRequest = z.infer<typeof InvestigateRequestSchema>;

export const CloseIncidentRequestSchema = z.object({
  tenant: TenantSchema,
  sessionId: z.string(),
  title: z.string().min(3),
  summary: z.string().min(3),
  severity: z.enum(["SEV1", "SEV2", "SEV3", "SEV4"]),
  service: z.string(),
  causedByPr: z.string().optional().describe("PR uid"),
  responders: z.array(z.string()).default([]).describe("Person uids"),
  runbook: z.object({ title: z.string(), steps: z.array(z.string()).min(1) }),
  findingIds: z.array(z.string()).default([]),
});
export type CloseIncidentRequest = z.infer<typeof CloseIncidentRequestSchema>;

export interface CloseIncidentResult {
  incidentUid: string;
  runbookUid: string;
  cypher: string;
}

/** Snapshot file format: data/<tenant>.json. Loaded by packages/graph loadSnapshot(). */
export interface SnapshotNode {
  label: NodeLabel;
  uid: string;
  props: Record<string, Json>;
}
export interface SnapshotEdge {
  type: RelType;
  from: string;
  to: string;
  props?: Record<string, Json>;
}
export interface Snapshot {
  tenant: SeedPack;
  /** ISO; deterministic (derived from source data, not wall clock) */
  generatedAt: string;
  sources: { repo: string; url: string; sha: string; license: string }[];
  /** seed used for synthetic data */
  seed: number;
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
}

/** Display colours per label (shared by web legend and docs). */
export const LABEL_COLORS: Record<NodeLabel, string> = {
  Service: "#60a5fa",
  File: "#64748b",
  PR: "#f59e0b",
  Person: "#34d399",
  Team: "#10b981",
  Issue: "#f472b6",
  Thread: "#c084fc",
  Decision: "#facc15",
  Doc: "#a3e635",
  Incident: "#f87171",
  Runbook: "#2dd4bf",
  Alert: "#ef4444",
  Session: "#94a3b8",
  Episode: "#cbd5e1",
  Finding: "#e879f9",
  Agent: "#818cf8",
  Workspace: "#64748b",
};

/** Max rows a model sees from one tool result (the UI gets everything). */
export const MODEL_ROW_CAP = 25;
/** Max tool-loop steps per agent. */
export const MAX_AGENT_STEPS = 8;

/* ────────────────────────────────────────────────────────────────────────
 * UI read models.
 * ──────────────────────────────────────────────────────────────────────── */

export interface SessionSummary {
  sessionId: string;
  uid: string;
  mode: InvestigationMode;
  question: string;
  /** epoch ms */
  startedAt: number;
  status: "open" | "closed";
  episodes: number;
  findings: number;
}

export interface EpisodeView {
  uid: string;
  seq: number;
  agent: AgentName | "system";
  kind: string;
  summary: string;
  /** epoch ms */
  at: number;
  findings: Finding[];
}

export interface ProceduralMemory {
  service: string; // Service uid
  incidents: {
    uid: string;
    title: string;
    severity: string;
    resolvedAt?: number;
    synthetic: boolean;
    /** set when written by the Scribe in a session */
    sessionId?: string;
    causedBy?: string; // PR uid
    runbook?: { uid: string; title: string; steps: string[] };
  }[];
}

/** GET /api/memory → packages/graph memoryInspector(tenant, sessionId?) */
export interface MemoryInspectorData {
  tenant: Tenant;
  sessions: SessionSummary[];
  /** present when a sessionId was given */
  session?: {
    sessionId: string;
    episodes: EpisodeView[];
    handoffs: { findingId: string; from: AgentName; to: AgentName; claim: string }[];
  };
  procedural: ProceduralMemory[];
  /** graph of the selected session's memory (Session→Episodes→Findings→domain nodes) */
  subgraph: Subgraph;
  /** the Cypher used, for the Why? drawer */
  cypher: string[];
}

export interface HealthStatus {
  falkordb: { ok: boolean; ms?: number; error?: string };
  postgres: { ok: boolean; ms?: number; error?: string };
  agentMode: AgentMode;
  model?: string;
  embeddings?: "model" | "hash";
  transport?: "direct" | "mcp";
}

/* ────────────────────────────────────────────────────────────────────────
 * People and personas.
 *
 * Real git authors (Person.persona=false) only ever carry REAL facts:
 * AUTHORED PRs (and derived team membership). Everything fictional that
 * involves a person (chat messages, tickets, ADR sign-off, on-call
 * rotation, incident response) is attached to a fictional PERSONA:
 * Person {persona:true, synthetic:true, role}. We never put invented words
 * in a real contributor's mouth.
 * ──────────────────────────────────────────────────────────────────────── */

export interface PersonSummary {
  uid: string;
  name: string;
  /** true = fictional persona; false = real public git author */
  persona: boolean;
  /** persona role, e.g. "SRE", "Engineering manager", "Support lead" */
  role?: string;
  isBot: boolean;
  team?: string; // Team uid
  /** services this person is on call for in the current week */
  onCallNow: string[];
  counts: { prs: number; posts: number; incidents: number; onCallWeeks: number; decisions: number; findings: number };
}

export type PersonActivityKind = "pr" | "thread" | "issue" | "incident" | "on_call" | "decision" | "finding" | "action";

export interface PersonActivityItem {
  /** epoch ms */
  at: number;
  kind: PersonActivityKind;
  /** uid of the PR / Thread / Issue / Incident / Service (on_call) / Decision / Finding */
  uid: string;
  title: string;
  detail?: string;
  /** set for agent activity (findings that name this person) */
  sessionId?: string;
}

/** GET /api/people/activity → packages/graph personActivity(tenant, uid) */
export interface PersonActivity {
  person: PersonSummary;
  /** newest first */
  items: PersonActivityItem[];
  cypher: string[];
}

/* ────────────────────────────────────────────────────────────────────────
 * Graph builder: what a user may create by hand in /build.
 * The graph package validates against these; the web forms render from them.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Relationships a user may draw, with their direction (source → target).
 * Derived types (TOUCHES, COLLABORATES_WITH) and agent memory are left out:
 * the loader derives the first two, the agents write memory.
 */
export const REL_SHAPES: Partial<Record<RelType, { from: readonly NodeLabel[]; to: readonly NodeLabel[]; help: string; props?: readonly string[] }>> = {
  DEPENDS_ON: { from: ["Service"], to: ["Service"], help: "caller → callee: if the callee fails, the caller breaks", props: ["protocol"] },
  OWNS: { from: ["Team"], to: ["Service"], help: "the team responsible for the service" },
  MEMBER_OF: { from: ["Person"], to: ["Team"], help: "a person is on a team" },
  ON_CALL_FOR: { from: ["Person"], to: ["Service"], help: "on call for one week (weekStart = a Monday)", props: ["weekStart"] },
  PART_OF: { from: ["File"], to: ["Service"], help: "a source file belongs to a service" },
  AUTHORED: { from: ["Person"], to: ["PR"], help: "who wrote the pull request" },
  MODIFIES: { from: ["PR"], to: ["File"], help: "a PR changed this file (TOUCHES Service is derived from it)" },
  AFFECTED: { from: ["Incident"], to: ["Service"], help: "the incident hit this service" },
  CAUSED_BY: { from: ["Incident"], to: ["PR"], help: "the change that caused the incident" },
  RESOLVED_BY: { from: ["Incident"], to: ["Runbook"], help: "the runbook that fixed it" },
  RESPONDED_BY: { from: ["Incident"], to: ["Person"], help: "who worked the incident" },
  TRIGGERED_BY: { from: ["Incident"], to: ["Alert"], help: "the alert that opened the incident" },
  FIRED_ON: { from: ["Alert"], to: ["Service"], help: "the service the alert watches" },
  APPLIES_TO: { from: ["Runbook"], to: ["Service"], help: "the service a runbook is for" },
  ABOUT: { from: ["Decision", "Doc", "Issue", "Thread"], to: ["Service"], help: "what the knowledge is about" },
  JUSTIFIES: { from: ["Decision"], to: ["PR"], help: "the decision behind a change" },
  DOCUMENTED_IN: { from: ["Decision"], to: ["Doc"], help: "where the decision is written down" },
  DECIDED_BY: { from: ["Decision"], to: ["Person", "Team"], help: "who made the decision" },
  POSTED: { from: ["Person"], to: ["Thread", "Issue"], help: "who wrote the thread or filed the ticket" },
  MENTIONS: { from: ["Issue", "Thread", "Doc", "Decision", "Incident"], to: ["Service", "PR", "Person", "Incident", "Decision", "Issue"], help: "a reference in the text" },
};

export type BuilderFieldKind = "text" | "longtext" | "int" | "date" | "enum" | "lines";
export interface BuilderField {
  name: string;
  label: string;
  kind: BuilderFieldKind;
  required?: boolean;
  options?: readonly string[];
  placeholder?: string;
}

/**
 * Hand-creatable node labels: their fields and how the uid key is derived.
 * `key` names the field whose (slugified, unless numeric/path) value becomes
 * the uid key, e.g. Service name "Cart API" → `Service:cart-api`.
 */
export const NODE_FORMS: Partial<Record<NodeLabel, { help: string; key: string; slug: boolean; fields: readonly BuilderField[] }>> = {
  Service: {
    help: "Something that runs and can fail. The center of the graph.",
    key: "name",
    slug: true,
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, placeholder: "checkout" },
      { name: "tier", label: "Tier", kind: "enum", options: ["1", "2", "3"], placeholder: "1 = customer-facing" },
      { name: "language", label: "Language", kind: "text", placeholder: "go" },
      { name: "description", label: "Description", kind: "longtext", placeholder: "What it does" },
    ],
  },
  Team: {
    help: "A group of people that owns services.",
    key: "name",
    slug: true,
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, placeholder: "Payments" },
      { name: "slack", label: "Chat channel", kind: "text", placeholder: "#team-payments" },
    ],
  },
  Person: {
    help: "An engineer. Keyed by a slug of their name (never an email).",
    key: "name",
    slug: true,
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, placeholder: "Ada Lovelace" },
      { name: "role", label: "Role", kind: "text", placeholder: "SRE" },
    ],
  },
  File: {
    help: "A source file. Its path is its key.",
    key: "path",
    slug: false,
    fields: [
      { name: "path", label: "Path", kind: "text", required: true, placeholder: "src/checkout/main.go" },
      { name: "language", label: "Language", kind: "text", placeholder: "go" },
    ],
  },
  PR: {
    help: "A merged pull request. Keyed by its number.",
    key: "number",
    slug: false,
    fields: [
      { name: "number", label: "Number", kind: "int", required: true, placeholder: "101" },
      { name: "title", label: "Title", kind: "text", required: true, placeholder: "Add retries to payment client" },
      { name: "mergedAt", label: "Merged on", kind: "date", required: true },
    ],
  },
  Incident: {
    help: "A past outage. Embedded, so agents find similar ones by meaning.",
    key: "key",
    slug: false,
    fields: [
      { name: "key", label: "Id", kind: "text", required: true, placeholder: "INC-001" },
      { name: "title", label: "Title", kind: "text", required: true, placeholder: "checkout 5xx after deploy" },
      { name: "severity", label: "Severity", kind: "enum", options: ["SEV1", "SEV2", "SEV3"] },
      { name: "startedAt", label: "Started on", kind: "date", required: true },
      { name: "summary", label: "Summary", kind: "longtext", placeholder: "What happened" },
      { name: "rootCause", label: "Root cause", kind: "longtext" },
    ],
  },
  Runbook: {
    help: "The steps that fix a known problem.",
    key: "title",
    slug: true,
    fields: [
      { name: "title", label: "Title", kind: "text", required: true, placeholder: "Roll back checkout" },
      { name: "steps", label: "Steps (one per line)", kind: "lines", placeholder: "kubectl rollout undo deploy/checkout" },
    ],
  },
  Alert: {
    help: "A monitoring alert.",
    key: "title",
    slug: true,
    fields: [
      { name: "title", label: "Title", kind: "text", required: true, placeholder: "checkout error rate high" },
      { name: "metric", label: "Metric", kind: "text", placeholder: "http_server_errors_ratio" },
    ],
  },
  Decision: {
    help: "An architecture decision (ADR). Embedded for Ask the company.",
    key: "key",
    slug: false,
    fields: [
      { name: "key", label: "Id", kind: "text", required: true, placeholder: "ADR-001" },
      { name: "title", label: "Title", kind: "text", required: true, placeholder: "Use Postgres for orders" },
      { name: "status", label: "Status", kind: "enum", options: ["accepted", "proposed", "superseded"] },
      { name: "decidedAt", label: "Decided on", kind: "date" },
      { name: "context", label: "Context", kind: "longtext" },
      { name: "decision", label: "Decision", kind: "longtext" },
    ],
  },
  Doc: {
    help: "A document or wiki page. Embedded for Ask the company.",
    key: "title",
    slug: true,
    fields: [
      { name: "title", label: "Title", kind: "text", required: true },
      { name: "text", label: "Text", kind: "longtext", required: true },
    ],
  },
  Issue: {
    help: "A ticket. Embedded for Ask the company.",
    key: "key",
    slug: false,
    fields: [
      { name: "key", label: "Id", kind: "text", required: true, placeholder: "OPS-12" },
      { name: "title", label: "Title", kind: "text", required: true },
      { name: "status", label: "Status", kind: "enum", options: ["open", "closed"] },
      { name: "body", label: "Body", kind: "longtext" },
    ],
  },
  Thread: {
    help: "A chat thread. Embedded for Ask the company.",
    key: "title",
    slug: true,
    fields: [
      { name: "title", label: "Title", kind: "text", required: true },
      { name: "channel", label: "Channel", kind: "text", placeholder: "#sre" },
      { name: "text", label: "Messages", kind: "longtext", required: true, placeholder: "Ada: why is checkout on Postgres?" },
    ],
  },
};
