/**
 * People reads from @blastradius/graph (listPeople / personActivity, SPEC §3).
 * Resolved at call time so the web app builds and fails visibly (501) if the
 * graph package hasn't shipped them yet, instead of breaking the whole build.
 */
import * as graph from "@blastradius/graph";
import type { PersonActivity, PersonSummary, Tenant } from "@blastradius/shared";
import { HttpError } from "./http.ts";

type PeopleApi = {
  listPeople?: (tenant: Tenant, opts?: { persona?: boolean }) => Promise<PersonSummary[]>;
  personActivity?: (tenant: Tenant, uid: string, opts?: { limit?: number }) => Promise<PersonActivity>;
};
const g = graph as unknown as PeopleApi;

export async function listPeople(tenant: Tenant, opts: { persona?: boolean }): Promise<PersonSummary[]> {
  if (typeof g.listPeople !== "function") throw new HttpError(501, "listPeople is not implemented in @blastradius/graph yet");
  return g.listPeople(tenant, opts);
}

export async function personActivity(tenant: Tenant, uid: string, limit: number): Promise<PersonActivity> {
  if (typeof g.personActivity !== "function") throw new HttpError(501, "personActivity is not implemented in @blastradius/graph yet");
  return g.personActivity(tenant, uid, { limit });
}
