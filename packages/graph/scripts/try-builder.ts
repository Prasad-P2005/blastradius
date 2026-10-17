/**
 * Manual check of the builder on a throwaway graph `itest-builder`:
 * create → seed every starter step → run the agents' tools → edit → delete.
 *   pnpm --filter @blastradius/graph exec tsx scripts/try-builder.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRootEnv, findRepoRoot } from "@blastradius/shared/env";
loadRootEnv();
const g = await import("../src/index.ts");
const T = "itest-builder";
if (await g.workspaceExists(T)) await g.deleteWorkspace(T);
const made = await g.createWorkspace(T, { name: "Itest Builder", createdBy: "script" });
console.log("created", made.workspace.id, made.cypher.length, "statements");
const starter = JSON.parse(readFileSync(join(findRepoRoot(), "data/samples/starter.json"), "utf8")) as { steps: Record<string, import("../src/index.ts").BuilderSample> };
for (const [step, sample] of Object.entries(starter.steps)) {
  const r = await g.addSample(T, sample);
  console.log(`seed ${step}: ${r.nodes} nodes ${r.edges} edges in ${r.ms} ms`);
}
const ws = await g.getWorkspace(T);
console.log("workspace", ws.nodes, "nodes", ws.edges, "edges");
const ctx = { tenant: T };
const show = async (tool: Parameters<typeof g.runTool>[0], input: unknown) => {
  const r = await g.runTool(tool, ctx, input);
  console.log(`${tool}: ${r.summary}`);
};
await show("blast_radius", { service: "Service:orders-db" });
await show("suspect_changes", { service: "Service:payments" });
await show("who_knows", { service: "Service:payments" });
await show("on_call", { service: "Service:payments" });
await show("past_incidents", { service: "Service:payments" });
await show("similar_incidents", { text: "payment charges timing out, retries piling up" });
await show("ask_company", { question: "why do we retry payments?" });
await show("critical_services", {});
await show("search_nodes", { query: "payments" });
// edit + delete
const n = await g.addNode(T, "Service", { name: "Loyalty Points", tier: "3" });
await g.addEdge(T, "DEPENDS_ON", "Service:orders", n.uid!, { protocol: "grpc" });
try { await g.addEdge(T, "OWNS", "Service:orders", "Team:platform"); } catch (e) { console.log("direction check:", (e as Error).message); }
await g.deleteEdge(T, "DEPENDS_ON", "Service:orders", n.uid!);
await g.deleteNode(T, n.uid!);
console.log("dump", (await g.graphDump(T)).nodes.length, "nodes in live view");
console.log("list", (await g.listWorkspaces()).map((w) => `${w.id}(${w.nodes})`).join(", "));
await g.deleteWorkspace(T);
console.log("deleted; exists:", await g.workspaceExists(T));
await g.closeFalkor();
