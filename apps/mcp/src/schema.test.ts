import { describe, expect, it } from "vitest";
import { z } from "zod";
import { REL_TYPES, TOOL_NAMES, WRITE_TOOLS } from "@blastradius/shared";
import { REL_DIRECTIONS, exposedToolNames, isMemoryTool, staticSchema, toolInputShape } from "./schema.ts";

describe("tool input shapes", () => {
  it("every tool requires a tenant enum", () => {
    for (const t of TOOL_NAMES) {
      const schema = z.object(toolInputShape(t));
      expect(schema.safeParse({}).success, t).toBe(false);
      expect(schema.safeParse({ tenant: "nope" }).success, t).toBe(false);
    }
    expect(z.object(toolInputShape("critical_services")).safeParse({ tenant: "acme" }).success).toBe(true);
  });

  it("memory tools get optional sessionId and agent; others do not", () => {
    for (const t of TOOL_NAMES) {
      const shape = toolInputShape(t);
      expect("sessionId" in shape, t).toBe(isMemoryTool(t));
      expect("agent" in shape, t).toBe(isMemoryTool(t));
    }
    const rh = z.object(toolInputShape("read_handoffs"));
    expect(rh.safeParse({ tenant: "acme" }).success).toBe(true); // checked at call time instead
    expect(rh.safeParse({ tenant: "acme", sessionId: "s1", agent: "investigator" }).success).toBe(true);
    expect(rh.safeParse({ tenant: "acme", sessionId: "s1", agent: "nobody" }).success).toBe(false);
  });

  it("keeps the contract's fields", () => {
    const shape = toolInputShape("blast_radius");
    expect(Object.keys(shape).sort()).toEqual(["direction", "maxHops", "service", "tenant"]);
  });
});

describe("write gating", () => {
  it("hides write tools unless writes are allowed", () => {
    const ro = exposedToolNames(false);
    const rw = exposedToolNames(true);
    for (const w of WRITE_TOOLS) {
      expect(ro).not.toContain(w);
      expect(rw).toContain(w);
    }
    expect(rw.length).toBe(TOOL_NAMES.length);
  });
});

describe("schema resource", () => {
  it("documents a direction for exactly the contract's relationship types", () => {
    expect(Object.keys(REL_DIRECTIONS).sort()).toEqual([...REL_TYPES].sort());
  });

  it("lists exposed tools only", () => {
    const s = staticSchema(exposedToolNames(false));
    expect(s.tools.map((t) => t.name)).not.toContain("record_finding");
    expect(s.relationships.find((r) => r.type === "HANDED_TO")).toMatchObject({ from: ["Finding"], to: ["Agent"] });
  });
});
