"use client";
/**
 * One builder step: what you're modelling and why, a form per node label and
 * one for relationships (rendered from NODE_FORMS / REL_SHAPES in shared),
 * "fill the next example" from the starter company, the items already in the
 * graph (with delete), the exact Cypher that just ran, and "Try it" for the
 * agent tools this step unlocks.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { NODE_FORMS, REL_SHAPES, slugify, type BuilderField, type GEdge, type GNode, type GraphToolResult, type NodeLabel, type RelType, type Tenant } from "@blastradius/shared";
import { api, type BuilderResult, type GraphState, type StarterSample } from "@/lib/api";
import type { BuilderStep, TryTool } from "@/lib/builder-steps";
import { labelColor } from "@/lib/format";
import { CypherBlock, RowsTable, Spinner, UidPill, cx } from "@/components/ui";

type Values = Record<string, string>;

/** The uid a form's values will get (mirrors buildNode in @blastradius/graph). */
export function uidFor(label: NodeLabel, values: Values): string | null {
  const form = NODE_FORMS[label];
  const raw = form ? (values[form.key] ?? "").trim() : "";
  if (!form || !raw) return null;
  return `${label}:${form.slug ? slugify(raw) : raw}`;
}

function thisMonday(): string {
  const d = new Date();
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
  return m.toISOString().slice(0, 10);
}

/** Turns a starter value like "-3d" / "thisWeek" into something a form input shows. */
function showValue(v: string | number, kind?: BuilderField["kind"]): string {
  const s = String(v);
  const m = /^-(\d+)d$/.exec(s);
  if (m) {
    const d = new Date(Date.now() - Number(m[1]) * 86_400_000).toISOString().slice(0, 10);
    return kind === "date" || !kind ? d : s;
  }
  if (s === "thisWeek") return thisMonday();
  if (s === "lastWeek") {
    const d = new Date(Date.parse(`${thisMonday()}T00:00:00Z`) - 7 * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  return s;
}

const inputCls = "w-full rounded-md border border-line-2 bg-panel-2 px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent/60";

export interface StepPanelProps {
  tenant: Tenant;
  step: BuilderStep;
  state: GraphState;
  starter: StarterSample | null;
  onChanged: (r: BuilderResult, what: string) => Promise<void>;
  onError: (e: string | null) => void;
}

export function StepPanel({ tenant, step, state, starter, onChanged, onError }: StepPanelProps) {
  const nodes = state.graph.nodes;
  const edges = state.graph.edges;
  const sample = starter?.steps[step.id];
  const [seeding, setSeeding] = useState(false);

  const seedStep = async () => {
    setSeeding(true);
    onError(null);
    try {
      const r = await api.seedStep(tenant, step.id);
      await onChanged(r, `Seeded the ${step.short.toLowerCase()} sample: ${r.nodes} nodes, ${r.edges} relationships`);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSeeding(false);
    }
  };

  const pendingSample = useMemo(() => {
    if (!sample) return 0;
    const have = new Set(nodes.map((n) => n.id));
    const haveE = new Set(edges.map((e) => `${e.type}|${e.source}|${e.target}`));
    return (
      sample.nodes.filter((n) => {
        const u = uidFor(n.label as NodeLabel, n.values);
        return u && !have.has(u);
      }).length + sample.edges.filter((e) => !haveE.has(`${e.type}|${e.from}|${e.to}`)).length
    );
  }, [sample, nodes, edges]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-fg">{step.title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-2">{step.intro}</p>
        <div className="mt-3 rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs leading-relaxed text-fg-2">
          <b className="text-accent">Why the agents need it: </b>
          {step.why}
        </div>
      </div>

      {sample && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-panel-2 px-3 py-2.5">
          <div className="min-w-0 flex-1 text-xs text-fg-2">
            {pendingSample > 0 ? (
              <>
                Short on ideas? The sample company <b className="text-fg">Nimbus Coffee</b> has {pendingSample} items for this step. Add them one by one with{" "}
                <i>Fill next example</i>, or all at once (this also adds anything the earlier steps' samples provide):
              </>
            ) : (
              <>All of Nimbus Coffee's sample items for this step are in your graph.</>
            )}
          </div>
          {pendingSample > 0 && (
            <button type="button" disabled={seeding} onClick={() => void seedStep()} className="flex shrink-0 items-center gap-2 rounded-md border border-line-2 px-3 py-1.5 text-xs text-fg hover:bg-panel-3 disabled:opacity-50">
              {seeding && <Spinner />}
              Seed this step
            </button>
          )}
        </div>
      )}

      {step.labels.map((label) => (
        <NodeForm key={label} tenant={tenant} label={label} nodes={nodes} sample={sample?.nodes.filter((n) => n.label === label) ?? []} onChanged={onChanged} onError={onError} />
      ))}
      {step.rels.length > 0 && <EdgeForm tenant={tenant} rels={step.rels} nodes={nodes} edges={edges} sample={sample?.edges ?? []} onChanged={onChanged} onError={onError} />}

      <ItemsList tenant={tenant} step={step} nodes={nodes} edges={edges} onChanged={onChanged} onError={onError} />

      {step.try.length > 0 && <TryPanel tenant={tenant} tools={step.try} nodes={nodes} />}
    </div>
  );
}

function Card({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-fg">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function LabelChip({ label }: { label: string }) {
  const c = labelColor(label);
  return (
    <span className="rounded border px-1.5 font-mono text-xs" style={{ color: c, borderColor: `${c}55`, background: `${c}14` }}>
      {label}
    </span>
  );
}

function NodeForm({
  tenant,
  label,
  nodes,
  sample,
  onChanged,
  onError,
}: {
  tenant: Tenant;
  label: NodeLabel;
  nodes: GNode[];
  sample: { label: string; values: Record<string, string> }[];
  onChanged: StepPanelProps["onChanged"];
  onError: StepPanelProps["onError"];
}) {
  const form = NODE_FORMS[label]!;
  const [values, setValues] = useState<Values>({});
  const [busy, setBusy] = useState(false);
  const existing = new Set(nodes.map((n) => n.id));
  const next = sample.find((s) => {
    const u = uidFor(label, s.values);
    return u && !existing.has(u);
  });
  const preview = uidFor(label, values);

  const fill = () => {
    if (!next) return;
    const v: Values = {};
    for (const f of form.fields) if (next.values[f.name] !== undefined) v[f.name] = showValue(next.values[f.name]!, f.kind);
    setValues(v);
  };

  const submit = async () => {
    setBusy(true);
    onError(null);
    try {
      const payload: Record<string, string | string[]> = {};
      for (const f of form.fields) {
        const v = values[f.name];
        if (v === undefined || v.trim() === "") continue;
        payload[f.name] = f.kind === "lines" ? v.split("\n") : v;
      }
      const r = await api.addNode(tenant, label, payload);
      setValues({});
      await onChanged(r, `Added ${r.uid}`);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const required = form.fields.filter((f) => f.required).every((f) => (values[f.name] ?? "").trim() !== "");

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Add a <LabelChip label={label} />
        </span>
      }
      right={
        next ? (
          <button type="button" onClick={fill} className="shrink-0 text-2xs text-accent hover:underline">
            Fill next example
          </button>
        ) : null
      }
    >
      <p className="-mt-1 mb-3 text-xs text-muted">{form.help}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {form.fields.map((f) => (
          <label key={f.name} className={cx("block", (f.kind === "longtext" || f.kind === "lines") && "sm:col-span-2")}>
            <span className="mb-1 block text-2xs font-semibold tracking-[0.08em] text-muted uppercase">
              {f.label}
              {f.required && <span className="text-bad"> *</span>}
            </span>
            {f.kind === "enum" ? (
              <select value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} className={inputCls}>
                <option value="">{f.placeholder ? `— ${f.placeholder}` : "—"}</option>
                {f.options!.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : f.kind === "longtext" || f.kind === "lines" ? (
              <textarea value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} placeholder={f.placeholder} className={cx(inputCls, "min-h-[70px] resize-y")} />
            ) : (
              <input
                type={f.kind === "date" ? "date" : f.kind === "int" ? "number" : "text"}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                placeholder={f.placeholder}
                className={inputCls}
              />
            )}
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" disabled={!required || busy} onClick={() => void submit()} className="flex items-center gap-2 rounded-md bg-accent-2 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-accent disabled:opacity-50">
          {busy && <Spinner className="border-white/30 border-t-white" />}
          Add {label}
        </button>
        {preview && (
          <span className="text-2xs text-muted">
            will be stored as <code className="font-mono text-fg-2">{preview}</code>
            {existing.has(preview) && <span className="text-warn"> (exists: this updates it)</span>}
          </span>
        )}
      </div>
    </Card>
  );
}

function EdgeForm({
  tenant,
  rels,
  nodes,
  edges,
  sample,
  onChanged,
  onError,
}: {
  tenant: Tenant;
  rels: RelType[];
  nodes: GNode[];
  edges: GEdge[];
  sample: { type: string; from: string; to: string; props?: Record<string, string | number> }[];
  onChanged: StepPanelProps["onChanged"];
  onError: StepPanelProps["onError"];
}) {
  const [type, setType] = useState<RelType>(rels[0]!);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [props, setProps] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const shape = REL_SHAPES[type]!;
  const fromOpts = nodes.filter((n) => shape.from.includes(n.label)).sort((a, b) => a.name.localeCompare(b.name));
  const toOpts = nodes.filter((n) => shape.to.includes(n.label) && n.id !== from).sort((a, b) => a.name.localeCompare(b.name));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const haveE = new Set(edges.map((e) => `${e.type}|${e.source}|${e.target}`));
  // the next sample edge whose ends both exist already
  const next = sample.find((e) => rels.includes(e.type as RelType) && !haveE.has(`${e.type}|${e.from}|${e.to}`) && nodeIds.has(e.from) && nodeIds.has(e.to));

  useEffect(() => {
    if (from && !fromOpts.some((n) => n.id === from)) setFrom("");
    if (to && !toOpts.some((n) => n.id === to)) setTo("");
    if (type === "ON_CALL_FOR" && !props.weekStart) setProps((p) => ({ ...p, weekStart: thisMonday() }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, nodes]);

  const fill = () => {
    if (!next) return;
    setType(next.type as RelType);
    setFrom(next.from);
    setTo(next.to);
    setProps(Object.fromEntries(Object.entries(next.props ?? {}).map(([k, v]) => [k, showValue(v)])));
  };

  const submit = async () => {
    setBusy(true);
    onError(null);
    try {
      const clean: Record<string, string | number> = {};
      for (const k of shape.props ?? []) if (props[k]) clean[k] = props[k]!;
      const r = await api.addEdge(tenant, type, from, to, clean);
      setFrom("");
      setTo("");
      await onChanged(r, `Connected ${from} -[:${type}]-> ${to}`);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const needNodes = fromOpts.length === 0 || toOpts.length === 0;

  return (
    <Card
      title="Draw a relationship"
      right={
        next ? (
          <button type="button" onClick={fill} className="shrink-0 text-2xs text-accent hover:underline">
            Fill next example
          </button>
        ) : null
      }
    >
      <div className="flex flex-wrap gap-1.5">
        {rels.map((r) => (
          <button key={r} type="button" onClick={() => setType(r)} className={cx("rounded border px-2 py-0.5 font-mono text-2xs", r === type ? "border-accent/60 bg-accent/15 text-accent" : "border-line-2 text-muted hover:text-fg")}>
            {r}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">
        <span className="font-mono text-fg-2">
          ({shape.from.join("|")})-[:{type}]-&gt;({shape.to.join("|")})
        </span>
        : {shape.help}
      </p>
      {needNodes ? (
        <p className="mt-3 rounded-md border border-dashed border-line-2 px-3 py-3 text-xs text-faint">
          Add at least one {shape.from.join(" or ")} and one {shape.to.join(" or ")} first.
        </p>
      ) : (
        <div className="mt-3 grid items-end gap-2 sm:grid-cols-[1fr_auto_1fr]">
          <select value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} aria-label="from">
            <option value="">from…</option>
            {fromOpts.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}: {n.name}
              </option>
            ))}
          </select>
          <span className="hidden px-1 pb-2 font-mono text-2xs text-muted sm:block">—{type}→</span>
          <select value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} aria-label="to">
            <option value="">to…</option>
            {toOpts.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}: {n.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {(shape.props ?? []).length > 0 && !needNodes && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {(shape.props ?? []).map((k) => (
            <label key={k} className="block">
              <span className="mb-1 block text-2xs font-semibold tracking-[0.08em] text-muted uppercase">{k}</span>
              <input
                type={k === "weekStart" ? "date" : "text"}
                value={props[k] ?? ""}
                onChange={(e) => setProps({ ...props, [k]: e.target.value })}
                placeholder={k === "protocol" ? "grpc, http, postgres…" : ""}
                className={inputCls}
              />
            </label>
          ))}
        </div>
      )}
      {!needNodes && (
        <button type="button" disabled={!from || !to || busy} onClick={() => void submit()} className="mt-3 flex items-center gap-2 rounded-md bg-accent-2 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-accent disabled:opacity-50">
          {busy && <Spinner className="border-white/30 border-t-white" />}
          Connect
        </button>
      )}
    </Card>
  );
}

function ItemsList({
  tenant,
  step,
  nodes,
  edges,
  onChanged,
  onError,
}: {
  tenant: Tenant;
  step: BuilderStep;
  nodes: GNode[];
  edges: GEdge[];
  onChanged: StepPanelProps["onChanged"];
  onError: StepPanelProps["onError"];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const mine = nodes.filter((n) => step.labels.includes(n.label)).sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
  const derived = step.id === "code" ? edges.filter((e) => e.type === "TOUCHES" || e.type === "COLLABORATES_WITH") : [];
  const myEdges = edges.filter((e) => step.rels.includes(e.type));
  if (mine.length === 0 && myEdges.length === 0) return null;

  const del = async (key: string, fn: () => Promise<BuilderResult>, what: string) => {
    setBusy(key);
    onError(null);
    try {
      await onChanged(await fn(), what);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={`In your graph (${mine.length} nodes, ${myEdges.length} relationships)`}>
      {mine.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {mine.map((n) => (
            <li key={n.id} className="flex items-center gap-1 rounded border border-line bg-panel-2 py-0.5 pr-1 pl-0.5">
              <UidPill uid={n.id} name={n.name} size="xs" />
              <button type="button" title={`Delete ${n.id} and its relationships`} disabled={busy !== null} onClick={() => void del(n.id, () => api.deleteNode(tenant, n.id), `Deleted ${n.id}`)} className="px-1 text-xs text-faint hover:text-bad disabled:opacity-40">
                {busy === n.id ? "…" : "×"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {myEdges.length > 0 && (
        <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto pr-1">
          {myEdges.map((e) => (
            <li key={e.id} className="flex items-center gap-2 font-mono text-2xs text-fg-2">
              <span className="min-w-0 flex-1 truncate">
                {e.source.split(":").slice(1).join(":")} <span className="text-muted">—{e.type}→</span> {e.target.split(":").slice(1).join(":")}
                {e.props.protocol ? <span className="text-faint"> ({String(e.props.protocol)})</span> : null}
                {e.props.weekStart ? <span className="text-faint"> (week of {String(e.props.weekStart)})</span> : null}
              </span>
              <button type="button" title="Delete this relationship" disabled={busy !== null} onClick={() => void del(e.id, () => api.deleteEdge(tenant, e.type, e.source, e.target), `Deleted ${e.type}`)} className="px-1 text-xs text-faint hover:text-bad disabled:opacity-40">
                {busy === e.id ? "…" : "×"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {derived.length > 0 && (
        <p className="mt-3 text-2xs text-muted">
          Derived for you: {derived.filter((e) => e.type === "TOUCHES").length} <span className="font-mono">TOUCHES</span> and {derived.filter((e) => e.type === "COLLABORATES_WITH").length}{" "}
          <span className="font-mono">COLLABORATES_WITH</span> relationships (recomputed after every change).
        </p>
      )}
    </Card>
  );
}

function TryPanel({ tenant, tools, nodes }: { tenant: Tenant; tools: TryTool[]; nodes: GNode[] }) {
  const services = nodes.filter((n) => n.label === "Service").sort((a, b) => a.name.localeCompare(b.name));
  const [i, setI] = useState(0);
  const tool = tools[i] ?? tools[0]!;
  const [service, setService] = useState("");
  const [text, setText] = useState(tool.placeholder ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GraphToolResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!services.some((s) => s.id === service)) setService(services[0]?.id ?? "");
  }, [services, service]);
  useEffect(() => {
    setText(tool.placeholder ?? "");
    setResult(null);
    setErr(null);
  }, [tool]);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setResult(await api.tryTool(tenant, tool.tool, tool.build(tool.input === "service" ? service : text)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || (tool.input === "service" && !service) || (tool.input === "text" && !text.trim());

  return (
    <Card title="Try it: run the agents' tool on your graph">
      <div className="flex flex-wrap gap-1.5">
        {tools.map((t, k) => (
          <button key={t.tool} type="button" onClick={() => setI(k)} className={cx("rounded border px-2 py-0.5 text-2xs", k === i ? "border-accent/60 bg-accent/15 text-accent" : "border-line-2 text-muted hover:text-fg")}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="rounded bg-panel-3 px-1.5 font-mono text-xs text-fg">{tool.tool}</code>
        {tool.input === "service" && (
          <select value={service} onChange={(e) => setService(e.target.value)} className="min-w-40 rounded-md border border-line-2 bg-panel-2 px-2.5 py-1.5 text-sm text-fg outline-none focus:border-accent/60">
            {services.length === 0 && <option value="">no services yet</option>}
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        {tool.input === "text" && <input value={text} onChange={(e) => setText(e.target.value)} placeholder={tool.placeholder} className="min-w-0 flex-1 rounded-md border border-line-2 bg-panel-2 px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent/60" />}
        <button type="button" disabled={disabled} onClick={() => void run()} className="flex items-center gap-2 rounded-md border border-accent/50 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/20 disabled:opacity-50">
          {busy && <Spinner />}
          Run
        </button>
      </div>
      {err && <div className="mt-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</div>}
      {result && (
        <div className="animate-fade-in mt-3 space-y-2">
          <div className="rounded-md border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">
            {result.summary} <span className="text-faint">· {result.ms} ms</span>
          </div>
          <RowsTable rows={result.rows} max={8} />
          <details>
            <summary className="cursor-pointer text-2xs text-muted hover:text-fg">The Cypher the agent runs (this is what a Why? chip shows)</summary>
            <div className="mt-2">
              <CypherBlock cypher={result.cypher} maxHeight={300} />
            </div>
          </details>
        </div>
      )}
    </Card>
  );
}
