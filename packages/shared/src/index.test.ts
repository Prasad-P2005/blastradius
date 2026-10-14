import { describe, expect, it } from "vitest";
import {
  AGENT_TOOLS,
  REL_TYPES,
  TOOL_NAMES,
  ToolInputSchemas,
  assertLabel,
  cosineDistanceToSimilarity,
  graphName,
  parseUid,
  serviceUid,
  slugify,
  uid,
} from "./index.ts";
import { parseDotenv } from "./env.ts";

describe("ids", () => {
  it("builds and parses uids", () => {
    expect(uid("Service", "checkout")).toBe("Service:checkout");
    expect(parseUid("PR:4087")).toEqual({ label: "PR", key: "4087" });
    expect(parseUid("File:src/cart/a:b.ts")).toEqual({ label: "File", key: "src/cart/a:b.ts" });
    expect(parseUid("Nope:x")).toBeNull();
    expect(serviceUid("checkout")).toBe("Service:checkout");
    expect(serviceUid("Service:checkout")).toBe("Service:checkout");
  });
  it("slugifies deterministically", () => {
    expect(slugify("Jane O'Neil")).toBe("jane-o-neil");
    expect(slugify("  Zoë  Ångström ")).toBe("zoe-angstrom");
  });
  it("whitelists labels", () => {
    expect(() => assertLabel("Service) DETACH DELETE (n")).toThrow();
  });
  it("names graphs per tenant", () => {
    expect(graphName("acme")).toBe("blastradius_acme");
  });
});

describe("tools", () => {
  it("has a schema for every tool and every allowed tool exists", () => {
    for (const t of TOOL_NAMES) expect(ToolInputSchemas[t]).toBeDefined();
    for (const tools of Object.values(AGENT_TOOLS)) for (const t of tools) expect(TOOL_NAMES).toContain(t);
  });
  it("applies defaults", () => {
    expect(ToolInputSchemas.blast_radius.parse({ service: "cart" })).toEqual({
      service: "cart",
      maxHops: 3,
      direction: "dependents",
    });
  });
  it("exposes zod shapes for MCP", () => {
    expect(Object.keys(ToolInputSchemas.explain_path.shape)).toEqual(["from", "to", "maxHops"]);
  });
  it("has 27 relationship types", () => {
    expect(REL_TYPES.length).toBe(27);
  });
});

describe("misc", () => {
  it("converts cosine distance to similarity", () => {
    expect(cosineDistanceToSimilarity(0)).toBe(1);
    expect(cosineDistanceToSimilarity(0.25)).toBe(0.75);
    expect(cosineDistanceToSimilarity(1.6)).toBe(0);
  });
  it("parses dotenv", () => {
    expect(parseDotenv('A=1\n# c\nexport B="x y"\nC=z # tail\n')).toEqual({ A: "1", B: "x y", C: "z" });
  });
});
