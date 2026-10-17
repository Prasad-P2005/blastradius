import { readStarter } from "@/server/builder";
import { handle, json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The starter company's data, per builder step ("fill the next example"). */
export function GET() {
  return handle(async () => json(readStarter()));
}
