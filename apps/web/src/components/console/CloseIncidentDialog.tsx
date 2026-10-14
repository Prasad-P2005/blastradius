"use client";
/** Close the incident: the Scribe writes Incident + Runbook into procedural memory. */
import { useEffect, useState } from "react";
import type { CloseIncidentRequest, CloseIncidentResult } from "@blastradius/shared";
import { CypherBlock, Spinner, UidPill } from "@/components/ui";

export interface CloseIncidentDialogProps {
  initial: CloseIncidentRequest;
  onSubmit: (req: CloseIncidentRequest) => Promise<CloseIncidentResult>;
  onClose: () => void;
  onNewSession: () => void;
}

export function CloseIncidentDialog({ initial, onSubmit, onClose, onNewSession }: CloseIncidentDialogProps) {
  const [form, setForm] = useState(initial);
  const [stepsText, setStepsText] = useState(initial.runbook.steps.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CloseIncidentResult | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const steps = stepsText.split("\n").map((s) => s.trim()).filter(Boolean);
      setResult(await onSubmit({ ...form, runbook: { ...form.runbook, steps } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full rounded border border-line-2 bg-panel-2 px-2 py-1.5 text-sm text-fg outline-none focus:border-accent/60";
  const lbl = "mb-1 block text-2xs font-semibold tracking-[0.08em] text-muted uppercase";

  return (
    <div className="absolute inset-0 z-40 grid place-items-center p-4">
      <button type="button" aria-label="close" className="animate-fade-in absolute inset-0 bg-black/55" onClick={onClose} />
      <div className="animate-slide-in relative flex max-h-[90vh] w-[min(620px,96vw)] flex-col overflow-hidden rounded-lg border border-line-2 bg-panel shadow-2xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="text-sm font-semibold">Close incident</span>
          <span className="text-xs text-faint">Scribe writes Incident + Runbook to procedural memory</span>
          <button type="button" onClick={onClose} className="ml-auto font-mono text-2xs text-faint hover:text-fg">
            esc ×
          </button>
        </header>

        {result ? (
          <div className="flex flex-col gap-3 px-4 py-4">
            <div className="flex items-center gap-2 text-sm text-ok">✓ Written to the graph</div>
            <div className="flex flex-wrap items-center gap-2">
              <UidPill uid={result.incidentUid} />
              <UidPill uid={result.runbookUid} />
            </div>
            <CypherBlock cypher={result.cypher} maxHeight={200} />
            <div className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-fg-2">
              Start a new session and ask about the same service: the recall step will bring this incident and its runbook back.
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded border border-line-2 px-3 py-1.5 text-sm text-muted hover:text-fg">
                Done
              </button>
              <button type="button" onClick={onNewSession} className="rounded bg-accent-2 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent">
                Start new session
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3 overflow-auto px-4 py-3">
              <div>
                <label className={lbl}>Title</label>
                <input className={input} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={lbl}>Severity</label>
                  <select className={input} value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as CloseIncidentRequest["severity"] })}>
                    {["SEV1", "SEV2", "SEV3", "SEV4"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={lbl}>Service</label>
                  <input className={`${input} font-mono text-xs`} value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })} />
                </div>
                <div>
                  <label className={lbl}>Caused by PR</label>
                  <input
                    className={`${input} font-mono text-xs`}
                    value={form.causedByPr ?? ""}
                    placeholder="PR:1234"
                    onChange={(e) => {
                      const { causedByPr: _drop, ...rest } = form;
                      setForm(e.target.value ? { ...rest, causedByPr: e.target.value } : rest);
                    }}
                  />
                </div>
              </div>
              <div>
                <label className={lbl}>Summary</label>
                <textarea className={`${input} min-h-16`} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
              </div>
              <div>
                <label className={lbl}>Responders</label>
                <div className="flex flex-wrap gap-1">
                  {form.responders.length === 0 && <span className="text-xs text-faint">none found</span>}
                  {form.responders.map((r) => (
                    <span key={r} className="inline-flex items-center gap-0.5">
                      <UidPill uid={r} />
                      <button type="button" className="px-0.5 text-faint hover:text-bad" onClick={() => setForm({ ...form, responders: form.responders.filter((x) => x !== r) })}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <label className={lbl}>Runbook title</label>
                <input className={input} value={form.runbook.title} onChange={(e) => setForm({ ...form, runbook: { ...form.runbook, title: e.target.value } })} />
              </div>
              <div>
                <label className={lbl}>Runbook steps (one per line)</label>
                <textarea className={`${input} min-h-28 font-mono text-xs leading-relaxed`} value={stepsText} onChange={(e) => setStepsText(e.target.value)} />
              </div>
              {error && <div className="rounded border border-bad/40 bg-bad/10 px-2 py-1.5 text-xs text-bad">{error}</div>}
            </div>
            <footer className="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5">
              <span className="mr-auto font-mono text-2xs text-faint">{form.findingIds.length} findings linked</span>
              <button type="button" onClick={onClose} className="rounded border border-line-2 px-3 py-1.5 text-sm text-muted hover:text-fg">
                Cancel
              </button>
              <button type="button" disabled={busy} onClick={submit} className="inline-flex items-center gap-2 rounded bg-accent-2 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent disabled:opacity-60">
                {busy && <Spinner />} Close incident
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
