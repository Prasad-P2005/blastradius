"use client";
/** Picks which graph a page works on. The list comes live from FalkorDB (GET /api/graphs). */
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Tenant } from "@blastradius/shared";
import { api, type WorkspaceInfo } from "@/lib/api";

export function useGraphs(): WorkspaceInfo[] | null {
  const [graphs, setGraphs] = useState<WorkspaceInfo[] | null>(null);
  useEffect(() => {
    api
      .graphs()
      .then(setGraphs)
      .catch(() => setGraphs([]));
  }, []);
  return graphs;
}

export function GraphSwitcher({ tenant, graphs, onChange }: { tenant: Tenant; graphs: WorkspaceInfo[] | null; onChange: (t: Tenant) => void }) {
  const list = graphs ?? [];
  const known = list.some((g) => g.id === tenant);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <select
        value={tenant}
        onChange={(e) => onChange(e.target.value)}
        aria-label="graph"
        className="max-w-44 min-w-0 rounded-md border border-line bg-panel-2 px-2 py-1 text-xs text-fg outline-none"
      >
        {!known && <option value={tenant}>{tenant}</option>}
        {list.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
      <Link href={`/build?tenant=${tenant}`} title="Edit this graph in the builder" className="rounded border border-line-2 px-1.5 py-0.5 text-2xs text-muted hover:text-fg">
        edit
      </Link>
    </div>
  );
}

/** Full-page state for pages that need a graph when none exists yet. */
export function NoGraphs() {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-fg">No graphs yet</h1>
        <p className="mt-2 text-sm text-fg-2">Everything here runs over a FalkorDB graph. Create one in the builder, step by step, then come back.</p>
        <Link href="/build" className="mt-5 inline-block rounded-md bg-accent-2 px-4 py-2 text-sm font-medium text-white hover:bg-accent">
          Create your first graph →
        </Link>
      </div>
    </div>
  );
}
