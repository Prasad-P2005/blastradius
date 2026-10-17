import { z } from "zod";
import { DEMO_USERS, USER_COOKIE, encodeUser } from "@/lib/demo-user";
import { HttpError, handle, json, readJson } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ id: z.string() });

/** Logs in as one of the fixed demo users (no password: it's a demo identity). */
export function POST(req: Request) {
  return handle(async () => {
    const { id } = Body.parse(await readJson(req));
    const user = DEMO_USERS.find((u) => u.id === id);
    if (!user) throw new HttpError(404, `unknown demo user ${id}`);
    const res = json({ id: user.id, name: user.name, role: user.role });
    res.headers.append("set-cookie", `${USER_COOKIE}=${encodeUser(user)}; Path=/; Max-Age=604800; SameSite=Lax`);
    return res;
  });
}
