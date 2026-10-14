"use client";
/**
 * Right-hand graph panel: force graph + legend + node details. Pure view —
 * the Console owns the data (overview + expansions + run graph) and focus.
 */
import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { GEdge, GNode, Json } from "@blastradius/shared";
import { fmtColumn, labelColor } from "@/lib/format";
import { Spinner, UidPill, cx } from "@/components/ui";

const ForceGraph = dynamic(() => import("./ForceGraph"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 grid place-items-center text-xs text-faint">loading graph…</div>,
});

export interface GraphPanelProps {
  nodes: GNode[];
  edges: GEdge[];
  involved: Set<string> | null;
  focus: Set<string> | null;
  selected: GNode | null;
  loading?: boolean;
  error?: string | null;
  expanding?: string | null;
  fitKey?: string | number;
  title?: string;
  compact?: boolean;
  onNodeClick?: (n: GNode) => void;
  onClearSelection?: () => void;
  onClearFocus?: () => void;
  onUid?: (uid: string) => void;
}

const HIDDEN_PROPS = new Set(["embedding", "uid", "synthetic"]);

export function GraphPanel(p: GraphPanelProps) {
  const labelsPresent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of p.nodes) counts.set(n.label, (counts.get(n.label) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [p.nodes]);

  const selEdges = useMemo(() => {
    if (!p.selected) return [];
    const id = p.selected.id;
    return p.edges.filter((e) => e.source === id || e.target === id).slice(0, 14);
  }, [p.selected, p.edges]);

  const involvedCount = p.involved ? [...p.involved].filter((id) => !id.includes("->")).length : 0;

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden bg-[radial-gradient(ellipse_at_center,#10141d_0%,#090b0f_70%)]">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(#ffffff05_1px,transparent_1px),linear-gradient(90deg,#ffffff05_1px,transparent_1px)] bg-[size:32px_32px]" />
      <ForceGraph
        nodes={p.nodes}
        edges={p.edges}
        involved={p.involved}
        focus={p.focus}
        selected={p.selected?.id ?? null}
        onNodeClick={p.onNodeClick}
        onBackgroundClick={p.onClearSelection}
        fitKey={p.fitKey}
        compact={p.compact}
      />

      {/* header strip */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
        <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-line bg-panel/85 px-2 py-1 text-xs backdrop-blur">
          <span className="font-medium text-fg-2">{p.title ?? "Company graph"}</span>
          <span className="font-mono text-2xs text-faint">
            {p.nodes.length} nodes · {p.edges.length} edges
          </span>
          {involvedCount > 0 && <span className="font-mono text-2xs text-accent">{involvedCount} involved</span>}
          {(p.loading || p.expanding) && <Spinner />}
        </div>
        {p.focus && p.focus.size > 0 && (
          <button
            type="button"
            onClick={p.onClearFocus}
            className="pointer-events-auto rounded-md border border-accent/50 bg-accent/15 px-2 py-1 text-xs text-accent backdrop-blur hover:bg-accent/25"
          >
            Focused path · clear <span className="font-mono text-2xs opacity-70">esc</span>
          </button>
        )}
      </div>

      {p.error && (
        <div className="absolute inset-x-3 top-12 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
          Graph unavailable: {p.error}
        </div>
      )}

      {/* legend */}
      <div className="absolute bottom-2.5 left-2.5 flex max-w-[60%] flex-wrap gap-x-2.5 gap-y-1 rounded-md border border-line bg-panel/85 px-2 py-1.5 backdrop-blur">
        {labelsPresent.map(([label, count]) => (
          <span key={label} className="inline-flex items-center gap-1 text-2xs text-muted">
            <span className={cx("size-2", label === "Team" || label === "Agent" ? "" : label === "PR" || label === "Incident" || label === "Finding" ? "rotate-45" : "rounded-full")} style={{ background: labelColor(label) }} />
            {label}
            <span className="font-mono text-faint">{count}</span>
          </span>
        ))}
      </div>

      {/* details */}
      {p.selected && (
        <div className="animate-fade-in absolute top-12 right-2.5 w-72 overflow-hidden rounded-md border border-line-2 bg-panel/95 shadow-2xl backdrop-blur">
          <div className="flex items-start justify-between gap-2 border-b border-line px-2.5 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium" style={{ color: labelColor(p.selected.label) }}>
                {p.selected.name}
              </div>
              <div className="truncate font-mono text-2xs text-faint">{p.selected.id}</div>
            </div>
            <button type="button" onClick={p.onClearSelection} className="text-faint hover:text-fg" aria-label="close details">
              ×
            </button>
          </div>
          <dl className="max-h-48 overflow-auto px-2.5 py-1.5 text-2xs">
            {Object.entries(p.selected.props)
              .filter(([k]) => !HIDDEN_PROPS.has(k))
              .slice(0, 14)
              .map(([k, v]) => (
                <div key={k} className="grid grid-cols-[88px_1fr] gap-2 py-0.5">
                  <dt className="truncate font-mono text-faint">{k}</dt>
                  <dd className="truncate text-fg-2" title={typeof v === "string" ? v : JSON.stringify(v)}>
                    {k === "url" && typeof v === "string" ? (
                      <a href={v} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                        {v.replace(/^https?:\/\//, "")}
                      </a>
                    ) : (
                      fmtColumn(k, v as Json)
                    )}
                  </dd>
                </div>
              ))}
            {Object.keys(p.selected.props).length === 0 && <div className="py-1 text-faint">No properties loaded yet{p.expanding ? "…" : "."}</div>}
          </dl>
          {selEdges.length > 0 && (
            <div className="border-t border-line px-2.5 py-1.5">
              <div className="pb-1 text-2xs text-faint uppercase">Edges</div>
              <div className="flex max-h-36 flex-col gap-0.5 overflow-auto">
                {selEdges.map((e) => {
                  const out = e.source === p.selected!.id;
                  const other = out ? e.target : e.source;
                  return (
                    <div key={e.id} className="flex items-center gap-1 font-mono text-2xs text-muted">
                      <span className="w-4 text-faint">{out ? "→" : "←"}</span>
                      <span className="w-24 shrink-0 truncate">{e.type}</span>
                      <UidPill uid={other} size="xs" onClick={p.onUid} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
