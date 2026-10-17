"use client";
/**
 * /start: the first page after login. Lists the graphs that exist (straight
 * from FalkorDB). With none, it leads into the builder to create the first one.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type WorkspaceInfo } from "@/lib/api";
import { BUILDER_STEPS } from "@/lib/builder-steps";
import { fmtAgo } from "@/lib/format";
import { Logo } from "@/components/console/Console";
import { Spinner } from "@/components/ui";
import { UserMenu, useUser } from "@/components/auth/UserMenu";

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
    <div className="h-full overflow-y-auto">
      <header className="sticky top-0 z-10 flex h-11 items-center gap-3 border-b border-line bg-panel/95 px-3 whitespace-nowrap backdrop-blur">
        <Link href="/start" className="flex items-center gap-2">
          <Logo />
          <span className="text-sm font-semibold tracking-tight">Blastradius</span>
        </Link>
        <span className="h-4 w-px bg-line-2" />
        <span className="text-sm text-fg-2">Your graphs</span>
        <div className="ml-auto flex items-center gap-3">
          <Link href="/about-us" className="hidden text-xs text-fg-2 hover:text-fg sm:inline">
            About
          </Link>
          <UserMenu />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 pt-10 pb-24 sm:px-6">
        <div className="text-2xs font-semibold tracking-[0.12em] text-accent uppercase">Welcome{user ? `, ${user.name.split(" ")[0]}` : ""}</div>

        {error && (
          <div className="mt-4 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
            {error}
            <div className="mt-1 text-fg-2">
              Is FalkorDB running? <code className="font-mono">docker compose up -d falkordb postgres</code>
            </div>
          </div>
        )}
        {!graphs && !error && (
          <div className="mt-6 flex items-center gap-2 text-xs text-muted">
            <Spinner /> Listing graphs in FalkorDB…
          </div>
        )}

        {graphs && graphs.length === 0 && (
          <section className="mt-3">
            <h1 className="text-3xl font-semibold tracking-tight text-fg">Let's build your first graph</h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-fg-2">
              There's no data yet, on purpose. You'll create an empty FalkorDB graph and fill it one kind of node at a time. Each step explains what you're adding,
              shows the exact Cypher that runs, and lets you try the agent tool it unlocks. Type your own data or seed the sample company whenever you like.
            </p>
            <Link href="/build" className="mt-6 inline-block rounded-md bg-accent-2 px-5 py-2.5 text-sm font-medium text-white hover:bg-accent">
              Create your first graph →
            </Link>
          </section>
        )}

        {graphs && graphs.length > 0 && (
          <section className="mt-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-fg">Your graphs</h1>
              <Link href="/build" className="rounded-md bg-accent-2 px-4 py-2 text-xs font-medium text-white hover:bg-accent">
                + New graph
              </Link>
            </div>
            <div className="mt-6 grid gap-3 md:grid-cols-2">
              {graphs.map((g) => (
                <div key={g.id} className="flex flex-col rounded-lg border border-line bg-panel p-5">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="truncate text-base font-semibold text-fg">{g.name}</h2>
                    <code className="shrink-0 font-mono text-2xs text-faint">blastradius_{g.id}</code>
                  </div>
                  {g.description && <p className="mt-1 text-xs text-fg-2">{g.description}</p>}
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted">
                    <span>
                      <b className="font-mono text-fg-2">{g.nodes}</b> nodes
                    </span>
                    <span>
                      <b className="font-mono text-fg-2">{g.edges}</b> relationships
                    </span>
                    {g.createdBy && <span>by {g.createdBy}</span>}
                    {g.createdAt && <span>{fmtAgo(g.createdAt)}</span>}
                    {g.seeded.length > 0 && <span>seeded: {g.seeded.join(", ")}</span>}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Link href={`/build?tenant=${g.id}`} className="rounded-md border border-line-2 px-3 py-1.5 text-xs text-fg hover:bg-panel-3">
                      Continue building
                    </Link>
                    <Link href={`/?tenant=${g.id}`} className="rounded-md bg-accent-2 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent">
                      Investigate →
                    </Link>
                    <Link href={`/memory?tenant=${g.id}`} className="rounded-md px-2 py-1.5 text-xs text-fg-2 hover:text-fg">
                      Memory
                    </Link>
                    <Link href={`/people?tenant=${g.id}`} className="rounded-md px-2 py-1.5 text-xs text-fg-2 hover:text-fg">
                      People
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mt-14">
          <div className="text-2xs font-semibold tracking-[0.12em] text-accent uppercase">How the builder teaches it</div>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-fg">Seven steps, each one unlocking something the agents can do</h2>
          <ol className="mt-5 grid gap-2 md:grid-cols-2">
            <PathStep n={0} title="Create a graph" text="One FalkorDB graph per company, with its indexes." />
            {BUILDER_STEPS.map((s, i) => (
              <PathStep key={s.id} n={i + 1} title={s.title} text={s.why} tools={s.try.map((t) => t.tool)} />
            ))}
            <PathStep n={BUILDER_STEPS.length + 1} title="Investigate" text="Fire an alert on your graph and watch five agents answer, each claim with a Why?" />
          </ol>
        </section>
      </main>
    </div>
  );
}

function PathStep({ n, title, text, tools }: { n: number; title: string; text: string; tools?: string[] }) {
  return (
    <li className="flex gap-3 rounded-lg border border-line bg-panel p-4">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line-2 font-mono text-2xs text-muted">{n}</span>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-fg">{title}</div>
        <p className="mt-1 text-xs leading-relaxed text-fg-2">{text}</p>
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
