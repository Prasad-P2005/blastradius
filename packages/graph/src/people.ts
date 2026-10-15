/**
 * people.ts — people and personas: `listPeople` and `personActivity` (the live
 * activity feed on the /people page).
 *
 * Two kinds of Person share one label:
 *   - real git authors (persona=false): only real facts — AUTHORED PRs, team membership;
 *   - fictional personas (persona=true, role): POSTED threads/tickets, ON_CALL_FOR
 *     weeks, RESPONDED_BY incidents, DECIDED_BY decisions.
 * Agent memory joins in: Findings that are ABOUT or SUPPORTED_BY a person show
 * up in that person's feed with the session that wrote them, so a user can
 * watch agents "talk about" a persona live.
 */
import {
  parseUid,
  type Json,
  type PersonActivity,
  type PersonActivityItem,
  type PersonActivityKind,
  type PersonSummary,
  type Row,
  type Tenant,
} from "@blastradius/shared";
import { runCypher } from "./connection.ts";
import { num, str } from "./tools/common.ts";

const WEEK_MS = 7 * 86_400_000;
/** On-call weeks shown in a feed: this many weeks either side of the tenant's "now". */
export const ON_CALL_WINDOW_WEEKS = 12;

/**
 * One row per person with activity counts. `$uid` (optional) restricts to one
 * person; `$persona` (optional) to personas or real authors.
 * "On call now" = edges of the newest rotation week that started on or before
 * $today (the same rule the on_call tool uses).
 */
export const LIST_PEOPLE_CYPHER = `// People (personas and real authors) with activity counts and current on-call services
OPTIONAL MATCH (:Person)-[w:ON_CALL_FOR]->(:Service)
WHERE w.weekStart <= $today
WITH max(w.weekStart) AS currentWeek
MATCH (p:Person)
WHERE ($uid IS NULL OR p.uid = $uid)
  AND ($persona IS NULL OR coalesce(p.persona, false) = $persona)
OPTIONAL MATCH (f:Finding)-[:ABOUT|SUPPORTED_BY]->(p)
WITH currentWeek, p, count(DISTINCT f) AS findings
OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
WITH currentWeek, p, findings, collect(t.uid)[0] AS team
RETURN p.uid AS uid, p.name AS name, coalesce(p.persona, false) AS persona, p.role AS role,
       coalesce(p.isBot, false) AS isBot, team, findings,
       size([(p)-[:AUTHORED]->(x:PR) | x]) AS prs,
       size([(p)-[:POSTED]->(x) | x]) AS posts,
       size([(x:Incident)-[:RESPONDED_BY]->(p) | x]) AS incidents,
       size([(p)-[:ON_CALL_FOR]->(x:Service) | x]) AS onCallWeeks,
       size([(x:Decision)-[:DECIDED_BY]->(p) | x]) AS decisions,
       // keep this comprehension LAST: on FalkorDB 6.0.2 one that binds a relationship
       // variable empties the comprehensions after it (see docs/CYPHER.md)
       [(p)-[oc:ON_CALL_FOR]->(s:Service) WHERE oc.weekStart = currentWeek | s.uid] AS onCallNow
ORDER BY persona DESC, prs DESC, name ASC
LIMIT $limit`;

function toSummary(r: Row): PersonSummary {
  const s: PersonSummary = {
    uid: str(r.uid),
    name: str(r.name),
    persona: r.persona === true,
    isBot: r.isBot === true,
    onCallNow: Array.isArray(r.onCallNow) ? [...new Set(r.onCallNow.map(String))] : [],
    counts: {
      prs: num(r.prs),
      posts: num(r.posts),
      incidents: num(r.incidents),
      onCallWeeks: num(r.onCallWeeks),
      decisions: num(r.decisions),
      findings: num(r.findings),
    },
  };
  if (typeof r.role === "string") s.role = r.role;
  if (typeof r.team === "string") s.team = r.team;
  return s;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Personas first, then real authors by PR count. `persona` filters to one kind. */
export async function listPeople(tenant: Tenant, opts: { persona?: boolean; limit?: number } = {}): Promise<PersonSummary[]> {
  const params = { uid: null, persona: opts.persona ?? null, today: today(), limit: opts.limit ?? 500 };
  const { rows } = await runCypher(tenant, LIST_PEOPLE_CYPHER, params, { readOnly: true });
  return rows.map(toSummary);
}

/**
 * The activity feed: one CALL {} subquery with a UNION ALL branch per kind of
 * activity, all returning (at, kind, uid, title, detail, sessionId), then one
 * ORDER BY over the lot, newest first.
 * On-call weeks are collapsed to one item per week (services joined) and kept
 * to ±ON_CALL_WINDOW_WEEKS around the tenant's "now" (the newest PR).
 */
// Keep the first part free of aggregations before CALL {}: on FalkorDB 6.0.2 an
// aggregating WITH (e.g. max(...) AS now) ahead of a multi-branch CALL { … UNION ALL … }
// makes the whole subquery return no rows. Only the on-call part needs "now".
export const PERSON_ACTIVITY_CYPHER = `// Activity feed for one person, newest first
MATCH (p:Person {uid: $uid})
CALL {
  WITH p
  // PRs they authored (real authors)
  MATCH (p)-[:AUTHORED]->(pr:PR)
  RETURN pr.mergedAt AS at, 'pr' AS kind, pr.uid AS uid, pr.title AS title,
         'PR #' + toString(pr.number) AS detail, null AS sessionId
  UNION ALL
  WITH p
  // chat threads and tickets they POSTED (personas)
  MATCH (p)-[:POSTED]->(x)
  RETURN x.createdAt AS at, CASE WHEN x:Issue THEN 'issue' ELSE 'thread' END AS kind, x.uid AS uid,
         x.title AS title, coalesce(x.channel, x.key + ' ' + x.status) AS detail, null AS sessionId
  UNION ALL
  WITH p
  // incidents they responded to
  MATCH (i:Incident)-[:RESPONDED_BY]->(p)
  RETURN i.startedAt AS at, 'incident' AS kind, i.uid AS uid, i.title AS title,
         i.severity AS detail, i.sessionId AS sessionId
  UNION ALL
  WITH p
  // decisions they signed off
  MATCH (d:Decision)-[:DECIDED_BY]->(p)
  RETURN d.decidedAt AS at, 'decision' AS kind, d.uid AS uid, d.title AS title,
         d.key + ' (' + d.status + ')' AS detail, null AS sessionId
  UNION ALL
  WITH p
  // agent activity: findings that are ABOUT the person or cite them as evidence
  MATCH (f:Finding)-[:ABOUT|SUPPORTED_BY]->(p)
  WITH DISTINCT f
  RETURN f.createdAt AS at, 'finding' AS kind, f.uid AS uid, f.claim AS title,
         f.agent + ' · ' + f.kind AS detail, f.sessionId AS sessionId
  UNION ALL
  WITH p
  // on-call rotation: one item per week, within the window around the tenant's "now"
  MATCH (latest:PR)
  WITH p, max(latest.mergedAt) AS now
  MATCH (p)-[oc:ON_CALL_FOR]->(s:Service)
  WHERE oc.weekStartTs >= now - $windowMs AND oc.weekStartTs <= now + $windowMs
  WITH oc.weekStart AS week, oc.weekStartTs AS at, collect(s.name) AS services, collect(s.uid) AS uids
  RETURN at, 'on_call' AS kind, uids[0] AS uid, 'On call: ' + week AS title,
         reduce(acc = '', n IN services | acc + CASE WHEN acc = '' THEN '' ELSE ', ' END + n) AS detail,
         null AS sessionId
}
// one ORDER BY over every branch (after a top-level UNION it would sort only the last part)
RETURN at, kind, uid, title, detail, sessionId
ORDER BY at DESC
LIMIT $limit`;

export async function personActivity(tenant: Tenant, uid: string, opts: { limit?: number } = {}): Promise<PersonActivity> {
  if (parseUid(uid)?.label !== "Person") throw new Error(`personActivity needs a Person uid, got ${uid}`);
  const summaryParams = { uid, persona: null, today: today(), limit: 1 };
  const feedParams = { uid, windowMs: ON_CALL_WINDOW_WEEKS * WEEK_MS, limit: opts.limit ?? 100 };
  const [summary, feed] = await Promise.all([
    runCypher(tenant, LIST_PEOPLE_CYPHER, summaryParams, { readOnly: true }),
    runCypher(tenant, PERSON_ACTIVITY_CYPHER, feedParams, { readOnly: true }),
  ]);
  const row = summary.rows[0];
  if (!row) throw new Error(`person not found: ${uid}`);
  const items: PersonActivityItem[] = feed.rows
    .filter((r) => r.at !== null && r.at !== undefined)
    .map((r) => {
      const it: PersonActivityItem = { at: num(r.at), kind: str(r.kind) as PersonActivityKind, uid: str(r.uid), title: str(r.title) };
      if (r.detail !== null && r.detail !== undefined && r.detail !== "") it.detail = str(r.detail as Json);
      if (r.sessionId) it.sessionId = str(r.sessionId);
      return it;
    });
  return { person: toSummary(row), items, cypher: [LIST_PEOPLE_CYPHER, PERSON_ACTIVITY_CYPHER] };
}
