/**
 * scripts/try-tools.ts — loads the test fixture into the `itest` namespace and
 * runs every tool, printing cypher + rows. Used to capture docs/CYPHER.md samples.
 *   pnpm --filter @blastradius/graph exec tsx scripts/try-tools.ts [toolName]
 */
process.env.BLASTRADIUS_GRAPH_NAMESPACE ??= "itest";
const { fixtureSnapshot } = await import("../test/fixture.ts");
const g = await import("../src/index.ts");

const only = process.argv[2];
const stats = await g.loadSnapshot("acme", fixtureSnapshot, { reset: true });
console.log("load", stats, "backend", await g.embeddingBackend());
const ctx = { tenant: "acme" as const };
const calls: [Parameters<typeof g.runTool>[0], unknown][] = [
  ["blast_radius", { service: "cart" }],
  ["critical_services", { limit: 5 }],
  ["failure_communities", { algorithm: "cdlp" }],
  ["failure_communities", { algorithm: "wcc" }],
  ["suspect_changes", { service: "cart" }],
  ["who_knows", { service: "cart" }],
  ["who_knows", { topic: "valkey pool" }],
  ["on_call", { service: "cart" }],
  ["on_call", { service: "cart", at: "2025-09-24" }],
  ["service_context", { service: "cart" }],
  ["past_incidents", { service: "cart" }],
  ["similar_incidents", { text: "cart returns 503, connection pool exhausted", service: "cart" }],
  ["decision_trace", { query: "why did we move cart to valkey" }],
  ["decision_trace", { uid: "Incident:INC-2025-007" }],
  ["explain_path", { from: "Person:alice-chen", to: "Incident:INC-2025-019" }],
  ["search_nodes", { query: "valkey" }],
  ["ask_company", { question: "Why did we move the cart to Valkey and what went wrong?" }],
];
for (const [name, input] of calls) {
  if (only && name !== only) continue;
  try {
    const r = await g.runTool(name, ctx, input);
    console.log(`\n=== ${name} ${JSON.stringify(input)} (${r.ms} ms)\n${r.cypher}\nparams: ${JSON.stringify(r.params)}\nsummary: ${r.summary}`);
    for (const row of r.rows) console.log("  ", JSON.stringify(row));
    console.log(`   paths: ${r.paths.length}`, r.paths[0] ? r.paths[0].nodes.map((n) => n.id).join(" | ") + "  edges: " + r.paths[0].edges.map((e) => e.id).join(", ") : "");
  } catch (err) {
    console.log(`\n=== ${name} FAILED: ${(err as Error).message}`);
  }
}
await g.closeFalkor();
