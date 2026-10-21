import { pruneEmbeddings, sectionsToEmbed, storeEmbeddings, type DB } from './db.ts';
import { OllamaError, type OllamaClient } from './ollama.ts';
import { errorMessage } from './util.ts';

const BATCH = 16;

/** Unit-length float32 copy, so cosine similarity is a dot product. */
export function normalize(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let sum = 0;
  for (const x of out) sum += x * x;
  const len = Math.sqrt(sum) || 1;
  for (let i = 0; i < out.length; i++) out[i]! /= len;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

export interface EmbedReport {
  /** Sections embedded this run. */
  embedded: number;
  /** Still without a vector (Ollama down, model missing, or an error part way). */
  remaining: number;
  /** Vectors from another embedding model were dropped: everything is re-embedded. */
  modelChanged: boolean;
  /** Why embedding stopped early, if it did. */
  skipped?: string;
}

/**
 * Embed every section that has no vector from `model` yet. A vector is keyed by the
 * hash of its text, so an edited sheet only re-embeds the sections whose text changed.
 * Batches are stored as they arrive, so a failure part way keeps the work done so far.
 */
export async function embedIndex(db: DB, client: OllamaClient, model: string): Promise<EmbedReport> {
  const { otherModel } = pruneEmbeddings(db, model);
  const todo = sectionsToEmbed(db, model);
  const report: EmbedReport = { embedded: 0, remaining: todo.length, modelChanged: otherModel > 0 };
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    let vectors: number[][];
    try {
      vectors = await client.embed(model, batch.map((b) => b.input));
    } catch (e) {
      report.skipped = e instanceof OllamaError ? e.message : `embedding failed: ${errorMessage(e)}`;
      return report;
    }
    storeEmbeddings(db, model, batch.map((b, j) => ({ hash: b.hash, vec: normalize(vectors[j]!) })));
    report.embedded += batch.length;
    report.remaining -= batch.length;
  }
  return report;
}

export async function embedQuery(client: OllamaClient, model: string, query: string, timeoutMs?: number): Promise<Float32Array> {
  const [v] = await client.embed(model, [query], timeoutMs);
  return normalize(v!);
}
