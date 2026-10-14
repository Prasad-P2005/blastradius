/**
 * scripts/scale-check.ts — loads a synthetic graph roughly the size of a real
 * tenant (namespace `scale`) and times the heavier tools against the 1000 ms
 * server default timeout. No embeddings (EMBEDDINGS irrelevant).
 */
process.env.BLASTRADIUS_GRAPH_NAMESPACE = "scale";
const g = await import("../src/index.ts");
import type { Snapshot, SnapshotEdge, SnapshotNode } from "@blastradius/shared";

const nodes: SnapshotNode[] = [];
const edges: SnapshotEdge[] = [];
let seed = 42;
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
const S = 30, F = 6000, P = 5000, H = 300;
for (let i = 0; i < S; i++) nodes.push({ label: "Service", uid: `Service:s${i}`, props: { name: `s${i}`, slug: `s${i}`, tier: 1 + (i % 3) } });
for (let i = 1; i < S; i++) for (let k = 0; k < 2; k++) edges.push({ type: "DEPENDS_ON", from: `Service:s${rnd(i)}`, to: `Service:s${i}`, props: { protocol: "grpc" } });
for (let i = 0; i < F; i++) {
  nodes.push({ label: "File", uid: `File:f${i}`, props: { path: `f${i}`, service: `s${i % S}` } });
  edges.push({ type: "PART_OF", from: `File:f${i}`, to: `Service:s${i % S}` });
}
for (let i = 0; i < H; i++) nodes.push({ label: "Person", uid: `Person:p${i}`, props: { name: `P ${i}`, slug: `p${i}`, isBot: i < 5 } });
const t0 = Date.UTC(2025, 0, 1);
for (let i = 0; i < P; i++) {
  nodes.push({ label: "PR", uid: `PR:${i}`, props: { number: i, title: `change ${i} pool cache`, mergedAt: t0 + i * 3_600_000, isBot: false } });
  edges.push({ type: "AUTHORED", from: `Person:p${rnd(H)}`, to: `PR:${i}` });
  for (let k = 0; k < 3; k++) edges.push({ type: "MODIFIES", from: `PR:${i}`, to: `File:f${rnd(F)}`, props: { additions: 1, deletions: 1 } });
}
const dedup = new Map(edges.map((e) => [`${e.type}|${e.from}|${e.to}`, e]));
const snap: Snapshot = { tenant: "acme", generatedAt: "", seed: 1, sources: [], nodes, edges: [...dedup.values()] };
console.log("load", await g.loadSnapshot("acme", snap, { reset: true, embed: false }));
for (const [name, input] of [
  ["blast_radius", { service: "s29", maxHops: 6, direction: "both" }],
  ["critical_services", {}],
  ["suspect_changes", { service: "s5", maxHops: 4 }],
  ["who_knows", { service: "s5" }],
  ["who_knows", { topic: "pool" }],
  ["explain_path", { from: "Person:p1", to: "Service:s20", maxHops: 8 }],
  ["failure_communities", {}],
] as const) {
  try {
    const r = await g.runTool(name, { tenant: "acme" }, input);
    console.log(name, r.ms, "ms", r.rows.length, "rows");
  } catch (e) {
    console.log(name, "FAILED", (e as Error).message);
  }
}
console.log("overview", (await g.overview("acme")).nodes.length, "counts", JSON.stringify(await g.counts("acme")));
if (!process.env.KEEP) await g.resetGraph("acme");
await g.closeFalkor();
