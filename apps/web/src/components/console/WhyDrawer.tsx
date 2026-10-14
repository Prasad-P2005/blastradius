"use client";
/**
 * The Why? drawer: for each finding behind a claim, show the exact Cypher that
 * ran (matched by exact string against tool results), its params, rows, timing
 * and the evidence paths — and let the user spotlight those paths on the graph.
 */
import { useEffect } from "react";
import { AGENT_INFO, type Finding, type GraphPath } from "@blastradius/shared";
import { evidenceForFinding, pathsForFinding, type RunState } from "@/lib/run-state";
import { fmtMs } from "@/lib/format";
import { ConfidenceBar, CopyButton, CypherBlock, PathChain, RowsTable, UidPill, cx } from "@/components/ui";

export interface WhyDrawerProps {
  run: RunState;
  findingIds: string[];
  onClose: () => void;
  onFocus: (paths: GraphPath[], extraUids: string[]) => void;
  onUid: (uid: string) => void;
}

export function WhyDrawer({ run, findingIds, onClose, onFocus, onUid }: WhyDrawerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const findings = findingIds.map((id) => run.findings[id]).filter((f): f is Finding => !!f);

  return (
    <div className="absolute inset-0 z-30 flex justify-end">
      <button type="button" aria-label="close" className="animate-fade-in absolute inset-0 bg-black/40" onClick={onClose} />
      <aside className="animate-drawer-in relative flex h-full w-[min(640px,92vw)] flex-col border-l border-line-2 bg-panel shadow-2xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="rounded border border-accent/40 bg-accent/10 px-1.5 font-mono text-xs text-accent">Why?</span>
          <span className="text-sm font-medium">
            {findings.length} finding{findings.length === 1 ? "" : "s"} · the Cypher and graph path behind the claim
          </span>
          <button type="button" onClick={onClose} className="ml-auto rounded px-1.5 font-mono text-2xs text-faint hover:text-fg">
            esc ×
          </button>
        </header>
        <div className="flex-1 overflow-auto px-4 py-3">
          {findings.length === 0 && <div className="text-sm text-faint">No findings recorded for this claim.</div>}
          <div className="flex flex-col gap-5">
            {findings.map((f) => (
              <FindingWhy key={f.id} run={run} f={f} onFocus={onFocus} onUid={onUid} />
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

function FindingWhy({ run, f, onFocus, onUid }: { run: RunState; f: Finding; onFocus: WhyDrawerProps["onFocus"]; onUid: (u: string) => void }) {
  const evidence = evidenceForFinding(run, f);
  const paths = pathsForFinding(run, f);
  return (
    <section className="flex flex-col gap-2.5">
      <div className="rounded-md border border-line bg-panel-2 px-3 py-2">
        <div className="flex items-center gap-2 text-2xs text-muted">
          <span className="rounded bg-panel-3 px-1 font-mono uppercase">{f.kind}</span>
          <span>{AGENT_INFO[f.agent]?.title ?? f.agent}</span>
          <span className="font-mono text-faint">{f.uid}</span>
          <ConfidenceBar value={f.confidence} className="ml-auto" />
        </div>
        <div className="mt-1.5 text-sm leading-relaxed text-fg">{f.claim}</div>
        <div className="mt-2 grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 text-2xs">
          <span className="pt-0.5 font-mono text-faint">ABOUT</span>
          <div className="flex flex-wrap gap-1">
            {f.about.map((u) => (
              <UidPill key={u} uid={u} size="xs" onClick={onUid} />
            ))}
          </div>
          <span className="pt-0.5 font-mono text-faint">EVIDENCE</span>
          <div className="flex flex-wrap gap-1">
            {f.evidence.map((u) => (
              <UidPill key={u} uid={u} size="xs" onClick={onUid} />
            ))}
          </div>
        </div>
      </div>

      {paths.length > 0 && (
        <div className="rounded-md border border-line px-3 py-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-2xs font-semibold tracking-[0.08em] text-muted uppercase">Evidence path{paths.length > 1 ? "s" : ""}</span>
            <button
              type="button"
              onClick={() => onFocus(paths, [...f.about, ...f.evidence])}
              className="rounded border border-accent/50 bg-accent/15 px-2 py-0.5 text-xs text-accent hover:bg-accent/25"
            >
              Focus on graph
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {paths.slice(0, 6).map((p, i) => (
              <PathChain key={i} path={p} onUid={onUid} />
            ))}
          </div>
        </div>
      )}

      {evidence.map((ev, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-2xs">
            <span className="font-semibold tracking-[0.08em] text-muted uppercase">Query {i + 1}</span>
            {ev.call ? (
              <>
                <span className="font-mono text-fg-2">{ev.call.tool}</span>
                {ev.extra && <span className="text-faint">(extra query)</span>}
                <span className="font-mono text-faint">
                  {ev.call.result?.rows.length ?? 0} rows · {fmtMs(ev.call.result?.ms)}
                </span>
                <span className="font-mono text-faint">by {ev.call.agent}</span>
              </>
            ) : (
              <span className="text-warn">no matching tool result in this run</span>
            )}
            <span className="ml-auto">
              <CopyButton text={ev.cypher} label="copy cypher" />
            </span>
          </div>
          <CypherBlock cypher={ev.cypher} />
          {Object.keys(ev.params).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {Object.entries(ev.params).map(([k, v]) => (
                <span key={k} className="rounded border border-line bg-panel-2 px-1.5 font-mono text-2xs leading-[18px]">
                  <span className="text-warn">${k}</span>
                  <span className="text-faint"> = </span>
                  <span className={cx("text-fg-2")}>{JSON.stringify(v).slice(0, 80)}</span>
                </span>
              ))}
            </div>
          )}
          {ev.call?.result && <RowsTable rows={ev.call.result.rows} max={20} onUid={onUid} />}
        </div>
      ))}
    </section>
  );
}
