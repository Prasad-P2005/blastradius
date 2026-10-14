"use client";
/** Small presentational primitives shared by the console and the memory inspector. */
import { useState, type ReactNode } from "react";
import { highlightCypher } from "@/lib/cypher-highlight";
import { fmtColumn, labelColor, uidKey, uidLabel } from "@/lib/format";
import type { GraphPath, Json, Row } from "@blastradius/shared";

export function cx(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(" ");
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-label="running"
      className={cx("inline-block size-3 rounded-full border-[1.5px] border-accent/30 border-t-accent", className)}
      style={{ animation: "spin 0.8s linear infinite" }}
    />
  );
}

export function Dot({ ok, title, pending }: { ok: boolean | null; title?: string; pending?: boolean }) {
  const color = pending || ok === null ? "bg-faint" : ok ? "bg-ok" : "bg-bad";
  return (
    <span title={title} className="relative inline-flex size-2">
      {ok === false && <span className="absolute inset-0 animate-ping rounded-full bg-bad/60" />}
      <span className={cx("relative inline-flex size-2 rounded-full", color)} />
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-2 bg-panel-2 px-1 font-mono text-2xs text-muted">{children}</kbd>;
}

/** A node reference: coloured dot + label + key. Clicking focuses it on the graph. */
export function UidPill({ uid, name, onClick, size = "sm" }: { uid: string; name?: string; onClick?: (uid: string) => void; size?: "sm" | "xs" }) {
  const label = uidLabel(uid) ?? "?";
  const color = labelColor(label);
  const Comp = onClick ? "button" : "span";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick ? () => onClick(uid) : undefined}
      title={uid}
      className={cx(
        "inline-flex max-w-full items-center gap-1 rounded border px-1.5 font-mono leading-[18px] whitespace-nowrap",
        size === "xs" ? "text-2xs" : "text-xs",
        onClick && "cursor-pointer hover:brightness-125",
      )}
      style={{ borderColor: `${color}40`, background: `${color}12`, color }}
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="opacity-70">{label}</span>
      <span className="truncate text-fg-2">{name ?? uidKey(uid)}</span>
    </Comp>
  );
}

export function ConfidenceBar({ value, className }: { value: number; className?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const color = value >= 0.75 ? "var(--color-ok)" : value >= 0.5 ? "var(--color-warn)" : "var(--color-bad)";
  return (
    <span className={cx("inline-flex items-center gap-1.5", className)} title={`confidence ${pct}%`}>
      <span className="relative h-1 w-14 overflow-hidden rounded-full bg-line-2">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: color }} />
      </span>
      <span className="font-mono text-2xs tabular-nums text-muted">{pct}%</span>
    </span>
  );
}

export function WhyChip({ onClick, count }: { onClick: () => void; count?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ml-1 inline-flex translate-y-[-1px] items-center gap-0.5 rounded border border-accent/40 bg-accent/10 px-1 font-mono text-2xs leading-4 text-accent hover:bg-accent/20"
      title="Show the Cypher and graph path behind this claim"
    >
      Why?{count && count > 1 ? <span className="opacity-60">×{count}</span> : null}
    </button>
  );
}

export function StatusPill({ status }: { status: "done" | "dry_run" | "failed" | string }) {
  const style =
    status === "done"
      ? "border-ok/40 bg-ok/10 text-ok"
      : status === "dry_run"
        ? "border-warn/40 bg-warn/10 text-warn"
        : "border-bad/40 bg-bad/10 text-bad";
  return <span className={cx("rounded border px-1.5 font-mono text-2xs leading-[18px] uppercase", style)}>{status.replace("_", " ")}</span>;
}

export function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className="rounded border border-line-2 bg-panel-2 px-1.5 font-mono text-2xs leading-[18px] text-muted hover:text-fg"
    >
      {done ? "copied" : label}
    </button>
  );
}

export function CypherBlock({ cypher, maxHeight = 260 }: { cypher: string; maxHeight?: number }) {
  return (
    <pre className="code overflow-auto rounded-md border border-line bg-[#07090c] p-2.5 text-fg-2" style={{ maxHeight }}>
      {highlightCypher(cypher).map(([cls, t], i) =>
        cls ? (
          <span key={i} className={cls}>
            {t}
          </span>
        ) : (
          t
        ),
      )}
    </pre>
  );
}

/** Compact table of result rows. Columns from the union of the first rows' keys. */
export function RowsTable({ rows, max = 20, onUid }: { rows: Row[]; max?: number; onUid?: (uid: string) => void }) {
  if (rows.length === 0) return <div className="px-2 py-1.5 text-xs text-faint">0 rows</div>;
  const cols: string[] = [];
  for (const r of rows.slice(0, max)) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const isUid = (v: Json | undefined): v is string => typeof v === "string" && /^[A-Z][A-Za-z]+:[^\s]+$/.test(v) && uidLabel(v) !== null;
  return (
    <div className="overflow-auto rounded-md border border-line">
      <table className="w-full border-collapse font-mono text-2xs">
        <thead className="sticky top-0 bg-panel-3 text-left text-muted">
          <tr>
            {cols.map((c) => (
              <th key={c} className="border-b border-line px-2 py-1 font-medium whitespace-nowrap">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, max).map((r, i) => (
            <tr key={i} className="odd:bg-panel-2/40 hover:bg-panel-3/60">
              {cols.map((c) => {
                const v = r[c];
                return (
                  <td key={c} className="max-w-[260px] truncate border-b border-line/60 px-2 py-1 align-top text-fg-2" title={typeof v === "string" ? v : JSON.stringify(v)}>
                    {isUid(v) && onUid ? (
                      <button type="button" className="hover:underline" style={{ color: labelColor(uidLabel(v)!) }} onClick={() => onUid(v)}>
                        {v}
                      </button>
                    ) : (
                      fmtColumn(c, v)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max && <div className="border-t border-line px-2 py-1 text-2xs text-faint">+{rows.length - max} more rows</div>}
    </div>
  );
}

/** `Service:frontend —DEPENDS_ON→ Service:checkout …` as pills with arrows (direction respected). */
export function PathChain({ path, onUid }: { path: GraphPath; onUid?: (uid: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {path.nodes.map((n, i) => {
        const e = path.edges[i];
        const forward = e ? e.source === n.id : true;
        return (
          <span key={`${n.id}-${i}`} className="contents">
            <UidPill uid={n.id} name={n.name} onClick={onUid} size="xs" />
            {e && (
              <span className="inline-flex items-center font-mono text-2xs text-faint">
                {forward ? "—" : "←"}
                <span className="px-0.5 text-muted">{e.type}</span>
                {forward ? "→" : "—"}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-0.5 pb-1.5">
      <div className="text-2xs font-semibold tracking-[0.08em] text-muted uppercase">{children}</div>
      {right}
    </div>
  );
}

export function Banner({ tone, children }: { tone: "bad" | "warn" | "info"; children: ReactNode }) {
  const c =
    tone === "bad" ? "border-bad/40 bg-bad/10 text-bad" : tone === "warn" ? "border-warn/40 bg-warn/10 text-warn" : "border-accent/40 bg-accent/10 text-accent";
  return <div className={cx("border-b px-4 py-1.5 text-xs", c)}>{children}</div>;
}
