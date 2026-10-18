"use client";
/**
 * The frame every page sits in, modelled on the AWS console:
 *   - a navy top bar: product name, the company (graph) being looked at,
 *     system status, demo/AI mode and the user menu
 *   - a left side menu grouping the pages by what people want to do
 *   - breadcrumbs, a page title with a one-line description, and page actions
 *
 * Pages keep their own state; they only pass in what the frame shows.
 */
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { tenantInfo, type HealthStatus, type Tenant } from "@blastradius/shared";
import { api, type WorkspaceInfo } from "@/lib/api";
import { UserMenu } from "@/components/auth/UserMenu";
import { cx } from "@/components/ui";

export type NavKey = "investigate" | "ask" | "graphs" | "people" | "memory" | "build" | "about";

export interface Crumb {
  label: string;
  href?: string;
}

export interface AppShellProps {
  active: NavKey;
  /** the company graph this page works on (omit on pages that aren't about one graph) */
  tenant?: Tenant;
  graphs?: WorkspaceInfo[] | null;
  onTenantChange?: (t: Tenant) => void;
  crumbs?: Crumb[];
  title?: ReactNode;
  description?: ReactNode;
  /** buttons shown at the right of the page title */
  actions?: ReactNode;
  /** pass the console's own health poll to avoid a second one */
  health?: HealthStatus | null;
  /** keeps ?fixture=1 on the menu links */
  fixture?: boolean;
  /** "fill" = children get the remaining height (console, memory, people); "scroll" = the page scrolls */
  layout?: "fill" | "scroll";
  children: ReactNode;
}

const LS_NAV = "br.nav.open";

/** A company's display name: the graph's own name if it has one, else the seed pack name. */
export function companyName(tenant: Tenant, graphs?: WorkspaceInfo[] | null): string {
  const g = graphs?.find((x) => x.id === tenant);
  const info = tenantInfo(tenant);
  return g && g.name && g.name !== tenant ? g.name : info.name;
}

export function AppShell({ active, tenant, graphs, onTenantChange, crumbs, title, description, actions, health: healthProp, fixture, layout = "scroll", children }: AppShellProps) {
  const [navOpen, setNavOpen] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem(LS_NAV) === "0") setNavOpen(false);
    } catch {
      /* storage blocked */
    }
  }, []);
  const toggleNav = () =>
    setNavOpen((o) => {
      try {
        localStorage.setItem(LS_NAV, o ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !o;
    });

  const ownHealth = useHealth(healthProp === undefined);
  const health = healthProp === undefined ? ownHealth : healthProp;

  return (
    <div className="flex h-full flex-col">
      <TopBar tenant={tenant} graphs={graphs} onTenantChange={onTenantChange} health={health} onToggleNav={toggleNav} />
      {health && !health.falkordb.ok && (
        <div className="flex items-center gap-2 border-b border-bad/30 bg-[#fff7f7] px-4 py-2 text-sm text-bad">
          <StatusIcon tone="bad" /> The graph database (FalkorDB) is not reachable: {health.falkordb.error ?? "health check failed"}. Investigations will fail until it is back.
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {navOpen && <SideNav active={active} tenant={tenant} fixture={fixture} onClose={toggleNav} />}
        <main className={cx("flex min-w-0 flex-1 flex-col", layout === "scroll" && "overflow-y-auto")}>
          {(crumbs || title) && (
            <div className="shrink-0 px-6 pt-4 pb-3">
              {!navOpen && (
                <button type="button" onClick={toggleNav} className="mb-2 text-xs text-accent hover:underline">
                  ☰ Show menu
                </button>
              )}
              {crumbs && crumbs.length > 0 && <Breadcrumbs crumbs={crumbs} />}
              {title && (
                <div className="mt-1.5 flex flex-wrap items-end gap-3">
                  <div className="min-w-0 flex-1">
                    <h1 className="text-2xl leading-tight font-bold text-fg">{title}</h1>
                    {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
                  </div>
                  {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
                </div>
              )}
            </div>
          )}
          <div className={cx(layout === "fill" ? "flex min-h-0 flex-1 flex-col" : "")}>{children}</div>
        </main>
      </div>
    </div>
  );
}

/* ── top bar ─────────────────────────────────────────────────────────── */

function TopBar({ tenant, graphs, onTenantChange, health, onToggleNav }: { tenant?: Tenant; graphs?: WorkspaceInfo[] | null; onTenantChange?: (t: Tenant) => void; health: HealthStatus | null; onToggleNav: () => void }) {
  return (
    <header className="relative z-30 flex h-12 shrink-0 items-center gap-3 bg-nav px-3 text-nav-fg whitespace-nowrap">
      <button type="button" onClick={onToggleNav} aria-label="Toggle menu" className="grid size-8 place-items-center rounded hover:bg-nav-2">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      <Link href="/start" className="flex items-center gap-2">
        <Logo />
        <span className="text-[15px] font-bold tracking-tight">Blastradius</span>
      </Link>

      {tenant && (
        <div className="ml-3 flex min-w-0 items-center gap-2 border-l border-white/15 pl-4">
          <span className="text-xs text-nav-muted">Company</span>
          {onTenantChange ? (
            <select
              value={tenant}
              onChange={(e) => onTenantChange(e.target.value)}
              aria-label="Company"
              className="max-w-56 min-w-0 rounded border border-white/25 bg-nav-2 px-2 py-1 text-sm font-semibold text-nav-fg outline-none focus:border-brand"
            >
              {!(graphs ?? []).some((g) => g.id === tenant) && <option value={tenant}>{companyName(tenant, graphs)}</option>}
              {(graphs ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {companyName(g.id, graphs)}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-sm font-semibold">{companyName(tenant, graphs)}</span>
          )}
        </div>
      )}

      <div className="ml-auto flex items-center gap-4">
        <SystemStatus health={health} />
        {health?.agentMode && (
          <span
            className="hidden rounded-full border border-white/25 px-2 py-0.5 text-xs text-nav-muted md:inline"
            title={health.agentMode === "llm" ? `AI agents (${health.model ?? "LLM"}) decide which graph tools to call` : "No AI key set: the agents call the same graph tools in a fixed order. Same answers, fully deterministic."}
          >
            {health.agentMode === "llm" ? "AI mode" : "Demo mode"}
          </span>
        )}
        <Link href="/about-us" className="hidden text-sm text-nav-muted hover:text-nav-fg md:inline">
          Help
        </Link>
        <UserMenu onDark />
      </div>
    </header>
  );
}

function SystemStatus({ health }: { health: HealthStatus | null }) {
  const [open, setOpen] = useState(false);
  if (!health) return <span className="text-xs text-nav-muted">Checking systems…</span>;
  const graphOk = health.falkordb.ok;
  const dbOk = health.postgres.ok;
  const label = graphOk && dbOk ? "All systems operational" : graphOk ? "History unavailable" : "Graph database down";
  const tone = graphOk && dbOk ? "ok" : graphOk ? "warn" : "bad";
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs text-nav-muted hover:bg-nav-2 hover:text-nav-fg">
        <span className={cx("size-2 rounded-full", tone === "ok" ? "bg-[#29ad32]" : tone === "warn" ? "bg-brand" : "bg-[#ff5d64]")} />
        <span className="hidden lg:inline">{label}</span>
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-1.5 w-72 rounded-lg border border-line-2 bg-panel p-3 text-fg shadow-xl shadow-black/15 whitespace-normal">
          <div className="text-sm font-semibold">System status</div>
          <StatusLine ok={graphOk} name="Graph database (FalkorDB)" detail={graphOk ? `responding in ${health.falkordb.ms ?? "?"} ms. Holds all company knowledge and agent memory.` : (health.falkordb.error ?? "not reachable")} />
          <StatusLine ok={dbOk} name="History database (Postgres)" detail={dbOk ? "chat history and the action audit log." : "past investigations can't be listed; everything else works."} />
          <div className="mt-2 border-t border-line pt-2 text-xs text-muted">
            Embeddings: {health.embeddings === "model" ? "MiniLM model (local)" : "hashed fallback"} · Tools called {health.transport === "mcp" ? "over MCP" : "in-process"}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusLine({ ok, name, detail }: { ok: boolean; name: string; detail: string }) {
  return (
    <div className="mt-2 flex gap-2 text-xs">
      <StatusIcon tone={ok ? "ok" : "bad"} />
      <div>
        <div className="font-semibold">{name}</div>
        <div className="text-muted">{detail}</div>
      </div>
    </div>
  );
}

function useHealth(enabled: boolean): HealthStatus | null {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const tick = () =>
      api
        .health()
        .then((h) => alive && setHealth(h))
        .catch(() => alive && setHealth(null));
    void tick();
    const id = setInterval(tick, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled]);
  return health;
}

/* ── side menu ───────────────────────────────────────────────────────── */

interface NavItem {
  key: NavKey;
  label: string;
  hint: string;
  href: (q: string) => string;
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Respond",
    items: [
      { key: "investigate", label: "Investigate an alert", hint: "What breaks, what caused it, who can fix it", href: (q) => `/${q}` },
      { key: "ask", label: "Ask the company", hint: "Answers from decisions, docs and chat, with sources", href: (q) => `/${q ? `${q}&` : "?"}mode=ask` },
    ],
  },
  {
    section: "Know your company",
    items: [
      { key: "people", label: "People & experts", hint: "Who knows what, who is on call", href: (q) => `/people${q}` },
      { key: "memory", label: "What we learned", hint: "Past investigations, incidents and runbooks", href: (q) => `/memory${q}` },
    ],
  },
  {
    section: "Set up",
    items: [
      { key: "graphs", label: "Companies", hint: "All company graphs", href: () => "/start" },
      { key: "build", label: "Graph builder", hint: "Add services, people and history step by step", href: (q) => `/build${q}` },
    ],
  },
  {
    section: "Help",
    items: [{ key: "about", label: "How it works", hint: "The idea, the graph model and the agents", href: () => "/about-us" }],
  },
];

function SideNav({ active, tenant, fixture, onClose }: { active: NavKey; tenant?: Tenant; fixture?: boolean; onClose: () => void }) {
  const params = new URLSearchParams();
  if (tenant) params.set("tenant", tenant);
  if (fixture) params.set("fixture", "1");
  const q = params.size ? `?${params}` : "";
  return (
    <nav className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-line-2/60 bg-panel">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <span className="text-base font-bold text-fg">Blastradius</span>
        <button type="button" onClick={onClose} aria-label="Hide menu" className="grid size-7 place-items-center rounded text-muted hover:bg-panel-3 hover:text-fg">
          ✕
        </button>
      </div>
      <div className="flex flex-col gap-4 px-3 py-4">
        {NAV.map((group) => (
          <div key={group.section}>
            <div className="px-2 pb-1 text-xs font-bold text-fg">{group.section}</div>
            <ul className="flex flex-col">
              {group.items.map((item) => {
                const isActive = item.key === active;
                return (
                  <li key={item.key}>
                    <Link
                      href={item.href(q)}
                      aria-current={isActive ? "page" : undefined}
                      className={cx(
                        "block rounded-md border-l-[3px] px-2 py-1.5",
                        isActive ? "border-accent bg-[#f0f7ff] font-semibold text-accent" : "border-transparent text-fg-2 hover:bg-panel-3 hover:text-fg",
                      )}
                    >
                      <span className="block text-sm">{item.label}</span>
                      <span className={cx("block text-xs font-normal", isActive ? "text-accent/80" : "text-faint")}>{item.hint}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="mt-auto border-t border-line px-5 py-3 text-xs text-faint">One FalkorDB graph per company. Every answer shows its evidence.</div>
    </nav>
  );
}

/* ── building blocks pages share ─────────────────────────────────────── */

function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumbs" className="flex flex-wrap items-center gap-1.5 text-sm">
      {crumbs.map((c, i) => (
        <span key={`${c.label}-${i}`} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-faint">›</span>}
          {c.href && i < crumbs.length - 1 ? (
            <Link href={c.href} className="text-accent hover:underline">
              {c.label}
            </Link>
          ) : (
            <span className="text-muted">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** A white container with a header, like a Cloudscape Container. */
export function Panel({ title, description, actions, children, className, bodyClassName }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cx("rounded-xl border border-line-2/50 bg-panel shadow-[0_1px_3px_rgba(0,7,22,0.08)]", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-lg font-bold text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx("px-5 py-4", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Buttons: "primary" is the one orange action per screen; "normal" is outlined blue. */
export function Button({
  variant = "normal",
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "normal" | "link" }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors disabled:cursor-not-allowed",
        variant === "primary" && "bg-brand px-5 py-1.5 text-[#0f141a] hover:bg-brand-2 disabled:bg-line disabled:text-faint",
        variant === "normal" && "border-2 border-accent bg-panel px-4 py-1 text-accent hover:bg-[#f0f7ff] disabled:border-line-2 disabled:text-faint",
        variant === "link" && "px-1 text-accent hover:underline disabled:text-faint",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Same look as Button, for navigation. */
export function ButtonLink({ href, variant = "normal", className, children }: { href: string; variant?: "primary" | "normal"; className?: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-full text-sm font-bold whitespace-nowrap",
        variant === "primary" ? "bg-brand px-5 py-1.5 text-[#0f141a] hover:bg-brand-2" : "border-2 border-accent bg-panel px-4 py-1 text-accent hover:bg-[#f0f7ff]",
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** Status indicator icon: ✓ in green, ! in amber, ✕ in red, ◷ in blue. */
export function StatusIcon({ tone }: { tone: "ok" | "warn" | "bad" | "info" | "pending" }) {
  const map = {
    ok: ["#037f0c", "✓"],
    warn: ["#c27c00", "!"],
    bad: ["#d91515", "✕"],
    info: ["#0972d3", "i"],
    pending: ["#5f6b7a", "…"],
  } as const;
  const [color, glyph] = map[tone];
  return (
    <span className="inline-grid size-4 shrink-0 place-items-center rounded-full text-[10px] leading-none font-bold text-white" style={{ background: color }}>
      {glyph}
    </span>
  );
}

/** "Completed" / "In progress" / "Failed" with an icon, like Cloudscape's StatusIndicator. */
export function StatusText({ tone, children }: { tone: "ok" | "warn" | "bad" | "info" | "pending"; children: ReactNode }) {
  const color = { ok: "text-ok", warn: "text-warn", bad: "text-bad", info: "text-accent", pending: "text-muted" }[tone];
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-sm", color)}>
      <StatusIcon tone={tone} />
      {children}
    </span>
  );
}

export function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="10" fill="none" stroke="#ff9900" strokeOpacity="0.45" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="6" fill="none" stroke="#ff9900" strokeOpacity="0.8" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="2.6" fill="#ff9900" />
    </svg>
  );
}
