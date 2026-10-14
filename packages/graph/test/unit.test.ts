/**
 * Unit tests (no database): the converter, the hash embedder and the Cypher
 * builders.
 */
import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM } from "@blastradius/shared";
import { pathsFromRaw, toGEdge, toGNode, toGraphPath, toPlain } from "../src/convert.ts";
import { fnv1a, hashEmbed, tokenize, vecParam } from "../src/embed.ts";
import { edgeUpsertCypher, embedText, nodeUpsertCypher, touchesCypher } from "../src/load.ts";
import { schemaStatements } from "../src/schema.ts";
import { blastRadiusCypher } from "../src/tools/impact.ts";
import { suspectChangesCypher } from "../src/tools/changes.ts";
import { explainPathCypher, searchNodesCypher } from "../src/tools/context.ts";
import { askCompanyCypher } from "../src/tools/brain.ts";
import { fulltextQuery, reportedParams } from "../src/tools/common.ts";
import { recallMemoryCypher, recordFindingCypher } from "../src/memory.ts";

// Shapes exactly as the falkordb client returns them.
const nA = { id: 7, labels: ["Service"], properties: { uid: "Service:cart", name: "cart", embedding: [0.1, 0.2] } };
const nB = { id: 3, labels: ["Service"], properties: { uid: "Service:valkey-cart", name: "valkey-cart" } };
const eAB = { id: 11, relationshipType: "DEPENDS_ON", sourceId: 7, destinationId: 3, properties: { protocol: "redis" } };

describe("converter", () => {
  it("nodes become uid-keyed GNodes without embeddings", () => {
    const n = toGNode(nA);
    expect(n).toEqual({ id: "Service:cart", label: "Service", name: "cart", props: { uid: "Service:cart", name: "cart" } });
  });
  it("edges reference uids, never internal ids", () => {
    const e = toGEdge(eAB, new Map([[7, "Service:cart"], [3, "Service:valkey-cart"]]));
    expect(e).toEqual({
      id: "Service:cart-DEPENDS_ON->Service:valkey-cart",
      source: "Service:cart",
      target: "Service:valkey-cart",
      type: "DEPENDS_ON",
      props: { protocol: "redis" },
    });
  });
  it("parallel ON_CALL_FOR edges stay distinct by weekStart", () => {
    const e = toGEdge({ ...eAB, relationshipType: "ON_CALL_FOR", properties: { weekStart: "2025-09-29" } }, new Map([[7, "a"], [3, "b"]]));
    expect(e.id).toBe("a-ON_CALL_FOR->b#2025-09-29");
  });
  it("paths keep order and direction (reverse edges too)", () => {
    const p = toGraphPath({ nodes: [nB, nA], edges: [eAB] });
    expect(p.nodes.map((n) => n.id)).toEqual(["Service:valkey-cart", "Service:cart"]);
    expect(p.edges[0]!.source).toBe("Service:cart");
    expect(JSON.stringify(p)).not.toMatch(/"(sourceId|destinationId)"/);
  });
  it("toPlain flattens nested values and drops embeddings", () => {
    expect(toPlain({ a: [nA], m: { x: 1, embedding: [1] }, n: NaN })).toEqual({
      a: [{ uid: "Service:cart", label: "Service", name: "cart", props: { uid: "Service:cart", name: "cart" } }],
      m: { x: 1 },
      n: null,
    });
  });
  it("pathsFromRaw finds paths in chosen columns (incl. lists) and de-duplicates", () => {
    const path = { nodes: [nA, nB], edges: [eAB] };
    const ps = pathsFromRaw([{ p: path, ps: [path, path], other: path }], ["p", "ps"]);
    expect(ps).toHaveLength(1);
  });
});

describe("hash embedder", () => {
  it("is deterministic, 384-dim and L2-normalised", () => {
    const a = hashEmbed("Cart 5xx after Valkey connection exhaustion");
    const b = hashEmbed("Cart 5xx after Valkey connection exhaustion");
    expect(a).toEqual(b);
    expect(a).toHaveLength(EMBEDDING_DIM);
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
  });
  it("is case-insensitive and similar texts score higher", () => {
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(hashEmbed("VALKEY Pool")).toEqual(hashEmbed("valkey pool"));
    const q = hashEmbed("valkey connection pool exhausted");
    expect(dot(q, hashEmbed("cart valkey connection pool too small"))).toBeGreaterThan(dot(q, hashEmbed("frontend css redesign")));
  });
  it("has stable hashes and handles empty text", () => {
    expect(fnv1a("cart")).toBe(fnv1a("cart"));
    expect(tokenize("Hello, World-42")).toEqual(["hello", "world", "42"]);
    expect(Math.hypot(...hashEmbed(""))).toBeCloseTo(1);
  });
  it("vecParam avoids exponent notation", () => {
    expect(vecParam([1.5e-7, 0.1234567891]).map(String)).toEqual(["0", "0.123457"]);
  });
});

describe("cypher builders", () => {
  it("only whitelisted labels / types are interpolated", () => {
    expect(() => nodeUpsertCypher("Bogus" as never)).toThrow(/whitelist/);
    expect(() => edgeUpsertCypher("DROP", "Service", "Service")).toThrow(/whitelist/);
    expect(() => explainPathCypher("Service", "x) DETACH DELETE (n" as never, 3)).toThrow();
  });
  it("ON_CALL_FOR merges on weekStart; other types do not", () => {
    expect(edgeUpsertCypher("ON_CALL_FOR", "Person", "Service")).toContain("MERGE (a)-[r:ON_CALL_FOR {weekStart: row.props.weekStart}]->(b)");
    expect(edgeUpsertCypher("DEPENDS_ON", "Service", "Service")).toContain("MERGE (a)-[r:DEPENDS_ON]->(b)");
  });
  it("hop caps are validated integers", () => {
    expect(blastRadiusCypher(3, "dependents")).toContain("(svc)-[:DEPENDS_ON*1..3]->(s)");
    expect(blastRadiusCypher(2, "dependencies")).toContain("(s)-[:DEPENDS_ON*1..2]->(svc)");
    expect(() => blastRadiusCypher(7, "both")).toThrow();
    expect(suspectChangesCypher(0)).toContain("DEPENDS_ON*0..0");
  });
  it("search_nodes and ask_company union one CALL per label", () => {
    const s = searchNodesCypher(["Service", "PR"]);
    expect(s.match(/db\.idx\.fulltext\.queryNodes/g)).toHaveLength(2);
    expect(s).toContain("UNION ALL");
    expect(askCompanyCypher(["Incident", "Doc", "Thread"]).match(/vector\.queryNodes/g)).toHaveLength(3);
  });
  it("recall_memory includes only the branches that apply and always excludes the session", () => {
    expect(recallMemoryCypher(true, false)).not.toContain("vector");
    expect(recallMemoryCypher(false, true)).not.toContain("$service");
    expect(recallMemoryCypher(true, true).match(/\$sessionId IS NULL OR/g)).toHaveLength(4);
  });
  it("record_finding links per label and only hands off when asked", () => {
    const c = recordFindingCypher(new Map([["Service", ["Service:cart"]]]), new Map(), false);
    expect(c).toContain("OPTIONAL MATCH (t0:Service) WHERE t0.uid IN $about_Service");
    expect(c).not.toContain("HANDED_TO");
    expect(recordFindingCypher(new Map(), new Map(), true)).toContain("HANDED_TO");
  });
  it("schema has range, full-text (multi-property) and vector indexes", () => {
    const s = schemaStatements();
    expect(s).toContain("CREATE INDEX FOR (n:Service) ON (n.uid)");
    expect(s).toContain("CREATE FULLTEXT INDEX FOR (n:Service) ON (n.name, n.slug, n.description)");
    expect(s.filter((x) => x.startsWith("CREATE VECTOR INDEX"))).toHaveLength(6);
  });
  it("misc helpers", () => {
    expect(touchesCypher(true)).toContain("UNWIND $prs");
    expect(embedText("Incident", { title: "T", summary: "S", rootCause: null })).toBe("T\nS");
    expect(fulltextQuery("Why the Valkey pool?")).toBe("valkey | valkey* | pool | pool*");
    expect(reportedParams({ vec: [1, 2], text: "x" })).toEqual({ vec: "<2-dim embedding of $text>", text: "x" });
  });
});
