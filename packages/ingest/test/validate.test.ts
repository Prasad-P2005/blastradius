import { describe, expect, it } from "vitest";
import type { Scenario, Snapshot, SnapshotEdge, SnapshotNode } from "@blastradius/shared";
import { emailErrors, validateGraph, validateScenarios, validateSnapshot } from "../src/validate.ts";
import { isoDate, mondayOf } from "../src/time.ts";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const MON = mondayOf(NOW);
const T = 1_760_000_000_000;

function base(): { nodes: SnapshotNode[]; edges: SnapshotEdge[] } {
  const svc = (slug: string): SnapshotNode => ({ label: "Service", uid: `Service:${slug}`, props: { name: slug, slug, language: "go", kind: "service", repoPath: `src/${slug}`, description: "d", tier: 1, synthetic: false } });
  return {
    nodes: [
      svc("checkout"), svc("cart"), svc("frontend"),
      { label: "PR", uid: "PR:1", props: { number: 1, title: "t", sha: "a".repeat(40), mergedAt: T, additions: 1, deletions: 0, filesChanged: 1, url: "u", isBot: false, authorName: "Jane Doe", synthetic: false } },
      { label: "Person", uid: "Person:jane-doe", props: { name: "Jane Doe", slug: "jane-doe", isBot: false, prCount: 1, firstSeenAt: T, lastSeenAt: T, synthetic: false } },
      { label: "Team", uid: "Team:core", props: { name: "Core", slug: "core", slack: "#core", synthetic: true } },
      { label: "Incident", uid: "Incident:INC-1", props: { key: "INC-1", title: "t", summary: "s", rootCause: "r", severity: "SEV2", status: "resolved", startedAt: T, resolvedAt: T + 1, synthetic: true } },
    ],
    edges: [
      { type: "DEPENDS_ON", from: "Service:frontend", to: "Service:checkout", props: { protocol: "grpc", source: "compose.yaml" } },
      { type: "DEPENDS_ON", from: "Service:checkout", to: "Service:cart", props: { protocol: "grpc", source: "compose.yaml" } },
      { type: "AUTHORED", from: "Person:jane-doe", to: "PR:1" },
      { type: "OWNS", from: "Team:core", to: "Service:checkout" },
      { type: "ON_CALL_FOR", from: "Person:jane-doe", to: "Service:checkout", props: { weekStart: isoDate(MON), weekStartTs: MON } },
      { type: "AFFECTED", from: "Incident:INC-1", to: "Service:checkout" },
    ],
  };
}

describe("validateGraph", () => {
  it("accepts a valid graph", () => {
    const g = base();
    expect(validateGraph(g.nodes, g.edges, { now: NOW })).toEqual([]);
  });
  it("catches dangling edges, bad labels, duplicate uids and uid/key mismatch", () => {
    const g = base();
    g.edges.push({ type: "AUTHORED", from: "Person:ghost", to: "PR:1" });
    g.nodes.push({ ...g.nodes[0]! });
    g.nodes.push({ label: "Nope" as never, uid: "Nope:x", props: { synthetic: true } });
    g.nodes.push({ label: "PR", uid: "PR:2", props: { ...g.nodes[3]!.props } });
    const errs = validateGraph(g.nodes, g.edges, { now: NOW }).join("\n");
    expect(errs).toMatch(/missing from-node Person:ghost/);
    expect(errs).toMatch(/duplicate uid Service:checkout/);
    expect(errs).toMatch(/label Nope not in whitelist/);
    expect(errs).toMatch(/PR:2: number=1 does not match/);
  });
  it("requires synthetic, required props, integer *At and allowed edge shapes", () => {
    const g = base();
    delete g.nodes[4]!.props.synthetic;
    delete g.nodes[3]!.props.title;
    g.nodes[6]!.props.startedAt = "2026-01-01";
    g.edges.push({ type: "OWNS", from: "Service:cart", to: "Service:checkout" });
    g.edges.push({ type: "TOUCHES", from: "PR:1", to: "Service:cart" });
    const errs = validateGraph(g.nodes, g.edges, { now: NOW }).join("\n");
    expect(errs).toMatch(/Person:jane-doe: synthetic must be a boolean/);
    expect(errs).toMatch(/PR:1: missing title/);
    expect(errs).toMatch(/startedAt must be epoch-ms/);
    expect(errs).toMatch(/OWNS: Service→Service not allowed/);
    expect(errs).toMatch(/TOUCHES .* derived at load time/);
  });
  it("checks on-call coverage of the current week and Monday weekStarts", () => {
    const g = base();
    g.edges = g.edges.filter((e) => e.type !== "ON_CALL_FOR");
    g.edges.push({ type: "ON_CALL_FOR", from: "Person:jane-doe", to: "Service:checkout", props: { weekStart: "2026-10-14", weekStartTs: Date.parse("2026-10-14T00:00:00Z") } });
    const errs = validateGraph(g.nodes, g.edges, { now: NOW }).join("\n");
    expect(errs).toMatch(/bad weekStart 2026-10-14/);
    expect(errs).toMatch(/nobody on call for Service:checkout/);
  });
});

describe("email scan", () => {
  it("fails on emails anywhere, tolerates image-density file names", () => {
    expect(emailErrors('{"title":"ping jane.doe@example.com"}')).toHaveLength(1);
    expect(emailErrors('{"path":"src/react-native-app/assets/App-Icon-1024x1024@1x.png"}')).toEqual([]);
    expect(emailErrors('{"x":"@mention and foo@bar"}')).toEqual([]);
  });
  it("validateSnapshot includes the scan and source checks", () => {
    const g = base();
    const snap: Snapshot = { tenant: "acme", generatedAt: new Date(T).toISOString(), seed: 1, sources: [{ repo: "r", url: "u", sha: "b".repeat(40), license: "Apache-2.0" }], ...g };
    expect(validateSnapshot(snap, JSON.stringify(snap), { now: NOW })).toEqual([]);
    expect(validateSnapshot(snap, JSON.stringify(snap) + "a@b.io", { now: NOW }).join()).toMatch(/email/);
  });
});

describe("validateScenarios", () => {
  const g = base();
  const snap: Snapshot = { tenant: "acme", generatedAt: "2026-01-01T00:00:00Z", seed: 1, sources: [], ...g };
  const inc = (id: string): Scenario => ({
    id, tenant: "acme", title: "t", mode: "incident", question: "q", presenterNote: "n",
    alert: { service: "cart" },
    expected: { blastRadius: ["Service:checkout", "Service:frontend"], suspectPr: "PR:1", expert: "Person:jane-doe", pastIncident: "Incident:INC-1" },
  });
  const ask: Scenario = { id: "a", tenant: "acme", title: "t", mode: "ask", question: "q", presenterNote: "n", expected: { sources: ["Incident:INC-1"] } };
  it("accepts valid scenarios", () => {
    expect(validateScenarios([inc("1"), inc("2"), inc("3"), ask], { acme: snap })).toEqual([]);
  });
  it("flags missing references, too few scenarios and duplicates", () => {
    const bad = inc("1");
    bad.expected!.suspectPr = "PR:999";
    const errs = validateScenarios([bad, inc("1")], { acme: snap }).join("\n");
    expect(errs).toMatch(/suspectPr PR:999 not in acme snapshot/);
    expect(errs).toMatch(/duplicate id/);
    expect(errs).toMatch(/needs ≥3 incident scenarios/);
    expect(errs).toMatch(/needs ≥1 ask scenario/);
  });
});
