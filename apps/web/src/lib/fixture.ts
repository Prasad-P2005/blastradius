/**
 * Dev-only fixture replay (?fixture=1): the UI runs with no backend at all.
 * Fixtures are hand-written AgentEvent[] streams that follow the contract
 * exactly; they're loaded with dynamic import so they never ship in the main bundle.
 */
import type { AgentEvent, InvestigationMode, MemoryInspectorData, Scenario, Subgraph } from "@blastradius/shared";

export function fixtureEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const on = new URLSearchParams(window.location.search).get("fixture") === "1";
  const allowed = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_ENABLE_FIXTURES === "1";
  return on && allowed;
}

/** ?instant=1 applies the whole stream at once (for screenshots). */
export function fixtureInstant(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("instant") === "1";
}

export async function loadFixtureRun(mode: InvestigationMode): Promise<AgentEvent[]> {
  const mod = mode === "ask" ? await import("../fixtures/run.acme.ask.json") : await import("../fixtures/run.acme.json");
  return mod.default as unknown as AgentEvent[];
}

export async function loadFixtureOverview(): Promise<Subgraph> {
  return (await import("../fixtures/overview.acme.json")).default as unknown as Subgraph;
}

export async function loadFixtureMemory(): Promise<MemoryInspectorData> {
  return (await import("../fixtures/memory.acme.json")).default as unknown as MemoryInspectorData;
}

export const FIXTURE_SCENARIOS: Scenario[] = [
  {
    id: "acme-checkout-5xx",
    tenant: "acme",
    title: "checkout 5xx at 12%",
    mode: "incident",
    question: "checkout 5xx at 12%",
    alert: { service: "checkout", metric: "http_5xx_rate", value: "12%" },
    presenterNote: "Fixture replay.",
  },
  {
    id: "acme-ask-kafka",
    tenant: "acme",
    title: "Why does checkout publish to Kafka?",
    mode: "ask",
    question: "Why does checkout publish to Kafka instead of calling accounting directly?",
    presenterNote: "Fixture replay.",
  },
];

/**
 * Replay with the recorded pacing (gaps clamped to 40–450 ms). Each replay gets a
 * fresh runId so the reducer doesn't dedupe a second replay in the same session.
 */
export async function* replayFixture(events: AgentEvent[], opts: { instant?: boolean; signal?: AbortSignal; nonce: number }): AsyncGenerator<AgentEvent> {
  let prev: number | null = null;
  for (const ev of events) {
    if (opts.signal?.aborted) return;
    const t = Date.parse(ev.ts);
    if (!opts.instant && prev !== null) {
      const gap = Math.min(450, Math.max(40, t - prev));
      await new Promise((r) => setTimeout(r, gap));
    }
    prev = t;
    yield { ...ev, runId: `${ev.runId}-${opts.nonce}` };
  }
}
