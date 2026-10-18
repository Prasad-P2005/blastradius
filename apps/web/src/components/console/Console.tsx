"use client";
/**
 * The incident console (`/`). Owns all client state:
 *   tenant · mode · session · runs (via the pure reducer) · graph data · focus · drawers.
 * Inside the app shell: tabs (alert / question), then the runs as plain-language
 * summaries (RunSummary) with the agent log collapsed, and the service map on the right.
 * Overlays: Why? drawer, close-incident dialog.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isTenant,
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
import { Banner, Spinner, cx } from "@/components/ui";
import { AppShell, Button, Logo, Panel, StatusIcon, companyName } from "@/components/shell/AppShell";
import { RunSummary } from "./RunSummary";
import { WhyDrawer } from "./WhyDrawer";
import { CloseIncidentDialog } from "./CloseIncidentDialog";
import { NoGraphs, useGraphs } from "@/components/graphs/GraphSwitcher";

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
  const [showMap, setShowMap] = useState(true);
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

  /* when a new question is sent, bring the top of its result into view (the answers come first) */
  const latestRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    latestRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [runs.length, pending]);

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
  const sessionClosed = sessions.find((s) => s.sessionId === sessionId)?.status === "closed";
  const canClose =
    !!latest && latest.mode === "incident" && latest.status === "ok" && !!latest.runId && !closedRuns.has(latest.runId) && !sessionClosed && !streaming;
  const closeInitial = useMemo(() => (canClose && latest ? prefillClose(latest) : null), [canClose, latest]);

  const nodeNames = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.name])), [graph.nodes]);
  const nameOf = useCallback((uid: string) => nodeNames.get(uid), [nodeNames]);

  if (!fixture && graphs && graphs.length === 0) return <NoGraphs />;

  const company = companyName(tenant, graphs);
  const pageTitle = mode === "ask" ? "Ask the company" : "Investigate an alert";
  const started = runs.length > 0 || pending !== null;
  const lastIndex = runs.length - 1;

  const composer = (
    <Composer
      mode={mode}
      value={input}
      onChange={setInput}
      onSend={() => void send(input)}
      onStop={stop}
      streaming={streaming}
      followUp={started}
    />
  );

  return (
    <AppShell
      active={mode === "ask" ? "ask" : "investigate"}
      tenant={tenant}
      graphs={graphs}
      onTenantChange={switchTenant}
      health={health}
      fixture={fixture}
      layout="fill"
      crumbs={[{ label: "Companies", href: "/start" }, { label: company, href: `/?tenant=${tenant}` }, { label: pageTitle }]}
      title={pageTitle}
      description={
        mode === "ask"
          ? "Ask how the company works or why something was decided. The answer comes from its decisions, docs, tickets and chat threads, with sources."
          : "Describe what's wrong. Four agents walk the company graph and answer: what else breaks, what probably caused it, who can fix it, and what worked last time."
      }
      actions={
        <>
          {fixture && <span className="rounded-full bg-[#fff7e0] px-2.5 py-0.5 text-xs font-semibold text-warn">Recorded replay</span>}
          <HistoryMenu
            open={sessionsOpen}
            setOpen={setSessionsOpen}
            sessions={sessions}
            currentId={sessionId}
            loading={loadingSession}
            fixture={fixture}
            onOpen={(s) => void openSession(s)}
          />
          {started && (
            <Button onClick={resetSession} disabled={streaming}>
              New investigation
            </Button>
          )}
          <Button onClick={() => setShowMap((v) => !v)}>{showMap ? "Hide service map" : "Show service map"}</Button>
        </>
      }
    >
      {!health && healthErr && !fixture && <Banner tone="bad">Health check failed: {healthErr}</Banner>}

      {/* ── tabs ── */}
      <div className="flex shrink-0 gap-1 border-b border-line-2/60 px-6">
        {(["incident", "ask"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            aria-selected={m === mode}
            role="tab"
            className={cx(
              "-mb-px border-b-[3px] px-3 pt-1 pb-2 text-sm font-bold",
              m === mode ? "border-accent text-accent" : "border-transparent text-fg-2 hover:text-accent",
            )}
          >
            {m === "incident" ? "Investigate an alert" : "Ask the company"}
          </button>
        ))}
      </div>

      {/* ── body ── */}
      <div className={cx("relative grid min-h-0 flex-1", showMap ? "grid-cols-[minmax(0,1fr)_minmax(340px,38%)]" : "grid-cols-1")}>
        <section className="flex min-h-0 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable]">
            {!started ? (
              <StartPanel company={company} mode={mode} scenarios={scenarios} onPick={(s) => void send(s.question, { scenario: s })} disabled={streaming} composer={composer} />
            ) : (
              <div className="mx-auto flex max-w-5xl flex-col gap-6">
                {runs.map((r, i) =>
                  i < lastIndex ? (
                    <EarlierRun key={r.runId ?? i} run={r}>
                      <RunSummary run={r} isLatest={false} nameOf={nameOf} cb={{ onWhy: (ids) => setWhy({ run: i, findingIds: ids }), onUid }} />
                    </EarlierRun>
                  ) : (
                    <div key={r.runId ?? i} ref={latestRef} className="scroll-mt-4">
                    <RunSummary
                      run={r}
                      isLatest
                      nameOf={nameOf}
                      cb={{ onWhy: (ids) => setWhy({ run: i, findingIds: ids }), onUid }}
                      next={
                        canClose && closeInitial ? (
                          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[#b8d8f8] bg-[#f0f7ff] px-5 py-4">
                            <StatusIcon tone="info" />
                            <div className="min-w-0 flex-1">
                              <div className="font-bold text-fg">Fixed it? Close the incident.</div>
                              <div className="text-sm text-fg-2">The Scribe saves what happened and how it was fixed, so next time the agents recall it.</div>
                            </div>
                            <Button variant="primary" onClick={() => latest?.runId && setClosing({ init: closeInitial, runId: latest.runId })}>
                              Close incident
                            </Button>
                          </div>
                        ) : undefined
                      }
                    />
                    </div>
                  ),
                )}
                {pending && (
                  <div ref={latestRef} className="flex scroll-mt-4 items-center gap-2 rounded-xl border border-line-2/50 bg-panel px-5 py-4 text-sm text-muted">
                    <Spinner /> Starting “{pending}”: recalling past incidents…
                  </div>
                )}
              </div>
            )}
            {localError && (
              <div className="mx-auto mt-4 flex max-w-5xl gap-2 rounded-xl border border-bad/30 bg-[#fff7f7] px-4 py-3 text-sm">
                <StatusIcon tone="bad" />
                <div>
                  <div className="font-semibold text-bad">Something went wrong</div>
                  <div className="font-mono text-xs text-fg-2">{localError}</div>
                </div>
              </div>
            )}
          </div>

          {/* follow-up composer + example shortcuts once a run is on screen */}
          {started && (
            <div className="shrink-0 border-t border-line-2/60 bg-panel px-6 pt-3 pb-3">
              <div className="mx-auto max-w-5xl">
                {scenarios.length > 0 && (
                  <div className="mb-2 flex items-center gap-1.5 overflow-x-auto pb-0.5">
                    <span className="shrink-0 text-xs text-muted">Examples:</span>
                    {scenarios.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        disabled={streaming}
                        onClick={() => void send(s.question, { scenario: s })}
                        title={s.question}
                        className="shrink-0 rounded-full border border-line-2 bg-panel px-2.5 py-0.5 text-xs text-fg-2 hover:border-accent hover:text-accent disabled:opacity-50"
                      >
                        {s.title}
                      </button>
                    ))}
                  </div>
                )}
                {composer}
              </div>
            </div>
          )}
        </section>

        {showMap && (
          <section className="flex min-h-0 flex-col py-5 pr-6">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line-2/50 bg-panel shadow-[0_1px_3px_rgba(0,7,22,0.08)]">
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <h2 className="text-base font-bold">Service map</h2>
                <span className="text-xs text-muted">{latest ? "highlighted: everything this investigation touched" : "services, teams and how they depend on each other"}</span>
              </div>
              <div className="relative min-h-0 flex-1">
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
                  title={`${company}`}
                  onNodeClick={onNodeClick}
                  onClearSelection={() => setSelected(null)}
                  onClearFocus={() => setFocus(null)}
                  onUid={onUid}
                  personHref={peopleHref}
                />
              </div>
            </div>
          </section>
        )}

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
    </AppShell>
  );
}

/** The first screen: describe the problem, or pick a ready-made example. */
function StartPanel({ company, mode, scenarios, onPick, disabled, composer }: { company: string; mode: InvestigationMode; scenarios: Scenario[]; onPick: (s: Scenario) => void; disabled: boolean; composer: React.ReactNode }) {
  const forMode = scenarios.filter((s) => s.mode === mode);
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <Panel
        title={mode === "incident" ? `What's wrong at ${company}?` : `What do you want to know about ${company}?`}
        description={
          mode === "incident"
            ? "Name the service and the symptom, the way an alert would. For example: “payments failing for 25% of customers”."
            : "Ask about a decision, a system or a person. For example: “why do orders go through a queue?”"
        }
      >
        {composer}
      </Panel>

      <Panel
        title="Or try an example"
        description={mode === "incident" ? "Real-looking alerts for this company. Each one runs the full investigation." : "Questions this company's documents can answer."}
      >
        {forMode.length === 0 ? (
          <p className="text-sm text-muted">
            No ready-made examples for this company. Type one above, using the name of a service in the graph.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {forMode.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={disabled}
                onClick={() => onPick(s)}
                className="group flex flex-col items-start gap-1 rounded-xl border border-line-2/70 bg-panel px-4 py-3 text-left hover:border-accent hover:shadow-[0_0_0_1px_var(--color-accent)] disabled:opacity-50"
              >
                <span className="flex w-full items-center gap-2">
                  {s.mode === "incident" ? (
                    <span className="rounded-full bg-[#fff1f1] px-2 py-0.5 text-xs font-semibold text-bad">Alert</span>
                  ) : (
                    <span className="rounded-full bg-[#f0f7ff] px-2 py-0.5 text-xs font-semibold text-accent">Question</span>
                  )}
                  <span className="text-base font-bold text-fg">{s.title}</span>
                </span>
                <span className="text-sm text-fg-2">{s.question}</span>
                {s.alert && <span className="text-xs text-muted">Service: {s.alert.service}</span>}
                <span className="mt-1 text-sm font-semibold text-accent group-hover:underline">{s.mode === "incident" ? "Investigate →" : "Ask →"}</span>
              </button>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Composer({ mode, value, onChange, onSend, onStop, streaming, followUp }: { mode: InvestigationMode; value: string; onChange: (v: string) => void; onSend: () => void; onStop: () => void; streaming: boolean; followUp: boolean }) {
  return (
    <div>
      <div className="flex items-end gap-3">
        <textarea
          value={value}
          rows={followUp ? 1 : 2}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          aria-label={mode === "incident" ? "Describe the alert" : "Your question"}
          placeholder={
            followUp
              ? "Ask a follow-up, or describe another alert…"
              : mode === "incident"
                ? "e.g. payments failing for 25% of customers since 19:05"
                : "e.g. why do orders go through a queue instead of straight to the kitchen?"
          }
          className="max-h-40 min-h-[40px] flex-1 resize-none rounded-lg border-2 border-line-2 bg-panel px-3 py-2 text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
        />
        {streaming ? (
          <Button onClick={onStop}>Stop</Button>
        ) : (
          <Button variant="primary" disabled={!value.trim()} onClick={onSend}>
            {mode === "incident" ? "Investigate" : "Ask"}
          </Button>
        )}
      </div>
      <div className="mt-1.5 text-xs text-faint">Press Enter to send, Shift+Enter for a new line.</div>
    </div>
  );
}

/** "Past investigations" dropdown (the sessions stored in Postgres). */
function HistoryMenu({
  open,
  setOpen,
  sessions,
  currentId,
  loading,
  fixture,
  onOpen,
}: {
  open: boolean;
  setOpen: (f: (o: boolean) => boolean) => void;
  sessions: SessionListItem[];
  currentId: string | null;
  loading: boolean;
  fixture: boolean;
  onOpen: (s: SessionListItem) => void;
}) {
  return (
    <div className="relative">
      <Button onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Past investigations {loading ? <Spinner /> : <span aria-hidden>▾</span>}
      </Button>
      {open && (
        <div className="animate-fade-in absolute top-full right-0 z-40 mt-1.5 w-[26rem] overflow-hidden rounded-lg border border-line-2 bg-panel shadow-xl shadow-black/15">
          <div className="border-b border-line px-4 py-2 text-sm font-bold">Past investigations</div>
          <div className="max-h-96 overflow-auto">
            {sessions.length === 0 && <div className="px-4 py-3 text-sm text-muted">{fixture ? "Not available in a recorded replay." : "None yet for this company."}</div>}
            {sessions.map((s) => (
              <button
                key={s.sessionId}
                type="button"
                onClick={() => onOpen(s)}
                className={cx("flex w-full flex-col gap-0.5 border-b border-line px-4 py-2 text-left last:border-b-0 hover:bg-[#f0f7ff]", s.sessionId === currentId && "bg-[#f0f7ff]")}
              >
                <span className="truncate text-sm font-semibold text-fg">{s.title ?? s.question}</span>
                <span className="flex gap-3 text-xs text-muted">
                  <span>{s.mode === "ask" ? "Question" : "Alert"}</span>
                  <span>{s.status === "closed" ? "Closed" : "Open"}</span>
                  <span>{s.findings} answers</span>
                  <span className="ml-auto">{s.startedAt ? fmtAgo(s.startedAt) : ""}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** An earlier run in the same session, collapsed to one line. */
function EarlierRun({ run, children }: { run: RunState; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-line-2/50 bg-panel">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-5 py-3 text-left" aria-expanded={open}>
        <span className={cx("text-muted transition-transform", open && "rotate-90")}>▸</span>
        <span className="text-xs text-muted">Earlier:</span>
        <span className="truncate text-sm font-semibold text-fg">{run.question}</span>
        <span className="ml-auto shrink-0 text-xs text-muted">{run.findingOrder.length} answers</span>
      </button>
      {open && <div className="border-t border-line p-4">{children}</div>}
    </div>
  );
}

export { Logo };
