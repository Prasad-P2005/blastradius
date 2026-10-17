/**
 * The guided builder, step by step. Each step introduces a slice of the graph
 * model, says why it matters, and unlocks one or more agent tools that the
 * user can run right there ("Try it") to see what the new data makes possible.
 *
 * Step ids match the keys of data/samples/starter.json, so every step can
 * seed its own part of the sample company.
 */
import type { NodeLabel, RelType, ToolName } from "@blastradius/shared";

export interface TryTool {
  tool: ToolName;
  label: string;
  /** what the input box asks for */
  input: "service" | "text" | "none";
  /** default text for `input: "text"` */
  placeholder?: string;
  /** builds the tool input from the chosen service uid or text */
  build: (v: string) => Record<string, unknown>;
}

export interface BuilderStep {
  id: string;
  title: string;
  short: string;
  /** what you're modelling, in plain words */
  intro: string;
  /** why the agents need it */
  why: string;
  labels: NodeLabel[];
  rels: RelType[];
  try: TryTool[];
  /** done when these counts are reached (labels and/or relationship types) */
  done: Partial<Record<NodeLabel | RelType, number>>;
}

export const BUILDER_STEPS: BuilderStep[] = [
  {
    id: "services",
    title: "Add your services",
    short: "Services",
    intro: "A Service is anything that runs and can fail: an API, a worker, a database. Every other node in the graph ends up connected to one.",
    why: "Alerts fire on services. The agents start every investigation by finding the alerting service with full-text search.",
    labels: ["Service"],
    rels: [],
    try: [{ tool: "search_nodes", label: "Find a service by name", input: "text", placeholder: "pay", build: (v) => ({ query: v }) }],
    done: { Service: 2 },
  },
  {
    id: "dependencies",
    title: "Connect them with DEPENDS_ON",
    short: "Dependencies",
    intro: "Draw an arrow from the caller to the service it calls: (orders)-[:DEPENDS_ON]->(payments). Direction matters. If payments fails, orders breaks, not the other way round.",
    why: "“What else breaks?” is a multi-hop walk over these arrows. Betweenness centrality then ranks the chokepoints, the services most paths run through.",
    labels: [],
    rels: ["DEPENDS_ON"],
    try: [
      { tool: "blast_radius", label: "What breaks if this fails?", input: "service", build: (v) => ({ service: v }) },
      { tool: "critical_services", label: "Rank the chokepoints", input: "none", build: () => ({}) },
    ],
    done: { DEPENDS_ON: 1 },
  },
  {
    id: "people",
    title: "Add teams, people and on-call",
    short: "Teams & people",
    intro: "Teams OWN services, people are MEMBER_OF teams, and ON_CALL_FOR edges say who holds the pager each week (one edge per week).",
    why: "Once something breaks, the next question is who to page. The agents read ownership and the current on-call week straight from these edges.",
    labels: ["Team", "Person"],
    rels: ["OWNS", "MEMBER_OF", "ON_CALL_FOR"],
    try: [{ tool: "on_call", label: "Who is on call?", input: "service", build: (v) => ({ service: v }) }],
    done: { Team: 1, Person: 1, OWNS: 1 },
  },
  {
    id: "code",
    title: "Add code and pull requests",
    short: "Code & PRs",
    intro: "Files are PART_OF a service. A person AUTHORED a PR, and the PR MODIFIES files. Blastradius then derives (PR)-[:TOUCHES]->(Service) for you, plus a co-authorship graph between people who changed the same files.",
    why: "Most incidents follow a change. Recent PRs that touched the alerting service or its dependencies are the suspects. PageRank over co-authorship finds who knows the code.",
    labels: ["File", "PR"],
    rels: ["PART_OF", "AUTHORED", "MODIFIES"],
    try: [
      { tool: "suspect_changes", label: "What probably caused it?", input: "service", build: (v) => ({ service: v }) },
      { tool: "who_knows", label: "Who can fix it?", input: "service", build: (v) => ({ service: v }) },
    ],
    done: { PR: 1, MODIFIES: 1, PART_OF: 1 },
  },
  {
    id: "incidents",
    title: "Record past incidents and runbooks",
    short: "Incidents",
    intro: "An Incident AFFECTED services, was CAUSED_BY a PR and RESOLVED_BY a Runbook. Incidents are embedded as vectors inside FalkorDB, so new alerts find old incidents by meaning, not just by keyword.",
    why: "“What worked last time?” The agents pull past incidents on the service and the most similar ones by vector search, with their runbooks.",
    labels: ["Incident", "Runbook", "Alert"],
    rels: ["AFFECTED", "CAUSED_BY", "RESOLVED_BY", "RESPONDED_BY", "TRIGGERED_BY", "FIRED_ON", "APPLIES_TO"],
    try: [
      { tool: "past_incidents", label: "Past incidents here", input: "service", build: (v) => ({ service: v }) },
      { tool: "similar_incidents", label: "Similar incidents (vector search)", input: "text", placeholder: "payments timing out, retries piling up", build: (v) => ({ text: v }) },
    ],
    done: { Incident: 1, AFFECTED: 1 },
  },
  {
    id: "knowledge",
    title: "Add decisions, docs, tickets and chat",
    short: "Company brain",
    intro: "Decisions (ADRs) are ABOUT services and JUSTIFY PRs. Docs, tickets and chat threads are ABOUT services too. All of them are embedded, so they can be searched by meaning.",
    why: "This is the company brain. “Ask the company” searches all of it at once and answers with sources, and decision tracing follows Doc ← Decision → PR → Incident.",
    labels: ["Decision", "Doc", "Issue", "Thread"],
    rels: ["ABOUT", "JUSTIFIES", "DOCUMENTED_IN", "DECIDED_BY", "POSTED", "MENTIONS"],
    try: [{ tool: "ask_company", label: "Ask the company", input: "text", placeholder: "why do we retry payments?", build: (v) => ({ question: v }) }],
    done: { Decision: 1, ABOUT: 1 },
  },
];

/** How far a step is, from the graph's live label and relationship counts. */
export function stepProgress(step: BuilderStep, counts: { labels: Record<string, number>; rels: Record<string, number> } | null): { done: boolean; have: number; need: number } {
  const entries = Object.entries(step.done) as [string, number][];
  let have = 0;
  for (const [k, need] of entries) {
    const n = counts?.labels[k] ?? counts?.rels[k] ?? 0;
    if (n >= need) have += 1;
  }
  return { done: have === entries.length, have, need: entries.length };
}
