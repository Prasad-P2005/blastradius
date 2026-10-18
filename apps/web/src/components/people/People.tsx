"use client";
/**
 * People (`/people`): fictional personas and real git contributors, each with a
 * live activity feed. Personas own the synthetic content (threads, tickets, on-call,
 * incident response, decisions); real contributors only carry their real public PRs.
 * Agent findings that name a person show up in their feed — polled every 5 s while
 * the tab is visible, so an investigation naming the on-call persona appears live.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTenant, type PersonActivity, type PersonActivityItem, type PersonActivityKind, type PersonSummary, type Tenant } from "@blastradius/shared";
import { api } from "@/lib/api";
import { fixtureEnabled, loadFixturePeople } from "@/lib/fixture";
import { fmtAgo, labelColor, uidKey } from "@/lib/format";
import { CypherBlock, SectionTitle, Spinner, UidPill, cx } from "@/components/ui";
import { AppShell, companyName } from "@/components/shell/AppShell";
import { NoGraphs, useGraphs } from "@/components/graphs/GraphSwitcher";

const POLL_MS = 5_000;
const NEW_HIGHLIGHT_MS = 6_000;

const KIND_META: Record<PersonActivityKind, { label: string; color: string; path: string }> = {
  pr: { label: "PR", color: labelColor("PR"), path: "M6 3v12M18 9v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12-12a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM6 6c0 5 12 3 12 6" },
  thread: { label: "Thread", color: labelColor("Thread"), path: "M4 5h16v10H9l-5 4V5Z" },
  issue: { label: "Ticket", color: labelColor("Issue"), path: "M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4V7Z" },
  incident: { label: "Incident", color: labelColor("Incident"), path: "M12 3 2 20h20L12 3Zm0 6v5m0 3v.5" },
  on_call: { label: "On call", color: "#fbbf24", path: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2" },
  decision: { label: "Decision", color: labelColor("Decision"), path: "M5 4h14v16H5V4Zm3 8 3 3 5-6" },
  finding: { label: "Agent finding", color: labelColor("Finding"), path: "M12 2l2.2 6.8L21 11l-6.8 2.2L12 20l-2.2-6.8L3 11l6.8-2.2L12 2Z" },
  action: { label: "Action", color: "#f472b6", path: "M13 2 4 14h7l-1 8 9-12h-7l1-8Z" },
};

const itemKey = (x: PersonActivityItem) => `${x.kind}|${x.uid}|${x.at}`;

export function People() {
  const [fixture, setFixture] = useState(false);
  const [ready, setReady] = useState(false);
  const [tenant, setTenant] = useState<Tenant>("acme");
  const graphs = useGraphs();
  useEffect(() => {
    // the linked graph doesn't exist (any more): fall back to the newest one
    if (graphs && graphs.length > 0 && !graphs.some((g) => g.id === tenant)) setTenant(graphs[0]!.id);
  }, [graphs, tenant]);
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [peopleErr, setPeopleErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [activity, setActivity] = useState<PersonActivity | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const [loadingAct, setLoadingAct] = useState(false);
  const [showBots, setShowBots] = useState(false);
  const [filter, setFilter] = useState("");
  const [showCypher, setShowCypher] = useState(false);
  const [lastPoll, setLastPoll] = useState<number | null>(null);
  const [, forceTick] = useState(0);
  const newSince = useRef(new Map<string, number>());
  const seenKeys = useRef<Set<string> | null>(null);
  const fixtureRef = useRef<Awaited<ReturnType<typeof loadFixturePeople>> | null>(null);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setFixture(fixtureEnabled());
    const t = p.get("tenant");
    if (t && isTenant(t)) setTenant(t);
    const uid = p.get("uid");
    if (uid) setSelected(uid);
    setReady(true);
  }, []);

  /* roster (refreshed every 30 s for on-call / counts) */
  const loadPeople = useCallback(async () => {
    try {
      if (fixture) {
        fixtureRef.current ??= await loadFixturePeople();
        setPeople(fixtureRef.current.people);
      } else setPeople(await api.people(tenant));
      setPeopleErr(null);
    } catch (e) {
      setPeopleErr(e instanceof Error ? e.message : String(e));
    }
  }, [fixture, tenant]);

  useEffect(() => {
    if (!ready) return;
    void loadPeople();
    const id = setInterval(() => document.visibilityState === "visible" && void loadPeople(), 30_000);
    return () => clearInterval(id);
  }, [ready, loadPeople]);

  // default selection: the first persona on call now, else the first persona
  useEffect(() => {
    if (selected || people.length === 0) return;
    const pick = people.find((p) => p.persona && p.onCallNow.length) ?? people.find((p) => p.persona) ?? people[0];
    if (pick) setSelected(pick.uid);
  }, [people, selected]);

  /* activity: fetch on select, then poll every 5 s while visible; mark new items */
  const loadActivity = useCallback(
    async (uid: string, initial: boolean) => {
      if (initial) setLoadingAct(true);
      try {
        const a = fixture ? (fixtureRef.current ??= await loadFixturePeople()).activity(uid) : await api.personActivity(tenant, uid);
        const keys = new Set(a.items.map(itemKey));
        if (seenKeys.current && !initial) {
          const now = Date.now();
          for (const k of keys) if (!seenKeys.current.has(k)) newSince.current.set(k, now);
        }
        seenKeys.current = keys;
        setActivity(a);
        setActErr(null);
        setLastPoll(Date.now());
      } catch (e) {
        setActErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (initial) setLoadingAct(false);
      }
    },
    [fixture, tenant],
  );

  useEffect(() => {
    if (!ready || !selected) return;
    seenKeys.current = null;
    newSince.current.clear();
    setActivity(null);
    void loadActivity(selected, true);
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void loadActivity(selected, false);
    }, POLL_MS);
    const onVis = () => document.visibilityState === "visible" && void loadActivity(selected, false);
    document.addEventListener("visibilitychange", onVis);
    // keep the url shareable
    const url = new URL(window.location.href);
    url.searchParams.set("uid", selected);
    url.searchParams.set("tenant", tenant);
    window.history.replaceState(null, "", url);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [ready, selected, tenant, loadActivity]);

  // re-render once a second so "new" highlights fade and "x s ago" stays fresh
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const switchTenant = (t: Tenant) => {
    if (t === tenant) return;
    setTenant(t);
    setSelected(null);
    setActivity(null);
    setPeople([]);
  };

  const q = filter.trim().toLowerCase();
  const match = (p: PersonSummary) => !q || p.name.toLowerCase().includes(q) || (p.role ?? "").toLowerCase().includes(q) || (p.team ?? "").toLowerCase().includes(q);
  const personas = useMemo(
    () => people.filter((p) => p.persona && match(p)).sort((a, b) => b.onCallNow.length - a.onCallNow.length || a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [people, q],
  );
  const real = useMemo(
    () => people.filter((p) => !p.persona && (showBots || !p.isBot) && match(p)).sort((a, b) => b.counts.prs - a.counts.prs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [people, q, showBots],
  );
  const botCount = people.filter((p) => !p.persona && p.isBot).length;
  const person = activity?.person ?? people.find((p) => p.uid === selected) ?? null;

  if (graphs && graphs.length === 0) return <NoGraphs />;

  return (
    <AppShell
      active="people"
      tenant={tenant}
      graphs={graphs}
      onTenantChange={switchTenant}
      fixture={fixture}
      layout="fill"
      crumbs={[{ label: "Companies", href: "/start" }, { label: companyName(tenant, graphs), href: `/?tenant=${tenant}` }, { label: "People & experts" }]}
      title="People & experts"
      description="Everyone in the company graph: who is on call, what they've worked on, and what the agents have said about them. The feed updates live during an investigation."
      actions={fixture ? <span className="rounded-full bg-[#fff7e0] px-2.5 py-0.5 text-xs font-semibold text-warn">Recorded replay</span> : undefined}
    >

      <div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)]">
        {/* roster */}
        <aside className="flex min-h-0 flex-col border-r border-line bg-panel">
          <div className="border-b border-line p-2.5">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name, role or team"
              className="w-full rounded border border-line-2 bg-panel-2 px-2 py-1 text-xs text-fg outline-none placeholder:text-faint focus:border-accent/60"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 py-2.5">
            {peopleErr && <div className="mb-2 rounded border border-bad/40 bg-bad/10 px-2 py-1.5 text-xs text-bad">People unavailable: {peopleErr}</div>}
            <div className="px-1">
              <SectionTitle right={<span className="font-mono text-2xs text-faint">{personas.length}</span>}>Personas · fictional</SectionTitle>
            </div>
            {personas.map((p) => (
              <RosterRow key={p.uid} p={p} active={p.uid === selected} onClick={() => setSelected(p.uid)} />
            ))}
            {personas.length === 0 && !peopleErr && <div className="px-1 pb-2 text-xs text-faint">No personas{q ? " match" : ""}.</div>}

            <div className="mt-3 px-1">
              <SectionTitle
                right={
                  <label className="flex cursor-pointer items-center gap-1 text-2xs text-faint">
                    <input type="checkbox" checked={showBots} onChange={(e) => setShowBots(e.target.checked)} className="accent-[var(--color-accent)]" />
                    bots ({botCount})
                  </label>
                }
              >
                Code contributors
              </SectionTitle>
            </div>
            {real.map((p) => (
              <RosterRow key={p.uid} p={p} active={p.uid === selected} onClick={() => setSelected(p.uid)} />
            ))}
          </div>
          <div className="border-t border-line px-3 py-2 text-2xs leading-relaxed text-faint">
            Personas are fictional. Contributors appear only with the code changes they made: real git history for Acme and Globex, invented for Slice.
          </div>
        </aside>

        {/* person + feed */}
        <section className="min-h-0 overflow-auto">
          {!person ? (
            <div className="pt-16 text-center text-sm text-faint">{people.length ? "Select a person." : peopleErr ? "" : <Spinner />}</div>
          ) : (
            <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-5">
              <PersonHeader p={person} lastPoll={lastPoll} />
              <StatsStrip p={person} />

              <div>
                <SectionTitle
                  right={
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-1.5 font-mono text-2xs text-faint">
                        <span className="relative inline-flex size-1.5">
                          <span className="absolute inset-0 animate-ping rounded-full bg-ok/60" />
                          <span className="relative size-1.5 rounded-full bg-ok" />
                        </span>
                        live · every {POLL_MS / 1000}s{lastPoll ? ` · ${fmtAgo(lastPoll)}` : ""}
                      </span>
                      {activity && activity.cypher.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowCypher((v) => !v)}
                          className={cx("rounded border px-1.5 font-mono text-2xs", showCypher ? "border-accent/50 text-accent" : "border-line-2 text-faint hover:text-fg")}
                        >
                          Why? cypher
                        </button>
                      )}
                    </div>
                  }
                >
                  Activity
                </SectionTitle>
                {showCypher && activity && (
                  <div className="mb-3 flex flex-col gap-2">
                    {activity.cypher.map((c, i) => (
                      <CypherBlock key={i} cypher={c} maxHeight={240} />
                    ))}
                  </div>
                )}
                {actErr && <div className="mb-2 rounded border border-bad/40 bg-bad/10 px-2 py-1.5 text-xs text-bad">Activity unavailable: {actErr}</div>}
                {loadingAct && !activity && (
                  <div className="flex items-center gap-2 text-xs text-faint">
                    <Spinner /> loading activity…
                  </div>
                )}
                {activity && activity.items.length === 0 && <div className="text-xs text-faint">No activity recorded.</div>}
                <ol className="relative flex flex-col">
                  {/* upcoming on-call weeks are a schedule, not activity: leave them out of the feed */}
                  {activity?.items.filter((it) => !(it.kind === "on_call" && it.at > Date.now())).map((it) => {
                    const since = newSince.current.get(itemKey(it));
                    const fresh = since !== undefined && Date.now() - since < NEW_HIGHLIGHT_MS;
                    return <FeedItem key={itemKey(it)} it={it} fresh={fresh} tenant={tenant} fixture={fixture} />;
                  })}
                </ol>
              </div>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function SourceBadge({ persona, synthetic }: { persona: boolean; synthetic?: boolean }) {
  return persona || synthetic ? (
    <span className="rounded border border-[#c084fc]/40 bg-[#c084fc]/10 px-1 font-mono text-[10px] leading-4 text-[#9333ea]" title={persona ? "Fictional persona (synthetic data)" : "Fictional author in a hand-written sample company"}>
      fictional
    </span>
  ) : (
    <span className="rounded border border-ok/40 bg-ok/10 px-1 font-mono text-[10px] leading-4 text-ok" title="Real public git author">
      real
    </span>
  );
}

function Avatar({ p, size = 28 }: { p: PersonSummary; size?: number }) {
  const initials = p.name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");
  const color = p.persona ? "#c084fc" : p.isBot ? "#64748b" : labelColor("Person");
  return (
    <span className="grid shrink-0 place-items-center rounded-full font-semibold" style={{ width: size, height: size, fontSize: size * 0.38, background: `${color}22`, color, border: `1px solid ${color}55` }}>
      {initials || "?"}
    </span>
  );
}

function RosterRow({ p, active, onClick }: { p: PersonSummary; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx("mb-0.5 flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left", active ? "border-accent/50 bg-accent/10" : "border-transparent hover:border-line hover:bg-panel-2")}
    >
      <Avatar p={p} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-fg">{p.name}</span>
          <SourceBadge persona={p.persona} synthetic={p.synthetic} />
          {p.isBot && <span className="font-mono text-[10px] text-faint">bot</span>}
        </span>
        <span className="block truncate text-2xs text-muted">
          {p.persona ? (p.role ?? "persona") : `${p.counts.prs} PRs`}
          {p.team ? ` · ${uidKey(p.team)}` : ""}
        </span>
      </span>
      {p.onCallNow.length > 0 && (
        <span className="shrink-0 rounded border border-warn/50 bg-warn/10 px-1 font-mono text-[10px] leading-4 text-warn" title={`On call now: ${p.onCallNow.map(uidKey).join(", ")}`}>
          on call
        </span>
      )}
    </button>
  );
}

function PersonHeader({ p, lastPoll }: { p: PersonSummary; lastPoll: number | null }) {
  void lastPoll;
  return (
    <div className="flex items-start gap-3 rounded-md border border-line bg-panel px-4 py-3">
      <Avatar p={p} size={44} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold tracking-tight">{p.name}</h1>
          <SourceBadge persona={p.persona} synthetic={p.synthetic} />
          {p.isBot && <span className="rounded border border-line-2 px-1 font-mono text-[10px] text-faint">bot</span>}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{p.persona ? (p.role ?? "Persona") : "Real contributor (public git history)"}</span>
          {p.team && <UidPill uid={p.team} size="xs" />}
          <span className="font-mono text-2xs text-faint">{p.uid}</span>
        </div>
        {p.onCallNow.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="rounded border border-warn/50 bg-warn/10 px-1.5 font-mono text-2xs text-warn">ON CALL NOW</span>
            {p.onCallNow.map((s) => (
              <UidPill key={s} uid={s} size="xs" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatsStrip({ p }: { p: PersonSummary }) {
  const stats: [string, number, string][] = [
    ["PRs", p.counts.prs, labelColor("PR")],
    ["Posts", p.counts.posts, labelColor("Thread")],
    ["Incidents", p.counts.incidents, labelColor("Incident")],
    ["On-call weeks", p.counts.onCallWeeks, "#fbbf24"],
    ["Decisions", p.counts.decisions, labelColor("Decision")],
    ["Agent findings", p.counts.findings, labelColor("Finding")],
  ];
  return (
    <div className="grid grid-cols-6 overflow-hidden rounded-md border border-line bg-panel">
      {stats.map(([label, n, color]) => (
        <div key={label} className="border-r border-line px-3 py-2 last:border-r-0">
          <div className="font-mono text-lg font-semibold tabular-nums" style={{ color: n ? color : "var(--color-faint)" }}>
            {n}
          </div>
          <div className="text-2xs text-muted">{label}</div>
        </div>
      ))}
    </div>
  );
}

function FeedItem({ it, fresh, tenant, fixture }: { it: PersonActivityItem; fresh: boolean; tenant: Tenant; fixture: boolean }) {
  const meta = KIND_META[it.kind] ?? KIND_META.action;
  return (
    <li className="relative grid grid-cols-[32px_1fr] gap-2.5">
      <div className="relative flex justify-center">
        <span className="absolute top-0 bottom-0 w-px bg-line" />
        <span className="relative mt-2 grid size-6 place-items-center rounded-md border bg-bg" style={{ borderColor: `${meta.color}66`, color: meta.color }} title={meta.label}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d={meta.path} />
          </svg>
        </span>
      </div>
      <div
        className={cx("mb-1.5 min-w-0 rounded-md border px-3 py-2 transition-colors duration-[1500ms]", fresh ? "animate-slide-in border-accent/60 bg-accent/10" : "border-line bg-panel")}
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-2xs uppercase" style={{ color: meta.color }}>
            {meta.label}
          </span>
          {fresh && <span className="rounded bg-accent/20 px-1 font-mono text-[10px] text-accent">new</span>}
          <span className="ml-auto shrink-0 font-mono text-2xs text-faint" title={new Date(it.at).toLocaleString()}>
            {fmtAgo(it.at)}
          </span>
        </div>
        <div className="mt-0.5 text-sm text-fg">{it.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-muted">
          <UidPill uid={it.uid} size="xs" />
          {it.detail && <span>{it.detail}</span>}
          {it.sessionId && (
            <Link href={`/memory?tenant=${tenant}&session=${it.sessionId}${fixture ? "&fixture=1" : ""}`} className="font-mono text-accent hover:underline">
              session {it.sessionId} →
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}
