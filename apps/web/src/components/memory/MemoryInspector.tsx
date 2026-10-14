"use client";
/**
 * Memory inspector (`/memory`): how judges see track 02 at a glance.
 *   Episodic   — Session -[:HAS_EPISODE]-> Episode -[:NEXT]-> Episode …
 *   Semantic   — Findings each episode PRODUCED (ABOUT / SUPPORTED_BY domain nodes)
 *   Coordination — Finding -[:HANDED_TO]-> Agent (the only handoff channel)
 *   Procedural — Incident + Runbook per service (seeded, or written by the Scribe)
 */
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { AGENT_INFO, TENANTS, TENANT_INFO, type EpisodeView, type Finding, type GNode, type MemoryInspectorData, type Tenant } from "@blastradius/shared";
import { api } from "@/lib/api";
import { fixtureEnabled, loadFixtureMemory } from "@/lib/fixture";
import { fmtAgo, fmtDate, fmtTime, labelColor } from "@/lib/format";
import { ConfidenceBar, CypherBlock, SectionTitle, Spinner, UidPill, cx } from "@/components/ui";
import { Logo } from "@/components/console/Console";

const ForceGraph = dynamic(() => import("@/components/graph/ForceGraph"), { ssr: false });

const AGENT_ACCENT: Record<string, string> = {
  system: "#94a3b8",
  triage: "#60a5fa",
  investigator: "#f59e0b",
  expert: "#34d399",
  scribe: "#2dd4bf",
  navigator: "#c084fc",
};

export function MemoryInspector() {
  const [fixture, setFixture] = useState(false);
  const [tenant, setTenant] = useState<Tenant>("acme");
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [data, setData] = useState<MemoryInspectorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showCypher, setShowCypher] = useState(false);
  const [selected, setSelected] = useState<GNode | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setFixture(fixtureEnabled());
    const t = p.get("tenant");
    if (t && (TENANTS as readonly string[]).includes(t)) setTenant(t as Tenant);
    const s = p.get("session");
    if (s) setSessionId(s);
    setReady(true);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = fixture ? await loadFixtureMemory() : await api.memory(tenant, sessionId);
      setData(d);
      // default to the newest session so the page is never empty when memory exists
      if (!sessionId && d.sessions[0]) setSessionId(d.sessions[0].sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [fixture, tenant, sessionId]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  const switchTenant = (t: Tenant) => {
    setTenant(t);
    setSessionId(undefined);
    setData(null);
    setSelected(null);
  };

  const sess = data?.session;
  const subgraph = data?.subgraph ?? { nodes: [], edges: [] };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <Link href={`/?tenant=${tenant}${fixture ? "&fixture=1" : ""}`} className="flex items-center gap-2">
          <Logo />
          <span className="text-sm font-semibold tracking-tight">Blastradius</span>
        </Link>
        <span className="h-4 w-px bg-line-2" />
        <span className="text-sm text-fg-2">Memory inspector</span>
        <div className="flex items-center rounded-md border border-line bg-panel-2 p-0.5">
          {TENANTS.map((t) => (
            <button key={t} type="button" onClick={() => switchTenant(t)} className={cx("rounded px-2 py-0.5 text-xs", t === tenant ? "bg-panel-3 text-fg" : "text-muted hover:text-fg")}>
              {TENANT_INFO[t].name}
            </button>
          ))}
        </div>
        <span className="font-mono text-2xs text-faint">graph blastradius_{tenant}</span>
        {loading && <Spinner />}
        <div className="ml-auto flex items-center gap-3">
          {fixture && <span className="rounded border border-warn/40 bg-warn/10 px-1.5 font-mono text-2xs text-warn">FIXTURE</span>}
          <button type="button" onClick={() => setShowCypher((v) => !v)} className={cx("rounded border px-2 py-0.5 font-mono text-2xs", showCypher ? "border-accent/50 bg-accent/15 text-accent" : "border-line-2 text-muted hover:text-fg")}>
            Why? cypher
          </button>
          <Link href={`/?tenant=${tenant}${fixture ? "&fixture=1" : ""}`} className="text-xs text-fg-2 hover:text-fg">
            ← Console
          </Link>
        </div>
      </header>

      <MemoryLegend />

      {error && <div className="border-b border-bad/40 bg-bad/10 px-4 py-1.5 text-xs text-bad">Memory unavailable: {error}</div>}

      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_minmax(360px,32%)]">
        {/* sessions */}
        <aside className="flex min-h-0 flex-col border-r border-line bg-panel">
          <div className="px-3 pt-3">
            <SectionTitle right={<span className="font-mono text-2xs text-faint">{data?.sessions.length ?? 0}</span>}>Sessions</SectionTitle>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
            {data && data.sessions.length === 0 && <div className="px-1 text-xs text-faint">No sessions yet. Run an investigation from the console.</div>}
            {data?.sessions.map((s) => (
              <button
                key={s.sessionId}
                type="button"
                onClick={() => {
                  setSessionId(s.sessionId);
                  setSelected(null);
                }}
                className={cx(
                  "mb-1 flex w-full flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left",
                  s.sessionId === sessionId ? "border-accent/50 bg-accent/10" : "border-transparent hover:border-line hover:bg-panel-2",
                )}
              >
                <span className="line-clamp-2 text-xs text-fg-2">{s.question}</span>
                <span className="flex items-center gap-1.5 font-mono text-2xs text-faint">
                  <span className={s.mode === "ask" ? "text-[#c084fc]" : "text-bad"}>{s.mode}</span>
                  <span className={s.status === "closed" ? "text-ok" : ""}>{s.status}</span>
                  <span>
                    {s.episodes}ep {s.findings}f
                  </span>
                  <span className="ml-auto">{fmtAgo(s.startedAt)}</span>
                </span>
                <span className="truncate font-mono text-2xs text-faint">{s.sessionId}</span>
              </button>
            ))}
          </div>
        </aside>

        {/* episode chain */}
        <main className="min-h-0 overflow-auto px-5 py-3">
          {sess ? (
            <>
              <SectionTitle right={<span className="font-mono text-2xs text-faint">Session:{sess.sessionId}</span>}>Episodic memory · Session → Episode chain</SectionTitle>
              <SessionHeader data={data!} sessionId={sess.sessionId} />
              <ol className="relative mt-2">
                {sess.episodes.map((ep, i) => (
                  <EpisodeRow key={ep.uid} ep={ep} last={i === sess.episodes.length - 1} first={i === 0} onUid={(u) => setSelected(subgraph.nodes.find((n) => n.id === u) ?? null)} />
                ))}
              </ol>

              {sess.handoffs.length > 0 && (
                <div className="mt-4">
                  <SectionTitle>Coordination · handoffs through the graph</SectionTitle>
                  <div className="flex flex-col gap-1">
                    {sess.handoffs.map((h) => (
                      <div key={`${h.findingId}-${h.to}`} className="flex items-center gap-2 rounded border border-line bg-panel px-2.5 py-1.5 text-xs">
                        <AgentTag name={h.from} />
                        <span className="font-mono text-2xs text-faint">
                          -[:WROTE]→ <span className="text-[#e879f9]">Finding</span> -[:HANDED_TO]→
                        </span>
                        <AgentTag name={h.to} />
                        <span className="min-w-0 flex-1 truncate text-muted" title={h.claim}>
                          {h.claim}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            !loading && <div className="pt-10 text-center text-sm text-faint">{data ? "Select a session." : ""}</div>
          )}

          {showCypher && data && (
            <div className="mt-5">
              <SectionTitle>Cypher used by this page</SectionTitle>
              <div className="flex flex-col gap-2">
                {data.cypher.map((c, i) => (
                  <CypherBlock key={i} cypher={c} maxHeight={220} />
                ))}
              </div>
            </div>
          )}
        </main>

        {/* graph + procedural */}
        <aside className="flex min-h-0 flex-col border-l border-line">
          <div className="relative h-[46%] min-h-[260px] border-b border-line bg-[radial-gradient(ellipse_at_center,#10141d_0%,#090b0f_75%)]">
            <div className="absolute top-2 left-2.5 z-10 rounded border border-line bg-panel/85 px-2 py-0.5 text-2xs text-muted backdrop-blur">
              session memory subgraph · <span className="font-mono">{subgraph.nodes.length}n {subgraph.edges.length}e</span>
            </div>
            {subgraph.nodes.length > 0 && (
              <ForceGraph
                nodes={subgraph.nodes}
                edges={subgraph.edges}
                involved={null}
                focus={selected ? new Set([selected.id]) : null}
                selected={selected?.id ?? null}
                onNodeClick={setSelected}
                onBackgroundClick={() => setSelected(null)}
                fitKey={sessionId}
                compact
              />
            )}
            {selected && (
              <div className="absolute right-2 bottom-2 left-2 z-10 rounded border border-line-2 bg-panel/95 px-2.5 py-1.5 text-xs backdrop-blur">
                <div className="flex items-center gap-2">
                  <UidPill uid={selected.id} size="xs" />
                  <button type="button" className="ml-auto text-faint hover:text-fg" onClick={() => setSelected(null)}>
                    ×
                  </button>
                </div>
                <div className="mt-1 line-clamp-2 text-muted">{String(selected.props.claim ?? selected.props.summary ?? selected.name)}</div>
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
            <SectionTitle>Procedural memory · incidents + runbooks</SectionTitle>
            {data && data.procedural.length === 0 && <div className="text-xs text-faint">No incidents recorded.</div>}
            <div className="flex flex-col gap-3">
              {data?.procedural.map((p) => (
                <div key={p.service}>
                  <div className="mb-1">
                    <UidPill uid={p.service} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {p.incidents.map((inc) => (
                      <div key={inc.uid} className="rounded-md border border-line bg-panel px-2.5 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className="rounded bg-bad/15 px-1 font-mono text-2xs text-bad">{inc.severity}</span>
                          <span className="min-w-0 flex-1 truncate text-xs text-fg" title={inc.title}>
                            {inc.title}
                          </span>
                          {inc.sessionId ? (
                            <span className="rounded border border-ok/40 bg-ok/10 px-1 font-mono text-2xs text-ok" title={`written by the Scribe in session ${inc.sessionId}`}>
                              learned
                            </span>
                          ) : (
                            <span className="rounded border border-line-2 px-1 font-mono text-2xs text-faint">{inc.synthetic ? "synthetic seed" : "seed"}</span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-2xs text-faint">
                          <span>{inc.uid}</span>
                          {inc.resolvedAt && <span>· resolved {fmtDate(inc.resolvedAt)}</span>}
                          {inc.causedBy && (
                            <>
                              <span>· caused by</span>
                              <UidPill uid={inc.causedBy} size="xs" />
                            </>
                          )}
                          {inc.sessionId && <span>· session {inc.sessionId}</span>}
                        </div>
                        {inc.runbook && (
                          <div className="mt-1.5 border-t border-line pt-1.5">
                            <div className="text-2xs text-muted">
                              <span style={{ color: labelColor("Runbook") }}>Runbook</span> {inc.runbook.title}
                            </div>
                            <ol className="mt-0.5 list-decimal pl-5 text-xs text-fg-2 marker:text-faint">
                              {inc.runbook.steps.map((s, i) => (
                                <li key={i}>{s}</li>
                              ))}
                            </ol>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function MemoryLegend() {
  const item = (label: string, text: string, color: string) => (
    <div className="flex min-w-0 items-start gap-2">
      <span className="mt-1 size-2 shrink-0 rounded-full" style={{ background: color }} />
      <div className="min-w-0">
        <div className="text-xs font-medium text-fg-2">{label}</div>
        <div className="truncate font-mono text-2xs text-faint">{text}</div>
      </div>
    </div>
  );
  return (
    <div className="grid shrink-0 grid-cols-4 gap-4 border-b border-line bg-panel-2/50 px-4 py-2">
      {item("Episodic", "(:Session)-[:HAS_EPISODE]->(:Episode)-[:NEXT]->(:Episode)", labelColor("Episode"))}
      {item("Semantic", "(:Episode)-[:PRODUCED]->(:Finding)-[:ABOUT|SUPPORTED_BY]->(domain)", labelColor("Finding"))}
      {item("Coordination", "(:Agent)-[:WROTE]->(:Finding)-[:HANDED_TO]->(:Agent)", labelColor("Agent"))}
      {item("Procedural", "(:Incident)-[:RESOLVED_BY]->(:Runbook), written on close", labelColor("Runbook"))}
    </div>
  );
}

function SessionHeader({ data, sessionId }: { data: MemoryInspectorData; sessionId: string }) {
  const s = data.sessions.find((x) => x.sessionId === sessionId);
  if (!s) return null;
  return (
    <div className="mb-1 rounded-md border border-line bg-panel px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="size-2.5 rounded-full" style={{ background: labelColor("Session") }} />
        <span className="text-sm text-fg">{s.question}</span>
      </div>
      <div className="mt-0.5 flex gap-3 pl-[18px] font-mono text-2xs text-faint">
        <span>{s.mode}</span>
        <span className={s.status === "closed" ? "text-ok" : ""}>{s.status}</span>
        <span>started {new Date(s.startedAt).toLocaleString()}</span>
        <span>
          {s.episodes} episodes · {s.findings} findings
        </span>
      </div>
    </div>
  );
}

function AgentTag({ name }: { name: string }) {
  const title = (AGENT_INFO as Record<string, { title: string }>)[name]?.title ?? name;
  return (
    <span className="inline-flex items-center gap-1 rounded px-1 text-xs font-medium" style={{ color: AGENT_ACCENT[name] ?? "#94a3b8", background: `${AGENT_ACCENT[name] ?? "#94a3b8"}18` }}>
      {title}
    </span>
  );
}

function EpisodeRow({ ep, first, last, onUid }: { ep: EpisodeView; first: boolean; last: boolean; onUid: (u: string) => void }) {
  return (
    <li className="relative grid grid-cols-[28px_1fr] gap-2">
      {/* rail */}
      <div className="relative flex justify-center">
        <span className={cx("absolute w-px bg-line-2", first ? "top-3" : "top-0", last ? "h-3" : "bottom-0")} />
        <span className="relative mt-2 grid size-4 place-items-center rounded-full border text-[9px] font-bold" style={{ borderColor: labelColor("Episode"), background: "#090b0f", color: labelColor("Episode") }}>
          {ep.seq}
        </span>
      </div>
      <div className={cx("pb-2", !last && "relative")}>
        <div className="rounded-md border border-line bg-panel px-2.5 py-1.5">
          <div className="flex items-center gap-2">
            <AgentTag name={ep.agent} />
            <span className="rounded bg-panel-3 px-1 font-mono text-2xs text-muted">{ep.kind}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-fg-2" title={ep.summary}>
              {ep.summary}
            </span>
            <span className="font-mono text-2xs text-faint">{fmtTime(ep.at)}</span>
          </div>
          {ep.findings.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-1.5 border-t border-line pt-1.5">
              {ep.findings.map((f) => (
                <FindingMini key={f.id} f={f} onUid={onUid} />
              ))}
            </div>
          )}
        </div>
        {!last && <div className="py-0.5 pl-2 font-mono text-[10px] text-faint">:NEXT ↓</div>}
      </div>
    </li>
  );
}

function FindingMini({ f, onUid }: { f: Finding; onUid: (u: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-line/80 bg-panel-2 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-2xs text-[#e879f9]">PRODUCED →</span>
        <span className="rounded bg-panel-3 px-1 font-mono text-2xs text-muted uppercase">{f.kind}</span>
        <ConfidenceBar value={f.confidence} />
        {f.handTo && (
          <span className="font-mono text-2xs text-faint">
            HANDED_TO <AgentTag name={f.handTo} />
          </span>
        )}
        {f.cypher.length > 0 && (
          <button type="button" onClick={() => setOpen((o) => !o)} className={cx("ml-auto rounded border px-1 font-mono text-2xs", open ? "border-accent/50 text-accent" : "border-line-2 text-faint hover:text-fg")}>
            cypher {f.cypher.length}
          </button>
        )}
      </div>
      <div className="mt-1 text-xs text-fg">{f.claim}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {f.about.map((u) => (
          <UidPill key={`a${u}`} uid={u} size="xs" onClick={onUid} />
        ))}
        {f.evidence.filter((u) => !f.about.includes(u)).length > 0 && <span className="font-mono text-[10px] text-faint">SUPPORTED_BY</span>}
        {f.evidence
          .filter((u) => !f.about.includes(u))
          .map((u) => (
            <UidPill key={`e${u}`} uid={u} size="xs" onClick={onUid} />
          ))}
      </div>
      {open && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {f.cypher.map((c, i) => (
            <CypherBlock key={i} cypher={c} maxHeight={160} />
          ))}
        </div>
      )}
    </div>
  );
}
