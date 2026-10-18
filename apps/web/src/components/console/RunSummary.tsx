"use client";
/**
 * The plain-language view of one run, shown first. It answers the four
 * questions on cards (what else breaks, what caused it, who can fix it, what
 * worked last time), or the answer and its sources in Ask mode, then lists the
 * actions taken. Every card links to its evidence (the Why? drawer).
 *
 * The full agent-by-agent log (RunView) stays available underneath, collapsed,
 * for people who want to see the tool calls and Cypher.
 */
import { useState, type ReactNode } from "react";
import { AGENT_INFO, type ActionRecord, type AgentName, type Finding } from "@blastradius/shared";
import { findingsOfKind, type RunState } from "@/lib/run-state";
import { fmtMs, fmtTime, labelColor, uidKey, uidLabel } from "@/lib/format";
import { Spinner, cx } from "@/components/ui";
import { Panel, StatusIcon, StatusText } from "@/components/shell/AppShell";
import { RunView, SourcesList, type RunCallbacks } from "./RunView";

interface Question {
  kind: Finding["kind"];
  title: string;
  /** what this card is for, in one line */
  hint: string;
  agent: AgentName;
  /** a second finding kind shown under the main one */
  extra?: Finding["kind"];
}

const INCIDENT_QUESTIONS: Question[] = [
  { kind: "impact", extra: "risk", title: "What else breaks?", hint: "Services that depend on this one, ranked by how central they are", agent: "triage" },
  { kind: "cause", title: "What probably caused it?", hint: "Recent changes to this service or what it depends on", agent: "investigator" },
  { kind: "expert", title: "Who can fix it?", hint: "People who know this code best, and who is on call", agent: "expert" },
  { kind: "precedent", title: "What worked last time?", hint: "Similar past incidents and the runbook that fixed them", agent: "investigator" },
];

const STEPS: Record<"incident" | "ask", { agent: AgentName; label: string }[]> = {
  incident: [
    { agent: "triage", label: "Map the impact" },
    { agent: "investigator", label: "Find the cause" },
    { agent: "expert", label: "Find who can fix it" },
    { agent: "scribe", label: "Write it up" },
  ],
  ask: [{ agent: "navigator", label: "Search the company's knowledge" }],
};

export interface RunSummaryProps {
  run: RunState;
  cb: RunCallbacks;
  isLatest: boolean;
  /** display name for a uid, from the graph data the console already has */
  nameOf: (uid: string) => string | undefined;
  /** the "Close incident" call to action, when it applies */
  next?: ReactNode;
}

export function RunSummary({ run, cb, isLatest, nameOf, next }: RunSummaryProps) {
  const [showLog, setShowLog] = useState(false);
  const mode = run.mode ?? "incident";
  const running = run.status === "running" || run.status === "idle";
  const actions = run.actionOrder.map((id) => run.actions[id]).filter((a): a is ActionRecord => !!a);
  const fatal = run.errors.find((e) => e.fatal);

  return (
    <div className="animate-slide-in flex flex-col gap-4">
      {/* ── what was asked, and where the run is ── */}
      <Panel
        title={<span className="text-base">{run.question || "…"}</span>}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{mode === "ask" ? "Question to the company" : "Alert investigation"}</span>
            {run.service && <span>Service: {nameOf(run.service) ?? uidKey(run.service)}</span>}
            {run.startedAt && <span>Started {fmtTime(run.startedAt)}</span>}
          </span>
        }
        actions={<RunStatus run={run} />}
      >
        <Steps run={run} mode={mode} />
      </Panel>

      {fatal && (
        <div className="flex gap-2 rounded-xl border border-bad/30 bg-[#fff7f7] px-4 py-3 text-sm">
          <StatusIcon tone="bad" />
          <div>
            <div className="font-semibold text-bad">The investigation stopped</div>
            <div className="mt-0.5 text-fg-2">{fatal.message}</div>
          </div>
        </div>
      )}

      {/* ── the answers ── */}
      {mode === "incident" ? (
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
          {INCIDENT_QUESTIONS.map((q, i) => (
            <AnswerCard key={q.kind} n={i + 1} q={q} run={run} cb={cb} nameOf={nameOf} running={running} />
          ))}
        </div>
      ) : (
        <AskAnswer run={run} cb={cb} running={running} />
      )}

      {run.memories.length > 0 && <MemoryNote run={run} />}

      {actions.length > 0 && <ActionsTable actions={actions} run={run} cb={cb} />}

      {next}

      {/* ── the full log, for the curious ── */}
      <div className="rounded-xl border border-line-2/50 bg-panel">
        <button type="button" onClick={() => setShowLog((v) => !v)} className="flex w-full items-center gap-2 px-5 py-3 text-left" aria-expanded={showLog}>
          <span className={cx("text-muted transition-transform", showLog && "rotate-90")}>▸</span>
          <span className="text-sm font-bold text-fg">How the agents worked it out</span>
          <span className="text-sm text-muted">
            {Object.keys(run.agents).length} agents · {Object.keys(run.toolCalls).length} graph queries · every step with its exact Cypher
          </span>
        </button>
        {showLog && (
          <div className="border-t border-line bg-panel-2 px-4 py-4">
            <RunView run={run} cb={cb} isLatest={isLatest} />
          </div>
        )}
      </div>
    </div>
  );
}

function RunStatus({ run }: { run: RunState }) {
  if (run.status === "running" || run.status === "idle")
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-accent">
        <Spinner /> In progress
      </span>
    );
  if (run.status === "ok") return <StatusText tone="ok">Completed in {fmtMs(run.ms)}</StatusText>;
  if (run.status === "aborted") return <StatusText tone="warn">Stopped</StatusText>;
  return <StatusText tone="bad">Failed</StatusText>;
}

/** Progress through the agents, like the steps of an AWS wizard. */
function Steps({ run, mode }: { run: RunState; mode: "incident" | "ask" }) {
  const steps = STEPS[mode];
  return (
    <ol className="flex flex-wrap gap-x-6 gap-y-2">
      <StepItem done={run.timeline.some((t) => t.kind === "memory") || run.status !== "running"} active={false} label="Recall past incidents" by="Memory" />
      {steps.map((s) => {
        const a = run.agents[s.agent];
        return <StepItem key={s.agent} done={a?.status === "done"} active={a?.status === "running"} label={s.label} by={AGENT_INFO[s.agent].title} />;
      })}
    </ol>
  );
}

function StepItem({ done, active, label, by }: { done: boolean; active: boolean; label: string; by: string }) {
  return (
    <li className="flex items-center gap-2">
      {done ? <StatusIcon tone="ok" /> : active ? <Spinner /> : <span className="size-4 rounded-full border-2 border-line-2" />}
      <span>
        <span className={cx("block text-sm", done || active ? "font-semibold text-fg" : "text-muted")}>{label}</span>
        <span className="block text-xs text-faint">{by} agent</span>
      </span>
    </li>
  );
}

function Confidence({ value }: { value: number }) {
  const level = value >= 0.75 ? "High" : value >= 0.5 ? "Medium" : "Low";
  const style = value >= 0.75 ? "bg-[#e9f6e9] text-ok" : value >= 0.5 ? "bg-[#fff7e0] text-warn" : "bg-[#fff1f1] text-bad";
  return (
    <span className={cx("rounded-full px-2 py-0.5 text-xs font-semibold", style)} title={`The agent's confidence: ${Math.round(value * 100)}%`}>
      {level} confidence
    </span>
  );
}

const CHIP_LABELS = new Set(["Service", "PR", "Person", "Incident", "Runbook", "Decision", "Doc", "Thread", "Issue"]);

/** A friendly link to a graph node: "PR #135", "Maya Patel", "payments". */
function EntityChip({ uid, nameOf, onClick }: { uid: string; nameOf: (uid: string) => string | undefined; onClick: (uid: string) => void }) {
  const label = uidLabel(uid) ?? "";
  const key = uidKey(uid);
  const text = label === "PR" ? `PR #${key}` : (nameOf(uid) ?? key.replace(/^persona-/, "").replace(/-/g, " "));
  const kind = label === "PR" ? "Change" : label === "Person" ? "Person" : label === "Service" ? "Service" : label;
  return (
    <button
      type="button"
      onClick={() => onClick(uid)}
      title={label === "Person" ? "Open their profile" : "Show on the service map"}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line-2 bg-panel px-2.5 py-0.5 text-xs hover:border-accent hover:text-accent"
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: labelColor(label) }} />
      <span className="text-faint">{kind}</span>
      <span className="truncate font-semibold text-fg-2">{text}</span>
    </button>
  );
}

function AnswerCard({ n, q, run, cb, nameOf, running }: { n: number; q: Question; run: RunState; cb: RunCallbacks; nameOf: (uid: string) => string | undefined; running: boolean }) {
  const f = findingsOfKind(run, q.kind)[0];
  const extra = q.extra ? findingsOfKind(run, q.extra)[0] : undefined;
  const agent = run.agents[q.agent];
  const chips = f ? [...new Set([...f.evidence, ...f.about])].filter((u) => CHIP_LABELS.has(uidLabel(u) ?? "")).slice(0, 5) : [];
  return (
    <section className="flex flex-col rounded-xl border border-line-2/50 bg-panel shadow-[0_1px_3px_rgba(0,7,22,0.08)]">
      <header className="flex items-start gap-3 px-5 pt-4">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#f0f7ff] text-sm font-bold text-accent">{n}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-fg">{q.title}</h3>
          <p className="text-xs text-muted">{q.hint}</p>
        </div>
        {f && <Confidence value={f.confidence} />}
      </header>
      <div className="flex-1 px-5 pt-3 pb-4">
        {f ? (
          <>
            <p className="text-[15px] leading-relaxed text-fg">{f.claim}</p>
            {extra && <p className="mt-2 text-sm leading-relaxed text-muted">{extra.claim}</p>}
            {chips.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {chips.map((u) => (
                  <EntityChip key={u} uid={u} nameOf={nameOf} onClick={cb.onUid} />
                ))}
              </div>
            )}
          </>
        ) : running && agent?.status !== "done" ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> {agent ? `${AGENT_INFO[q.agent].title} agent is working on it…` : "Waiting for the previous step…"}
          </p>
        ) : (
          <p className="text-sm text-muted">No answer found in the graph for this question.</p>
        )}
      </div>
      {f && (
        <footer className="border-t border-line px-5 py-2.5">
          <button type="button" onClick={() => cb.onWhy([f.id, ...(extra ? [extra.id] : [])], f.id)} className="text-sm font-semibold text-accent hover:underline">
            Why? See the evidence →
          </button>
          <span className="ml-2 text-xs text-faint">the exact graph query and path behind this answer</span>
        </footer>
      )}
    </section>
  );
}

function AskAnswer({ run, cb, running }: { run: RunState; cb: RunCallbacks; running: boolean }) {
  const answers = findingsOfKind(run, "answer");
  const nav = run.agents.navigator;
  const text = answers[0]?.claim ?? nav?.messages.at(-1)?.text;
  return (
    <Panel
      title="Answer"
      description="Written from the company's own decisions, docs, tickets and chat threads"
      actions={answers[0] ? <Confidence value={answers[0].confidence} /> : undefined}
    >
      {text ? (
        <>
          <p className="text-[15px] leading-relaxed text-fg">{text}</p>
          {answers.slice(1).map((a) => (
            <p key={a.id} className="mt-2 text-sm leading-relaxed text-fg-2">
              {a.claim}
            </p>
          ))}
          {answers[0] && (
            <button type="button" onClick={() => cb.onWhy(answers.map((a) => a.id))} className="mt-3 text-sm font-semibold text-accent hover:underline">
              Why? See the evidence →
            </button>
          )}
        </>
      ) : running ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> Searching decisions, docs, tickets and threads…
        </p>
      ) : (
        <p className="text-sm text-muted">No answer found.</p>
      )}
      {nav && (
        <div className="mt-4 -mx-3">
          <SourcesList run={run} agent={nav} cb={cb} />
        </div>
      )}
    </Panel>
  );
}

function MemoryNote({ run }: { run: RunState }) {
  const incidents = run.memories.filter((m) => m.kind === "incident").length;
  const findings = run.memories.length - incidents;
  return (
    <div className="flex items-start gap-2 rounded-xl border border-[#b8d8f8] bg-[#f0f7ff] px-4 py-3 text-sm text-fg-2">
      <StatusIcon tone="info" />
      <span>
        <span className="font-semibold text-fg">Recalled from memory: </span>
        {incidents > 0 && `${incidents} past incident${incidents === 1 ? "" : "s"}`}
        {incidents > 0 && findings > 0 && " and "}
        {findings > 0 && `${findings} finding${findings === 1 ? "" : "s"} from earlier investigations`}. The agents used these before starting. Open “How the agents worked it out” to read them.
      </span>
    </div>
  );
}

const ACTION_KIND: Record<string, string> = { github_issue: "GitHub issue", rollback_pr: "Rollback pull request", webhook: "Team chat message" };

function ActionsTable({ actions, run, cb }: { actions: ActionRecord[]; run: RunState; cb: RunCallbacks }) {
  const anyDry = actions.some((a) => a.status === "dry_run");
  return (
    <Panel
      title={`Actions taken (${actions.length})`}
      description={anyDry ? "Dry run: GitHub and chat aren't connected, so each action shows exactly what it would send. All actions are audit-logged." : "Sent to the sandbox repository and team chat. All actions are audit-logged."}
      bodyClassName="p-0"
    >
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs font-bold text-fg-2">
            <th className="w-52 px-5 py-2">Action</th>
            <th className="w-32 px-3 py-2">Status</th>
            <th className="px-3 py-2">Details</th>
            <th className="w-24 px-5 py-2 text-right" />
          </tr>
        </thead>
        <tbody>
          {actions.map((a) => (
            <tr key={a.id} className="border-b border-line last:border-b-0">
              <td className="px-5 py-2.5 font-semibold whitespace-nowrap text-fg">{ACTION_KIND[a.kind] ?? a.kind}</td>
              <td className="px-3 py-2.5 whitespace-nowrap">
                {a.status === "done" ? <StatusText tone="ok">Sent</StatusText> : a.status === "dry_run" ? <StatusText tone="info">Dry run</StatusText> : <StatusText tone="bad">Failed</StatusText>}
              </td>
              <td className="px-3 py-2.5">
                <div className="truncate text-fg-2" title={a.title}>
                  {a.title}
                </div>
                {a.error && <div className="truncate text-xs text-bad">{a.error}</div>}
              </td>
              <td className="px-5 py-2.5 text-right whitespace-nowrap">
                {a.url ? (
                  <a href={a.url} target="_blank" rel="noreferrer" className="font-semibold text-accent hover:underline">
                    Open ↗
                  </a>
                ) : (
                  a.findingIds.length > 0 && (
                    <button type="button" className="font-semibold text-accent hover:underline" onClick={() => cb.onWhy(a.findingIds.filter((id) => run.findings[id]))}>
                      View
                    </button>
                  )
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
