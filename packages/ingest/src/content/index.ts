/** Per-tenant hand-written synthetic content. */
import type { SeedPack as Tenant } from "@blastradius/shared";
import type { TenantContent } from "../synth/types.ts";
import { ACME_CONTENT } from "./acme.ts";
import { GLOBEX_CONTENT } from "./globex.ts";

export const CONTENT: Record<Tenant, TenantContent> = { acme: ACME_CONTENT, globex: GLOBEX_CONTENT };
