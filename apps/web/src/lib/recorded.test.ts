/**
 * Regression test on a stream RECORDED from the real pipeline (scripted mode, acme
 * "Checkout 5xx at 12%", replayed from Postgres via /api/sessions/[id]/messages).
 * Guards the contract the Why? drawer depends on: every claim resolves to findings
 * and every finding's cypher[] matches a tool_result by exact string.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@blastradius/shared";
import recorded from "../fixtures/recorded.acme.checkout.json" with { type: "json" };
import { buildSession, evidenceForFinding, findingsForClaim } from "./run-state.ts";
import { prefillClose } from "./close-prefill.ts";

const events = recorded as unknown as AgentEvent[];

describe("recorded real run", () => {
  const [run] = buildSession(events);

  it("finishes ok with findings, handoffs and actions", () => {
    expect(run!.status).toBe("ok");
    expect(run!.findingOrder.length).toBeGreaterThan(3);
    expect(run!.handoffs.length).toBeGreaterThan(2);
    expect(run!.actionOrder.length).toBeGreaterThan(0);
  });

  it("links every claim to findings", () => {
    expect(run!.claimOrder.length).toBeGreaterThan(0);
    for (const id of run!.claimOrder) expect(findingsForClaim(run!, id).length).toBe(run!.claims[id]!.findingIds.length);
  });

  it("matches every finding's cypher to a tool_result", () => {
    for (const id of run!.findingOrder) {
      for (const ev of evidenceForFinding(run!, run!.findings[id]!)) expect(ev.call, ev.cypher.slice(0, 60)).not.toBeNull();
    }
  });

  it("prefills the close form with the suspect PR", () => {
    const req = prefillClose(run!)!;
    expect(req.service).toBe("Service:checkout");
    expect(req.causedByPr).toMatch(/^PR:\d+$/);
    expect(req.runbook.steps.length).toBeGreaterThan(1);
  });
});
