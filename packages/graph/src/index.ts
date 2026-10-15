/**
 * @blastradius/graph — the FalkorDB query layer.
 *
 * This is the public API (SPEC §3). Other packages may import nothing else.
 * Every tool result, memory read and UI read comes from FalkorDB through here.
 */

// connection
export { getFalkor, graphFor, closeFalkor, falkorHealth, runCypher } from "./connection.ts";

// schema + embeddings
export { ensureSchema } from "./schema.ts";
export { embed, embedMany, embeddingBackend } from "./embed.ts";

// converters (the ONE place FalkorDB values become uids / plain JSON)
export { toGNode, toGEdge, toGraphPath, toPlain } from "./convert.ts";

// tools
export type { ToolSpec } from "./tools/types.ts";
export { toolSpecs, runTool, newestPrAt } from "./tools/index.ts";

// memory
export {
  startSession,
  recordEpisode,
  recordFinding,
  readHandoffs,
  recallMemory,
  getFindings,
  closeIncident,
  listGraphSessions,
} from "./memory.ts";

// people (personas + real authors)
export { listPeople, personActivity } from "./people.ts";

// UI reads (all ids are uids)
export { overview, neighborhood, counts, memoryInspector } from "./reads.ts";

// loading
export { loadSnapshot, ingestDelta, resetGraph } from "./load.ts";
export type { LoadStats } from "./load.ts";
