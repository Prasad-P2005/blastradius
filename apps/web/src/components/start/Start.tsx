"use client";
/**
 * /start: the first page after login. Lists the company graphs that exist
 * (straight from FalkorDB). With none, it leads into the builder to create the first one.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { isSeedPack, tenantInfo } from "@blastradius/shared";
import { api, type WorkspaceInfo } from "@/lib/api";
import { BUILDER_STEPS } from "@/lib/builder-steps";
import { fmtAgo } from "@/lib/format";
import { Spinner } from "@/components/ui";
import { useUser } from "@/components/auth/UserMenu";
import { AppShell, ButtonLink, Panel, StatusIcon, companyName } from "@/components/shell/AppShell";

export function Start() {
  const user = useUser();
  const [graphs, setGraphs] = useState<WorkspaceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .graphs()
      .then(setGraphs)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <AppShell
      active="graphs"
      crumbs={[{ label: "Companies" }]}
      title={`Welcome${user ? `, ${user.name.split(" ")[0]}` : ""}`}
      description="Each company is one FalkorDB graph: its services, code changes, people, past incidents, decisions and chat, plus everything the agents have learned. Pick one to investigate, or build your own."
      actions={
        <ButtonLink href="/build" variant="primary">
          Create company graph
        </ButtonLink>
      }
    >
      <div className="flex max-w-6xl flex-col gap-6 px-6 pb-16">
        {error && (
          <div className="flex gap-2 rounded-xl border border-bad/30 bg-[#fff7f7] px-4 py-3 text-sm">
            <StatusIcon tone="bad" />
            <div>
              <div className="font-semibold text-bad">Can't list the company graphs</div>
              <div className="text-fg-2">
                {error}. Is FalkorDB running? <code className="font-mono">docker compose up -d falkordb postgres</code>
              </div>
            </div>
          </div>
        )}
        {!graphs && !error && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Loading companies…
          </div>
        )}

        {graphs && graphs.length === 0 && (
          <Panel title="Let's build your first company graph">
            <p className="max-w-2xl text-sm leading-relaxed text-fg-2">
              There's no data yet, on purpose. You'll create an empty FalkorDB graph and fill it one kind of thing at a time. Each step explains what you're adding,
              shows the exact Cypher that runs, and lets you try the agent tool it unlocks. Type your own data or load a sample company whenever you like.
            </p>
            <ButtonLink href="/build" variant="primary" className="mt-4">
              Create your first graph
            </ButtonLink>
          </Panel>
        )}

        {graphs && graphs.length > 0 && (
          <Panel title={`Companies (${graphs.length})`} description="Start with Slice Pizza if you're new: a small food-delivery company anyone can follow.">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {[...graphs].sort(easiestFirst).map((g) => (
                <CompanyCard key={g.id} g={g} graphs={graphs} />
              ))}
            </div>
          </Panel>
        )}

        <Panel title="Build your own, step by step" description="The graph builder adds one kind of data at a time. Each step unlocks something the agents can do.">
          <ol className="grid gap-3 md:grid-cols-2">
            <PathStep n={0} title="Create a graph" text="One FalkorDB graph per company, with its indexes." />
            {BUILDER_STEPS.map((s, i) => (
              <PathStep key={s.id} n={i + 1} title={s.title} text={s.why} tools={s.try.map((t) => t.tool)} />
            ))}
            <PathStep n={BUILDER_STEPS.length + 1} title="Investigate" text="Fire an alert on your graph and watch the agents answer, each answer with its evidence." />
          </ol>
        </Panel>
      </div>
    </AppShell>
  );
}

/** Slice (the hand-written easy example) first, then the other sample companies, then user-built graphs. */
function easiestFirst(a: WorkspaceInfo, b: WorkspaceInfo): number {
  const rank = (g: WorkspaceInfo) => (g.id === "slice" ? 0 : isSeedPack(g.id) ? 1 : 2);
  return rank(a) - rank(b) || a.id.localeCompare(b.id);
}

function CompanyCard({ g, graphs }: { g: WorkspaceInfo; graphs: WorkspaceInfo[] }) {
  const info = tenantInfo(g.id);
  return (
    <div className="flex flex-col rounded-xl border border-line-2/70 bg-panel p-5">
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 truncate text-lg font-bold text-fg">{companyName(g.id, graphs)}</h3>
        {g.id === "slice" && <span className="shrink-0 rounded-full bg-[#e9f6e9] px-2 py-0.5 text-xs font-semibold text-ok">Easiest</span>}
      </div>
      <p className="mt-1 min-h-10 text-sm text-fg-2">{g.description || info.description}</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3 text-sm">
        <div>
          <dt className="text-xs text-muted">Things in the graph</dt>
          <dd className="font-semibold text-fg">{g.nodes.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Connections</dt>
          <dd className="font-semibold text-fg">{g.edges.toLocaleString()}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-muted">Data</dt>
          <dd className="truncate text-fg-2" title={info.sourceRepo}>
            {g.id === "slice"
              ? "Fully synthetic, hand-written"
              : isSeedPack(g.id)
                ? `Real git history of ${info.sourceRepo}`
                : `Built in the graph builder${g.createdAt ? `, ${fmtAgo(g.createdAt)}` : ""}`}
          </dd>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ButtonLink href={`/?tenant=${g.id}`} variant="primary">
          Investigate
        </ButtonLink>
        <ButtonLink href={`/?tenant=${g.id}&mode=ask`}>Ask</ButtonLink>
        <span className="ml-auto flex gap-3 text-sm">
          <Link href={`/people?tenant=${g.id}`} className="text-accent hover:underline">
            People
          </Link>
          <Link href={`/build?tenant=${g.id}`} className="text-accent hover:underline">
            Edit
          </Link>
        </span>
      </div>
    </div>
  );
}

function PathStep({ n, title, text, tools }: { n: number; title: string; text: string; tools?: string[] }) {
  return (
    <li className="flex gap-3 rounded-xl border border-line-2/60 p-4">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#f0f7ff] text-sm font-bold text-accent">{n}</span>
      <div className="min-w-0">
        <div className="text-sm font-bold text-fg">{title}</div>
        <p className="mt-1 text-sm leading-relaxed text-fg-2">{text}</p>
        {tools && tools.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {tools.map((t) => (
              <code key={t} className="rounded bg-panel-3 px-1.5 font-mono text-2xs text-accent">
                {t}
              </code>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
