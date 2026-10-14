/**
 * Prefill the close-incident form from a finished run (pure, unit-tested).
 *  - title: the alert/question
 *  - service: run.service (else the first Service in the impact finding)
 *  - causedByPr: first PR uid in the top `cause` finding's evidence/about
 *  - responders: Person uids from `expert` findings
 *  - runbook steps: the recalled/past incident runbook, then a step from the summary
 */
import type { CloseIncidentRequest, Finding } from "@blastradius/shared";
import { findingsOfKind, type RunState } from "./run-state.ts";

export function prefillClose(run: RunState): CloseIncidentRequest | null {
  if (!run.tenant || !run.sessionId) return null;
  const all = run.findingOrder.map((id) => run.findings[id]).filter((f): f is Finding => !!f);
  const firstUid = (fs: Finding[], prefix: string) => {
    for (const f of fs) for (const u of [...f.evidence, ...f.about]) if (u.startsWith(prefix)) return u;
    return undefined;
  };
  const cause = findingsOfKind(run, "cause");
  const experts = findingsOfKind(run, "expert");
  const summary = findingsOfKind(run, "summary")[0];
  const service = run.service ?? firstUid(findingsOfKind(run, "impact"), "Service:") ?? firstUid(all, "Service:") ?? "";
  const causedByPr = firstUid(cause, "PR:");
  const responders = [...new Set(experts.flatMap((f) => [...f.about, ...f.evidence]).filter((u) => u.startsWith("Person:")))];

  // Runbook: recalled memory first, then a past_incidents row with runbookSteps.
  let steps: string[] = [];
  let runbookTitle = "";
  const recalled = run.memories.find((m) => m.runbook && m.runbook.steps.length);
  if (recalled?.runbook) {
    steps = [...recalled.runbook.steps];
    runbookTitle = recalled.runbook.title;
  } else {
    for (const c of Object.values(run.toolCalls)) {
      if (c.tool !== "past_incidents") continue;
      const row = c.result?.rows.find((r) => Array.isArray(r.runbookSteps) && r.runbookSteps.length);
      if (row && Array.isArray(row.runbookSteps)) {
        steps = row.runbookSteps.filter((x): x is string => typeof x === "string");
        break;
      }
    }
  }
  if (causedByPr) steps = [`Roll back ${causedByPr.replace("PR:", "PR #")} and confirm the error rate recovers`, ...steps];
  if (summary) steps.push(`Follow-up: ${summary.claim}`);
  if (steps.length === 0) steps = ["Describe what fixed it"];

  const svcName = service.replace(/^Service:/, "");
  const req: CloseIncidentRequest = {
    tenant: run.tenant,
    sessionId: run.sessionId,
    title: run.question || `${svcName} incident`,
    summary: summary?.claim ?? all.map((f) => f.claim).slice(0, 3).join(" "),
    severity: "SEV2",
    service,
    responders,
    runbook: { title: runbookTitle ? `${svcName}: ${runbookTitle.replace(/^[^:]+:\s*/, "")}` : `${svcName}: recovery`, steps },
    findingIds: all.map((f) => f.id),
  };
  if (causedByPr) req.causedByPr = causedByPr;
  return req;
}
