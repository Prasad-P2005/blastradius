/**
 * pnpm seed:memory: gives the demo graph some agent memory to show.
 *
 * After `pnpm graph:load` the tenant graphs hold domain data only: no Session,
 * Episode, Finding or agent-written Incident/Runbook. So the Memory inspector is
 * empty and cross-session recall has nothing to recall. This script runs real
 * scenarios from data/scenarios.json through the normal pipeline (scripted
 * mode, same tools, same graph writes as the UI) on the LIVE graph:
 *
 *   1. two incident scenarios per tenant, each closed by the Scribe
 *      (Incident + Runbook into procedural memory);
 *   2. one incident scenario left open (an unresolved session);
 *   3. a follow-up on the first closed service, which must recall that
 *      incident from the earlier session (checked, exit 1 if not);
 *   4. one "Ask the company" question.
 *
 * Nothing is faked: every Session/Episode/Finding comes from an actual run.
 * Actions stay dry_run unless GITHUB_TOKEN / WEBHOOK_URL are set (they are
 * real actions then, so this script refuses to run with them set unless you
 * pass --allow-actions).
 *
 * The script stops if a tenant already has sessions, so it doesn't pile up
 * duplicate memory on repeat runs. Pass --force to add more anyway, or run
 * `pnpm graph:load` first to start from a clean graph.
 *
 * Options: --tenants acme,globex  --force  --allow-actions
 */
import { loadRootEnv } from "@blastradius/shared/env";
import { TENANTS, isSeedPack as isTenant, type AgentEvent, type Finding, type InvestigateRequest, type Scenario, type SeedPack as Tenant } from "@blastradius/shared";

loadRootEnv();
const { investigate, closeIncident, loadScenarios, closeDefaultExecutor } = await import("../index.ts");
const graph = await import("@blastradius/graph");
const db = await import("@blastradius/db");

const args = process.argv.slice(2).filter((a) => a !== "--");
const argOf = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const force = args.includes("--force");
const allowActions = args.includes("--allow-actions");
const tenants = (argOf("--tenants")?.split(",") ?? [...TENANTS]).filter(isTenant);

/**
 * Which scenarios to run per tenant, and how the closed ones were resolved.
 * The runbook steps are what an on-call engineer would write after the fix;
 * `{pr}` is replaced with the suspect PR the Investigator actually found.
 */
interface SeedPlan {
  closed: { scenario: string; severity: "SEV1" | "SEV2" | "SEV3"; steps: string[] }[];
  open: string;
  ask: string;
}
const PLANS: Record<Tenant, SeedPlan> = {
  acme: {
    closed: [
      {
        scenario: "acme-checkout-5xx",
        severity: "SEV2",
        steps: [
          "Confirm the 5xx spike is on PlaceOrder only (checkout dashboard, split by RPC)",
          "Diff {pr} against the previous release and check the checkout → payment/cart calls it touched",
          "Roll back {pr} via the sandbox rollback PR; watch the error ratio for 10 minutes",
          "Page the cart and payment owners if errors persist after rollback",
        ],
      },
      {
        scenario: "acme-cart-errors",
        severity: "SEV3",
        steps: [
          "Check Valkey health and connection count from the cart pods",
          "Review {pr} for changes to the cart store or its retry logic",
          "Roll back {pr} if GetCart errors started at its deploy time",
          "Add an alert on cart → valkey latency if it was the trigger",
        ],
      },
    ],
    open: "acme-payment-failures",
    ask: "acme-ask-valkey",
  },
  globex: {
    closed: [
      {
        scenario: "globex-catalog-errors",
        severity: "SEV2",
        steps: [
          "Check productcatalogservice logs for catalog load or parse errors",
          "Review {pr} for changes to the product catalog or its base image",
          "Roll back {pr}; confirm ListProducts errors drop below 1%",
          "Notify frontend and recommendation owners (both call ListProducts)",
        ],
      },
      {
        scenario: "globex-ad-errors",
        severity: "SEV3",
        steps: [
          "Check adservice JVM heap and profiler overhead",
          "Review {pr} for dependency or JVM flag changes",
          "Roll back {pr} if GetAds errors line up with its deploy",
        ],
      },
    ],
    open: "globex-assistant-timeouts",
    ask: "globex-ask-assistant",
  },
};

function toRequest(s: Scenario, message = s.question): InvestigateRequest {
  return { tenant: s.tenant, mode: s.mode, message, scenarioId: s.id, ...(s.alert ? { alert: s.alert } : {}), agentMode: "scripted" };
}

/** Runs one investigation to the end; returns its session id and the findings it emitted. */
async function run(req: InvestigateRequest): Promise<{ sessionId: string; findings: Finding[]; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  for await (const e of investigate(req)) events.push(e);
  const last = events.at(-1);
  if (last?.type !== "run_finished" || last.status !== "ok") {
    const err = events.find((e) => e.type === "error");
    throw new Error(`run "${req.message}" did not finish ok: ${err?.type === "error" ? err.message : last?.type}`);
  }
  const findings = events.flatMap((e) => (e.type === "finding" ? [e.finding] : []));
  return { sessionId: events[0]!.sessionId, findings, events };
}

let failed = false;
try {
  if (!allowActions && (process.env.GITHUB_TOKEN?.trim() || process.env.WEBHOOK_URL?.trim())) {
    throw new Error("GITHUB_TOKEN or WEBHOOK_URL is set, so runs would take real actions. Unset them or pass --allow-actions.");
  }
  const health = await graph.falkorHealth();
  if (!health.ok) throw new Error(`FalkorDB is not reachable: ${health.error}`);
  if (!(await db.pgHealth()).ok) console.warn("! Postgres is not reachable: sessions will be in the graph but not in the transcript/replay log");
  if (process.env.BLASTRADIUS_GRAPH_NAMESPACE) console.warn(`! BLASTRADIUS_GRAPH_NAMESPACE=${process.env.BLASTRADIUS_GRAPH_NAMESPACE}: seeding that namespace, not the demo graph`);

  const scenarios = await loadScenarios();
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const need = (id: string) => {
    const s = byId.get(id);
    if (!s) throw new Error(`scenario ${id} not in data/scenarios.json`);
    return s;
  };

  for (const tenant of tenants) {
    // How much agent memory this tenant already has (guards against duplicate seeding).
    const { rows } = await graph.runCypher(tenant, "MATCH (s:Session) RETURN count(s) AS sessions", {});
    const existing = Number(rows[0]?.sessions ?? 0);
    if (existing > 0 && !force) {
      console.log(`\n── ${tenant}: already has ${existing} sessions, skipping (--force to add more, or pnpm graph:load to reset)`);
      continue;
    }
    const plan = PLANS[tenant];
    console.log(`\n── ${tenant}`);

    const closedIncidents: string[] = [];
    for (const c of plan.closed) {
      const s = need(c.scenario);
      const { sessionId, findings } = await run(toRequest(s));
      const cause = findings.find((f) => f.kind === "cause");
      const expert = findings.find((f) => f.kind === "expert");
      const suspectPr = cause?.about.find((u) => u.startsWith("PR:"));
      const closed = await closeIncident({
        tenant,
        sessionId,
        title: s.title,
        summary: findings.find((f) => f.kind === "summary")?.claim ?? s.question,
        severity: c.severity,
        service: s.alert!.service,
        ...(suspectPr ? { causedByPr: suspectPr } : {}),
        responders: (expert?.about ?? []).filter((u) => u.startsWith("Person:")),
        runbook: { title: `${s.title}: runbook`, steps: c.steps.map((step) => step.replaceAll("{pr}", suspectPr ?? "the suspect PR")) },
        findingIds: findings.map((f) => f.id),
      });
      closedIncidents.push(closed.incidentUid);
      console.log(`   closed   ${s.id} → ${closed.incidentUid} (${findings.length} findings, suspect ${suspectPr ?? "none"})`);
    }

    const open = need(plan.open);
    const o = await run(toRequest(open));
    console.log(`   open     ${open.id} → session ${o.sessionId} (${o.findings.length} findings)`);

    // A later alert on the first closed service: recall must surface the incident we just closed.
    const first = need(plan.closed[0]!.scenario);
    const again = await run(toRequest(first, `${first.alert!.message} (again)`));
    const recalled = again.events.find((e) => e.type === "memory_recalled");
    const uids = recalled?.type === "memory_recalled" ? recalled.memories.map((m) => m.uid) : [];
    const ok = uids.includes(closedIncidents[0]!);
    if (!ok) failed = true;
    console.log(`   recall   ${first.id} again → ${ok ? "✓" : "✗"} recalled ${closedIncidents[0]} (got ${uids.slice(0, 4).join(", ") || "nothing"})`);

    const ask = need(plan.ask);
    const a = await run(toRequest(ask));
    console.log(`   ask      ${ask.id} → session ${a.sessionId} (${a.findings.length} findings)`);
  }
} catch (err) {
  failed = true;
  console.error(`seed-memory failed: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  await closeDefaultExecutor();
  await graph.closeFalkor().catch(() => {});
  await db.closeDb();
}
process.exit(failed ? 1 : 0);
