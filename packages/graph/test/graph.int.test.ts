/**
 * Integration test against live FalkorDB (FALKORDB_URL). Runs under the
 * `itest` graph namespace (vitest.int.config.ts), so it loads the fixture into
 * `itest_blastradius_acme` and never touches the real tenant graphs.
 *
 * Covers: loading (+ TOUCHES, embeddings), every tool with content assertions,
 * the memory flow (session → episode → finding handed to another agent →
 * read_handoffs → closeIncident → a NEW session recalls it), UI reads, and
 * incremental re-ingest.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphToolResult, Row } from "@blastradius/shared";
import * as g from "../src/index.ts";
import { graphKey } from "../src/connection.ts";
import { NEWEST, fixtureDelta, fixtureSnapshot } from "./fixture.ts";

const ctx = { tenant: "acme" as const };
const col = (r: GraphToolResult, c: string) => r.rows.map((x: Row) => x[c]);
/** Every path must be uid-based: no internal ids, edges reference path nodes. */
function expectUidPaths(r: GraphToolResult) {
  for (const p of r.paths) {
    const ids = new Set(p.nodes.map((n) => n.id));
    for (const n of p.nodes) expect(n.id).toMatch(/^[A-Z][A-Za-z]+:.+/);
    for (const e of p.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
    for (const n of p.nodes) expect(n.props.embedding).toBeUndefined();
  }
}

beforeAll(async () => {
  expect(graphKey("acme")).toBe("itest_blastradius_acme");
  const stats = await g.loadSnapshot("acme", fixtureSnapshot, { reset: true });
  expect(stats.nodes).toBe(fixtureSnapshot.nodes.length);
  expect(stats.edges).toBe(fixtureSnapshot.edges.length);
  expect(stats.touches).toBeGreaterThan(0);
  expect(stats.embedded).toBe(7); // 2 incidents, 1 decision, 2 docs, 1 thread, 1 issue
});

afterAll(async () => {
  await g.closeFalkor();
});

describe("connection + loading", () => {
  it("health is ok", async () => {
    const h = await g.falkorHealth();
    expect(h.ok).toBe(true);
  });
  it("re-running ensureSchema is fine", async () => {
    await g.ensureSchema("acme");
  });
  it("counts reflect the fixture, TOUCHES derived, ON_CALL_FOR one edge per week", async () => {
    const c = await g.counts("acme");
    expect(c.labels.Service).toBe(9);
    expect(c.rels.ON_CALL_FOR).toBe(5);
    expect(c.rels.TOUCHES).toBe(12);
  });
  it("newestPrAt is the newest PR in the graph", async () => {
    expect(await g.newestPrAt("acme")).toBe(NEWEST);
  });
});

describe("tools", () => {
  it("blast_radius: dependents of cart ranked by betweenness", async () => {
    const r = await g.runTool("blast_radius", ctx, { service: "cart" });
    expect(col(r, "service")).toEqual(["Service:checkout", "Service:frontend"]);
    expect(r.rows[0]!.betweenness).toBeGreaterThan(0);
    expect(r.paths).toHaveLength(2);
    expectUidPaths(r);
    const deps = await g.runTool("blast_radius", ctx, { service: "checkout", direction: "dependencies", maxHops: 2 });
    expect(col(deps, "service")).toEqual(expect.arrayContaining(["Service:cart", "Service:valkey-cart", "Service:payment"]));
  });

  it("critical_services: checkout is the top chokepoint", async () => {
    const r = await g.runTool("critical_services", ctx, {});
    expect(r.rows[0]!.service).toBe("Service:checkout");
  });

  it("failure_communities: WCC separates isolated flagd; CDLP returns communities", async () => {
    const wcc = await g.runTool("failure_communities", ctx, { algorithm: "wcc" });
    expect(wcc.rows).toHaveLength(2);
    expect(wcc.rows[0]!.size).toBe(8);
    const cdlp = await g.runTool("failure_communities", ctx, { algorithm: "cdlp" });
    const all = cdlp.rows.flatMap((x) => x.services as string[]);
    expect(all).toHaveLength(9);
  });

  it("suspect_changes: human PR 140 first, bot PR 141 after it, window from newest PR", async () => {
    const r = await g.runTool("suspect_changes", ctx, { service: "cart" });
    expect(r.rows[0]!.pr).toBe("PR:140");
    expect(col(r, "pr")).toContain("PR:141");
    expect(col(r, "pr").indexOf("PR:141")).toBeGreaterThan(0);
    expect(col(r, "pr")).not.toContain("PR:101"); // 200 days old
    expectUidPaths(r);
    expect(r.paths[0]!.edges.map((e) => e.type)).toEqual(["AUTHORED", "TOUCHES"]);
    const withBots = await g.runTool("suspect_changes", ctx, { service: "cart", includeBots: true });
    expect(withBots.rows[0]!.pr).toBe("PR:141"); // newest first
    const checkout = await g.runTool("suspect_changes", ctx, { service: "checkout", sinceDays: 30 });
    expect(col(checkout, "pr")).toEqual(expect.arrayContaining(["PR:142", "PR:140", "PR:125"])); // via cart / currency
  });

  it("COLLABORATES_WITH: derived between human authors who share files; PageRank on it is not flat", async () => {
    const { rows } = await g.runCypher("acme", `MATCH (a:Person)-[c:COLLABORATES_WITH]->(b:Person)
      RETURN a.uid AS a, b.uid AS b, c.files AS files, coalesce(a.isBot, false) OR coalesce(a.persona, false) AS fake`, {}, { readOnly: true });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.fake === false && (r.files as number) >= 1)).toBe(true);
    // both directions, so PageRank treats collaboration as mutual
    const pairs = new Set(rows.map((r) => `${r.a}>${r.b}`));
    expect(rows.every((r) => pairs.has(`${r.b}>${r.a}`))).toBe(true);
    const pr = await g.runCypher("acme", "CALL algo.pageRank('Person', 'COLLABORATES_WITH') YIELD node, score RETURN score", {}, { readOnly: true });
    expect(new Set(pr.rows.map((r) => (r.score as number).toFixed(6))).size).toBeGreaterThan(1);
  });

  it("who_knows: pageRank × activity, bots excluded by default", async () => {
    const r = await g.runTool("who_knows", ctx, { service: "checkout" });
    const people = col(r, "person");
    expect(people).toEqual(expect.arrayContaining(["Person:bob-patel", "Person:carol-diaz"]));
    expect(people).not.toContain("Person:renovate-bot");
    expect(r.rows.every((x) => typeof x.pagerank === "number" && (x.pagerank as number) > 0)).toBe(true);
    expectUidPaths(r);
    const bots = await g.runTool("who_knows", ctx, { service: "checkout", includeBots: true });
    const bot = bots.rows.find((x) => x.person === "Person:renovate-bot");
    expect(bot).toBeDefined();
    expect(bot!.score as number).toBeLessThan(1); // ×0.1
    const topic = await g.runTool("who_knows", ctx, { topic: "valkey pool" });
    expect(topic.rows[0]!.person).toBe("Person:alice-chen");
    const team = await g.runTool("who_knows", ctx, { service: "checkout", team: "web-team" });
    expect(team.rows).toHaveLength(0);
    // personas never rank (they author nothing and are filtered); on-call teammates are surfaced
    expect(people.some((p) => String(p).includes("persona-"))).toBe(false);
    expect(r.rows.every((x) => x.onCallTeammate === "Person:persona-jo-okafor")).toBe(true);
    const cart = await g.runTool("who_knows", ctx, { service: "cart", onCallOnly: true });
    expect(cart.rows[0]).toMatchObject({ person: "Person:alice-chen", onCall: false, onCallTeammate: "Person:persona-sam-rivera" });
  });

  it("on_call: latest week <= at, one edge per week, personas with role", async () => {
    const now = await g.runTool("on_call", ctx, { service: "cart" });
    expect(now.rows[0]).toMatchObject({ person: "Person:persona-sam-rivera", role: "SRE", persona: true });
    const past = await g.runTool("on_call", ctx, { service: "cart", at: "2025-09-24" });
    expect(past.rows[0]!.person).toBe("Person:persona-jo-okafor");
    expect(past.paths[0]!.edges[0]!.id).toContain("#2025-09-22");
  });

  it("service_context: one row with team, deps, runbooks, docs, incidents, decisions", async () => {
    const r = await g.runTool("service_context", ctx, { service: "Service:cart" });
    const row = r.rows[0]!;
    expect(row.teamName).toBe("Cart Team");
    expect((row.dependsOn as Row[]).map((x) => x.uid)).toEqual(["Service:valkey-cart"]);
    expect((row.dependents as Row[]).length).toBe(2);
    expect((row.runbooks as Row[])[0]!.uid).toBe("Runbook:valkey-connection-exhaustion");
    expect((row.docs as Row[]).length).toBe(2);
    expect((row.decisions as Row[])[0]!.uid).toBe("Decision:ADR-003");
    expect(r.paths.length).toBeGreaterThan(5);
  });

  it("past_incidents: cart incident first, neighbour incident after, with runbook steps", async () => {
    const r = await g.runTool("past_incidents", ctx, { service: "cart" });
    expect(r.rows[0]!.incident).toBe("Incident:INC-2025-007");
    expect(r.rows[0]!.causedBy).toBe("PR:101");
    expect((r.rows[0]!.runbookSteps as string[]).length).toBe(3);
    expect(col(r, "incident")).toContain("Incident:INC-2025-019"); // via checkout neighbour
    const only = await g.runTool("past_incidents", ctx, { service: "cart", includeNeighbors: false });
    expect(col(only, "incident")).toEqual(["Incident:INC-2025-007"]);
  });

  it("similar_incidents: vector search finds the Valkey incident and expands it", async () => {
    const r = await g.runTool("similar_incidents", ctx, { text: "cart returns 503, connection pool exhausted" });
    expect(r.rows[0]!.incident).toBe("Incident:INC-2025-007");
    expect(r.rows[0]!.similarity as number).toBeGreaterThan(0);
    expect(r.rows[0]!.similarity as number).toBeLessThanOrEqual(1);
    expect(r.rows[0]!.runbook).toBe("Runbook:valkey-connection-exhaustion");
    expect(r.params.vec).toMatch(/embedding/);
    expectUidPaths(r);
  });

  it("decision_trace: Doc ← Decision → PR ← Incident, from text and from a uid", async () => {
    const r = await g.runTool("decision_trace", ctx, { query: "why did we move cart storage to valkey" });
    const row = r.rows[0]!;
    expect(row.decision).toBe("Decision:ADR-003");
    expect(row.doc).toBe("Doc:adr-003-valkey");
    expect(row.prs).toEqual(["PR:101"]);
    expect(row.incidents).toEqual(["Incident:INC-2025-007"]);
    for (const uid of ["Incident:INC-2025-007", "PR:101", "Service:cart"]) {
      const t = await g.runTool("decision_trace", ctx, { uid });
      expect(t.rows[0]?.decision).toBe("Decision:ADR-003");
    }
  });

  it("explain_path: shortestPath between a person and an incident", async () => {
    const r = await g.runTool("explain_path", ctx, { from: "Person:alice-chen", to: "Incident:INC-2025-019" });
    const nodes = r.rows[0]!.nodes as string[];
    expect(nodes[0]).toBe("Person:alice-chen");
    expect(nodes.at(-1)).toBe("Incident:INC-2025-019");
    expect(r.paths[0]!.nodes.map((n) => n.id)).toEqual(nodes);
    expectUidPaths(r);
  });

  it("search_nodes: full-text across labels", async () => {
    const r = await g.runTool("search_nodes", ctx, { query: "valkey" });
    expect(col(r, "uid")).toEqual(expect.arrayContaining(["Service:valkey-cart", "PR:101", "Decision:ADR-003"]));
    const svc = await g.runTool("search_nodes", ctx, { query: "check", labels: ["Service"] });
    expect(svc.rows[0]!.uid).toBe("Service:checkout");
  });

  it("ask_company: vector search across labels with sources", async () => {
    const r = await g.runTool("ask_company", ctx, { question: "Why did we move the cart to Valkey?" });
    const top3 = col(r, "source").slice(0, 3);
    expect(top3).toContain("Decision:ADR-003");
    const labels = new Set(col(r, "label"));
    expect(labels.size).toBeGreaterThan(2);
    const dec = r.rows.find((x) => x.source === "Decision:ADR-003")!;
    expect((dec.related as Row[]).map((x) => x.uid)).toEqual(expect.arrayContaining(["PR:101", "Doc:adr-003-valkey"]));
    const onlyThreads = await g.runTool("ask_company", ctx, { question: "valkey pool", labels: ["Thread"] });
    expect(col(onlyThreads, "label")).toEqual(["Thread"]);
  });

  it("tool inputs are validated by the contract schemas", async () => {
    await expect(g.runTool("blast_radius", ctx, { service: "cart", maxHops: 99 })).rejects.toThrow();
    await expect(g.runTool("read_handoffs", ctx, {})).rejects.toThrow(/sessionId/);
  });
});

describe("memory flow", () => {
  const s1 = `itest_${Date.now()}_a`;
  const s2 = `itest_${Date.now()}_b`;
  let findingId = "";

  it("session → episodes (seq chain, concurrent-safe) → finding handed to investigator", async () => {
    const st = await g.startSession("acme", { sessionId: s1, mode: "incident", question: "cart 5xx at 12%", service: "cart", agentMode: "scripted" });
    expect(st.created).toBe(true);
    expect((await g.startSession("acme", { sessionId: s1, mode: "incident", question: "x", agentMode: "scripted" })).created).toBe(false);

    const eps = await Promise.all(
      Array.from({ length: 5 }, (_, i) => g.recordEpisode("acme", { sessionId: s1, agent: "triage", kind: "agent_run", summary: `step ${i}` })),
    );
    expect(eps.map((e) => e.seq).sort()).toEqual([0, 1, 2, 3, 4]);

    const blast = await g.runTool("blast_radius", ctx, { service: "cart" });
    const { finding, result } = await g.recordFinding(
      { tenant: "acme", sessionId: s1, agent: "triage" },
      {
        kind: "impact",
        claim: "Cart failure breaks checkout and frontend",
        confidence: 0.9,
        about: ["Service:cart"],
        evidence: ["Service:checkout", "Service:frontend", "Nope:bad"],
        cypher: [blast.cypher],
        handTo: "investigator",
      },
    );
    findingId = finding.id;
    expect(result.tool).toBe("record_finding");
    expect(finding.cypher[0]).toBe(blast.cypher);
  });

  it("a finding about a persona shows up in that persona's activity feed", async () => {
    await g.recordEpisode("acme", { sessionId: s1, agent: "expert", kind: "agent_run", summary: "expert started" });
    const oc = await g.runTool("on_call", ctx, { service: "cart" });
    const { finding } = await g.recordFinding(
      { tenant: "acme", sessionId: s1, agent: "expert" },
      { kind: "expert", claim: "Sam Rivera is on call for cart this week", confidence: 0.8, about: ["Person:persona-sam-rivera"], evidence: ["Service:cart"], cypher: [oc.cypher] },
    );
    const a = await g.personActivity("acme", "Person:persona-sam-rivera");
    const item = a.items.find((i) => i.kind === "finding");
    expect(item).toMatchObject({ uid: finding.uid, sessionId: s1, title: "Sam Rivera is on call for cart this week" });
    expect(a.items[0]!.uid).toBe(finding.uid); // newest first
    expect(a.person.counts.findings).toBe(1);
  });

  it("read_handoffs: the investigator sees it; the expert does not", async () => {
    const r = await g.runTool("read_handoffs", { tenant: "acme", sessionId: s1, agent: "investigator" }, {});
    expect(col(r, "finding")).toEqual([findingId]);
    expect(r.rows[0]!.from).toBe("triage");
    expect((r.rows[0]!.cypher as string[])[0]).toContain("algo.betweenness");
    const none = await g.readHandoffs({ tenant: "acme", sessionId: s1, agent: "expert" });
    expect(none.rows).toHaveLength(0);
    const fs = await g.getFindings("acme", s1);
    expect(fs[0]!.evidence).toContain("Service:checkout");
  });

  it("memory inspector shows the session's episodes, finding, handoff and subgraph", async () => {
    const m = await g.memoryInspector("acme", s1);
    expect(m.sessions.find((s) => s.sessionId === s1)?.episodes).toBe(6);
    expect(m.session!.episodes).toHaveLength(6);
    expect(m.session!.episodes[4]!.findings[0]!.id).toBe(findingId); // PRODUCED by the then-latest episode
    expect(m.session!.handoffs[0]).toMatchObject({ findingId, from: "triage", to: "investigator" });
    const types = new Set(m.subgraph.edges.map((e) => e.type));
    for (const t of ["HAS_EPISODE", "NEXT", "PRODUCED", "ABOUT", "SUPPORTED_BY", "HANDED_TO", "WROTE"]) expect(types).toContain(t);
    expect(m.procedural.find((p) => p.service === "Service:cart")?.incidents.length).toBeGreaterThan(0);
  });

  it("closeIncident writes procedural memory that the NEXT session recalls", async () => {
    const res = await g.closeIncident({
      tenant: "acme",
      sessionId: s1,
      title: "Cart Valkey pool too small after PR 140",
      summary: "Cart 5xx at 12% because PR 140 shrank the Valkey connection pool.",
      severity: "SEV2",
      service: "cart",
      causedByPr: "PR:140",
      responders: ["Person:persona-sam-rivera"],
      runbook: { title: "Restore Valkey pool size", steps: ["Revert PR 140", "Restart cart pods"] },
      findingIds: [findingId],
    });
    expect(res.incidentUid).toBe(`Incident:INC-${s1}`);
    expect((await g.listGraphSessions("acme")).find((s) => s.sessionId === s1)?.status).toBe("closed");

    await g.startSession("acme", { sessionId: s2, mode: "incident", question: "cart errors again", service: "cart", agentMode: "scripted" });
    const ctx2 = { tenant: "acme" as const, sessionId: s2 };

    const { memories, result } = await g.recallMemory(ctx2, { service: "cart", text: "cart valkey pool errors" });
    const inc = memories.find((m) => m.uid === res.incidentUid);
    expect(inc?.kind).toBe("incident");
    expect(inc?.runbook?.steps).toEqual(["Revert PR 140", "Restart cart pods"]);
    expect(inc?.path?.nodes.map((n) => n.id)).toContain("Service:cart");
    expect(memories.find((m) => m.uid === `Finding:${findingId}`)?.sessionId).toBe(s1);
    expect(result.rows.length).toBe(memories.length);

    // the current session never recalls itself
    const self = await g.recallMemory({ tenant: "acme", sessionId: s1 }, { service: "cart" });
    expect(self.memories.find((m) => m.sessionId === s1)).toBeUndefined();

    const past = await g.runTool("past_incidents", ctx2, { service: "cart" });
    expect(past.rows[0]!.incident).toBe(res.incidentUid); // newest first
    expect(past.rows[0]!.causedBy).toBe("PR:140");
    expect(past.rows[0]!.sessionId).toBe(s1);

    const sim = await g.runTool("similar_incidents", ctx2, { text: "Valkey connection pool too small, cart 5xx", service: "cart" });
    expect(col(sim, "incident")).toContain(res.incidentUid);
  });
});

describe("people", () => {
  it("listPeople: personas first with role, team, counts and on-call-now", async () => {
    const all = await g.listPeople("acme");
    expect(all.slice(0, 4).every((p) => p.persona)).toBe(true);
    const sam = all.find((p) => p.uid === "Person:persona-sam-rivera")!;
    expect(sam).toMatchObject({ role: "SRE", team: "Team:cart-team", isBot: false });
    expect(sam.onCallNow.sort()).toEqual(["Service:cart", "Service:valkey-cart"]);
    expect(sam.counts).toMatchObject({ posts: 1, onCallWeeks: 3, prs: 0 });
    // 1 seeded incident, plus the one the "closeIncident" memory test wrote earlier in this file
    expect(sam.counts.incidents).toBeGreaterThanOrEqual(1);
    const real = await g.listPeople("acme", { persona: false });
    expect(real.every((p) => !p.persona)).toBe(true);
    expect(real.find((p) => p.uid === "Person:alice-chen")?.counts.prs).toBeGreaterThanOrEqual(3);
    expect((await g.listPeople("acme", { persona: true })).map((p) => p.uid).sort()).toEqual(
      ["Person:persona-jo-okafor", "Person:persona-max-holt", "Person:persona-priya-nair", "Person:persona-sam-rivera"],
    );
  });

  it("personActivity: posts, incidents, decisions, on-call weeks for personas; PRs for authors", async () => {
    const sam = await g.personActivity("acme", "Person:persona-sam-rivera");
    const kinds = new Set(sam.items.map((i) => i.kind));
    for (const k of ["thread", "incident", "on_call"]) expect(kinds).toContain(k);
    const ats = sam.items.map((i) => i.at);
    expect([...ats].sort((a, b) => b - a)).toEqual(ats);
    const week = sam.items.find((i) => i.kind === "on_call" && i.title.includes("2025-09-29"))!;
    expect(week.detail).toMatch(/cart/); // collapsed: one item per week, services joined
    expect(sam.items.filter((i) => i.kind === "on_call")).toHaveLength(2);
    const priya = await g.personActivity("acme", "Person:persona-priya-nair");
    expect(priya.items.find((i) => i.kind === "decision")?.uid).toBe("Decision:ADR-003");
    const max = await g.personActivity("acme", "Person:persona-max-holt");
    expect(max.items[0]).toMatchObject({ kind: "issue", uid: "Issue:ACME-142" });
    const alice = await g.personActivity("acme", "Person:alice-chen", { limit: 2 });
    expect(alice.items).toHaveLength(2);
    expect(alice.items[0]).toMatchObject({ kind: "pr", uid: "PR:140" });
    expect(alice.cypher).toHaveLength(2);
  });
});

describe("UI reads + incremental ingest", () => {
  it("overview and neighborhood use uids only", async () => {
    const o = await g.overview("acme");
    expect(o.nodes.filter((n) => n.label === "Service")).toHaveLength(9);
    expect(o.edges.filter((e) => e.type === "DEPENDS_ON")).toHaveLength(10);
    expect(o.edges.filter((e) => e.type === "OWNS")).toHaveLength(9);
    const n = await g.neighborhood("acme", "PR:140");
    expect(n.nodes.map((x) => x.id)).toEqual(expect.arrayContaining(["PR:140", "Person:alice-chen", "Service:cart"]));
    for (const e of n.edges) expect(e.source).toMatch(/:/);
  });

  it("ingestDelta adds a newer PR, derives TOUCHES, and moves the 'now'", async () => {
    const st = await g.ingestDelta("acme", fixtureDelta.nodes, fixtureDelta.edges);
    expect(st.nodes).toBe(1);
    expect(st.touches).toBe(1);
    expect(await g.newestPrAt("acme")).toBe(NEWEST + 86_400_000);
    const r = await g.runTool("suspect_changes", ctx, { service: "cart" });
    expect(r.rows[0]!.pr).toBe("PR:150");
  });
});
