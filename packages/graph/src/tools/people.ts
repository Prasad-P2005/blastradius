/**
 * tools/people.ts — Track 01/03 "Who can fix it / who knows X?": who_knows
 * (algo.pageRank × authorship activity) and on_call (weekly rotation edges).
 *
 * ── Why PageRank is combined this way ───────────────────────────────────────
 * algo.pageRank(label, relType) is directed and takes ONE label and ONE
 * relationship type. Authorship edges point Person → PR, so on the pure
 * authorship graph rank flows from people INTO PRs and every person ends up
 * with the same teleport score (verified on FalkorDB 6.0.2: three authors with
 * 1, 1 and 2 PRs all scored 0.333). PageRank over authorship alone therefore
 * cannot rank people.
 *
 * Instead we run PageRank over the whole company graph (label and type null).
 * There, a Person only gains rank through INCOMING edges: incidents they
 * RESPONDED_BY, decisions DECIDED_BY them, threads/issues/docs that MENTION
 * them, and findings agents recorded as SUPPORTED_BY them. That is a
 * "recognised authority" signal: the people the organisation keeps pointing at.
 * It is global, so on its own it would rank the same people for every service.
 *
 * So the final score combines both signals:
 *
 *   activity  = number of the person's PRs that TOUCH the service (or match the topic)
 *   authority = 0.5 + 0.5 × pageRank / max(pageRank among the candidates)   ∈ [0.5, 1]
 *   score     = activity × authority × (0.1 if bot else 1)
 *
 * Activity decides who is a candidate and dominates the order (you must have
 * changed the code to fix it); authority breaks ties and lifts people who also
 * responded to incidents or made the decisions, at most doubling a score.
 * Bots are excluded unless includeBots, and then weighted ×0.1 (lesson 3).
 *
 * Personas: who_knows ranks REAL git authors only (persona=false): fictional
 * personas never author code. On-call rotations are staffed by personas, so
 * besides `onCall` (the person themself is on call) each row carries
 * `onCallTeammate`: a persona on the same team who is on call for the service
 * this week. `onCallOnly` keeps rows where either is set.
 */
import { serviceUid, slugify, uid } from "@blastradius/shared";
import { defineTool, fulltextQuery, makeResult, num, round, str, toolQuery } from "./common.ts";

/**
 * The who_knows query. `scope` is 'service' (PRs touching $service) or
 * 'topic' (PRs whose title matches the full-text query $topic).
 */
export function whoKnowsCypher(scope: "service" | "topic"): string {
  const head =
    scope === "service"
      ? `// Q3 "Who knows / can fix $service?"
MATCH (s:Service {uid: $service})
// the current rotation week for this service: newest weekStart <= today
OPTIONAL MATCH (:Person)-[w:ON_CALL_FOR]->(s)
WHERE w.weekStart <= $today
WITH s, max(w.weekStart) AS currentWeek
// authority: PageRank over the whole company graph (see the comment in people.ts)
CALL algo.pageRank(null, null) YIELD node, score
WITH s, currentWeek, node AS person, score AS authority
// real git authors only: fictional personas never author code
WHERE person:Person AND NOT coalesce(person.persona, false)
  AND ($includeBots OR NOT coalesce(person.isBot, false))
// activity: the person's PRs that touch the service
MATCH p = (person)-[:AUTHORED]->(pr:PR)-[:TOUCHES]->(s)`
      : `// Q3 "Who knows about $topic?"
// topic PRs: full-text index on PR.title
CALL db.idx.fulltext.queryNodes('PR', $topic) YIELD node AS hit
WITH collect(hit) AS topicPrs
// the current rotation week: newest weekStart <= today, across all services
OPTIONAL MATCH (:Person)-[w:ON_CALL_FOR]->(:Service)
WHERE w.weekStart <= $today
WITH topicPrs, max(w.weekStart) AS currentWeek
// authority: PageRank over the whole company graph (see the comment in people.ts)
CALL algo.pageRank(null, null) YIELD node, score
WITH topicPrs, currentWeek, node AS person, score AS authority
// real git authors only: fictional personas never author code
WHERE person:Person AND NOT coalesce(person.persona, false)
  AND ($includeBots OR NOT coalesce(person.isBot, false))
// activity: the person's PRs on the topic
MATCH p = (person)-[:AUTHORED]->(pr:PR)-[:TOUCHES]->(:Service)
WHERE pr IN topicPrs`;
  return `${head}
// most recent PR first, so collect(p)[0] is the person's latest evidence path
WITH currentWeek, person, authority, pr, p ORDER BY pr.mergedAt DESC
WITH currentWeek, person, authority, count(DISTINCT pr) AS prs, max(pr.mergedAt) AS lastActiveAt, collect(p)[0] AS path
// normalise authority against the strongest candidate: 0.5 .. 1.0
WITH currentWeek, max(authority) AS maxAuthority,
     collect({person: person, authority: authority, prs: prs, lastActiveAt: lastActiveAt, path: path}) AS cands
UNWIND cands AS c
WITH currentWeek, c.person AS person, c.prs AS prs, c.lastActiveAt AS lastActiveAt, c.path AS path,
     c.authority AS pagerank, 0.5 + 0.5 * c.authority / maxAuthority AS authority
OPTIONAL MATCH (person)-[:MEMBER_OF]->(team:Team)
WITH currentWeek, person, prs, lastActiveAt, path, pagerank, authority, collect(team) AS teams
WHERE $team IS NULL OR any(t IN teams WHERE t.uid = $team OR t.slug = $team)
// on call = has the current week's ON_CALL_FOR edge (for $service, or any service for a topic)
OPTIONAL MATCH (person)-[oc:ON_CALL_FOR {weekStart: currentWeek}]->(ocs:Service)
WHERE $service IS NULL OR ocs.uid = $service
WITH currentWeek, person, prs, lastActiveAt, path, pagerank, authority, teams, count(oc) > 0 AS onCall
// on-call rotations are staffed by personas: who on the person's team is on call right now?
OPTIONAL MATCH (mate:Person)-[:MEMBER_OF]->(mt:Team), (mate)-[:ON_CALL_FOR {weekStart: currentWeek}]->(ms:Service)
WHERE mt IN teams AND mate <> person AND ($service IS NULL OR ms.uid = $service)
WITH person, prs, lastActiveAt, path, pagerank, authority, teams, onCall, collect(DISTINCT mate.uid)[0] AS onCallTeammate
WHERE NOT $onCallOnly OR onCall OR onCallTeammate IS NOT NULL
RETURN person.uid AS person, person.name AS name,
       prs * authority * (CASE WHEN coalesce(person.isBot, false) THEN 0.1 ELSE 1.0 END) AS score,
       prs, pagerank, authority, [t IN teams | t.name][0] AS team, onCall, onCallTeammate, lastActiveAt,
       coalesce(person.isBot, false) AS isBot, path
ORDER BY score DESC, lastActiveAt DESC
LIMIT $limit`;
}

export const whoKnows = defineTool("who_knows", async (ctx, args) => {
  if (!args.service && !args.topic) throw new Error("who_knows needs a service or a topic");
  const scope = args.service ? "service" : "topic";
  const cypher = whoKnowsCypher(scope);
  const today = new Date();
  const team = args.team ? (args.team.startsWith("Team:") ? args.team : uid("Team", slugify(args.team))) : null;
  const params = {
    service: scope === "service" ? serviceUid(args.service!) : null,
    ...(scope === "topic" ? { topic: fulltextQuery(args.topic!) } : {}),
    team,
    includeBots: args.includeBots,
    onCallOnly: args.onCallOnly,
    today: today.toISOString().slice(0, 10),
    limit: args.limit,
  };
  if (scope === "topic" && !params.topic) throw new Error("who_knows: topic has no searchable words");
  const out = await toolQuery(ctx, cypher, params, { pathColumns: ["path"] });
  for (const r of out.rows) {
    r.score = round(num(r.score));
    r.pagerank = round(num(r.pagerank), 5);
    r.authority = round(num(r.authority));
  }
  const top = out.rows[0];
  const what = args.service ? serviceUid(args.service) : `"${args.topic}"`;
  const summary = top
    ? `${out.rows.length} people know ${what}; top: ${str(top.name)} (${num(top.prs)} PRs, score ${num(top.score)}${top.onCall ? ", on call" : ""})`
    : `nobody found for ${what}`;
  return makeResult("who_knows", ctx, cypher, params, out, summary);
});

export const ON_CALL_CYPHER = `// Who is on call for $service at $at? (on-call people are personas, e.g. role SRE)
// One ON_CALL_FOR edge per week:
// take the newest rotation week that started on or before $at.
MATCH (s:Service {uid: $service})
MATCH (:Person)-[w:ON_CALL_FOR]->(s)
WHERE w.weekStart <= $at
WITH s, max(w.weekStart) AS week
MATCH p = (person:Person)-[oc:ON_CALL_FOR {weekStart: week}]->(s)
OPTIONAL MATCH (person)-[:MEMBER_OF]->(team:Team)
RETURN person.uid AS person, person.name AS name, person.role AS role,
       coalesce(person.persona, false) AS persona, oc.weekStart AS weekStart,
       team.name AS team, s.uid AS service, p AS path
ORDER BY name`;

export const onCall = defineTool("on_call", async (ctx, args) => {
  const service = serviceUid(args.service);
  const at = (args.at ? new Date(args.at) : new Date()).toISOString().slice(0, 10);
  const params = { service, at };
  const out = await toolQuery(ctx, ON_CALL_CYPHER, params, { pathColumns: ["path"] });
  const summary = out.rows.length
    ? `${out.rows.map((r) => str(r.name)).join(", ")} on call for ${service} (week of ${str(out.rows[0]?.weekStart)})`
    : `no on-call rotation for ${service} on or before ${at}`;
  return makeResult("on_call", ctx, ON_CALL_CYPHER, params, out, summary);
});
