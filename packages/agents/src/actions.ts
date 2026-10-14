/**
 * Real actions (SPEC §5): GitHub issue, rollback PR (both in a SANDBOX repo),
 * and a Slack/Discord webhook ping. Each one:
 *   - is built from the session's findings READ FROM THE GRAPH (getFindings),
 *     never from in-memory agent text;
 *   - falls back to `dry_run` (full payload recorded) when its env is unset;
 *   - is recorded in Postgres (recordAction), emitted as an `action` event,
 *     and written to episodic memory as Episode(kind=action).
 *
 * GitHub calls use plain fetch against the REST API (no octokit).
 */
import { slugify, type ActionKind, type ActionRecord, type Finding, type Json, type Tenant } from "@blastradius/shared";
import { newId, type RunState } from "./runtime.ts";
import { keyOf, num, str } from "./templates.ts";

const GH_API = "https://api.github.com";
const HTTP_TIMEOUT_MS = 10_000;

export interface ActionEnv {
  githubToken?: string;
  githubRepo?: string;
  webhookUrl?: string;
  webhookKind: "slack" | "discord";
}

/** An env value, or undefined when empty or a leftover `# comment` (some .env parsers keep those). */
function envVal(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t && !t.startsWith("#") ? t : undefined;
}

export function actionEnv(env: NodeJS.ProcessEnv = process.env): ActionEnv {
  const kind = envVal(env.WEBHOOK_KIND)?.toLowerCase() === "discord" ? "discord" : "slack";
  const repo = envVal(env.GITHUB_SANDBOX_REPO);
  const url = envVal(env.WEBHOOK_URL);
  return {
    githubToken: envVal(env.GITHUB_TOKEN),
    githubRepo: repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : undefined,
    webhookUrl: url && /^https?:\/\//.test(url) ? url : undefined,
    webhookKind: kind,
  };
}

/** The suspect PR as stored in FalkorDB. */
export interface SuspectPr {
  uid: string;
  number: number;
  title: string;
  sha?: string;
  url?: string;
  author?: string;
}

/* ── content builders (pure; unit-tested) ───────────────────────────────── */

const KIND_HEADINGS: Record<string, string> = {
  impact: "What else breaks",
  risk: "Criticality",
  cause: "Probable cause",
  precedent: "What worked last time",
  expert: "Who can fix it",
  summary: "Summary",
  answer: "Answer",
  action: "Action",
};

export function findingsMarkdown(findings: Finding[]): string {
  return findings
    .map((f) => {
      const why = f.cypher.map((c) => "```cypher\n" + c.trim() + "\n```").join("\n");
      return `### ${KIND_HEADINGS[f.kind] ?? f.kind} (${f.agent}, confidence ${f.confidence.toFixed(2)})\n${f.claim}\n\n<details><summary>Why? (${f.cypher.length} Cypher ${f.cypher.length === 1 ? "query" : "queries"}, evidence: ${f.evidence.slice(0, 8).join(", ") || "none"})</summary>\n\n${why}\n\n</details>`;
    })
    .join("\n\n");
}

export function issueContent(tenant: Tenant, service: string, question: string, findings: Finding[]) {
  const title = `[blastradius/${tenant}] ${keyOf(service)}: ${question}`.slice(0, 240);
  const body = `Opened by Blastradius agents for **${tenant}** (service \`${service}\`).\n\n> ${question}\n\n${findingsMarkdown(findings)}\n\n_Every claim above links to the exact Cypher that produced it (FalkorDB graph \`blastradius_${tenant}\`)._`;
  return { title, body };
}

export function rollbackPlanMarkdown(opts: {
  tenant: Tenant;
  sessionId: string;
  service: string;
  pr: SuspectPr;
  findings: Finding[];
}): string {
  const { pr, findings } = opts;
  const impact = findings.find((f) => f.kind === "impact");
  const expert = findings.find((f) => f.kind === "expert");
  const cause = findings.find((f) => f.kind === "cause");
  const whyCypher = [...new Set([...(cause?.cypher ?? []), ...(impact?.cypher ?? [])])];
  return [
    `# Rollback plan: PR #${pr.number} "${pr.title}"`,
    "",
    `Tenant: \`${opts.tenant}\` · Session: \`${opts.sessionId}\` · Service: \`${opts.service}\``,
    "",
    "## Revert",
    "",
    "```bash",
    "git fetch origin",
    `git revert --no-edit ${pr.sha ?? `<merge sha of PR #${pr.number}>`}${pr.sha ? "" : "  # sha not recorded in the graph"}`,
    "git push origin HEAD",
    "```",
    "",
    pr.url ? `Original PR: ${pr.url}` : "",
    pr.author ? `Author: ${pr.author}` : "",
    "",
    "## Why this PR",
    cause?.claim ?? "(no cause finding)",
    "",
    "## Blast radius",
    impact?.claim ?? "(no impact finding)",
    "",
    "## Owners / who to page",
    expert?.claim ?? "(no expert finding)",
    "",
    "## Why? (exact Cypher)",
    ...whyCypher.map((c) => "```cypher\n" + c.trim() + "\n```"),
    "",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

export function webhookPayload(kind: "slack" | "discord", text: string): Record<string, Json> {
  return kind === "discord" ? { content: text.slice(0, 1900) } : { text };
}

/* ── HTTP ───────────────────────────────────────────────────────────────── */

async function gh(env: ActionEnv, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "blastradius-agents",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${path} → ${res.status}: ${String(json.message ?? text).slice(0, 200)}`), { status: res.status });
  return json;
}

async function createIssue(env: ActionEnv, title: string, body: string): Promise<string> {
  const out = await gh(env, "POST", `/repos/${env.githubRepo}/issues`, { title, body });
  return String(out.html_url);
}

/** Branch from the default branch, commit rollbacks/<id>.md, open a PR. Returns the PR url. */
async function createRollbackPr(env: ActionEnv, id: string, title: string, markdown: string, prBody: string): Promise<string> {
  const repo = env.githubRepo!;
  const meta = await gh(env, "GET", `/repos/${repo}`);
  const base = String(meta.default_branch ?? "main");
  const ref = await gh(env, "GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  const baseSha = String((ref.object as { sha?: string } | undefined)?.sha);
  let branch = `rollback/${id}`;
  try {
    await gh(env, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  } catch (err) {
    if ((err as { status?: number }).status !== 422) throw err;
    branch = `rollback/${id}-${Date.now().toString(36)}`; // branch exists (re-run): use a fresh one
    await gh(env, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  }
  await gh(env, "PUT", `/repos/${repo}/contents/rollbacks/${encodeURIComponent(id)}.md`, {
    message: title,
    content: Buffer.from(markdown, "utf8").toString("base64"),
    branch,
  });
  const pr = await gh(env, "POST", `/repos/${repo}/pulls`, { title, head: branch, base, body: prBody });
  return String(pr.html_url);
}

async function postWebhook(env: ActionEnv, payload: Record<string, Json>): Promise<void> {
  const res = await fetch(env.webhookUrl!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`webhook → ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/* ── the actions step ───────────────────────────────────────────────────── */

/** Reads the top suspect PR (from the cause finding's `about`) back from FalkorDB. */
async function suspectPr(run: RunState, findings: Finding[]): Promise<SuspectPr | undefined> {
  const cause = findings.find((f) => f.kind === "cause");
  const prUid = cause?.about.find((u) => u.startsWith("PR:"));
  if (!prUid) return undefined;
  // Q: what exactly is the suspect PR? (number, merge sha, url, author) — read-only, one node.
  const cypher = `
    MATCH (p:PR {uid: $uid})
    OPTIONAL MATCH (a:Person)-[:AUTHORED]->(p)
    RETURN p.number AS number, p.title AS title, p.sha AS sha, p.url AS url,
           coalesce(a.name, p.authorName) AS author
    LIMIT 1`;
  const { rows } = await run.deps.graph.runCypher(run.tenant, cypher, { uid: prUid }, { readOnly: true });
  const r = rows[0];
  if (!r) return undefined;
  return {
    uid: prUid,
    number: num(r.number) ?? Number(prUid.slice(3)),
    title: str(r.title) ?? "",
    ...(str(r.sha) ? { sha: str(r.sha)! } : {}),
    ...(str(r.url) ? { url: str(r.url)! } : {}),
    ...(str(r.author) ? { author: str(r.author)! } : {}),
  };
}

/**
 * Runs github_issue, rollback_pr and webhook for an incident run.
 * Action failures are recorded (status 'failed') and never stop the run.
 */
export async function runActions(run: RunState, opts: { question: string; env?: ActionEnv }): Promise<ActionRecord[]> {
  const env = opts.env ?? actionEnv();
  const findings = await run.graphWrite("getFindings", () => run.deps.graph.getFindings(run.tenant, run.sessionId));
  const service = run.service ?? findings.flatMap((f) => f.about).find((u) => u.startsWith("Service:")) ?? "Service:unknown";
  const findingIds = findings.map((f) => f.id);
  const ghReady = !!(env.githubToken && env.githubRepo);
  const out: ActionRecord[] = [];

  const perform = async (
    kind: ActionKind,
    title: string,
    payload: Record<string, Json>,
    ready: boolean,
    doIt: () => Promise<string | undefined>,
  ) => {
    run.checkAbort();
    let rec: ActionRecord = {
      id: newId("act"),
      sessionId: run.sessionId,
      tenant: run.tenant,
      kind,
      status: "dry_run",
      title,
      payload,
      findingIds,
      createdAt: new Date().toISOString(),
    };
    if (ready) {
      try {
        const url = await doIt();
        rec = { ...rec, status: "done", ...(url ? { url } : {}) };
      } catch (err) {
        rec = { ...rec, status: "failed", error: err instanceof Error ? err.message : String(err) };
        run.emit({ type: "error", agent: "expert", where: "action", message: `${kind}: ${rec.error}`, fatal: false });
      }
    }
    await run.deps.db.recordAction(rec, run.runId);
    run.emit({ type: "action", agent: "expert", action: rec });
    await run.graphWrite("recordEpisode(action)", () =>
      run.deps.graph.recordEpisode(run.tenant, {
        sessionId: run.sessionId,
        agent: "system",
        kind: "action",
        summary: `${kind} ${rec.status}: ${title}${rec.url ? ` (${rec.url})` : ""}`,
      }),
    );
    out.push(rec);
  };

  // 1. GitHub issue with every finding and its Why? Cypher.
  const issue = issueContent(run.tenant, service, opts.question, findings);
  await perform("github_issue", issue.title, { repo: env.githubRepo ?? null, title: issue.title, body: issue.body }, ghReady, () =>
    createIssue(env, issue.title, issue.body),
  );

  // 2. Rollback PR for the top suspect PR (only if the investigator named one).
  const pr = await run.graphWrite("suspect PR lookup", () => suspectPr(run, findings));
  if (pr) {
    const id = slugify(run.sessionId);
    const title = `Rollback PR #${pr.number}: ${pr.title}`.slice(0, 240);
    const markdown = rollbackPlanMarkdown({ tenant: run.tenant, sessionId: run.sessionId, service, pr, findings });
    const prBody = `Drafted by Blastradius for session \`${run.sessionId}\`. Adds \`rollbacks/${id}.md\` with the \`git revert\` plan for PR #${pr.number}; review before running it.`;
    await perform(
      "rollback_pr",
      title,
      { repo: env.githubRepo ?? null, branch: `rollback/${id}`, path: `rollbacks/${id}.md`, pr: pr.uid, sha: pr.sha ?? null, markdown, body: prBody },
      ghReady,
      () => createRollbackPr(env, id, title, markdown, prBody),
    );
  }

  // 3. Webhook ping (Slack {text} / Discord {content}).
  const lines = findings
    .filter((f) => ["impact", "cause", "expert", "precedent"].includes(f.kind))
    .map((f) => `• ${f.claim}`);
  const issueUrl = out.find((a) => a.kind === "github_issue")?.url;
  const text = `:rotating_light: *${run.tenant}* ${keyOf(service)}: ${opts.question}\n${lines.join("\n")}${issueUrl ? `\nIssue: ${issueUrl}` : ""}`;
  await perform("webhook", `Notify ${env.webhookKind}: ${keyOf(service)}`, webhookPayload(env.webhookKind, text), !!env.webhookUrl, async () => {
    await postWebhook(env, webhookPayload(env.webhookKind, text));
    return undefined;
  });

  return out;
}
