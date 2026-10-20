import type { DB } from './db.ts';
import type { Sheet } from './manifest.ts';
import { normalizeTag } from './util.ts';

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
  /** bm25 rank: lower is better. */
  score: number;
}

export interface SearchOptions {
  /** Only sheets that carry every one of these tags. */
  tags?: string[];
  limit?: number;
  /** Markers around matched terms in the snippet. */
  highlight?: [string, string];
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

  const hits: SearchHit[] = [];
  for (const r of rows) {
    const sheet = byId.get(r.id);
    if (!sheet) continue;
    if (!wantTags.every((t) => sheet.tags.includes(t))) continue;
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
      score: r.score,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
