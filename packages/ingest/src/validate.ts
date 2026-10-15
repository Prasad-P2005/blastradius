/**
 * Snapshot validator: everything packages/graph assumes about data/*.json,
 * checked before we commit or load it. Returns a list of human-readable
 * errors (empty = valid). The CLI exits non-zero if any are found.
 *
 * Checks:
 *   - labels / relationship types are in the contract whitelists; no memory
 *     labels, no derived TOUCHES / COLLABORATES_WITH edges, no stored embeddings
 *   - uid = `Label:key`, the label matches, the key matches the node's own
 *     key property (slug / number / path / key); no duplicate uids
 *   - required props per label (SPEC §1), `synthetic` boolean on every node,
 *     `*At` props are integer epoch-ms
 *   - every edge endpoint exists and has the label the contract allows
 *   - ON_CALL_FOR: weekStart is a Monday 'YYYY-MM-DD' matching weekStartTs,
 *     and every owned service has someone on call in the CURRENT real week
 *   - no email address anywhere in the serialized JSON
 *   - scenarios reference nodes that exist, suspects are human PRs
 */
import { MEMORY_LABELS, NODE_LABELS, REL_TYPES, isNodeLabel, isRelType, parseUid, type NodeLabel, type RelType, type Scenario, type Snapshot, type SnapshotEdge, type SnapshotNode, type Tenant } from "@blastradius/shared";
import { isoDate, mondayOf } from "./time.ts";

/** Any email-looking token. Deliberately broad: a false positive just fails the build. */
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export const REQUIRED_PROPS: Partial<Record<NodeLabel, string[]>> = {
  Service: ["name", "slug", "language", "kind", "repoPath", "description", "tier"],
  File: ["path", "service", "language"],
  PR: ["number", "title", "sha", "mergedAt", "additions", "deletions", "filesChanged", "url", "isBot", "authorName"],
  // real git authors; personas are checked against PERSONA_PROPS instead
  Person: ["name", "slug", "isBot", "prCount", "firstSeenAt", "lastSeenAt"],
  Team: ["name", "slug", "slack"],
  Issue: ["key", "title", "body", "status", "priority", "createdAt"],
  Thread: ["channel", "title", "text", "createdAt"],
  Decision: ["key", "title", "status", "context", "decision", "consequences", "decidedAt"],
  Doc: ["title", "kind", "text"],
  Incident: ["key", "title", "summary", "rootCause", "severity", "status", "startedAt", "resolvedAt"],
  Runbook: ["title", "steps", "createdAt"],
  Alert: ["title", "metric", "value", "message", "firedAt"],
};

/** Fictional personas (persona:true) carry a role instead of git activity. */
export const PERSONA_PROPS = ["name", "slug", "role", "isBot"];

/**
 * Persona policy: these edges describe fictional acts by a person, so their
 * Person end must be a persona. Real authors only ever carry real facts.
 */
export const PERSONA_ONLY_EDGES: Partial<Record<RelType, "from" | "to">> = {
  POSTED: "from", ON_CALL_FOR: "from", RESPONDED_BY: "to", DECIDED_BY: "to",
};

/** Which prop holds the uid key for each label (so `PR:42` must have number 42). */
const KEY_PROP: Partial<Record<NodeLabel, string>> = {
  Service: "slug", File: "path", PR: "number", Person: "slug", Team: "slug", Issue: "key", Decision: "key", Incident: "key",
};

const DOMAIN = NODE_LABELS.filter((l) => !(MEMORY_LABELS as readonly string[]).includes(l));
/** (from labels, to labels) per relationship type, from the contract's REL_TYPES comments. */
export const EDGE_SHAPES: Partial<Record<RelType, [readonly NodeLabel[], readonly NodeLabel[]]>> = {
  DEPENDS_ON: [["Service"], ["Service"]],
  OWNS: [["Team"], ["Service"]],
  PART_OF: [["File"], ["Service"]],
  AUTHORED: [["Person"], ["PR"]],
  MODIFIES: [["PR"], ["File"]],
  MEMBER_OF: [["Person"], ["Team"]],
  ON_CALL_FOR: [["Person"], ["Service"]],
  MENTIONS: [["Issue", "Thread", "Doc", "Decision", "Incident"], ["Service", "PR", "Person", "Incident", "Decision", "Issue"]],
  JUSTIFIES: [["Decision"], ["PR"]],
  DOCUMENTED_IN: [["Decision"], ["Doc"]],
  DECIDED_BY: [["Decision"], ["Person", "Team"]],
  ABOUT: [["Decision", "Doc", "Issue", "Thread"], ["Service"]],
  AFFECTED: [["Incident"], ["Service"]],
  CAUSED_BY: [["Incident"], ["PR"]],
  RESOLVED_BY: [["Incident"], ["Runbook"]],
  RESPONDED_BY: [["Incident"], ["Person"]],
  POSTED: [["Person"], ["Thread", "Issue"]],
  TRIGGERED_BY: [["Incident"], ["Alert"]],
  APPLIES_TO: [["Runbook"], ["Service"]],
  FIRED_ON: [["Alert"], ["Service"]],
};

export interface ValidateOptions {
  /** epoch ms whose week must be covered by ON_CALL_FOR (default: the real now) */
  now?: number;
  /** nodes that already exist in the graph (for deltas) */
  baseNodes?: SnapshotNode[];
  /** skip the on-call coverage check (deltas have no on-call edges) */
  skipOnCall?: boolean;
}

export function validateGraph(nodes: SnapshotNode[], edges: SnapshotEdge[], opts: ValidateOptions = {}): string[] {
  const errors: string[] = [];
  const err = (m: string) => {
    if (errors.length < 200) errors.push(m);
  };
  const byUid = new Map<string, SnapshotNode>();
  for (const n of opts.baseNodes ?? []) byUid.set(n.uid, n);
  const seen = new Set<string>();

  for (const n of nodes) {
    if (seen.has(n.uid)) err(`duplicate uid ${n.uid}`);
    seen.add(n.uid);
    byUid.set(n.uid, n);
    if (!isNodeLabel(n.label)) {
      err(`${n.uid}: label ${n.label} not in whitelist`);
      continue;
    }
    if (!(DOMAIN as readonly string[]).includes(n.label)) err(`${n.uid}: memory label ${n.label} must not be in a snapshot`);
    const parsed = parseUid(n.uid);
    if (!parsed) err(`${n.uid}: malformed uid`);
    else if (parsed.label !== n.label) err(`${n.uid}: uid label ≠ node label ${n.label}`);
    const keyProp = KEY_PROP[n.label];
    if (parsed && keyProp && String(n.props[keyProp]) !== parsed.key) err(`${n.uid}: ${keyProp}=${String(n.props[keyProp])} does not match uid key`);
    if (typeof n.props.synthetic !== "boolean") err(`${n.uid}: synthetic must be a boolean`);
    const isPersona = n.label === "Person" && n.props.persona === true;
    if (isPersona && (n.props.synthetic !== true || !parsed?.key.startsWith("persona-"))) err(`${n.uid}: personas need synthetic:true and a persona- key`);
    for (const p of (isPersona ? PERSONA_PROPS : REQUIRED_PROPS[n.label]) ?? []) {
      const v = n.props[p];
      // repoPath may be "" for stock-image components (valkey-cart, redis-cart)
      if (v === undefined || v === null || (v === "" && p !== "repoPath")) err(`${n.uid}: missing ${p}`);
    }
    if ("embedding" in n.props) err(`${n.uid}: embeddings must not be stored in the snapshot`);
    for (const [k, v] of Object.entries(n.props)) {
      if (k.endsWith("At") && !(Number.isInteger(v) && (v as number) > 1e12)) err(`${n.uid}: ${k} must be epoch-ms integer, got ${String(v)}`);
    }
  }

  // a persona must never share a name with a real contributor
  const people = [...byUid.values()].filter((n) => n.label === "Person");
  const realNames = new Set(people.filter((n) => n.props.persona !== true).map((n) => String(n.props.name).toLowerCase()));
  for (const n of people) {
    if (n.props.persona === true && realNames.has(String(n.props.name).toLowerCase())) err(`${n.uid}: persona name collides with a real contributor`);
  }

  const ownedServices = new Set<string>();
  const onCallThisWeek = new Set<string>();
  const thisWeek = isoDate(mondayOf(opts.now ?? Date.now()));
  for (const e of edges) {
    if (!isRelType(e.type)) {
      err(`edge type ${e.type} not in whitelist`);
      continue;
    }
    if (e.type === "TOUCHES" || e.type === "COLLABORATES_WITH") err(`${e.type} ${e.from}→${e.to}: derived at load time, must not be in a snapshot`);
    const a = byUid.get(e.from);
    const b = byUid.get(e.to);
    if (!a) err(`${e.type}: missing from-node ${e.from}`);
    if (!b) err(`${e.type}: missing to-node ${e.to}`);
    const shape = EDGE_SHAPES[e.type];
    if (a && b && shape) {
      if (!shape[0].includes(a.label) || !shape[1].includes(b.label)) err(`${e.type}: ${a.label}→${b.label} not allowed (${e.from}→${e.to})`);
    }
    const personaEnd = PERSONA_ONLY_EDGES[e.type];
    const person = personaEnd === "from" ? a : personaEnd === "to" ? b : undefined;
    if (person?.label === "Person" && person.props.persona !== true) err(`${e.type} ${e.from}→${e.to}: fictional acts must be done by a persona, not a real person`);
    if (e.type === "AUTHORED" && a?.props.persona === true) err(`AUTHORED ${e.from}→${e.to}: personas never author real PRs`);
    if (e.type === "OWNS") ownedServices.add(e.to);
    if (e.type === "DEPENDS_ON" && (!e.props?.protocol || !e.props?.source)) err(`DEPENDS_ON ${e.from}→${e.to}: needs protocol and source`);
    if (e.type === "MODIFIES" && (!Number.isInteger(e.props?.additions) || !Number.isInteger(e.props?.deletions))) err(`MODIFIES ${e.from}→${e.to}: needs additions/deletions`);
    if (e.type === "ON_CALL_FOR") {
      const ws = String(e.props?.weekStart ?? "");
      const ts = Number(e.props?.weekStartTs);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ws) || isoDate(ts) !== ws || mondayOf(ts) !== ts) err(`ON_CALL_FOR ${e.from}→${e.to}: bad weekStart ${ws}/${ts}`);
      if (ws === thisWeek) onCallThisWeek.add(e.to);
    }
  }
  if (!opts.skipOnCall) {
    for (const s of ownedServices) if (!onCallThisWeek.has(s)) err(`ON_CALL_FOR: nobody on call for ${s} in the current week ${thisWeek}`);
    if (ownedServices.size === 0) err("no OWNS edges: teams missing");
  }
  return errors;
}

export function validateSnapshot(snap: Snapshot, raw: string, opts: ValidateOptions = {}): string[] {
  const errors = validateGraph(snap.nodes, snap.edges, opts);
  errors.push(...emailErrors(raw));
  if (!snap.sources?.length || snap.sources.some((s) => !/^[0-9a-f]{40}$/.test(s.sha))) errors.push("sources: need repo + 40-char sha");
  if (!Number.isInteger(snap.seed)) errors.push("seed must be an integer");
  if (Number.isNaN(Date.parse(snap.generatedAt))) errors.push("generatedAt must be ISO");
  return errors;
}

/**
 * The only tolerated false positive: image-density file names such as
 * `App-Icon-1024x1024@1x.png` (real react-native-app asset paths). Anything
 * else that looks like local@domain.tld fails.
 */
const IMAGE_DENSITY_RE = /@\d+(\.\d+)?x\.(png|jpe?g|webp|gif|svg)$/i;

export function emailHits(raw: string): string[] {
  return (raw.match(EMAIL_RE) ?? []).filter((h) => !IMAGE_DENSITY_RE.test(h));
}

export function emailErrors(raw: string): string[] {
  const hits = emailHits(raw);
  return hits.length ? [`found ${hits.length} email-like string(s), e.g. ${hits.slice(0, 3).join(", ")}`] : [];
}

export function validateScenarios(scenarios: Scenario[], snaps: Partial<Record<Tenant, Snapshot>>): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const byTenant = new Map<Tenant, Scenario[]>();
  for (const s of scenarios) {
    if (ids.has(s.id)) errors.push(`scenario ${s.id}: duplicate id`);
    ids.add(s.id);
    byTenant.set(s.tenant, [...(byTenant.get(s.tenant) ?? []), s]);
    const snap = snaps[s.tenant];
    if (!snap) continue;
    const nodes = new Map(snap.nodes.map((n) => [n.uid, n]));
    const need = (u: string | undefined, label: NodeLabel, what: string) => {
      if (!u) return errors.push(`scenario ${s.id}: missing ${what}`);
      const n = nodes.get(u);
      if (!n) errors.push(`scenario ${s.id}: ${what} ${u} not in ${s.tenant} snapshot`);
      else if (n.label !== label) errors.push(`scenario ${s.id}: ${what} ${u} is a ${n.label}, expected ${label}`);
      return 0;
    };
    if (!s.presenterNote) errors.push(`scenario ${s.id}: missing presenterNote`);
    if (s.mode === "incident") {
      if (!s.alert?.service) errors.push(`scenario ${s.id}: incident scenario needs an alert`);
      else need(`Service:${s.alert.service}`, "Service", "alert service");
      for (const u of s.expected?.blastRadius ?? []) need(u, "Service", "blastRadius");
      if ((s.expected?.blastRadius ?? []).length < 2) errors.push(`scenario ${s.id}: blast radius < 2`);
      need(s.expected?.suspectPr, "PR", "suspectPr");
      if (s.expected?.suspectPr && nodes.get(s.expected.suspectPr)?.props.isBot !== false) errors.push(`scenario ${s.id}: suspect PR must be human`);
      need(s.expected?.expert, "Person", "expert");
      if (s.expected?.expert && nodes.get(s.expected.expert)?.props.isBot !== false) errors.push(`scenario ${s.id}: expert must be human`);
      need(s.expected?.pastIncident, "Incident", "pastIncident");
    } else {
      if (!(s.expected?.sources ?? []).length) errors.push(`scenario ${s.id}: ask scenario needs expected.sources`);
      for (const u of s.expected?.sources ?? []) if (!nodes.has(u)) errors.push(`scenario ${s.id}: source ${u} not in snapshot`);
    }
  }
  for (const [t, list] of byTenant) {
    if (list.filter((s) => s.mode === "incident").length < 3) errors.push(`${t}: needs ≥3 incident scenarios`);
    if (!list.some((s) => s.mode === "ask")) errors.push(`${t}: needs ≥1 ask scenario`);
  }
  for (const t of Object.keys(snaps) as Tenant[]) if (!byTenant.has(t)) errors.push(`${t}: no scenarios`);
  return errors;
}

export { NODE_LABELS, REL_TYPES };
