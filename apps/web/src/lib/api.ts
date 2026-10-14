/**
 * Browser-side API client. Every function throws an Error with the server's
 * `{error}` message on a non-2xx response, so the UI can show it verbatim.
 */
import type {
  AgentEvent,
  CloseIncidentRequest,
  CloseIncidentResult,
  HealthStatus,
  InvestigateRequest,
  MemoryInspectorData,
  Scenario,
  SessionSummary,
  Subgraph,
  Tenant,
} from "@blastradius/shared";
import { createSseDecoder } from "./sse.ts";

export interface TenantView {
  id: Tenant;
  name: string;
  description: string;
  sourceRepo: string;
  counts: { labels: Record<string, number>; rels: Record<string, number> } | null;
}

export interface SessionListItem extends SessionSummary {
  title?: string;
}

export interface SessionMessage {
  id?: number | string;
  role: "user" | "assistant" | "system";
  content: string;
  runId?: string | null;
  createdAt?: string;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return body as T;
}

const q = (params: Record<string, string | number | undefined | null>) =>
  new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== null).map(([k, v]) => [k, String(v)]),
  ).toString();

export const api = {
  health: () => getJson<HealthStatus>("/api/health"),
  tenants: () => getJson<TenantView[]>("/api/tenants"),
  scenarios: (tenant: Tenant) => getJson<Scenario[]>(`/api/scenarios?${q({ tenant })}`),
  sessions: (tenant: Tenant) => getJson<SessionListItem[]>(`/api/sessions?${q({ tenant })}`),
  createSession: (tenant: Tenant) =>
    getJson<{ sessionId: string }>("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant }) }),
  sessionMessages: (id: string) => getJson<{ messages: SessionMessage[]; events: AgentEvent[] }>(`/api/sessions/${encodeURIComponent(id)}/messages`),
  overview: (tenant: Tenant) => getJson<Subgraph>(`/api/graph/overview?${q({ tenant })}`),
  neighborhood: (tenant: Tenant, uid: string, limit = 40) => getJson<Subgraph>(`/api/graph/neighborhood?${q({ tenant, uid, limit })}`),
  memory: (tenant: Tenant, sessionId?: string) => getJson<MemoryInspectorData>(`/api/memory?${q({ tenant, sessionId })}`),
  closeIncident: (req: CloseIncidentRequest) =>
    getJson<CloseIncidentResult>("/api/incidents/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) }),
};

/**
 * POST /api/investigate and yield each AgentEvent as it arrives.
 * Aborting `signal` closes the connection; the server then aborts the agent loop.
 */
export async function* streamInvestigate(req: InvestigateRequest, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  const res = await fetch("/api/investigate", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(req),
    signal: signal ?? null,
  });
  if (!res.ok || !res.body) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const decoder = createSseDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const data of decoder.push(value)) yield JSON.parse(data) as AgentEvent;
  }
}
