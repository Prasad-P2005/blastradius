import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@blastradius/shared";
import { CloseIncidentRequestSchema } from "@blastradius/shared";
import run from "../fixtures/run.acme.json" with { type: "json" };
import { buildState } from "./run-state.ts";
import { prefillClose } from "./close-prefill.ts";

describe("prefillClose", () => {
  it("builds a valid CloseIncidentRequest from the incident fixture", () => {
    const req = prefillClose(buildState(run as unknown as AgentEvent[]))!;
    expect(CloseIncidentRequestSchema.parse(req)).toBeTruthy();
    expect(req.title).toBe("checkout 5xx at 12%");
    expect(req.service).toBe("Service:checkout");
    expect(req.causedByPr).toBe("PR:2143");
    expect(req.responders).toEqual(["Person:maya-okafor", "Person:tomas-lindqvist"]);
    expect(req.runbook.steps.length).toBeGreaterThan(3);
    expect(req.findingIds).toHaveLength(5);
  });
});
