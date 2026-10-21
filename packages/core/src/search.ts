import { embeddingCoverage, sectionText, sectionVectors, type DB } from './db.ts';
import { dot, embedQuery } from './embed.ts';
import { isStale, type Sheet } from './manifest.ts';
import type { OllamaClient } from './ollama.ts';
import { errorMessage, normalizeTag } from './util.ts';

/** bm25 scores are negative (lower is better); a stale hit keeps this share of its score. */
const STALE_FACTOR = 0.5;

export interface SearchHit {
  id: string;
  title: string;
  section: number;
  heading: string;
  tags: string[];
  status: Sheet['status'];
  format: Sheet['format'];
  file: string;
  snippet: string;
  /** lastVerified is older than staleAfterDays. */
  stale: boolean;
  /** OCR'd source: the text may have recognition errors. */
  ocr: boolean;
  /** keywordSearch: bm25, demoted for stale sheets, lower is better. hybridSearch: fused score, higher is better. */
  score: number;
  /** Which rankings found this section (hybridSearch only). */
  via?: ('keyword' | 'vector')[];
}

export interface SearchOptions {
  /** Only sheets that carry every one of these tags. */
  tags?: string[];
  limit?: number;
  /** Markers around matched terms in the snippet. */
  highlight?: [string, string];
  /** Sheets verified longer ago than this are flagged stale and ranked lower. Default 180. */
  staleAfterDays?: number;
  now?: Date;
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'is', 'it',
  'me', 'my', 'of', 'on', 'or', 'the', 'to', 'what', 'when', 'where', 'which', 'with',
]);

/**
 * Turn free text into a safe FTS5 query: each word is quoted (so FTS syntax in the
 * input is inert), words of 3+ letters also match as prefixes, and words are OR-ed
 * so bm25 ranks sections that match more of them first.
 */
export function buildMatchQuery(query: string): string | null {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOPWORDS.has(w));
  const terms = [...new Set(words)].map((w) => (w.length >= 3 ? `"${w}"*` : `"${w}"`));
  return terms.length ? terms.join(' OR ') : null;
}

/** Keyword search over sections (FTS5, bm25 with title and tags weighted up). */
export function keywordSearch(db: DB, sheets: Sheet[], query: string, opts: SearchOptions = {}): SearchHit[] {
  const match = buildMatchQuery(query);
  if (!match) return [];
  const limit = opts.limit ?? 10;
  const wantTags = (opts.tags ?? []).map(normalizeTag).filter(Boolean);
  const [open, close] = opts.highlight ?? ['', ''];
  const byId = new Map(sheets.map((s) => [s.id, s]));

  // Over-fetch so tag filtering and sheets missing from the manifest do not starve the result.
  const rows = db
    .prepare(
      `SELECT s.sheet_id AS id, s.idx AS section, s.heading AS heading,
              snippet(sections_fts, 2, ?, ?, '...', 16) AS snippet,
              bm25(sections_fts, 5.0, 3.0, 1.0, 4.0) AS score
         FROM sections_fts JOIN sections s ON s.id = sections_fts.rowid
        WHERE sections_fts MATCH ?
        ORDER BY score
        LIMIT ?`,
    )
    .all(open, close, match, Math.max(limit * 5, 50)) as {
    id: string;
    section: number;
    heading: string;
    snippet: string;
    score: number;
  }[];

  const staleAfterDays = opts.staleAfterDays ?? 180;
  const hits: SearchHit[] = [];
  for (const r of rows) {
    const sheet = byId.get(r.id);
    if (!sheet) continue;
    if (!wantTags.every((t) => sheet.tags.includes(t))) continue;
    const stale = isStale(sheet, staleAfterDays, opts.now);
    hits.push({
      id: sheet.id,
      title: sheet.title,
      section: r.section,
      heading: r.heading,
      tags: sheet.tags,
      status: sheet.status,
      format: sheet.format,
      file: sheet.file,
      snippet: r.snippet.replace(/\s+/g, ' ').trim(),
      ocr: !!sheet.ocr,
      stale,
      score: stale ? r.score * STALE_FACTOR : r.score,
    });
  }
  // Stable sort keeps bm25 order among equal scores.
  return hits.sort((a, b) => a.score - b.score).slice(0, limit);
}

/** Reciprocal rank fusion constant: the usual 60 keeps one list's top hit from dominating. */
export const RRF_K = 60;
/** Fused score multiplier for sections of sheets tagged like the current project. */
export const TAG_BOOST = 1.5;
/** Cosine similarity below this is not a vector match (bge-m3 puts unrelated text around 0.3 to 0.4). */
export const MIN_SIMILARITY = 0.45;
const QUERY_EMBED_TIMEOUT_MS = 20_000;

/** Sum of 1 / (k + rank) over every ranked list a key appears in (rank starts at 1). */
export function fuseRanks(lists: string[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((key, i) => scores.set(key, (scores.get(key) ?? 0) + 1 / (k + i + 1)));
  }
  return scores;
}

export interface HybridOptions extends SearchOptions {
  /** Ollama client for the query embedding; null searches by keyword only. */
  client: OllamaClient | null;
  embedModel: string;
  /** Tags of the current project; matching sheets rank higher. */
  boostTags?: string[];
  /** Resolves tag aliases (tags.json) before comparing. */
  canonical?: (tag: string) => string;
  minSimilarity?: number;
}

export interface SearchResult {
  mode: 'hybrid' | 'keyword';
  /** Why the search fell back to keyword only. */
  notice?: string;
  boostTags: string[];
  tookMs: number;
  hits: SearchHit[];
}

const sectionKey = (id: string, section: number) => `${id}:${section}`;

function plainSnippet(text: string, heading: string): string {
  const body = text.startsWith('#') ? text.slice(text.indexOf('\n') + 1) : text;
  const flat = (body.trim() || heading).replace(/\s+/g, ' ');
  return flat.length > 160 ? `${flat.slice(0, 157).trimEnd()}...` : flat;
}

/**
 * Keyword (FTS5) and vector (cosine over stored embeddings) rankings fused with
 * reciprocal rank fusion, then boosted for the current project's tags and demoted
 * for stale sheets. Without Ollama or without vectors it is keyword only, and says why.
 */
export async function hybridSearch(db: DB, sheets: Sheet[], query: string, opts: HybridOptions): Promise<SearchResult> {
  const started = performance.now();
  const limit = opts.limit ?? 10;
  const canonical = opts.canonical ?? normalizeTag;
  const boostTags = [...new Set((opts.boostTags ?? []).map(canonical).filter(Boolean))];
  const staleAfterDays = opts.staleAfterDays ?? 180;
  const wantTags = (opts.tags ?? []).map(normalizeTag).filter(Boolean);
  const byId = new Map(sheets.map((s) => [s.id, s]));

  // Stale demotion is applied once, after fusion, so ask for the raw keyword order.
  const keyword = keywordSearch(db, sheets, query, { ...opts, limit: Math.max(limit * 5, 50), staleAfterDays: Number.MAX_SAFE_INTEGER });

  let mode: SearchResult['mode'] = 'keyword';
  let notice: string | undefined;
  let vectorKeys: string[] = [];
  const vectorHeadings = new Map<string, string>();
  if (!opts.client) notice = 'Ollama is not configured';
  else if (!embeddingCoverage(db, opts.embedModel).embedded) notice = `no embeddings from ${opts.embedModel} yet; run refs index`;
  else {
    const health = await opts.client.health();
    if (!health.ok) notice = `Ollama not reachable at ${opts.client.host}`;
    else {
      try {
        const qv = await embedQuery(opts.client, opts.embedModel, query, QUERY_EMBED_TIMEOUT_MS);
        const min = opts.minSimilarity ?? MIN_SIMILARITY;
        const scored: { key: string; sim: number }[] = [];
        for (const v of sectionVectors(db, opts.embedModel)) {
          const sheet = byId.get(v.sheetId);
          if (!sheet || !wantTags.every((t) => sheet.tags.includes(t))) continue;
          const sim = dot(qv, v.vec);
          if (sim < min) continue;
          const key = sectionKey(v.sheetId, v.idx);
          scored.push({ key, sim });
          vectorHeadings.set(key, v.heading);
        }
        vectorKeys = scored.sort((a, b) => b.sim - a.sim).slice(0, Math.max(limit * 5, 50)).map((x) => x.key);
        mode = 'hybrid';
      } catch (e) {
        notice = errorMessage(e);
      }
    }
  }

  const keywordKeys = keyword.map((h) => sectionKey(h.id, h.section));
  const fused = fuseRanks([keywordKeys, vectorKeys]);
  const keywordHits = new Map(keyword.map((h) => [sectionKey(h.id, h.section), h]));
  const keywordSet = new Set(keywordKeys);
  const vectorSet = new Set(vectorKeys);
  const hits: SearchHit[] = [];
  for (const [key, base] of fused) {
    const sep = key.lastIndexOf(':');
    const id = key.slice(0, sep);
    const section = Number(key.slice(sep + 1));
    const sheet = byId.get(id)!;
    const stale = isStale(sheet, staleAfterDays, opts.now);
    let score = base;
    if (boostTags.length && sheet.tags.some((t) => boostTags.includes(canonical(t)))) score *= TAG_BOOST;
    if (stale) score *= STALE_FACTOR;
    const kw = keywordHits.get(key);
    const heading = kw?.heading ?? vectorHeadings.get(key) ?? '';
    const snippet = kw?.snippet ?? plainSnippet(sectionText(db, id, section), heading);
    hits.push({
      id,
      title: sheet.title,
      section,
      heading,
      tags: sheet.tags,
      status: sheet.status,
      format: sheet.format,
      file: sheet.file,
      snippet,
      stale,
      ocr: !!sheet.ocr,
      score,
      via: [...(keywordSet.has(key) ? ['keyword' as const] : []), ...(vectorSet.has(key) ? ['vector' as const] : [])],
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return {
    mode,
    notice,
    boostTags,
    tookMs: Math.round(performance.now() - started),
    hits: hits.slice(0, limit),
  };
}
