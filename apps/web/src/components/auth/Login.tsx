"use client";
/**
 * /login: pick a demo user from a dropdown, no credentials. The users are a
 * fixed list of fictional people (lib/demo-user.ts); the identity only names
 * who created a graph and greets you.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { DEMO_USERS } from "@/lib/demo-user";
import { Logo } from "@/components/console/Console";
import { Spinner } from "@/components/ui";
import { Avatar, useUser } from "./UserMenu";

export function Login() {
  const params = useSearchParams();
  const current = useUser();
  const [selected, setSelected] = useState(current?.id ?? DEMO_USERS[0]!.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = DEMO_USERS.find((u) => u.id === selected) ?? DEMO_USERS[0]!;

  const login = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.login(id);
      const next = params.get("next");
      // a hard navigation so the root layout re-reads the cookie
      window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/start";
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid min-h-full max-w-5xl grid-cols-1 items-center gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Logo />
            <span className="text-base font-semibold tracking-tight">Blastradius</span>
          </div>
          <h1 className="mt-6 max-w-lg text-3xl leading-tight font-semibold tracking-tight text-fg sm:text-4xl">Build your company's graph. Then let agents reason over it.</h1>
          <p className="mt-4 max-w-lg text-sm leading-relaxed text-fg-2">
            You start with an empty FalkorDB graph and add services, dependencies, people, code, incidents and decisions one step at a time. After every step
            you can run the agents' tools and see what the new data lets them answer.
          </p>
          <ol className="mt-6 space-y-2.5 text-sm text-fg-2">
            {["Create a graph", "Add nodes and relationships, step by step (or seed sample data)", "Try each agent tool as it unlocks", "Fire an alert and watch five agents investigate"].map((t, i) => (
              <li key={t} className="flex gap-3">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-accent/50 font-mono text-2xs text-accent">{i + 1}</span>
                {t}
              </li>
            ))}
          </ol>
          <Link href="/about-us" className="mt-6 inline-block text-xs text-accent hover:underline">
            Read the pitch →
          </Link>
        </div>

        <div className="min-w-0 rounded-xl border border-line bg-panel p-5 shadow-2xl shadow-black/40 sm:p-6">
          <h2 className="text-lg font-semibold text-fg">Choose a demo user</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">No password needed. These are fictional users for trying the app.</p>

          <label htmlFor="user" className="mt-5 block text-2xs font-semibold tracking-[0.08em] text-muted uppercase">
            Log in as
          </label>
          <select id="user" value={selected} onChange={(e) => setSelected(e.target.value)} className="mt-1.5 w-full cursor-pointer rounded-md border border-line-2 bg-panel-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent/60">
            {DEMO_USERS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}: {u.role}
              </option>
            ))}
          </select>

          <div className="animate-fade-in mt-4 flex items-center gap-3 rounded-lg border border-line bg-panel-2 p-4">
            <Avatar name={chosen.name} size={40} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-fg">{chosen.name}</div>
              <div className="truncate text-xs text-muted">{chosen.role}</div>
              <div className="mt-1 text-xs text-fg-2">{chosen.blurb}</div>
            </div>
          </div>

          {error && <div className="mt-4 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</div>}

          <button type="button" disabled={busy} onClick={() => void login(chosen.id)} className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-accent-2 px-4 py-2.5 text-sm font-medium text-white hover:bg-accent disabled:opacity-50">
            {busy && <Spinner className="border-white/30 border-t-white" />}
            Continue as {chosen.name.split(" ")[0]}
          </button>

          <div className="mt-5 border-t border-line pt-4">
            <div className="text-2xs font-semibold tracking-[0.08em] text-muted uppercase">Quick pick</div>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {DEMO_USERS.slice(0, 4).map((u) => (
                <button key={u.id} type="button" disabled={busy} onClick={() => void login(u.id)} className="flex min-w-0 items-center gap-2 rounded-md border border-line px-2 py-1.5 text-left hover:border-line-2 hover:bg-panel-2 disabled:opacity-50">
                  <Avatar name={u.name} size={20} />
                  <span className="truncate text-xs text-fg">{u.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
