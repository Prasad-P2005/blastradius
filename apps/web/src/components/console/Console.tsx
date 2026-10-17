"use client";
/**
 * The incident console (`/`). Owns all client state:
 *   tenant · mode · session · runs (via the pure reducer) · graph data · focus · drawers.
 * Left: chat timeline. Right: force graph. Overlays: Why? drawer, close-incident dialog.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isTenant,
  tenantInfo,
  type AgentEvent,
  type CloseIncidentRequest,
  type GNode,
  type GraphPath,
  type HealthStatus,
  type InvestigationMode,
  type Scenario,
  type Subgraph,
  type Tenant,
} from "@blastradius/shared";
import { api, streamInvestigate, type SessionListItem } from "@/lib/api";
import { buildSession, involvedIds, reduceSession, type RunState } from "@/lib/run-state";
import { mergeSubgraphs, pathsToIds, runSubgraph } from "@/lib/graph-merge";
import { prefillClose } from "@/lib/close-prefill";
import { fixtureEnabled, fixtureInstant, FIXTURE_SCENARIOS, loadFixtureOverview, loadFixtureRun, replayFixture } from "@/lib/fixture";
import { fmtAgo } from "@/lib/format";
import { GraphPanel } from "@/components/graph/GraphPanel";
import { Banner, Dot, Kbd, Spinner, cx } from "@/components/ui";
import { RunView } from "./RunView";
import { WhyDrawer } from "./WhyDrawer";
import { CloseIncidentDialog } from "./CloseIncidentDialog";
import { UserMenu } from "@/components/auth/UserMenu";
import { GraphSwitcher, NoGraphs, useGraphs } from "@/components/graphs/GraphSwitcher";

const LS_TENANT = "br.tenant";

export function Console() {
  const [fixture, setFixture] = useState(false);
  const [tenant, setTenant] = useState<Tenant>("acme");
  const [mode, setMode] = useState<InvestigationMode>("incident");
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunState[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [overview, setOverview] = useState<Subgraph | null>(null);
  const [overviewErr, setOverviewErr] = useState<string | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [expanded, setExpanded] = useState<Subgraph | null>(null);
  const [expanding, setExpanding] = useState<string | null>(null);
  const [selected, setSelected] = useState<GNode | null>(null);
  const [focus, setFocus] = useState<Set<string> | null>(null);
  const [why, setWhy] = useState<{ run: number; findingIds: string[] } | null>(null);
  // snapshot of the prefilled form + run, taken when the dialog opens (the run then becomes "closed")
  const [closing, setClosing] = useState<{ init: CloseIncidentRequest; runId: string } | null>(null);
  const closeOpen = closing !== null;
  const [closedRuns, setClosedRuns] = useState<Set<string>>(new Set());
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nonce = useRef(0);

  // the graphs that exist (FalkorDB GRAPH.LIST); data is only fetched for one of them
  const graphs = useGraphs();
  const ready = fixture || Boolean(graphs?.some((g) => g.id === tenant));
  useEffect(() => {
    if (fixture || !graphs || graphs.length === 0 || graphs.some((g) => g.id === tenant)) return;
    setTenant(graphs[0]!.id); // the saved or linked graph is gone: fall back to the newest one
  }, [graphs, tenant, fixture]);

  /* ── boot ── */
  useEffect(() => {
    setFixture(fixtureEnabled());
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tenant");
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(LS_TENANT);
    } catch {
      /* storage blocked */
    }
    const pick = t ?? saved;
    if (pick && isTenant(pick)) setTenant(pick);
    if (params.get("mode") === "ask") setMode("ask");
  }, []);

  /* ── health polling (always real, even in fixture mode) ── */
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const h = await api.health();
        if (alive) {
          setHealth(h);
          setHealthErr(null);
        }
      } catch (e) {
        if (alive) setHealthErr(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const id = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  /* ── per-tenant data ── */
  const refreshSessions = useCallback(async () => {
    if (fixture) return;
    try {
      setSessions(await api.sessions(tenant));
    } catch {
      setSessions([]);
    }
  }, [tenant, fixture]);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setOverview(null);
    setExpanded(null);
    setOverviewErr(null);
    setOverviewLoading(true);
    const load = fixture ? loadFixtureOverview() : api.overview(tenant);
    load
      .then((g) => alive && setOverview(g))
      .catch((e: unknown) => alive && setOverviewErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setOverviewLoading(false));
    if (fixture) setScenarios(FIXTURE_SCENARIOS.filter((s) => s.tenant === tenant));
    else
      api
        .scenarios(tenant)
        .then((s) => alive && setScenarios(s))
        .catch(() => alive && setScenarios([]));
    void refreshSessions();
    return () => {
      alive = false;
    };
  }, [tenant, fixture, refreshSessions, ready]);

  /* keep the newest event in view */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (nearBottom || streaming) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [runs, pending, streaming]);

  /* ── session controls ── */
  const resetSession = useCallback(() => {
    abortRef.current?.abort();
    setRuns([]);
    setSessionId(null);
    setPending(null);
    setLocalError(null);
    setFocus(null);
    setSelected(null);
    setWhy(null);
    setClosing(null);
  }, []);

  const switchTenant = (t: Tenant) => {
    if (t === tenant) return;
    resetSession();
    setTenant(t);
    try {
      localStorage.setItem(LS_TENANT, t);
    } catch {
      /* ignore */
    }
  };

  const openSession = async (s: SessionListItem) => {
    setSessionsOpen(false);
    resetSession();
    setLoadingSession(true);
    try {
      const { events } = await api.sessionMessages(s.sessionId);
      const replayed = buildSession(events);
      setRuns(replayed);
      setSessionId(s.sessionId);
      const last = replayed.at(-1);
      if (last?.mode) setMode(last.mode);
      if (replayed.length === 0) setLocalError("This session has no recorded events in Postgres (it may predate event logging).");
    } catch (e) {
      setLocalError(`Could not load session ${s.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoadingSession(false);
    }
  };

  /* ── sending ── */
  const send = useCallback(
    async (message: string, extra?: { scenario?: Scenario; mode?: InvestigationMode }) => {
      const text = message.trim();
      if (!text || streaming) return;
      const runMode = extra?.scenario?.mode ?? extra?.mode ?? mode;
      if (extra?.scenario) setMode(extra.scenario.mode);
      setInput("");
      setPending(text);
      setLocalError(null);
      setFocus(null);
      setStreaming(true);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const stream: AsyncIterable<AgentEvent> = fixture
          ? replayFixture(await loadFixtureRun(runMode), { instant: fixtureInstant(), signal: ac.signal, nonce: ++nonce.current })
          : streamInvestigate(
              {
                tenant,
                mode: runMode,
                message: text,
                ...(sessionId ? { sessionId } : {}),
                ...(extra?.scenario ? { scenarioId: extra.scenario.id } : {}),
                ...(extra?.scenario?.alert ? { alert: extra.scenario.alert } : {}),
              },
              ac.signal,
            );
        for await (const ev of stream) {
          setRuns((rs) => reduceSession(rs, ev));
          if (ev.type === "run_started") {
            setPending(null);
            setSessionId(ev.sessionId);
          }
        }
      } catch (e) {
        if (!ac.signal.aborted) setLocalError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(null);
        setStreaming(false);
        abortRef.current = null;
        void refreshSessions();
      }
    },
    [streaming, mode, fixture, tenant, sessionId, refreshSessions],
  );

  const stop = () => abortRef.current?.abort();

  /* ── deep links from /start and /data: ?scenario=<id> or ?q=<text> run once on arrival ── */
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || fixture) return;
    const p = new URLSearchParams(window.location.search);
    const scenarioId = p.get("scenario");
    const q = p.get("q");
    if (!scenarioId && !q) return;
    // wait until the boot effect has switched to the linked tenant (and its scenarios are loaded)
    if (p.get("tenant") && p.get("tenant") !== tenant) return;
    const scenario = scenarioId ? scenarios.find((s) => s.id === scenarioId) : undefined;
    if (scenarioId && !scenario) return;
    autoStarted.current = true;
    // drop the trigger from the URL so a reload doesn't start a second run
    p.delete("scenario");
    p.delete("q");
    window.history.replaceState(null, "", `${window.location.pathname}${p.size ? `?${p}` : ""}`);
    if (scenario) void send(scenario.question, { scenario });
    else void send(q!, { mode: p.get("mode") === "ask" ? "ask" : "incident" });
  }, [scenarios, tenant, send, fixture]);

  /* ── graph ── */
  const latest = runs.at(-1) ?? null;
  const graph = useMemo(() => mergeSubgraphs([overview, expanded, ...runs.map(runSubgraph)]), [overview, expanded, runs]);
  const involved = useMemo(() => (latest && latest.lastSeq >= 0 ? involvedIds(latest) : null), [latest]);

  const expand = useCallback(
    async (uid: string) => {
      if (fixture) return;
      setExpanding(uid);
      try {
        const sub = await api.neighborhood(tenant, uid, 40);
        setExpanded((prev) => mergeSubgraphs([prev, sub]));
        const found = sub.nodes.find((n) => n.id === uid);
        if (found) setSelected((s) => (s?.id === uid ? found : s));
      } catch (e) {
        setOverviewErr(`neighborhood(${uid}): ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setExpanding(null);
      }
    },
    [tenant, fixture],
  );

  const onNodeClick = (n: GNode) => {
    setSelected(n);
    void expand(n.id);
  };

  const peopleHref = useCallback((uid: string) => `/people?tenant=${tenant}&uid=${encodeURIComponent(uid)}${fixture ? "&fixture=1" : ""}`, [tenant, fixture]);

  const onUid = useCallback(
    (uid: string) => {
      // A person pill opens their live activity page (new tab, so the run stays on screen).
      if (uid.startsWith("Person:")) {
        window.open(peopleHref(uid), "_blank", "noopener");
        return;
      }
      const n = graph.nodes.find((x) => x.id === uid);
      setSelected(n ?? { id: uid, label: (uid.split(":")[0] as GNode["label"]) ?? "Service", name: uid.split(":").slice(1).join(":"), props: {} });
      setFocus(new Set([uid]));
      void expand(uid);
    },
    [graph.nodes, expand, peopleHref],
  );

  const onFocusPaths = (paths: GraphPath[], extra: string[]) => {
    setFocus(pathsToIds(paths, extra));
    setWhy(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !why && !closeOpen) {
        setFocus(null);
        setSessionsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [why, closeOpen]);

  /* ── derived ── */
  const agentMode = latest?.agentMode ?? health?.agentMode ?? null;
  const model = latest?.agentMode ? latest.model : health?.model;
  const falkorDown = health ? !health.falkordb.ok : false;
  const sessionClosed = sessions.find((s) => s.sessionId === sessionId)?.status === "closed";
  const canClose =
    !!latest && latest.mode === "incident" && latest.status === "ok" && !!latest.runId && !closedRuns.has(latest.runId) && !sessionClosed && !streaming;
  const closeInitial = useMemo(() => (canClose && latest ? prefillClose(latest) : null), [canClose, latest]);

  if (!fixture && graphs && graphs.length === 0) return <NoGraphs />;

  return (
    <div className="flex h-full flex-col">
      {/* ── top bar ── */}
      <header className="relative z-20 flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-3 whitespace-nowrap">
        <div className="flex items-center gap-2">
          <Logo />
          <span className="text-sm font-semibold tracking-tight">Blastradius</span>
        </div>
        <Divider />
        <GraphSwitcher tenant={tenant} graphs={graphs} onChange={switchTenant} />

        <div className="relative">
          <button
            type="button"
            onClick={() => setSessionsOpen((o) => !o)}
            className="flex items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 py-1 text-xs text-fg-2 hover:text-fg"
          >
            <span className="text-faint">session</span>
            <span className="max-w-40 truncate font-mono text-2xs">{sessionId ?? "new"}</span>
            {loadingSession ? <Spinner /> : <span className="text-faint">▾</span>}
          </button>
          {sessionsOpen && (
            <div className="animate-fade-in absolute top-full left-0 mt-1 w-96 overflow-hidden rounded-md border border-line-2 bg-panel shadow-2xl">
              <button
                type="button"
                onClick={() => {
                  resetSession();
                  setSessionsOpen(false);
                }}
                className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-xs text-accent hover:bg-panel-2"
              >
                + New session
              </button>
              <div className="max-h-80 overflow-auto">
                {sessions.length === 0 && <div className="px-3 py-2 text-xs text-faint">{fixture ? "No sessions in fixture mode." : "No past sessions for this tenant."}</div>}
                {sessions.map((s) => (
                  <button
                    key={s.sessionId}
                    type="button"
                    onClick={() => void openSession(s)}
                    className={cx("flex w-full flex-col gap-0.5 border-b border-line/60 px-3 py-1.5 text-left hover:bg-panel-2", s.sessionId === sessionId && "bg-panel-2")}
                  >
                    <span className="truncate text-xs text-fg-2">{s.title ?? s.question}</span>
                    <span className="flex gap-2 font-mono text-2xs text-faint">
                      <span>{s.mode}</span>
                      <span>{s.status}</span>
                      <span>
                        {s.episodes} ep · {s.findings} findings
                      </span>
                      <span className="ml-auto">{s.startedAt ? fmtAgo(s.startedAt) : ""}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center rounded-md border border-line bg-panel-2 p-0.5">
          {(["incident", "ask"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cx("rounded px-2 py-0.5 text-xs", m === mode ? "bg-panel-3 text-fg shadow-sm" : "text-muted hover:text-fg")}
            >
              {m === "incident" ? "Incident" : "Ask the company"}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {fixture && <span className="rounded border border-warn/40 bg-warn/10 px-1.5 font-mono text-2xs text-warn">FIXTURE REPLAY</span>}
          {agentMode && (
            <span
              title={agentMode === "llm" ? `LLM tool loop${model ? ` (${model})` : ""}` : "Scripted: same tools, fixed order, deterministic"}
              className={cx(
                "rounded border px-1.5 font-mono text-2xs leading-[18px]",
                agentMode === "llm" ? "border-accent/40 bg-accent/10 text-accent" : "border-line-2 bg-panel-2 text-muted",
              )}
            >
              {agentMode}
              {agentMode === "llm" && model ? ` · ${model}` : ""}
            </span>
          )}
          <span className="flex items-center gap-1.5 text-2xs text-muted" title={health?.falkordb.error ?? (health ? `${health.falkordb.ms ?? "?"} ms` : healthErr ?? "")}>
            <Dot ok={health ? health.falkordb.ok : healthErr ? false : null} /> FalkorDB
          </span>
          <span className="flex items-center gap-1.5 text-2xs text-muted" title={health?.postgres.error ?? (health ? `${health.postgres.ms ?? "?"} ms` : healthErr ?? "")}>
            <Dot ok={health ? health.postgres.ok : healthErr ? false : null} /> Postgres
          </span>
          <Divider />
          <Link href="/start" className="text-xs text-fg-2 hover:text-fg">
            Graphs
          </Link>
          <Link href={`/build?tenant=${tenant}`} className="text-xs text-fg-2 hover:text-fg">
            Builder
          </Link>
          <Link href={`/people?tenant=${tenant}${fixture ? "&fixture=1" : ""}`} className="text-xs text-fg-2 hover:text-fg">
            People
          </Link>
          <Link href={`/memory?tenant=${tenant}${fixture ? "&fixture=1" : ""}${sessionId ? `&session=${sessionId}` : ""}`} className="text-xs text-fg-2 hover:text-fg">
            Memory →
          </Link>
          <UserMenu compact />
        </div>
      </header>

      {falkorDown && <Banner tone="bad">FalkorDB is unreachable: {health?.falkordb.error ?? "health check failed"}. Investigations will fail until it is back.</Banner>}
      {!health && healthErr && !fixture && <Banner tone="bad">Health check failed: {healthErr}</Banner>}

      {/* ── body ── */}
      <div className="relative grid min-h-0 flex-1 grid-cols-[minmax(420px,44%)_1fr]">
        <section className="flex min-h-0 flex-col border-r border-line bg-bg">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3 [scrollbar-gutter:stable]">
            {runs.length === 0 && !pending ? (
              <EmptyState tenant={tenant} mode={mode} scenarios={scenarios} onPick={(s) => void send(s.question, { scenario: s })} disabled={streaming} />
            ) : (
              <div className="flex flex-col gap-4">
                {runs.map((r, i) => (
                  <RunView
                    key={r.runId ?? i}
                    run={r}
                    isLatest={i === runs.length - 1}
                    cb={{
                      onWhy: (findingIds) => setWhy({ run: i, findingIds }),
                      onUid,
                    }}
                  />
                ))}
                {pending && (
                  <div className="flex flex-col gap-2">
                    <div className="flex justify-end">
                      <div className="max-w-[88%] rounded-lg rounded-br-sm border border-accent/25 bg-accent/10 px-3 py-2 text-sm">{pending}</div>
                    </div>
                    <div className="flex items-center gap-2 px-1 text-xs text-faint">
                      <Spinner /> starting session, recalling memory…
                    </div>
                  </div>
                )}
              </div>
            )}
            {localError && (
              <div className="mt-3 rounded-md border border-bad/40 bg-bad/[0.07] px-3 py-2 text-xs text-bad">
                <span className="font-medium">Request failed:</span> <span className="font-mono">{localError}</span>
              </div>
            )}
          </div>

          {/* ── composer ── */}
          <div className="shrink-0 border-t border-line bg-panel px-3 pt-2 pb-2.5">
            {(runs.length > 0 || pending) && scenarios.length > 0 && (
              <div className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5">
                {scenarios.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    disabled={streaming}
                    onClick={() => void send(s.question, { scenario: s })}
                    title={s.presenterNote}
                    className="shrink-0 rounded-full border border-line-2 bg-panel-2 px-2 py-0.5 text-2xs text-muted hover:border-accent/50 hover:text-fg disabled:opacity-50"
                  >
                    <span className={s.mode === "ask" ? "text-[#c084fc]" : "text-bad"}>{s.mode === "ask" ? "ask" : "alert"}</span> {s.title}
                  </button>
                ))}
              </div>
            )}
            {canClose && closeInitial && (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-ok/30 bg-ok/[0.06] px-2.5 py-1.5">
                <span className="text-xs text-fg-2">Run finished with {latest?.findingOrder.length} findings.</span>
                <button type="button" onClick={() => latest?.runId && setClosing({ init: closeInitial, runId: latest.runId })} className="ml-auto rounded bg-ok/90 px-2.5 py-1 text-xs font-medium text-bg hover:bg-ok">
                  Close incident →
                </button>
              </div>
            )}
            <div className="flex items-end gap-2 rounded-md border border-line-2 bg-panel-2 px-2.5 py-2 focus-within:border-accent/60">
              <textarea
                value={input}
                rows={2}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                placeholder={mode === "incident" ? "Describe the alert, e.g. “checkout 5xx at 12%”" : "Ask the company, e.g. “why did we move cart to valkey?”"}
                className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent text-sm text-fg outline-none placeholder:text-faint"
              />
              {streaming ? (
                <button type="button" onClick={stop} className="rounded border border-line-2 px-2.5 py-1 text-xs text-muted hover:text-fg">
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!input.trim()}
                  onClick={() => void send(input)}
                  className="rounded bg-accent-2 px-3 py-1 text-xs font-medium text-white hover:bg-accent disabled:opacity-40"
                >
                  {mode === "incident" ? "Investigate" : "Ask"}
                </button>
              )}
            </div>
            <div className="mt-1 flex items-center gap-3 text-2xs text-faint">
              <span>
                <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> newline · <Kbd>Esc</Kbd> close / clear focus
              </span>
              <span className="ml-auto font-mono">{tenantInfo(tenant).sourceRepo ?? ""}</span>
            </div>
          </div>
        </section>

        <section className="relative min-h-0">
          <GraphPanel
            nodes={graph.nodes}
            edges={graph.edges}
            involved={involved}
            focus={focus}
            selected={selected}
            loading={overviewLoading}
            error={overviewErr}
            expanding={expanding}
            fitKey={`${tenant}:${overview ? 1 : 0}:${runs.length}:${latest?.status ?? ""}`}
            title={`${graphs?.find((g) => g.id === tenant)?.name ?? tenantInfo(tenant).name} graph`}
            onNodeClick={onNodeClick}
            onClearSelection={() => setSelected(null)}
            onClearFocus={() => setFocus(null)}
            onUid={onUid}
            personHref={peopleHref}
          />
        </section>

        {why && runs[why.run] && (
          <WhyDrawer run={runs[why.run]!} findingIds={why.findingIds} onClose={() => setWhy(null)} onFocus={onFocusPaths} onUid={onUid} />
        )}
        {closing && (
          <CloseIncidentDialog
            initial={closing.init}
            onClose={() => setClosing(null)}
            onSubmit={async (req) => {
              if (fixture) throw new Error("Closing an incident needs the real backend (fixture mode is read-only).");
              const res = await api.closeIncident(req);
              setClosedRuns((s) => new Set(s).add(closing.runId));
              void refreshSessions();
              return res;
            }}
            onNewSession={() => {
              resetSession();
            }}
          />
        )}
      </div>
    </div>
  );
}

function EmptyState({ tenant, mode, scenarios, onPick, disabled }: { tenant: Tenant; mode: InvestigationMode; scenarios: Scenario[]; onPick: (s: Scenario) => void; disabled: boolean }) {
  const ordered = [...scenarios].sort((a, b) => (a.mode === mode ? -1 : 0) - (b.mode === mode ? -1 : 0));
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 pt-6">
      <div>
        <div className="text-2xs font-semibold tracking-[0.08em] text-muted uppercase">{tenantInfo(tenant).name}</div>
        <h1 className="mt-1 text-lg font-semibold tracking-tight">{mode === "incident" ? "What's on fire?" : "Ask the company"}</h1>
        <p className="mt-1 text-sm text-muted">
          {mode === "incident"
            ? "Triage, Investigator, Expert finder and Scribe work over one FalkorDB graph: what else breaks, what caused it, who can fix it, and what worked last time. Every claim has a Why? path."
            : "The Navigator searches decisions, docs, tickets and chat threads in the same graph as the code, and answers with sources."}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-2xs font-semibold tracking-[0.08em] text-muted uppercase">Scenarios</div>
        {ordered.length === 0 && (
          <div className="rounded-md border border-dashed border-line-2 px-3 py-3 text-xs leading-relaxed text-muted">
            This graph has no ready-made scenarios. Type an alert below, like “payments 5xx at 12%”, using the name of a service in your graph.
          </div>
        )}
        {ordered.map((s) => (
          <button
            key={s.id}
            type="button"
            disabled={disabled}
            onClick={() => onPick(s)}
            className="group flex items-start gap-3 rounded-md border border-line bg-panel px-3 py-2 text-left hover:border-accent/50 hover:bg-panel-2 disabled:opacity-50"
          >
            <span className={cx("mt-0.5 rounded px-1 font-mono text-2xs uppercase", s.mode === "ask" ? "bg-[#c084fc]/15 text-[#c084fc]" : "bg-bad/15 text-bad")}>{s.mode === "ask" ? "ask" : "alert"}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-fg">{s.title}</span>
              {s.question !== s.title && <span className="block truncate text-xs text-muted">{s.question}</span>}
              {s.alert && (
                <span className="mt-0.5 block font-mono text-2xs text-faint">
                  {s.alert.service}
                  {s.alert.metric ? ` · ${s.alert.metric}` : ""}
                  {s.alert.value ? ` = ${s.alert.value}` : ""}
                </span>
              )}
            </span>
            <span className="text-faint group-hover:text-accent">→</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Divider() {
  return <span className="h-4 w-px bg-line-2" />;
}

export function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="10" fill="none" stroke="#f87171" strokeOpacity="0.35" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="6" fill="none" stroke="#f87171" strokeOpacity="0.7" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="2.4" fill="#f87171" />
    </svg>
  );
}
