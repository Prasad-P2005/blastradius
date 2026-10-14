/**
 * embed.ts — text → 384-dim L2-normalised vectors, computed locally.
 *
 * Primary: transformers.js `feature-extraction` with Xenova/all-MiniLM-L6-v2,
 * mean pooling + normalisation (the standard sentence-transformers recipe).
 * The model is downloaded once into HF_CACHE_DIR (default <repo>/.cache/hf).
 *
 * Fallback: a deterministic hashed bag-of-words (also 384 dims, normalised),
 * used when EMBEDDINGS=hash or when the model cannot load (offline, no
 * onnxruntime binary…). It only captures word overlap, but it is stable and
 * keeps vector search working end to end. `embeddingBackend()` reports which
 * one is active so the UI/health can show it.
 *
 * NOTE: never mix backends inside one graph — vectors from different backends
 * are not comparable. Re-load the snapshot if you switch.
 */
import { isAbsolute, join } from "node:path";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "@blastradius/shared";
import { findRepoRoot, loadRootEnv } from "@blastradius/shared/env";

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<Extractor | null> | null = null;
let loadError: string | null = null;

/** Lowercased word tokens (letters/digits), used by the hash embedder. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** FNV-1a 32-bit: tiny, stable across runs and platforms. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic hashed bag-of-words. Each token adds ±1 to bucket
 * hash(token) % 384 (the sign comes from another hash bit, which reduces
 * collision bias). Bigrams are added at half weight for a little word order.
 */
export function hashEmbed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  const toks = tokenize(text);
  const add = (tok: string, w: number) => {
    const h = fnv1a(tok);
    const sign = (h >>> 31) & 1 ? -1 : 1;
    const i = h % EMBEDDING_DIM;
    v[i] = v[i]! + sign * w;
  };
  toks.forEach((t, i) => {
    add(t, 1);
    if (i > 0) add(`${toks[i - 1]}_${t}`, 0.5);
  });
  return l2normalize(v);
}

export function l2normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) {
    // An empty text still needs a valid unit vector for vecf32/cosine.
    const out = new Array<number>(v.length).fill(0);
    out[0] = 1;
    return out;
  }
  return v.map((x) => x / norm);
}

function wantHash(): boolean {
  loadRootEnv();
  return (process.env.EMBEDDINGS ?? "model").toLowerCase() === "hash";
}

/** Loads the transformers.js pipeline once; resolves null if it cannot load. */
function getExtractor(): Promise<Extractor | null> {
  if (wantHash()) return Promise.resolve(null);
  if (!extractorPromise) {
    extractorPromise = (async () => {
      try {
        const tf = await import("@huggingface/transformers");
        const root = findRepoRoot();
        const dir = process.env.HF_CACHE_DIR || ".cache/hf";
        tf.env.cacheDir = isAbsolute(dir) ? dir : join(root, dir);
        tf.env.allowLocalModels = false;
        const pipe = await tf.pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "fp32" });
        return pipe as unknown as Extractor;
      } catch (err) {
        loadError = err instanceof Error ? err.message : String(err);
        console.warn(`[graph/embed] model unavailable, using hash embeddings: ${loadError}`);
        return null;
      }
    })();
  }
  return extractorPromise;
}

/** Which backend `embed()` uses right now ('model' loads the model if needed). */
export async function embeddingBackend(): Promise<"model" | "hash"> {
  return (await getExtractor()) ? "model" : "hash";
}

/** Why the model failed to load, if it did (for health/debugging). */
export function embeddingLoadError(): string | null {
  return loadError;
}

/** One text → one 384-dim unit vector. */
export async function embed(text: string): Promise<number[]> {
  const [v] = await embedMany([text]);
  return v!;
}

const BATCH = 32;

/** Many texts → vectors, batched through the shared pipeline. */
export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  if (!extractor) return texts.map(hashEmbed);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => (t.trim().length > 0 ? t : "(empty)"));
    const tensor = await extractor(batch, { pooling: "mean", normalize: true });
    for (const row of tensor.tolist()) out.push(row.map((x) => Number(x)));
  }
  return out;
}

/**
 * Vectors are sent to FalkorDB inside the query text (the client inlines
 * params), so keep them short and free of exponent notation: 6 decimals is
 * plenty for cosine similarity.
 */
export function vecParam(v: number[]): number[] {
  return v.map((x) => Math.round(x * 1e6) / 1e6);
}
