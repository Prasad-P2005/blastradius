/**
 * Shapes of the hand-written, per-tenant content (content/acme.ts,
 * content/globex.ts). All prose here is SYNTHETIC; every PR number, person
 * and service it references is REAL and checked at build time.
 */
import type { TeamSeed } from "./teams.ts";

export type Severity = "SEV1" | "SEV2" | "SEV3" | "SEV4";

export interface IncidentSpec {
  key: string;
  /** primary affected service (the PR must touch it) */
  service: string;
  /** extra AFFECTED services (e.g. the datastore or a caller) */
  neighbors?: string[];
  /** the REAL human PR that caused it */
  causedBy: number;
  severity: Severity;
  title: string;
  summary: string;
  rootCause: string;
  alert: { title: string; metric: string; value: string; message: string };
  runbook: { slug: string; title: string; steps: string[] };
  /** hours after the PR merged that the incident started: [min, max] */
  startedHoursAfterMerge?: [number, number];
  /** how long it lasted, minutes: [min, max] */
  durationMinutes?: [number, number];
  /** extra responders (persona slugs, without prefix) besides the owning team's personas */
  responders?: string[];
}

export interface DecisionSpec {
  key: string; // ADR-001
  docSlug: string;
  title: string;
  status: "accepted" | "superseded" | "proposed";
  context: string;
  decision: string;
  consequences: string;
  justifies: number[];
  about: string[];
  /** persona slugs (without prefix); default = the owning team's personas */
  decidedBy?: string[];
  /** also DECIDED_BY the team owning about[0] (default true) */
  decidedByTeam?: boolean;
}

export type When =
  | { daysAgo: number } // relative to the newest PR
  | { pr: number; offsetDays: number } // relative to a real PR's merge
  | { incident: string; offsetHours: number };

export interface IssueSpec {
  title: string;
  body: string;
  status: "open" | "in_progress" | "done";
  priority: "P1" | "P2" | "P3" | "P4";
  about: string[];
  when: When;
  /** persona slug (without prefix) who filed it; default = rotates over the owning team's personas */
  postedBy?: string;
  /** days to resolution when status = done */
  resolvedAfterDays?: number;
}

export interface ThreadSpec {
  channel: string;
  title: string;
  /** [speaker placeholder `{{persona:slug}}`, message]; the first speaker POSTED the thread */
  lines: [string, string][];
  about: string[];
  when: When;
}

export interface ScenarioSpec {
  id: string;
  mode: "incident" | "ask";
  title: string;
  question: string;
  alert?: { service: string; metric: string; value: string; message: string };
  suspectPr?: number;
  pastIncident?: string;
  /** expected expert = a REAL author slug; default = top human author on the alert service */
  expert?: string;
  /** ask mode: uids that ask_company should return in its top 3 */
  sources?: string[];
  presenterNote: string;
}

/** A fictional person. Carries everything fictional a person does. */
export interface PersonaSpec {
  /** slug WITHOUT the "persona-" prefix */
  slug: string;
  name: string;
  role: string;
  team: string;
}

export interface TenantContent {
  /** ticket key prefix, e.g. "ACME" */
  issuePrefix: string;
  personas: PersonaSpec[];
  teams: TeamSeed[];
  incidents: IncidentSpec[];
  decisions: DecisionSpec[];
  issues: IssueSpec[];
  threads: ThreadSpec[];
  scenarios: ScenarioSpec[];
  /** how many extra tickets / threads to generate from templates */
  templatedIssues: number;
  templatedThreads: number;
}
