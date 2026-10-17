/**
 * /about-us: the pitch. Static page (no backend calls), so it renders even when
 * FalkorDB is down. Every number here is one we measured; see the progress logs
 * in docs/progress/ and docs/CYPHER.md. Don't add numbers we can't back up.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/console/Console";

export const metadata = {
  title: "About us · Blastradius",
  description: "Blastradius turns a company's code, people, incidents and decisions into one graph that agents reason over, so on-call engineers get answers with proof.",
};

/** Fill in before the demo. The section is hidden while this is empty. */
const TEAM: { name: string; role: string; link?: string }[] = [];

const REPO_URL = "https://github.com/open-telemetry/opentelemetry-demo";
const GLOBEX_URL = "https://github.com/GoogleCloudPlatform/microservices-demo";

// ── the four questions an incident commander asks, and how the graph answers ──
const QUESTIONS = [
  {
    q: "What else breaks?",
    how: "Multi-hop DEPENDS_ON walk, ranked by betweenness centrality, so chokepoints come first.",
    algo: "algo.betweenness",
  },
  {
    q: "What probably caused it?",
    how: "Recent PRs on the service and its dependencies, plus past incidents found by vector search inside FalkorDB.",
    algo: "db.idx.vector.queryNodes",
  },
  {
    q: "Who can fix it?",
    how: "Authors of PRs on the service × PageRank over the real co-authorship graph, cross-checked with team and on-call.",
    algo: "algo.pageRank",
  },
  {
    q: "What worked last time?",
    how: "Incidents and runbooks the Scribe agent wrote into the graph when earlier sessions closed.",
    algo: "agent memory",
  },
];

const AGENTS = [
  { name: "Triage", does: "Sizes the blast radius, finds chokepoints and who's on call, then hands off." },
  { name: "Investigator", does: "Ranks suspect PRs and similar past incidents." },
  { name: "Expert", does: "Finds the humans who actually know this code." },
  { name: "Scribe", does: "On close, writes the Incident and Runbook back into the graph." },
  { name: "Navigator", does: "Answers “Ask the company” questions with sources." },
];

const PROOF = [
  { n: "0 → 1", label: "build a company graph from nothing in a guided builder, or seed one of 2 sample companies" },
  { n: "2,462", label: "nodes and 12,152 edges in the two sample companies built from real git history" },
  { n: "16", label: "graph tools, served to our agents and over MCP" },
  { n: "11/11", label: "demo scenarios where the expected answer ranks #1" },
  { n: "< 65 ms", label: "for every tool on a synthetic 11k-node, 26k-edge graph" },
  { n: "10", label: "concurrent agent runs on one graph, 473 consistency checks passing" },
];

const TRACKS = [
  {
    id: "01",
    name: "Agents That Act on Connected Data",
    points: [
      "Multi-hop reasoning, with betweenness, PageRank, shortest path, CDLP and WCC exposed as agent tools",
      "The same tool registry over MCP (stdio + Streamable HTTP)",
      "Real actions: a GitHub issue, a webhook ping, and a draft rollback PR in a sandbox repo",
      "A Why? chip on every claim, showing the exact Cypher and graph path behind it",
    ],
  },
  {
    id: "02",
    name: "Agent Memory and Coordination",
    points: [
      "Episodic memory: Session → Episode → NEXT → Episode",
      "Semantic memory: Findings linked into the domain graph",
      "Procedural memory: an Incident and Runbook written on close, recalled in later sessions",
      "Handoffs only through graph state: Finding -[:HANDED_TO]-> Agent",
    ],
  },
  {
    id: "03",
    name: "Company Brain",
    points: [
      "Tickets, chat threads, ADRs and docs in the same graph as the code",
      "Decision tracing: Doc ← Decision → PR → Incident",
      "Ask the company, with every answer sourced",
      "Incremental re-ingest: new PRs land without a rebuild",
    ],
  },
];

const ROADMAP = [
  { when: "Now", what: "A guided graph builder, one graph per workspace, five agents, 16 tools, MCP server, Why? on every claim, memory across sessions." },
  { when: "Next 3 months", what: "Live connectors (GitHub, PagerDuty, Slack, Jira), alert webhooks that start an investigation automatically, and design-partner pilots." },
  { when: "Next 6 months", what: "Postmortem drafts from the graph, change-risk scoring before merge (“this PR touches 3 chokepoints”), SSO and audit export." },
  { when: "Next 12 months", what: "A self-serve tier, an on-prem / VPC graph for regulated teams, and an MCP marketplace listing so any agent can query a company's brain." },
];

export default function AboutUsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <header className="sticky top-0 z-10 flex h-11 items-center gap-3 border-b border-line bg-panel/95 px-4 backdrop-blur">
        <Link href="/" className="flex items-center gap-2">
          <Logo />
          <span className="text-sm font-semibold tracking-tight">Blastradius</span>
        </Link>
        <span className="h-4 w-px bg-line-2" />
        <span className="text-sm text-fg-2">About us</span>
        <Link href="/" className="ml-auto text-xs text-fg-2 hover:text-fg">
          Open the console →
        </Link>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-24 sm:px-6">
        {/* ── hero ── */}
        <section className="pt-16 pb-14 sm:pt-24">
          <Eyebrow>Graph Hacks 2026 · FalkorDB × WeMakeDevs · all three tracks</Eyebrow>
          <h1 className="mt-4 max-w-3xl text-4xl leading-[1.1] font-semibold tracking-tight text-fg sm:text-5xl">
            When production breaks, the answers are already in your company. They're just not connected.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-fg-2">
            Blastradius puts your services, code, PRs, people, incidents, runbooks and decisions into{" "}
            <b className="text-fg">one FalkorDB graph</b>. A team of AI agents works over it the moment an alert fires. In seconds they tell
            you what else breaks, what caused it, who can fix it and what worked last time.{" "}
            <b className="text-fg">Every answer shows the graph path that proves it.</b>
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/" className="rounded-md bg-accent-2 px-4 py-2 text-sm font-medium text-white hover:bg-accent">
              See a live investigation
            </Link>
            <Link href="/memory" className="rounded-md border border-line-2 bg-panel-2 px-4 py-2 text-sm text-fg-2 hover:text-fg">
              Inspect agent memory
            </Link>
          </div>
        </section>

        {/* ── problem ── */}
        <Section eyebrow="The problem" title="The first 30 minutes of every incident are spent rebuilding context">
          <div className="grid gap-4 sm:grid-cols-3">
            <Card title="Context is scattered">
              The service map is in one tool, the code in another, the people in a third, and the last incident's fix in a postmortem
              nobody can find. On-call engineers rebuild that picture by hand, under pressure, every time.
            </Card>
            <Card title="Knowledge walks out the door">
              Who really knows the cart service? Why did we move to Valkey? That lives in people's heads and in old Slack threads. When
              they're asleep or have left, the team starts from zero.
            </Card>
            <Card title="AI assistants guess">
              Chat-over-documents tools give fluent answers with no proof. In an outage you can't act on “probably”. You need to see{" "}
              <i>why</i>.
            </Card>
          </div>
        </Section>

        {/* ── solution ── */}
        <Section eyebrow="The solution" title="Four questions, answered from the graph, with receipts">
          <div className="grid gap-3 sm:grid-cols-2">
            {QUESTIONS.map((x, i) => (
              <div key={x.q} className="rounded-lg border border-line bg-panel p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-base font-semibold text-fg">
                    <span className="mr-2 font-mono text-sm text-faint">{i + 1}</span>
                    {x.q}
                  </h3>
                  <code className="shrink-0 rounded border border-accent/30 bg-accent/10 px-1.5 font-mono text-2xs text-accent">{x.algo}</code>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-fg-2">{x.how}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 max-w-3xl text-sm leading-relaxed text-fg-2">
            The agents also <b className="text-fg">act</b>. They open a GitHub issue, ping the team's webhook and draft a rollback PR, and
            every action is logged. When the incident closes, the Scribe writes what happened back into the graph, so the next on-call
            starts where this one left off.
          </p>
        </Section>

        {/* ── demo walk-through ── */}
        <Section eyebrow="What it looks like" title="“Checkout 5xx at 12%”: a real run on real history">
          <ol className="space-y-3">
            <Step n={1} title="Blast radius">
              Triage walks <Mono>DEPENDS_ON</Mono> and finds <b className="text-fg">6 services</b> at risk, ranked by betweenness so the
              chokepoints come first.
            </Step>
            <Step n={2} title="Suspect change">
              Investigator ranks recent PRs on checkout and its dependencies. <Mono>PR #4059</Mono> comes out on top, and vector search
              surfaces the similar past incident <Mono>INC-2026-037</Mono>.
            </Step>
            <Step n={3} title="Who can fix it">
              Expert combines PR history with PageRank over who co-authors which files, and names the engineer who knows this code best,
              plus the on-call teammate.
            </Step>
            <Step n={4} title="Act, then remember">
              The agents open the issue and draft the rollback. On close, the Incident and Runbook go into the graph. Start a new session on
              the same service and the agents recall the fix.
            </Step>
          </ol>
          <div className="mt-6 overflow-hidden rounded-lg border border-line">
            <div className="flex items-center justify-between border-b border-line bg-panel-3 px-3 py-1.5">
              <span className="font-mono text-2xs text-muted">Why? → blast_radius (the exact query that ran)</span>
              <span className="font-mono text-2xs text-faint">FalkorDB · Cypher</span>
            </div>
            <pre className="code overflow-x-auto bg-[#07090c] p-4 text-fg-2">
              <span className="cy-comment">{"// What else breaks if $service fails?\n"}</span>
              <span className="cy-kw">CALL</span> <span className="cy-fn">algo.betweenness</span>
              {"({nodeLabels: ["}
              <span className="cy-str">{"'Service'"}</span>
              {"], relationshipTypes: ["}
              <span className="cy-str">{"'DEPENDS_ON'"}</span>
              {"]})\n"}
              <span className="cy-kw">YIELD</span>
              {" node, score\n"}
              <span className="cy-kw">WITH</span>
              {" node "}
              <span className="cy-kw">AS</span>
              {" svc, score "}
              <span className="cy-kw">AS</span>
              {" betweenness\n"}
              <span className="cy-kw">MATCH</span>
              {" (s:"}
              <span className="cy-label">Service</span>
              {" {uid: "}
              <span className="cy-param">$service</span>
              {"})\n"}
              <span className="cy-kw">MATCH</span>
              {" p = (svc)-[:"}
              <span className="cy-label">DEPENDS_ON</span>
              {"*1..3]->(s)\n"}
              <span className="cy-kw">WHERE</span>
              {" svc <> s\n"}
              <span className="cy-kw">RETURN</span>
              {" svc.name, length(p) "}
              <span className="cy-kw">AS</span>
              {" hops, betweenness, p\n"}
              <span className="cy-kw">ORDER BY</span>
              {" betweenness "}
              <span className="cy-kw">DESC</span>
            </pre>
          </div>
        </Section>

        {/* ── why graph ── */}
        <Section eyebrow="Why a graph, why FalkorDB" title="The questions are about relationships, so the data has to be a graph">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card title="Questions are paths">
              “What breaks” is a dependency walk. “Who knows” is a walk from service to file to PR to person. “Why did we decide this” runs
              Doc ← Decision → PR → Incident. Tables and vector stores can't answer these in one query. A graph can.
            </Card>
            <Card title="One engine does it all">
              FalkorDB runs our traversals, graph algorithms (PageRank, betweenness, CDLP, WCC, shortest path), vector search and full-text
              search inside one query engine. There's no second database for the agents to reason over.
            </Card>
            <Card title="Memory lives in the same graph">
              Sessions, episodes, findings and handoffs are nodes linked to the services and people they're about. Agents coordinate by
              reading graph state, not by passing chat messages to each other.
            </Card>
            <Card title="Proof by construction">
              Every claim cites the exact Cypher that produced it. The UI matches the claim to that query, its rows and its paths.
              Explainability is part of the architecture, not something added at the end.
            </Card>
          </div>
          <p className="mt-6 text-sm text-muted">
            Remove FalkorDB and Blastradius stops working. Postgres only stores app bookkeeping (sessions, transcripts, audit log). Nothing
            an agent reasons over lives there.
          </p>
        </Section>

        {/* ── how it works ── */}
        <Section eyebrow="How it works" title="Five agents, one graph per tenant, no hidden state">
          <div className="grid gap-3 sm:grid-cols-5">
            {AGENTS.map((a) => (
              <div key={a.name} className="rounded-lg border border-line bg-panel p-4">
                <div className="text-sm font-semibold text-fg">{a.name}</div>
                <p className="mt-1.5 text-xs leading-relaxed text-fg-2">{a.does}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-3 text-xs text-fg-2 sm:grid-cols-3">
            <Pill>Vercel AI SDK agents, plus a scripted mode that runs with no API key</Pill>
            <Pill>The same 16 tools over MCP, so any agent (Claude, Cursor…) can query the brain</Pill>
            <Pill>Read tools run as read-only queries; write tools are gated</Pill>
          </div>
        </Section>

        {/* ── traction / proof ── */}
        <Section eyebrow="Proof it works" title="Built in 72 hours, measured, not mocked">
          <div className="grid gap-3 sm:grid-cols-3">
            {PROOF.map((p) => (
              <div key={p.label} className="rounded-lg border border-line bg-panel p-5">
                <div className="font-mono text-3xl font-semibold tracking-tight text-fg tabular-nums">{p.n}</div>
                <div className="mt-1.5 text-xs leading-relaxed text-muted">{p.label}</div>
              </div>
            ))}
          </div>
          <p className="mt-6 max-w-3xl text-sm leading-relaxed text-fg-2">
            The sample companies come from the real git history of{" "}
            <a className="text-accent hover:underline" href={REPO_URL} target="_blank" rel="noreferrer">
              open-telemetry/opentelemetry-demo
            </a>{" "}
            and{" "}
            <a className="text-accent hover:underline" href={GLOBEX_URL} target="_blank" rel="noreferrer">
              GoogleCloudPlatform/microservices-demo
            </a>
            . Real contributors appear only through their public PRs. Chat, tickets and on-call duties belong to clearly marked fictional
            personas, and we store no email addresses.
          </p>
        </Section>

        {/* ── market / customer ── */}
        <Section eyebrow="Who pays" title="Platform and SRE teams who run dozens of services and get paged for all of them">
          <div className="grid gap-4 sm:grid-cols-3">
            <Card title="Buyer">
              Heads of platform and SRE at companies with tens to hundreds of microservices. They own MTTR, on-call health and onboarding.
            </Card>
            <Card title="Value">
              Less time from page to the right person and the right PR. Fewer repeat incidents, because the last fix is recalled
              automatically. New engineers can ask the company instead of interrupting the senior engineer.
            </Card>
            <Card title="Model (proposed)">
              Per-service pricing with a free tier for small teams. The MCP endpoint is the wedge: one graph, queried by every agent the
              team already uses.
            </Card>
          </div>
        </Section>

        {/* ── moat ── */}
        <Section eyebrow="Why we win" title="The graph compounds">
          <ul className="grid gap-3 text-sm leading-relaxed text-fg-2 sm:grid-cols-2">
            <Bullet>
              <b className="text-fg">Every incident makes it smarter.</b> Closed incidents and runbooks become procedural memory that later
              investigations recall.
            </Bullet>
            <Bullet>
              <b className="text-fg">Explainable by design.</b> Teams can audit each recommendation down to the query, which is what
              earns trust for automated rollbacks.
            </Bullet>
            <Bullet>
              <b className="text-fg">Agent-agnostic.</b> We're the context layer, not another chatbot. Any MCP client gets blast radius,
              ownership and history.
            </Bullet>
            <Bullet>
              <b className="text-fg">Incremental.</b> New PRs stream into the graph without a rebuild, so the brain stays current.
            </Bullet>
          </ul>
        </Section>

        {/* ── tracks ── */}
        <Section eyebrow="Hackathon tracks" title="One product, all three tracks">
          <div className="grid gap-3 lg:grid-cols-3">
            {TRACKS.map((t) => (
              <div key={t.id} className="rounded-lg border border-line bg-panel p-5">
                <div className="font-mono text-2xs text-accent">TRACK {t.id}</div>
                <h3 className="mt-1 text-base font-semibold text-fg">{t.name}</h3>
                <ul className="mt-3 space-y-2 text-xs leading-relaxed text-fg-2">
                  {t.points.map((p) => (
                    <Bullet key={p}>{p}</Bullet>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>

        {/* ── roadmap ── */}
        <Section eyebrow="Roadmap" title="From hackathon to the context layer for incident response">
          <ol className="relative space-y-5 border-l border-line-2 pl-6">
            {ROADMAP.map((r) => (
              <li key={r.when} className="relative">
                <span className="absolute top-1.5 -left-[29px] size-2.5 rounded-full border-2 border-bg bg-accent" />
                <div className="font-mono text-2xs tracking-wide text-accent uppercase">{r.when}</div>
                <p className="mt-1 text-sm leading-relaxed text-fg-2">{r.what}</p>
              </li>
            ))}
          </ol>
        </Section>

        {/* ── team ── */}
        {TEAM.length > 0 && (
          <Section eyebrow="Team" title="Who's building it">
            <div className="grid gap-3 sm:grid-cols-3">
              {TEAM.map((m) => (
                <div key={m.name} className="rounded-lg border border-line bg-panel p-5">
                  <div className="text-sm font-semibold text-fg">
                    {m.link ? (
                      <a href={m.link} target="_blank" rel="noreferrer" className="hover:underline">
                        {m.name}
                      </a>
                    ) : (
                      m.name
                    )}
                  </div>
                  <div className="mt-1 text-xs text-muted">{m.role}</div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ── the ask ── */}
        <section className="mt-20 rounded-xl border border-accent/30 bg-gradient-to-br from-accent/10 via-panel to-panel p-8 sm:p-10">
          <Eyebrow>The ask</Eyebrow>
          <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
            We're looking for design partners and pre-seed backers to take Blastradius from two demo tenants to production on-call
            rotations.
          </h2>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-fg-2">
            Funding goes to live connectors, a hosted multi-tenant FalkorDB deployment and our first pilots. In return, your platform team
            gets a company brain that answers with proof, and remembers every outage so you don't repeat it.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/" className="rounded-md bg-accent-2 px-4 py-2 text-sm font-medium text-white hover:bg-accent">
              Try it now
            </Link>
            <Link href="/people" className="rounded-md border border-line-2 bg-panel-2 px-4 py-2 text-sm text-fg-2 hover:text-fg">
              Who knows what
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}

// ── small presentational pieces (page-local) ──

function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="font-mono text-2xs font-medium tracking-[0.12em] text-accent uppercase">{children}</div>;
}

function Section({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section className="mt-20">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-2 mb-6 max-w-3xl text-2xl font-semibold tracking-tight text-fg">{title}</h2>
      {children}
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-5">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-fg-2">{children}</p>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-4 rounded-lg border border-line bg-panel p-4">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent/10 font-mono text-xs text-accent">{n}</span>
      <div>
        <div className="text-sm font-semibold text-fg">{title}</div>
        <p className="mt-1 text-sm leading-relaxed text-fg-2">{children}</p>
      </div>
    </li>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="rounded bg-panel-3 px-1 font-mono text-xs text-fg">{children}</code>;
}

function Pill({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-line bg-panel-2 px-3 py-2">{children}</div>;
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="mt-[0.55em] size-1 shrink-0 rounded-full bg-accent" />
      <span>{children}</span>
    </li>
  );
}
