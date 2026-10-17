/**
 * Demo identity. Not security: there are no passwords. The login page offers a
 * fixed list of fictional users; picking one stores who you are in a cookie so
 * the app can greet you and record who created a graph.
 *
 * Pure and dependency-free so middleware (edge runtime), server components and
 * route handlers can all use it.
 */

export const USER_COOKIE = "br_user";

export interface DemoUser {
  id: string;
  name: string;
  role: string;
}

/** The dummy users on /login. Fictional people; no emails anywhere. */
export const DEMO_USERS: readonly (DemoUser & { blurb: string })[] = [
  { id: "alex-rivera", name: "Alex Rivera", role: "SRE, on call this week", blurb: "Wants answers fast when an alert fires." },
  { id: "priya-nair", name: "Priya Nair", role: "New engineer, week one", blurb: "Learning how the company's systems fit together." },
  { id: "sam-chen", name: "Sam Chen", role: "Engineering manager", blurb: "Asks why decisions were made and who owns what." },
  { id: "taylor-brooks", name: "Taylor Brooks", role: "Platform engineer", blurb: "Maps services, dependencies and owners." },
  { id: "jordan-lee", name: "Jordan Lee", role: "Support lead", blurb: "Needs to know who to call about which service." },
  { id: "guest", name: "Guest Judge", role: "Hackathon judge", blurb: "Just looking around. Start with the builder." },
];

export function encodeUser(u: DemoUser): string {
  return encodeURIComponent(JSON.stringify({ id: u.id, name: u.name, role: u.role }));
}

/** Returns null for a missing or malformed cookie (never throws). */
export function decodeUser(raw: string | undefined | null): DemoUser | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as Partial<DemoUser>;
    const known = DEMO_USERS.find((u) => u.id === v.id);
    return known ? { id: known.id, name: known.name, role: known.role } : null;
  } catch {
    return null;
  }
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}
