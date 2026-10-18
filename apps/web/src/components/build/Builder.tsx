"use client";
/**
 * /build: build a graph by hand, one step at a time.
 *   0. create the graph (a new FalkorDB graph key + its indexes)
 *   1-6. BUILDER_STEPS: services → dependencies → people → code → incidents → company brain
 *   7. investigate: hand the graph to the agents
 * Left: the steps with live progress. Middle: the current step. Right: the
 * graph as it grows. Every write shows the exact Cypher that ran.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SEED_PACKS, TENANT_INFO, TENANT_SLUG_RE, slugify, type GNode, type Json, type Tenant } from "@blastradius/shared";
import { api, type BuilderResult, type GraphState, type StarterSample, type WorkspaceInfo } from "@/lib/api";
import { BUILDER_STEPS, stepProgress } from "@/lib/builder-steps";
import { AppShell, ButtonLink, companyName } from "@/components/shell/AppShell";
import { GraphPanel } from "@/components/graph/GraphPanel";
import { CypherBlock, Spinner, cx } from "@/components/ui";
import { StepPanel } from "./StepPanel";

interface LastRun {
  what: string;
  cypher: string[];
  params?: Json;
  ms: number;
}

export function Builder() {
  const router = useRouter();
  const params = useSearchParams();
  const tenant = params.get("tenant");
  const stepId = params.get("step") ?? (tenant ? BUILDER_STEPS[0]!.id : "create");

  const [graphs, setGraphs] = useState<WorkspaceInfo[]>([]);
  const [state, setState] = useState<GraphState | null>(null);
  const [starter, setStarter] = useState<StarterSample | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [selected, setSelected] = useState<GNode | null>(null);
  const [fresh, setFresh] = useState<Set<string> | null>(null);

  const go = (t: string | null, step?: string) => router.push(t ? `/build?tenant=${t}${step ? `&step=${step}` : ""}` : "/build");

  const refreshGraphs = useCallback(() => api.graphs().then(setGraphs).catch(() => setGraphs([])), []);
  const refresh = useCallback(async () => {
    if (!tenant) return;
    try {
      setState(await api.graphState(tenant));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [tenant]);

  useEffect(() => {
    void refreshGraphs();
    api.starter().then(setStarter).catch(() => setStarter(null));
  }, [refreshGraphs]);
  useEffect(() => {
    setState(null);
    void refresh();
  }, [refresh]);

  const onChanged = useCallback(
    async (r: BuilderResult, what: string) => {
      setLastRun({ what, cypher: r.cypher, ...(r.params !== undefined ? { params: r.params } : {}), ms: r.ms });
      setFresh(r.uid ? new Set([r.uid]) : null);
      await refresh();
      void refreshGraphs();
    },
    [refresh, refreshGraphs],
  );

  const step = BUILDER_STEPS.find((s) => s.id === stepId) ?? null;
  const idx = step ? BUILDER_STEPS.indexOf(step) : stepId === "investigate" ? BUILDER_STEPS.length : -1;
  const nextId = idx + 1 < BUILDER_STEPS.length ? BUILDER_STEPS[idx + 1]!.id : "investigate";
  const prevId = idx > 0 ? (BUILDER_STEPS[idx - 1]?.id ?? null) : null;

  return (
    <AppShell
      active="build"
      tenant={tenant ?? undefined}
      graphs={graphs}
      onTenantChange={(t) => go(t)}
      layout="fill"
      crumbs={[{ label: "Companies", href: "/start" }, ...(tenant ? [{ label: companyName(tenant, graphs), href: `/?tenant=${tenant}` }] : []), { label: "Graph builder" }]}
      title={tenant ? `Graph builder: ${companyName(tenant, graphs)}` : "Create a company graph"}
      description="Add one kind of data at a time. Each step shows what it adds, the exact Cypher that runs, and which agent tool it unlocks."
      actions={
        <>
          <select
            value={tenant ?? ""}
            onChange={(e) => go(e.target.value || null)}
            className="max-w-56 min-w-0 rounded-lg border-2 border-line-2 bg-panel px-2 py-1 text-sm text-fg outline-none focus:border-accent"
            aria-label="Company graph"
          >
            <option value="">+ New company graph</option>
            {graphs.map((g) => (
              <option key={g.id} value={g.id}>
                {companyName(g.id, graphs)} ({g.nodes})
              </option>
            ))}
          </select>
          {tenant && (
            <ButtonLink href={`/?tenant=${tenant}`} variant="primary">
              Investigate
            </ButtonLink>
          )}
        </>
      }
    >

      {!tenant ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <CreateGraph
            existing={graphs}
            onCreated={(w, cypher) => {
              setLastRun({ what: `Created the graph ${w.id}`, cypher, ms: 0 });
              void refreshGraphs();
              go(w.id, BUILDER_STEPS[0]!.id);
            }}
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 content-start overflow-y-auto lg:grid-cols-[210px_minmax(0,1fr)_minmax(0,0.9fr)] lg:content-stretch lg:overflow-hidden">
          {/* steps */}
          <nav className="flex gap-1 overflow-x-auto border-b border-line bg-panel p-2 lg:flex-col lg:overflow-y-auto lg:border-r lg:border-b-0">
            <StepLink n={0} label="Create graph" active={false} done onClick={() => undefined} />
            {BUILDER_STEPS.map((s, i) => {
              const p = stepProgress(s, state?.counts ?? null);
              return <StepLink key={s.id} n={i + 1} label={s.short} active={s.id === stepId} done={p.done} partial={p.have > 0 && !p.done} onClick={() => go(tenant, s.id)} />;
            })}
            <StepLink n={BUILDER_STEPS.length + 1} label="Investigate" active={stepId === "investigate"} done={false} onClick={() => go(tenant, "investigate")} />
          </nav>

          {/* the step */}
          <main className="px-4 py-5 sm:px-6 lg:min-h-0 lg:overflow-y-auto">
            {error && <div className="mb-4 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</div>}
            {!state && !error && (
              <div className="flex items-center gap-2 text-xs text-muted">
                <Spinner /> Reading the graph from FalkorDB…
              </div>
            )}
            {state && step && <StepPanel tenant={tenant} step={step} state={state} starter={starter} onChanged={onChanged} onError={setError} />}
            {state && stepId === "investigate" && (
              <InvestigateStep
                tenant={tenant}
                state={state}
                onChanged={onChanged}
                onError={setError}
                onDeleted={() => {
                  void refreshGraphs();
                  router.push("/start");
                }}
              />
            )}

            {lastRun && <LastRunPanel run={lastRun} onClose={() => setLastRun(null)} />}

            {state && (
              <div className="mt-6 flex items-center justify-between border-t border-line pt-4">
                {prevId ? (
                  <button type="button" onClick={() => go(tenant, prevId)} className="text-xs text-fg-2 hover:text-fg">
                    ← Back
                  </button>
                ) : (
                  <span />
                )}
                {stepId !== "investigate" && (
                  <button type="button" onClick={() => go(tenant, nextId)} className="rounded-md bg-accent-2 px-4 py-1.5 text-xs font-medium text-white hover:bg-accent">
                    Next: {nextId === "investigate" ? "Investigate" : BUILDER_STEPS.find((s) => s.id === nextId)!.short} →
                  </button>
                )}
              </div>
            )}
          </main>

          {/* the graph as it grows */}
          <aside className="relative h-[380px] min-h-0 border-t border-line lg:h-auto lg:border-t-0 lg:border-l">
            {state && state.graph.nodes.length === 0 ? (
              <div className="absolute inset-0 grid place-items-center p-6 text-center text-xs text-faint">
                Your graph is empty.
                <br />
                Add a node and it appears here.
              </div>
            ) : (
              <GraphPanel
                nodes={state?.graph.nodes ?? []}
                edges={state?.graph.edges ?? []}
                involved={fresh}
                focus={null}
                selected={selected}
                loading={!state}
                fitKey={`${tenant}-${state?.graph.nodes.length ?? 0}`}
                title={`${state?.workspace.name ?? tenant} graph`}
                onNodeClick={setSelected}
                onClearSelection={() => setSelected(null)}
              />
            )}
          </aside>
        </div>
      )}
    </AppShell>
  );
}

function StepLink({ n, label, active, done, partial, onClick }: { n: number; label: string; active: boolean; done: boolean; partial?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx("flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs", active ? "bg-panel-3 text-fg" : "text-fg-2 hover:bg-panel-2 hover:text-fg")}
    >
      <span
        className={cx(
          "flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-2xs",
          done ? "border-ok bg-ok/15 text-ok" : partial ? "border-warn/60 text-warn" : active ? "border-accent text-accent" : "border-line-2 text-muted",
        )}
      >
        {done ? "✓" : n}
      </span>
      {label}
    </button>
  );
}

function LastRunPanel({ run, onClose }: { run: LastRun; onClose: () => void }) {
  return (
    <section className="animate-fade-in mt-5 rounded-lg border border-ok/30 bg-panel p-4">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-ok" />
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-fg">What just ran in FalkorDB</h2>
        <button type="button" onClick={onClose} className="text-xs text-faint hover:text-fg">
          ×
        </button>
      </div>
      <p className="mt-1 text-xs text-fg-2">
        {run.what}
        {run.ms ? <span className="text-faint"> · {run.ms} ms</span> : null}
      </p>
      <div className="mt-3 space-y-2">
        {run.cypher.slice(0, 6).map((c, i) => (
          <CypherBlock key={i} cypher={c} maxHeight={180} />
        ))}
        {run.cypher.length > 6 && <p className="text-2xs text-muted">+{run.cypher.length - 6} more statements (the indexes for every label).</p>}
        {run.params !== undefined && (
          <details>
            <summary className="cursor-pointer text-2xs text-muted hover:text-fg">Parameters (values are never pasted into the query text)</summary>
            <pre className="code mt-2 max-h-48 overflow-auto rounded-md border border-line bg-panel-3 p-2.5 text-fg-2">{JSON.stringify(run.params, null, 2)}</pre>
          </details>
        )}
      </div>
    </section>
  );
}

function CreateGraph({ existing, onCreated }: { existing: WorkspaceInfo[]; onCreated: (w: WorkspaceInfo, cypher: string[]) => void }) {
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const autoId = slugify(name).slice(0, 30).replace(/^[^a-z]+/, "");
  const finalId = idTouched ? id : autoId;
  const taken = existing.some((g) => g.id === finalId);
  const valid = name.trim().length >= 2 && TENANT_SLUG_RE.test(finalId) && !taken;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.createGraph(finalId, name.trim(), description.trim());
      onCreated(r.workspace, r.cypher);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <div className="font-mono text-2xs tracking-[0.12em] text-accent uppercase">Step 0</div>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-fg">Create a new graph</h1>
      <p className="mt-3 text-sm leading-relaxed text-fg-2">
        Blastradius keeps <b className="text-fg">one FalkorDB graph per company</b>. Services, code, people, incidents, decisions and the agents' own memory
        all live in it. You'll build yours from nothing, one kind of node at a time, and after each step you can run the agents' tools to see what the new
        data unlocks.
      </p>

      <div className="mt-6 space-y-4 rounded-lg border border-line bg-panel p-5">
        <label className="block">
          <span className="mb-1 block text-2xs font-semibold tracking-[0.08em] text-muted uppercase">Company or graph name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Nimbus Coffee" className="w-full rounded-md border border-line-2 bg-panel-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent/60" />
        </label>
        <label className="block">
          <span className="mb-1 block text-2xs font-semibold tracking-[0.08em] text-muted uppercase">Graph id</span>
          <input
            value={finalId}
            onChange={(e) => {
              setIdTouched(true);
              setId(e.target.value.toLowerCase());
            }}
            placeholder="nimbus-coffee"
            className="w-full rounded-md border border-line-2 bg-panel-2 px-3 py-2 font-mono text-sm text-fg outline-none focus:border-accent/60"
          />
          <span className={cx("mt-1 block text-2xs", taken ? "text-bad" : "text-muted")}>
            {taken ? (
              "That id is taken."
            ) : (
              <>
                Stored in FalkorDB as the graph key <code className="font-mono text-fg-2">blastradius_{finalId || "…"}</code>
              </>
            )}
          </span>
        </label>
        <label className="block">
          <span className="mb-1 block text-2xs font-semibold tracking-[0.08em] text-muted uppercase">Description (optional)</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="An online coffee shop" className="w-full rounded-md border border-line-2 bg-panel-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent/60" />
        </label>
        {err && <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</div>}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={!valid || busy} onClick={() => void submit()} className="flex items-center gap-2 rounded-md bg-accent-2 px-4 py-2 text-sm font-medium text-white hover:bg-accent disabled:opacity-50">
            {busy && <Spinner className="border-white/30 border-t-white" />}
            Create graph
          </button>
          <button
            type="button"
            onClick={() => {
              setName("Nimbus Coffee");
              setIdTouched(false);
              setDescription("A small online coffee shop (the tutorial's sample company)");
            }}
            className="text-xs text-accent hover:underline"
          >
            Use the sample company's name
          </button>
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-line bg-panel-2 p-4 text-xs leading-relaxed text-fg-2">
        <b className="text-fg">What happens when you click Create:</b> FalkorDB creates the graph key, then Blastradius creates its indexes: a range index on{" "}
        <code className="font-mono">uid</code> for every label (fast MERGE), full-text indexes on names, and 384-dimension vector indexes for incidents, decisions,
        docs, tickets and threads. Then it writes one <code className="font-mono">(:Workspace)</code> node describing the graph. You'll see every statement.
      </div>
    </div>
  );
}

function InvestigateStep({
  tenant,
  state,
  onChanged,
  onError,
  onDeleted,
}: {
  tenant: Tenant;
  state: GraphState;
  onChanged: (r: BuilderResult, what: string) => Promise<void>;
  onError: (e: string | null) => void;
  onDeleted: () => void;
}) {
  const c = state.counts;
  const n = (k: string) => c.labels[k] ?? c.rels[k] ?? 0;
  const services = useMemo(() => state.graph.nodes.filter((x) => x.label === "Service").sort((a, b) => a.name.localeCompare(b.name)), [state]);
  // suggest the service that recent changes touched most (a likely suspect story)
  const suggested = useMemo(() => {
    const touched = new Map<string, number>();
    for (const e of state.graph.edges) if (e.type === "TOUCHES") touched.set(e.target, (touched.get(e.target) ?? 0) + 1);
    return [...touched.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? services[0]?.id ?? "";
  }, [state, services]);
  const [service, setService] = useState("");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const svc = service || suggested;
  const svcName = services.find((s) => s.id === svc)?.name ?? svc.replace(/^Service:/, "");

  const checks: [string, boolean, string][] = [
    ["What else breaks? (blast radius)", n("DEPENDS_ON") > 0, "needs DEPENDS_ON"],
    ["What probably caused it? (suspect PRs)", n("TOUCHES") > 0, "needs PRs that MODIFY files PART_OF services"],
    ["Who can fix it? (PageRank over co-authors)", n("AUTHORED") > 0, "needs AUTHORED PRs"],
    ["Who is on call?", n("ON_CALL_FOR") > 0, "needs ON_CALL_FOR"],
    ["What worked last time? (incidents + vectors)", n("AFFECTED") > 0, "needs incidents that AFFECTED a service"],
    ["Ask the company (decisions, docs, tickets, chat)", n("Decision") + n("Doc") + n("Issue") + n("Thread") > 0, "needs knowledge nodes"],
  ];

  const seedPack = async (pack: string) => {
    setBusy(pack);
    onError(null);
    try {
      const r = await api.seedPack(tenant, pack);
      await onChanged({ cypher: [], ms: r.ms }, `Merged the ${pack} sample company into this graph: ${r.nodes} nodes, ${r.edges} relationships`);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const del = async () => {
    setBusy("delete");
    try {
      await api.deleteGraph(tenant);
      onDeleted();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-fg">Hand your graph to the agents</h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-2">
          Five agents (Triage, Investigator, Expert, Scribe, Navigator) now investigate over <b className="text-fg">your</b> graph. Each answer they give has a Why?
          chip with the exact Cypher that produced it.
        </p>
      </div>

      <section className="rounded-lg border border-line bg-panel p-4">
        <h2 className="text-sm font-semibold text-fg">What your graph can answer</h2>
        <ul className="mt-3 space-y-1.5">
          {checks.map(([label, ok, hint]) => (
            <li key={label} className="flex items-center gap-2 text-xs">
              <span className={cx("flex size-4 items-center justify-center rounded-full text-[10px]", ok ? "bg-ok/20 text-ok" : "bg-line-2 text-faint")}>{ok ? "✓" : "–"}</span>
              <span className={ok ? "text-fg-2" : "text-muted"}>{label}</span>
              {!ok && <span className="text-2xs text-faint">({hint})</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-accent/40 bg-accent/5 p-4">
        <h2 className="text-sm font-semibold text-fg">Fire an alert</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select value={svc} onChange={(e) => setService(e.target.value)} className="rounded-md border border-line-2 bg-panel-2 px-2.5 py-1.5 text-sm text-fg outline-none">
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Link
            href={`/?tenant=${tenant}&q=${encodeURIComponent(`${svcName} 5xx at 12%`)}`}
            className={cx("rounded-md bg-accent-2 px-4 py-1.5 text-xs font-medium text-white hover:bg-accent", !svc && "pointer-events-none opacity-50")}
          >
            Investigate “{svcName} 5xx at 12%” →
          </Link>
        </div>
        <h2 className="mt-5 text-sm font-semibold text-fg">Or ask the company</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="why do we retry payments?" className="min-w-0 flex-1 rounded-md border border-line-2 bg-panel-2 px-2.5 py-1.5 text-sm text-fg outline-none" />
          <Link
            href={`/?tenant=${tenant}&mode=ask&q=${encodeURIComponent(question || "why do we retry payments?")}`}
            className="rounded-md border border-accent/50 px-4 py-1.5 text-xs font-medium text-accent hover:bg-accent/10"
          >
            Ask →
          </Link>
        </div>
      </section>

      <section className="rounded-lg border border-line bg-panel p-4">
        <h2 className="text-sm font-semibold text-fg">Seed a big sample company (optional)</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Merge a full company built from real public git history into this graph: hundreds of services, files and PRs, plus synthetic tickets, chat and incidents.
          It comes with ready-made demo scenarios.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {SEED_PACKS.map((p) => (
            <button key={p} type="button" disabled={busy !== null || state.workspace.seeded.includes(p)} onClick={() => void seedPack(p)} className="flex items-center gap-2 rounded-md border border-line-2 px-3 py-1.5 text-xs text-fg-2 hover:text-fg disabled:opacity-50">
              {busy === p && <Spinner />}
              {state.workspace.seeded.includes(p) ? "✓ " : "+ "}
              {TENANT_INFO[p].name} <span className="text-faint">({TENANT_INFO[p].sourceRepo})</span>
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-bad/30 bg-bad/5 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-fg">Delete this graph</h2>
            <p className="mt-1 text-xs text-muted">Removes the FalkorDB graph key: every node, relationship, index and all agent memory.</p>
          </div>
          {armed ? (
            <div className="flex gap-2">
              <button type="button" disabled={busy !== null} onClick={() => void del()} className="flex items-center gap-2 rounded-md bg-bad px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                {busy === "delete" && <Spinner className="border-white/30 border-t-white" />}
                Yes, delete {tenant}
              </button>
              <button type="button" onClick={() => setArmed(false)} className="rounded-md border border-line-2 px-3 py-1.5 text-xs text-fg-2">
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setArmed(true)} className="rounded-md border border-bad/50 px-3 py-1.5 text-xs text-bad hover:bg-bad/10">
              Delete graph…
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
