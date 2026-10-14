/**
 * tools/changes.ts — Track 01 "What probably caused it?": suspect_changes.
 *
 * "Recent" is measured back from the NEWEST PR in the tenant graph, never
 * from Date.now(): the snapshot is a frozen slice of git history, and the demo
 * must keep working weeks after it was taken (lesson 2).
 */
import { serviceUid, type Tenant } from "@blastradius/shared";
import { runCypher } from "../connection.ts";
import { defineTool, hopInt, makeResult, num, str, toolQuery } from "./common.ts";

const DAY_MS = 86_400_000;

export const NEWEST_PR_CYPHER = `// The tenant's "now": the merge time of the newest PR in the graph
MATCH (pr:PR)
RETURN max(pr.mergedAt) AS newest`;

/** Epoch ms of the newest PR (0 if the graph has no PRs). */
export async function newestPrAt(tenant: Tenant): Promise<number> {
  const { rows } = await runCypher(tenant, NEWEST_PR_CYPHER, {}, { readOnly: true });
  return Number(rows[0]?.newest ?? 0);
}

/** The suspect-changes query; the dependency hop cap is interpolated (0 = only the service itself). */
export function suspectChangesCypher(depHops: number): string {
  const h = hopInt(depHops, 0, 4);
  return `// Q2 "What probably caused the alert on $service?"
// Recent merged PRs that touched the service, or a service it depends on
// (up to ${h} DEPENDS_ON hops), newest first. "Recent" = within $sinceDays of
// the newest PR in the graph.
MATCH (latest:PR)
WITH max(latest.mergedAt) AS newest
MATCH (alert:Service {uid: $service})
MATCH p = (author:Person)-[:AUTHORED]->(pr:PR)-[:TOUCHES]->(svc:Service)<-[:DEPENDS_ON*0..${h}]-(alert)
WHERE pr.mergedAt >= newest - $sinceDays * ${DAY_MS}
// keep the closest service each PR reaches the alert through
WITH pr, author, svc, p, length(p) - 2 AS hops
ORDER BY hops ASC
WITH pr, author, collect(svc.uid)[0] AS service, min(hops) AS hops, collect(p)[0] AS path
OPTIONAL MATCH (pr)-[:MODIFIES]->(f:File)
WITH pr, author, service, hops, path, collect(f.path) AS files
RETURN pr.uid AS pr, pr.number AS number, pr.title AS title, pr.mergedAt AS mergedAt,
       author.uid AS author, author.name AS authorName, coalesce(pr.isBot, author.isBot, false) AS isBot,
       service, hops, files, pr.additions AS additions, pr.deletions AS deletions, pr.url AS url, path
// humans first unless bots were asked for, then newest first
ORDER BY CASE WHEN $includeBots THEN 0 WHEN isBot THEN 1 ELSE 0 END ASC,
         mergedAt DESC
LIMIT $limit`;
}

export const suspectChanges = defineTool("suspect_changes", async (ctx, args) => {
  const service = serviceUid(args.service);
  const cypher = suspectChangesCypher(args.includeDependencies ? args.maxHops : 0);
  const params = { service, sinceDays: args.sinceDays, includeBots: args.includeBots, limit: args.limit };
  const out = await toolQuery(ctx, cypher, params, { pathColumns: ["path"] });
  const top = out.rows[0];
  const summary = top
    ? `${out.rows.length} PRs in the ${args.sinceDays} days before the newest PR touched ${service}${args.includeDependencies ? " or its dependencies" : ""}; newest suspect: PR #${num(top.number)} "${str(top.title)}" by ${str(top.authorName)}`
    : `no PRs touched ${service} in the ${args.sinceDays} days before the newest PR`;
  return makeResult("suspect_changes", ctx, cypher, params, out, summary);
});
