"use client";
/**
 * Canvas force graph (react-force-graph-2d). Loaded only in the browser via
 * next/dynamic({ ssr:false }) from GraphCanvas — the library touches `window`.
 *
 * Node/link objects are kept in refs and REUSED across renders: force-graph
 * stores x/y/vx/vy on them, so recreating objects would re-layout everything
 * every time a new event streams in.
 */
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";
import { useEffect, useMemo, useRef, useState } from "react";
// @ts-expect-error d3-force-3d ships no types; we only use forceX/forceY.
import { forceX, forceY } from "d3-force-3d";
import type { GEdge, GNode } from "@blastradius/shared";
import { labelColor } from "@/lib/format";

export interface ForceGraphProps {
  nodes: GNode[];
  edges: GEdge[];
  /** elements involved in the current run; everything else dims. null = nothing dims */
  involved: Set<string> | null;
  /** elements to spotlight (Why? "Focus on graph", a clicked pill). Overrides involved. */
  focus: Set<string> | null;
  selected: string | null;
  onNodeClick?: (node: GNode) => void;
  onBackgroundClick?: () => void;
  /** zoom-to-fit when this key changes */
  fitKey?: string | number;
  compact?: boolean;
}

type N = NodeObject & { id: string; g: GNode };
type L = LinkObject & { id: string; g: GEdge; source: string | N; target: string | N };

const PULSE_MS = 1800;

function nodeRadius(g: GNode): number {
  switch (g.label) {
    case "Service":
      return g.props.tier === 1 ? 7 : 5.5;
    case "Team":
      return 5;
    case "Session":
      return 7;
    case "Incident":
    case "Decision":
      return 5;
    case "File":
      return 2.5;
    default:
      return 4;
  }
}

const endpointId = (x: string | N | undefined) => (typeof x === "object" && x ? x.id : (x ?? ""));

export default function ForceGraph({ nodes, edges, involved, focus, selected, onNodeClick, onBackgroundClick, fitKey, compact }: ForceGraphProps) {
  const fgRef = useRef<ForceGraphMethods<N, L> | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 400 });
  const nodeObjs = useRef(new Map<string, N>());
  const linkObjs = useRef(new Map<string, L>());
  const seenAt = useRef(new Map<string, number>());
  const [hoverLink, setHoverLink] = useState<string | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ w: Math.max(100, Math.floor(width)), h: Math.max(100, Math.floor(height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const data = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    const outNodes: N[] = nodes.map((g) => {
      let o = nodeObjs.current.get(g.id);
      if (!o) {
        o = { id: g.id, g };
        nodeObjs.current.set(g.id, o);
      } else {
        o.g = g;
      }
      return o;
    });
    const outLinks: L[] = [];
    for (const g of edges) {
      if (!ids.has(g.source) || !ids.has(g.target)) continue;
      let o = linkObjs.current.get(g.id);
      if (!o) {
        o = { id: g.id, g, source: g.source, target: g.target };
        linkObjs.current.set(g.id, o);
      }
      outLinks.push(o);
    }
    return { nodes: outNodes, links: outLinks };
  }, [nodes, edges]);

  // Record when an element first became "involved" so it can pulse briefly.
  useEffect(() => {
    if (!involved) return;
    const now = performance.now();
    for (const id of involved) if (!seenAt.current.has(id)) seenAt.current.set(id, now);
  }, [involved]);

  // Spread the layout a bit more than the default; dependency graphs are dense in the middle.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const charge = fg.d3Force("charge") as unknown as { strength?: (v: number) => void } | undefined;
    charge?.strength?.(compact ? -90 : -160);
    const link = fg.d3Force("link") as unknown as { distance?: (v: number) => void } | undefined;
    link?.distance?.(compact ? 30 : 46);
    // Weak gravity so disconnected pieces (a Thread → Person path) stay near the
    // main component instead of drifting off and shrinking zoom-to-fit.
    fg.d3Force("x", forceX(0).strength(0.06));
    fg.d3Force("y", forceY(0).strength(0.06));
  }, [compact]);

  // Fit once the layout settles after the data/focus changes (and once early, so it never looks empty).
  const pendingFit = useRef(true);
  const fit = () => {
    const fg = fgRef.current;
    if (!fg) return;
    if (focus && focus.size) fg.zoomToFit(600, 110, (n: N) => focus.has(n.id));
    else fg.zoomToFit(600, 70);
    // A tiny graph (3 nodes) would otherwise fill the panel with giant circles.
    setTimeout(() => {
      const z = fgRef.current?.zoom();
      if (typeof z === "number" && z > 2.6) fgRef.current?.zoom(2.6, 300);
    }, 650);
  };
  useEffect(() => {
    pendingFit.current = true;
    const t = setTimeout(fit, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, focus]);

  const spotlight = focus && focus.size ? focus : involved && involved.size ? involved : null;
  const alphaFor = (id: string): number => {
    if (!spotlight) return 1;
    if (spotlight.has(id)) return 1;
    if (focus && focus.size && involved?.has(id)) return 0.35;
    return 0.13;
  };

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <ForceGraph2D<N, L>
        ref={fgRef}
        width={size.w}
        height={size.h}
        graphData={data}
        backgroundColor="rgba(0,0,0,0)"
        autoPauseRedraw={false}
        cooldownTicks={160}
        onEngineStop={() => {
          if (pendingFit.current) {
            pendingFit.current = false;
            fit();
          }
        }}
        d3VelocityDecay={0.32}
        nodeId="id"
        nodeLabel={(n) => `<div style="font:12px ui-monospace,monospace;padding:2px 4px">${escapeHtml(n.id)}</div>`}
        nodeRelSize={1}
        nodeVal={(n) => nodeRadius(n.g) ** 2}
        onNodeClick={(n) => onNodeClick?.(n.g)}
        onNodeHover={(n) => setHoverNode(n ? n.id : null)}
        onBackgroundClick={() => onBackgroundClick?.()}
        onLinkHover={(l) => setHoverLink(l ? l.id : null)}
        linkLabel={(l) => `<div style="font:11px ui-monospace,monospace;padding:2px 4px">${escapeHtml(endpointId(l.source))} —${l.g.type}→ ${escapeHtml(endpointId(l.target))}</div>`}
        linkColor={(l) => {
          const a = alphaFor(l.id);
          const hot = spotlight?.has(l.id);
          const base = hot ? "180,190,255" : "120,132,160";
          return `rgba(${base},${(hot ? 0.85 : 0.38) * a})`;
        }}
        linkWidth={(l) => (spotlight?.has(l.id) ? 1.8 : hoverLink === l.id ? 1.6 : 0.6)}
        linkDirectionalArrowLength={(l) => (spotlight?.has(l.id) ? 5 : 3)}
        linkDirectionalArrowRelPos={0.92}
        linkDirectionalArrowColor={(l) => {
          const a = alphaFor(l.id);
          return spotlight?.has(l.id) ? `rgba(190,200,255,${0.95 * a})` : `rgba(140,150,175,${0.55 * a})`;
        }}
        linkDirectionalParticles={(l) => (focus?.has(l.id) ? 3 : 0)}
        linkDirectionalParticleWidth={2.2}
        linkDirectionalParticleSpeed={0.008}
        linkDirectionalParticleColor={() => "#c7d0ff"}
        linkCanvasObjectMode={() => "after"}
        linkCanvasObject={(l, ctx, scale) => {
          // edge-type label on hover (and on focused edges when zoomed in)
          if (hoverLink !== l.id && !(focus?.has(l.id) && scale > 1.6)) return;
          const s = l.source as N;
          const t = l.target as N;
          if (s.x === undefined || t.x === undefined || s.y === undefined || t.y === undefined) return;
          const fs = 10 / scale;
          ctx.font = `${fs}px ui-monospace, monospace`;
          const text = l.g.type;
          const w = ctx.measureText(text).width;
          const mx = (s.x + t.x) / 2;
          const my = (s.y + t.y) / 2;
          ctx.fillStyle = "rgba(9,11,15,0.85)";
          ctx.fillRect(mx - w / 2 - 2 / scale, my - fs / 2 - 1.5 / scale, w + 4 / scale, fs + 3 / scale);
          ctx.fillStyle = "#c7d0ff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(text, mx, my);
        }}
        nodeCanvasObject={(n, ctx, scale) => {
          if (n.x === undefined || n.y === undefined) return;
          const g = n.g;
          const r = nodeRadius(g);
          const a = alphaFor(n.id);
          const color = labelColor(g.label);
          ctx.globalAlpha = a;

          // pulse ring for recently involved nodes
          const t0 = seenAt.current.get(n.id);
          if (t0 !== undefined) {
            const age = performance.now() - t0;
            if (age < PULSE_MS) {
              const k = age / PULSE_MS;
              ctx.beginPath();
              ctx.arc(n.x, n.y, r + 2 + k * 14, 0, 2 * Math.PI);
              ctx.strokeStyle = color;
              ctx.globalAlpha = (1 - k) * 0.8;
              ctx.lineWidth = 1.6 / scale + 1;
              ctx.stroke();
              ctx.globalAlpha = a;
            }
          }

          if (spotlight?.has(n.id)) {
            ctx.beginPath();
            ctx.arc(n.x, n.y, r + 2.5, 0, 2 * Math.PI);
            ctx.fillStyle = `${color}33`;
            ctx.fill();
          }

          ctx.beginPath();
          if (g.label === "Team" || g.label === "Agent") {
            ctx.rect(n.x - r, n.y - r, r * 2, r * 2);
          } else if (g.label === "PR" || g.label === "Incident" || g.label === "Finding") {
            ctx.moveTo(n.x, n.y - r * 1.15);
            ctx.lineTo(n.x + r * 1.15, n.y);
            ctx.lineTo(n.x, n.y + r * 1.15);
            ctx.lineTo(n.x - r * 1.15, n.y);
            ctx.closePath();
          } else {
            ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
          }
          ctx.fillStyle = color;
          ctx.fill();
          if (selected === n.id || hoverNode === n.id) {
            ctx.lineWidth = 1.8 / scale + 0.6;
            ctx.strokeStyle = "#ffffff";
            ctx.stroke();
          } else {
            ctx.lineWidth = 0.8;
            ctx.strokeStyle = "rgba(9,11,15,0.9)";
            ctx.stroke();
          }

          // labels: services/teams always (when not too zoomed out), others when highlighted/hovered
          const important = compact ? g.label === "Session" || g.label === "Agent" : g.label === "Service" || g.label === "Team" || g.label === "Session";
          // Labels: keep the canvas readable with 80+ involved nodes. Focused/hovered always,
          // services/teams when not zoomed far out, other involved nodes once zoomed in a bit.
          const show =
            hoverNode === n.id ||
            selected === n.id ||
            (focus?.has(n.id) ?? false) ||
            (important && scale > 0.7) ||
            ((involved?.has(n.id) ?? false) && scale > 1.5) ||
            scale > 2.6;
          if (show) {
            const fs = Math.max(9, 11.5 / Math.sqrt(scale)) / scale * Math.min(scale, 1.6);
            ctx.font = `${spotlight?.has(n.id) ? 600 : 400} ${fs}px Inter, ui-sans-serif, system-ui`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            const max = g.label === "Service" || g.label === "Person" ? 28 : 20;
            const text = g.name.length > max ? `${g.name.slice(0, max - 1)}…` : g.name;
            ctx.lineWidth = 3 / scale;
            ctx.strokeStyle = "rgba(9,11,15,0.9)";
            ctx.strokeText(text, n.x, n.y + r + 2);
            ctx.fillStyle = spotlight && !spotlight.has(n.id) ? "#8690a3" : "#e3e7ef";
            ctx.fillText(text, n.x, n.y + r + 2);
          }
          ctx.globalAlpha = 1;
        }}
        nodePointerAreaPaint={(n, color, ctx) => {
          if (n.x === undefined || n.y === undefined) return;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x, n.y, nodeRadius(n.g) + 3, 0, 2 * Math.PI);
          ctx.fill();
        }}
      />
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
