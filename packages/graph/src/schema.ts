/**
 * schema.ts — `ensureSchema(tenant)`: range, full-text and vector indexes
 * (SPEC §1). Idempotent: FalkorDB answers "Attribute 'x' is already indexed"
 * when an index exists, which we treat as success.
 *
 * Syntax verified against FalkorDB 6.0.2:
 *   CREATE INDEX FOR (n:Service) ON (n.uid)
 *   CREATE FULLTEXT INDEX FOR (n:Service) ON (n.name, n.slug, n.description)   -- multi-property works
 *   CREATE VECTOR INDEX FOR (n:Incident) ON (n.embedding) OPTIONS {dimension:384, similarityFunction:'cosine'}
 */
import { EMBEDDED_LABELS, EMBEDDING_DIM, NODE_LABELS, assertLabel, type NodeLabel, type Tenant } from "@blastradius/shared";
import { runCypher } from "./connection.ts";

/** Extra range indexes beyond `uid` (which every label gets). */
export const RANGE_INDEXES: Partial<Record<NodeLabel, string[]>> = {
  Service: ["slug"],
  PR: ["number", "mergedAt"],
  Person: ["slug", "isBot"],
  Incident: ["key"],
  Decision: ["key"],
  Issue: ["key"],
  Session: ["sessionId"],
  Episode: ["sessionId"],
  Finding: ["sessionId", "id"],
};

/** Full-text indexes: label → properties (one multi-property index per label). */
export const FULLTEXT_INDEXES: Partial<Record<NodeLabel, string[]>> = {
  Service: ["name", "slug", "description"],
  PR: ["title"],
  Person: ["name"],
  Team: ["name"],
  Decision: ["title"],
  Doc: ["title"],
  Incident: ["title"],
  Issue: ["title"],
  Thread: ["title"],
  Runbook: ["title"],
};

/** Every DDL statement ensureSchema runs, in order (also printed in docs/CYPHER.md). */
export function schemaStatements(): string[] {
  const out: string[] = [];
  for (const l of NODE_LABELS) {
    const label = assertLabel(l);
    for (const prop of ["uid", ...(RANGE_INDEXES[label] ?? [])]) {
      out.push(`CREATE INDEX FOR (n:${label}) ON (n.${prop})`);
    }
  }
  for (const [l, props] of Object.entries(FULLTEXT_INDEXES)) {
    const label = assertLabel(l);
    out.push(`CREATE FULLTEXT INDEX FOR (n:${label}) ON (${props.map((p) => `n.${p}`).join(", ")})`);
  }
  for (const l of EMBEDDED_LABELS) {
    const label = assertLabel(l);
    out.push(
      `CREATE VECTOR INDEX FOR (n:${label}) ON (n.embedding) OPTIONS {dimension:${EMBEDDING_DIM}, similarityFunction:'cosine'}`,
    );
  }
  return out;
}

function isAlreadyIndexed(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already indexed|already exists/i.test(msg);
}

/** Creates all indexes for the tenant graph. Safe to call repeatedly. */
export async function ensureSchema(tenant: Tenant): Promise<void> {
  for (const stmt of schemaStatements()) {
    try {
      await runCypher(tenant, stmt, {}, { timeoutMs: 10_000 });
    } catch (err) {
      if (!isAlreadyIndexed(err)) throw err;
    }
  }
}
