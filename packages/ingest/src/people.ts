/**
 * People from git authorship. REAL names (as written in public commit
 * metadata), keyed by a slug of the name. Emails are never read or stored.
 *
 * - Person uid = `Person:<slug of name>`; the display name is kept as written.
 * - Characters NFKD can't decompose (ł, ø, ß…) are transliterated first, so
 *   "Piotr Kiełkowicz" becomes `piotr-kielkowicz`, not `piotr-kie-kowicz`.
 * - Obvious aliases (the same person committing under two spellings) are
 *   merged through ALIASES. We only merge when the history makes it obvious.
 * - Bots stay in the graph (they are real history) but carry `isBot: true`,
 *   so `who_knows` and the scenarios can ignore them.
 */
import { slugify } from "@blastradius/shared";

const TRANSLIT: Record<string, string> = { ł: "l", Ł: "L", ø: "o", Ø: "O", ß: "ss", æ: "ae", Æ: "AE", đ: "d", Đ: "D", ı: "i", ə: "e", Ə: "E", þ: "th" };

export function personSlug(name: string): string {
  const t = [...name].map((ch) => TRANSLIT[ch] ?? ch).join("");
  const s = slugify(t);
  return ALIASES[s] ?? s;
}

/** alias slug → canonical slug */
const ALIASES: Record<string, string> = {
  // microservices-demo: same contributor, short handle vs full name
  smeet07: "smeet-nagda",
  // opentelemetry-demo: "GarethE" and "Gareth" are the same contributor
  garethe: "gareth",
};

const BOT_PATTERNS: RegExp[] = [
  /\[bot\]$/i,
  /\bbot$/i, // "OpenTelemetry Bot", "StepSecurity Bot", "renovate-bot"
  /dependabot/i,
  /renovate/i, // "Mend Renovate", "WhiteSource Renovate"
  /github-actions/i,
  /otelbot/i,
  /copybara/i,
];

export function isBotName(name: string): boolean {
  return BOT_PATTERNS.some((re) => re.test(name.trim()));
}

/** Guard used by the validator and tests: names must never look like emails. */
export function looksLikeEmail(s: string): boolean {
  return /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(s);
}
