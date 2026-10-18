"use client";
/**
 * The logged-in demo user (from the br_user cookie, read once by the root
 * layout) and the avatar menu shown in every page header.
 */
import Link from "next/link";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { initials, type DemoUser } from "@/lib/demo-user";
import { cx } from "@/components/ui";

const UserContext = createContext<DemoUser | null>(null);

export function UserProvider({ user, children }: { user: DemoUser | null; children: ReactNode }) {
  return <UserContext.Provider value={user}>{children}</UserContext.Provider>;
}

export function useUser(): DemoUser | null {
  return useContext(UserContext);
}

export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  // a stable hue per name so each persona keeps its colour across pages
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.4, background: `hsl(${h} 45% 42%)` }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/**
 * `compact` hides the name next to the avatar (the console header is crowded).
 * `onDark` styles the trigger for the navy top bar of the app shell.
 */
export function UserMenu({ compact = false, onDark = false }: { compact?: boolean; onDark?: boolean }) {
  const user = useUser();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) {
    return (
      <Link href="/login" className={cx("text-xs hover:underline", onDark ? "text-nav-fg" : "text-accent")}>
        Log in
      </Link>
    );
  }

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      window.location.href = "/login";
    }
  };

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} title={`${user.name} · ${user.role}`} className={cx("flex items-center gap-2 rounded-md px-1 py-0.5", onDark ? "hover:bg-nav-2" : "hover:bg-panel-3")} aria-haspopup="menu" aria-expanded={open}>
        <Avatar name={user.name} size={22} />
        <span className={cx("hidden text-xs whitespace-nowrap", onDark ? "text-nav-fg" : "text-fg-2", compact ? "2xl:inline" : "md:inline")}>{user.name}</span>
      </button>
      {open && (
        <div role="menu" className="animate-fade-in absolute top-full right-0 z-50 mt-1.5 w-60 overflow-hidden rounded-lg border border-line-2 bg-panel shadow-xl shadow-black/15">
          <div className="flex items-center gap-2.5 border-b border-line p-3">
            <Avatar name={user.name} size={32} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-fg">{user.name}</div>
              <div className="truncate text-2xs text-muted">{user.role}</div>
            </div>
          </div>
          <MenuLink href="/start" onClick={() => setOpen(false)}>
            Your graphs
          </MenuLink>
          <MenuLink href="/build" onClick={() => setOpen(false)}>
            Build a new graph
          </MenuLink>
          <MenuLink href="/about-us" onClick={() => setOpen(false)}>
            About Blastradius
          </MenuLink>
          <button type="button" onClick={() => void logout()} className="block w-full border-t border-line px-3 py-2 text-left text-xs text-fg-2 hover:bg-panel-3 hover:text-fg">
            Switch user / log out
          </button>
        </div>
      )}
    </div>
  );
}

function MenuLink({ href, onClick, children }: { href: string; onClick: () => void; children: ReactNode }) {
  return (
    <Link href={href} onClick={onClick} role="menuitem" className="block px-3 py-2 text-xs text-fg-2 hover:bg-panel-3 hover:text-fg">
      {children}
    </Link>
  );
}
