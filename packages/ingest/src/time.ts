/**
 * Date helpers. All in UTC so output never depends on the machine's timezone.
 */

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** Monday 00:00 UTC of the week containing `ms`. */
export function mondayOf(ms: number): number {
  const d = new Date(ms);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = new Date(midnight).getUTCDay(); // 0 = Sunday
  const back = (dow + 6) % 7; // days since Monday
  return midnight - back * DAY;
}

/** 'YYYY-MM-DD' (UTC). */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function parseIsoDate(s: string): number {
  const ms = Date.parse(`${s}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new Error(`bad date: ${s}`);
  return ms;
}

/** Every Monday from mondayOf(fromMs) through `untilIso` (inclusive). */
export function mondaysBetween(fromMs: number, untilIso: string): number[] {
  const end = parseIsoDate(untilIso);
  const out: number[] = [];
  for (let m = mondayOf(fromMs); m <= end; m += WEEK) out.push(m);
  return out;
}
