/** Reads the demo identity (see lib/demo-user.ts) in route handlers. */
import { USER_COOKIE, decodeUser, type DemoUser } from "@/lib/demo-user";
import { HttpError } from "./http.ts";

export function userFromRequest(req: Request): DemoUser | null {
  const header = req.headers.get("cookie") ?? "";
  const raw = header
    .split(/;\s*/)
    .find((c) => c.startsWith(`${USER_COOKIE}=`))
    ?.slice(USER_COOKIE.length + 1);
  return decodeUser(raw);
}

export function requireUser(req: Request): DemoUser {
  const u = userFromRequest(req);
  if (!u) throw new HttpError(401, "pick a demo user on /login first");
  return u;
}
