/** Reads the builder's data files (data/samples/starter.json, data/<pack>.json). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuilderSample } from "@blastradius/graph";
import { findRepoRoot } from "@blastradius/shared/env";
import type { SeedPack, Snapshot } from "@blastradius/shared";

export interface Starter {
  about: string;
  steps: Record<string, BuilderSample>;
}

function readData<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(findRepoRoot(), "data", ...parts), "utf8")) as T;
}

export const readStarter = () => readData<Starter>("samples", "starter.json");
export const readPack = (pack: SeedPack) => readData<Snapshot>(`${pack}.json`);
