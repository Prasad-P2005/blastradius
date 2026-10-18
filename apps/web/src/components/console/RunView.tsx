"use client";
/**
 * One run rendered as a chat timeline: user message → recalled memory →
 * one card per agent (tool calls, findings, handoffs, messages with Why? chips)
 * → actions → errors → final status. Pure view over RunState.
 */
import { useState } from "react";
import { AGENT_INFO, type ActionRecord, type Finding, type RecalledMemory } from "@blastradius/shared";
import type { AgentView, RunState, ToolCallView } from "@/lib/run-state";
import { compactInput, fmtMs, fmtTime, labelColor } from "@/lib/format";
import { ConfidenceBar, CypherBlock, PathChain, RowsTable, Spinner, StatusPill, UidPill, WhyChip, cx } from "@/components/ui";

export interface RunCallbacks {
  onWhy: (findingIds: string[], focusFindingId?: string) => void;
  onUid: (uid: string) => void;
}

const AGENT_ACCENT: Record<string, string> = {
  triage: "#60a5fa",
  investigator: "#f59e0b",
  expert: "#34d399",
  scribe: "#2dd4bf",
  navigator: "#c084fc",
};

const KIND_LABEL: Record<string, string> = {
  impact: "impact",
  cause: "cause",
  expert: "expert",
  precedent: "precedent",
  answer: "answer",
  summary: "summary",
  risk: "risk",
  action: "action",
};

export function RunView({ run, cb, isLatest }: { run: RunState; cb: RunCallbacks; isLatest: boolean }) {
  return (
    <div className="flex flex-col gap-2.5">
      {run.timeline.map((item) => {
        switch (item.kind) {
          case "user":
            return <UserBubble key={`u${item.seq}`} run={run} />;
          case "memory":
            return <MemoryCard key={`m${item.seq}`} memories={run.memories} cb={cb} />;
          case "agent": {
            const a = run.agents[item.agent];
            return a ? <AgentCard key={`a${item.agent}`} run={run} agent={a} cb={cb} /> : null;
          }
          case "actions":
            return <ActionsCard key={`x${item.seq}`} actions={run.actionOrder.map((id) => run.actions[id]!).filter(Boolean)} run={run} cb={cb} />;
          case "error": {
            const e = run.errors[item.index];
            return e ? (
              <div key={`e${item.seq}`} className="animate-slide-in rounded-md border border-bad/40 bg-bad/[0.07] px-3 py-2">
                <div className="flex items-center gap-2 text-xs font-medium text-bad">
                  <span className="rounded bg-bad/20 px-1 font-mono text-2xs uppercase">{e.where}</span>
                  {e.fatal ? "Fatal error" : "Error"}
                  {e.agent && <span className="text-bad/70">in {AGENT_INFO[e.agent]?.title ?? e.agent}</span>}
                </div>
                <div className="mt-1 font-mono text-xs break-words text-bad/90">{e.message}</div>
              </div>
            ) : null;
          }
          case "finished":
            return <FinishedRow key={`f${item.seq}`} run={run} />;
        }
      })}
      {isLatest && run.status === "running" && (
        <div className="flex items-center gap-2 px-1 text-xs text-faint">
          <Spinner /> streaming…
        </div>
      )}
    </div>
  );
}

function UserBubble({ run }: { run: RunState }) {
  return (
    <div className="animate-slide-in flex justify-end">
      <div className="max-w-[88%] rounded-lg rounded-br-sm border border-accent/25 bg-accent/10 px-3 py-2">
        <div className="text-sm text-fg">{run.question}</div>
        <div className="mt-1 flex items-center justify-end gap-2 font-mono text-2xs text-faint">
          {run.mode === "ask" ? "ask the company" : "incident"}
          {run.service && <span>· {run.service}</span>}
          <span>· {fmtTime(run.startedAt)}</span>
        </div>
      </div>
    </div>
  );
}

function CardShell({ accent, children, className }: { accent: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("animate-slide-in relative overflow-hidden rounded-md border border-line bg-panel", className)}>
      <div className="absolute inset-y-0 left-0 w-[2px]" style={{ background: accent }} />
      {children}
    </div>
  );
}

function MemoryCard({ memories, cb }: { memories: RecalledMemory[]; cb: RunCallbacks }) {
  return (
    <CardShell accent={labelColor("Episode")}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="text-xs font-semibold text-fg">Recalled memory</span>
        <span className="text-2xs text-faint">from earlier sessions · recall_memory</span>
        <span className="ml-auto font-mono text-2xs text-muted">{memories.length}</span>
      </div>
      {memories.length === 0 ? (
        <div className="px-3 py-2 text-xs text-faint">Nothing relevant in memory yet. Close an incident to teach it.</div>
      ) : (
        <div className="flex flex-col divide-y divide-line">
          {memories.map((m) => (
            <MemoryRow key={m.uid} m={m} cb={cb} />
          ))}
        </div>
      )}
    </CardShell>
  );
}

function MemoryRow({ m, cb }: { m: RecalledMemory; cb: RunCallbacks }) {
  const [open, setOpen] = useState(false);
  // For findings the "summary" is often just the finding kind; show it as a tag instead of a paragraph.
  const shortSummary = m.summary && m.summary.length <= 24 ? m.summary : null;
  const longSummary = m.summary && !shortSummary && m.summary !== m.title ? m.summary : null;
  const steps = m.runbook?.steps ?? [];
  return (
    <div className="px-3 py-2">
      <div className="flex items-start gap-2">
        <UidPill uid={m.uid} name={m.kind === "incident" ? m.uid.split(":").slice(1).join(":") : (m.agent ?? "finding")} onClick={cb.onUid} size="xs" />
        <button type="button" onClick={() => setOpen((o) => !o)} className={cx("min-w-0 flex-1 text-left text-xs text-fg-2 hover:text-fg", !open && "line-clamp-2")}>
          {m.title}
        </button>
        {shortSummary && <span className="shrink-0 rounded bg-panel-3 px-1 font-mono text-2xs text-muted">{shortSummary}</span>}
        {m.similarity !== undefined && <span className="shrink-0 font-mono text-2xs text-muted">{m.similarity.toFixed(2)}</span>}
      </div>
      {longSummary && <div className={cx("mt-0.5 text-xs text-muted", !open && "line-clamp-2")}>{longSummary}</div>}
      {m.sessionId && <div className="mt-0.5 font-mono text-2xs text-faint">session {m.sessionId}</div>}
      {m.runbook && (
        <div className="mt-1.5 rounded border border-line bg-panel-2 px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-2xs">
            <UidPill uid={m.runbook.uid} name="runbook" size="xs" onClick={cb.onUid} />
            <span className="text-fg-2">{m.runbook.title}</span>
          </div>
          <ol className="mt-1 list-decimal pl-5 text-xs text-muted marker:text-faint">
            {(open ? steps : steps.slice(0, 3)).map((s, i) => (
              <li key={i} className={open ? "" : "truncate"}>
                {s}
              </li>
            ))}
          </ol>
          {steps.length > 3 && (
            <button type="button" onClick={() => setOpen((o) => !o)} className="mt-0.5 pl-5 font-mono text-2xs text-faint hover:text-fg">
              {open ? "less" : `+${steps.length - 3} more steps`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AgentCard({ run, agent, cb }: { run: RunState; agent: AgentView; cb: RunCallbacks }) {
  const accent = AGENT_ACCENT[agent.name] ?? "#8b9cff";
  const findings = agent.findings.map((id) => run.findings[id]).filter((f): f is Finding => !!f);
  return (
    <CardShell accent={accent}>
      <div className="flex items-center gap-2 px-3 pt-2 pb-1.5">
        <span className="grid size-5 place-items-center rounded text-2xs font-bold text-bg" style={{ background: accent }}>
          {agent.title.slice(0, 1)}
        </span>
        <span className="text-sm font-semibold text-fg">{agent.title}</span>
        <span className="truncate text-xs text-faint" title={agent.role}>
          {agent.goal || agent.role}
        </span>
        <span className="ml-auto shrink-0">
          {agent.status === "running" ? (
            <Spinner />
          ) : (
            <span className="font-mono text-2xs text-ok" title="done">
              ✓ done
            </span>
          )}
        </span>
      </div>

      {agent.toolCalls.length > 0 && (
        <div className="mx-3 mb-2 overflow-hidden rounded border border-line bg-panel-2/60">
          {agent.toolCalls.map((id) => {
            const c = run.toolCalls[id];
            return c ? <ToolCallRow key={id} call={c} cb={cb} /> : null;
          })}
        </div>
      )}

      {findings.length > 0 && (
        <div className="flex flex-col gap-1.5 px-3 pb-2">
          {findings.map((f) => (
            <FindingRow key={f.id} f={f} cb={cb} />
          ))}
        </div>
      )}

      {agent.handoffs.map((h) => (
        <div key={`${h.findingId}-${h.to}`} className="animate-slide-in mx-3 mb-2 flex items-center gap-2 rounded border border-dashed border-line-2 px-2 py-1 text-xs">
          <span className="font-mono text-accent">→</span>
          <span className="shrink-0 whitespace-nowrap text-fg-2">
            handed to <span className="font-medium" style={{ color: `color-mix(in srgb, ${AGENT_ACCENT[h.to] ?? "#8b9cff"} 60%, #000)` }}>{AGENT_INFO[h.to]?.title ?? h.to}</span>
          </span>
          <span className="truncate text-faint" title={h.note}>
            {h.note}
          </span>
          <span className="ml-auto shrink-0 font-mono text-2xs text-faint" title="Finding-[:HANDED_TO]->Agent in the graph">
            HANDED_TO
          </span>
        </div>
      ))}

      {agent.name === "navigator" && <SourcesList run={run} agent={agent} cb={cb} />}

      {agent.messages.map((m) => (
        <div key={m.seq} className="border-t border-line bg-panel-2/40 px-3 py-2.5">
          {/* skip the paragraph when it just repeats one of the claims (scripted mode often does) */}
          {!m.claimIds.some((cid) => run.claims[cid]?.text.trim() === m.text.trim()) && <p className="text-sm leading-relaxed text-fg">{m.text}</p>}
          {m.claimIds.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {m.claimIds.map((cid) => {
                const c = run.claims[cid];
                if (!c) return null;
                return (
                  <li key={cid} className="flex gap-2 text-sm text-fg-2">
                    <span className="mt-[7px] size-1 shrink-0 rounded-full bg-accent" />
                    <span>
                      {c.text}
                      {c.findingIds.length > 0 && <WhyChip onClick={() => cb.onWhy(c.findingIds)} count={c.findingIds.length} />}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}

      {agent.status === "done" && agent.summary && agent.messages.length === 0 && (
        <div className="border-t border-line px-3 py-1.5 text-xs text-muted">{agent.summary}</div>
      )}
    </CardShell>
  );
}

function ToolCallRow({ call, cb }: { call: ToolCallView; cb: RunCallbacks }) {
  const [open, setOpen] = useState(false);
  const r = call.result;
  const quiet = call.tool === "read_handoffs" || call.tool === "record_finding";
  return (
    <div className="border-b border-line/70 last:border-b-0">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-panel-3/60">
        <span className={cx("font-mono text-2xs text-faint transition-transform", open && "rotate-90")}>▸</span>
        <span className={cx("font-mono text-xs", quiet ? "text-muted" : "text-fg-2")}>{call.tool}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {call.status === "running" ? <span className="animate-breathe font-mono text-2xs">{compactInput(call.input)}</span> : call.error ? <span className="text-bad">{call.error}</span> : r?.summary}
        </span>
        <span className="shrink-0 font-mono text-2xs text-faint tabular-nums">
          {call.status === "running" ? <Spinner /> : r ? `${r.rows.length} rows · ${fmtMs(r.ms)}` : ""}
        </span>
      </button>
      {open && (
        <div className="animate-fade-in flex flex-col gap-2 border-t border-line/70 bg-panel-2 px-2.5 py-2">
          <div className="font-mono text-2xs text-muted">
            <span className="text-faint">input </span>
            {JSON.stringify(call.input)}
          </div>
          {r && (
            <>
              <CypherBlock cypher={r.cypher} maxHeight={180} />
              <RowsTable rows={r.rows} max={10} onUid={cb.onUid} />
              {r.paths.length > 0 && (
                <div className="flex flex-col gap-1">
                  {r.paths.slice(0, 4).map((p, i) => (
                    <PathChain key={i} path={p} onUid={cb.onUid} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FindingRow({ f, cb }: { f: Finding; cb: RunCallbacks }) {
  return (
    <div className="animate-slide-in rounded border border-line bg-panel-2 px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span className="rounded bg-panel-3 px-1 font-mono text-2xs text-muted uppercase">{KIND_LABEL[f.kind] ?? f.kind}</span>
        <ConfidenceBar value={f.confidence} />
        <span className="ml-auto">
          <WhyChip onClick={() => cb.onWhy([f.id], f.id)} />
        </span>
      </div>
      <div className="mt-1 text-sm text-fg">{f.claim}</div>
      {f.evidence.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {f.evidence.slice(0, 5).map((u) => (
            <UidPill key={u} uid={u} size="xs" onClick={cb.onUid} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActionsCard({ actions, run, cb }: { actions: ActionRecord[]; run: RunState; cb: RunCallbacks }) {
  const KIND: Record<string, string> = { github_issue: "GitHub issue", rollback_pr: "Rollback PR", webhook: "Webhook" };
  return (
    <CardShell accent="#f472b6">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="text-xs font-semibold text-fg">Actions</span>
        <span className="text-2xs text-faint">audit-logged · dry run when not configured</span>
      </div>
      <div className="flex flex-col divide-y divide-line">
        {actions.map((a) => (
          <div key={a.id} className="animate-slide-in flex items-center gap-2 px-3 py-1.5">
            <StatusPill status={a.status} />
            <span className="w-24 shrink-0 text-xs text-muted">{KIND[a.kind] ?? a.kind}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-fg-2" title={a.error ?? JSON.stringify(a.payload)}>
              {a.title}
              {a.error && <span className="ml-1 text-bad">({a.error})</span>}
            </span>
            {a.url ? (
              <a href={a.url} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-2xs text-accent hover:underline">
                open ↗
              </a>
            ) : (
              a.findingIds.length > 0 && (
                <button type="button" className="shrink-0 font-mono text-2xs text-faint hover:text-fg" onClick={() => cb.onWhy(a.findingIds.filter((id) => run.findings[id]))}>
                  payload / why
                </button>
              )
            )}
          </div>
        ))}
      </div>
    </CardShell>
  );
}

function FinishedRow({ run }: { run: RunState }) {
  const tone = run.status === "ok" ? "text-ok" : run.status === "aborted" ? "text-warn" : "text-bad";
  return (
    <div className="flex items-center gap-2 px-1 font-mono text-2xs text-faint">
      <span className="h-px flex-1 bg-line" />
      <span className={tone}>run {run.status}</span>
      <span>· {run.findingOrder.length} findings · {fmtMs(run.ms)}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

const SOURCE_LABELS = new Set(["Decision", "Doc", "Thread", "Issue", "PR", "Incident"]);

/** Ask-the-company sources: the ask_company hits, each a card with a Why? chip. */
export function SourcesList({ run, agent, cb }: { run: RunState; agent: AgentView; cb: RunCallbacks }) {
  const seen = new Set<string>();
  const sources: { uid: string; label: string; title: string; similarity?: number; snippet?: string; cypher: string }[] = [];
  for (const id of agent.toolCalls) {
    const r = run.toolCalls[id]?.result;
    if (!r || r.tool !== "ask_company") continue;
    for (const row of r.rows) {
      const uid = typeof row.source === "string" ? row.source : null;
      const label = typeof row.label === "string" ? row.label : uid?.split(":")[0] ?? "";
      if (!uid || seen.has(uid) || !SOURCE_LABELS.has(label)) continue;
      seen.add(uid);
      sources.push({
        uid,
        label,
        title: typeof row.title === "string" ? row.title : uid,
        ...(typeof row.similarity === "number" ? { similarity: row.similarity } : {}),
        ...(typeof row.snippet === "string" ? { snippet: row.snippet } : {}),
        cypher: r.cypher,
      });
    }
  }
  if (sources.length === 0) return null;
  // Why? for a source = the findings that cite it (evidence/about), else those backed by the ask_company query.
  const whyFor = (s: (typeof sources)[number]) => {
    const all = run.findingOrder.map((id) => run.findings[id]!).filter(Boolean);
    const citing = all.filter((f) => f.evidence.includes(s.uid) || f.about.includes(s.uid));
    const backed = citing.length ? citing : all.filter((f) => f.cypher.includes(s.cypher));
    return backed.map((f) => f.id);
  };
  return (
    <div className="px-3 pb-2">
      <div className="pb-1 text-2xs font-semibold tracking-[0.08em] text-muted uppercase">Sources</div>
      <div className="grid grid-cols-1 gap-1.5 xl:grid-cols-2">
        {sources.map((s) => {
          const ids = whyFor(s);
          return (
            <div key={s.uid} className="animate-slide-in flex flex-col gap-1 rounded border border-line bg-panel-2 px-2 py-1.5" style={{ borderLeft: `2px solid ${labelColor(s.label)}` }}>
              <div className="flex items-center gap-1.5">
                <UidPill uid={s.uid} size="xs" onClick={cb.onUid} />
                {s.similarity !== undefined && <span className="font-mono text-2xs text-faint">sim {s.similarity.toFixed(2)}</span>}
                <span className="ml-auto">{ids.length > 0 && <WhyChip onClick={() => cb.onWhy(ids)} />}</span>
              </div>
              <button type="button" onClick={() => cb.onUid(s.uid)} className="text-left text-xs font-medium text-fg-2 hover:text-fg">
                {s.title}
              </button>
              {s.snippet && <div className="line-clamp-2 text-2xs text-muted">{s.snippet}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
