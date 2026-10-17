import { USER_COOKIE } from "@/lib/demo-user";
import { json } from "@/server/http";

export const runtime = "nodejs";

export function POST() {
  const res = json({ ok: true });
  res.headers.append("set-cookie", `${USER_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
  return res;
}
