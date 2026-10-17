/**
 * Sends visitors without a demo identity to /login. API routes stay open (MCP
 * clients, curl and tests call them directly), and so do /login and /about-us
 * so the pitch can be shared without logging in.
 */
import { NextResponse, type NextRequest } from "next/server";
import { USER_COOKIE, decodeUser } from "@/lib/demo-user";

export function middleware(req: NextRequest) {
  if (decodeUser(req.cookies.get(USER_COOKIE)?.value)) return NextResponse.next();
  const url = req.nextUrl.clone();
  const next = req.nextUrl.pathname + req.nextUrl.search;
  url.pathname = "/login";
  url.search = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // everything except API routes, Next internals, static files, /login and /about-us
  matcher: ["/((?!api|_next|favicon|login|about-us|.*\\.[a-z0-9]+$).*)"],
};
