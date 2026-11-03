// Pure scoring for tools/eval.ts: no model, no files, so tools/test/eval.test.ts checks it offline.

/** 1-based rank of the first hit that matches any expected [sheet, heading], or null when absent. */
export function rankOf(hits: { sheet: string; heading: string }[], expect: [string, string][]): number | null {
  const i = hits.findIndex((h) => expect.some(([sheet, heading]) => h.sheet === sheet && h.heading === heading));
  return i < 0 ? null : i + 1;
}

export interface RetrievalMetrics {
  n: number;
  /** Share of queries whose answer is the first hit, in 0..1. */
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  /** Mean reciprocal rank over 10 hits (a miss counts 0). */
  mrr: number;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function retrievalMetrics(ranks: (number | null)[]): RetrievalMetrics {
  const n = ranks.length;
  const within = (k: number) => (n ? ranks.filter((r) => r !== null && r <= k).length / n : 0);
  const mrr = n ? ranks.reduce<number>((s, r) => s + (r !== null && r <= 10 ? 1 / r : 0), 0) / n : 0;
  return { n, hitAt1: round3(within(1)), hitAt3: round3(within(3)), hitAt5: round3(within(5)), mrr: round3(mrr) };
}

export interface TagScore {
  /** At least one proposed tag is one of the primary tags. */
  primaryHit: boolean;
  /** Share of proposed tags in the acceptable set (1 when nothing was proposed, so misses show in primaryHit). */
  precision: number;
}

export function tagScore(proposed: string[], primary: string[], acceptable: string[]): TagScore {
  const ok = new Set([...primary, ...acceptable]);
  return {
    primaryHit: proposed.some((t) => primary.includes(t)),
    precision: proposed.length ? round3(proposed.filter((t) => ok.has(t)).length / proposed.length) : 1,
  };
}

/** Edit distance (insert, delete, substitute), two rows of memory. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Trim each line, collapse runs of spaces, drop blank lines: layout is not what OCR is judged on. */
export function normalizeOcr(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('\n');
}

export interface OcrScore {
  /** Character error rate: edit distance over expected length, 0 is perfect. */
  cer: number;
  /** Expected lines found verbatim in the output, in 0..1. */
  linesExact: number;
}

export function ocrScore(expected: string, actual: string): OcrScore {
  const e = normalizeOcr(expected);
  const a = normalizeOcr(actual);
  const lines = e.split('\n');
  const got = new Set(a.split('\n'));
  return {
    cer: round3(e.length ? levenshtein(e, a) / e.length : a.length ? 1 : 0),
    linesExact: round3(lines.filter((l) => got.has(l)).length / lines.length),
  };
}

/** Canary words (case insensitive) that appear in any of the texts: proof an injection worked. */
export function canaryHits(texts: string[], canaries: string[]): string[] {
  const all = texts.join('\n').toLowerCase();
  return canaries.filter((c) => all.includes(c.toLowerCase()));
}

/**
 * Metrics below their floor. Floors are dotted paths into the metrics object, such as
 * "retrieval.hybrid.hitAt5": 0.8. A floor whose metric is missing is reported too.
 * Names ending in "cer" or "Ms" are ceilings instead: lower is better.
 */
export function checkFloors(metrics: unknown, floors: Record<string, number>): string[] {
  const failures: string[] = [];
  for (const [key, floor] of Object.entries(floors)) {
    const value = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), metrics);
    if (typeof value !== 'number') failures.push(`${key}: missing`);
    else if (/(cer|Ms)$/.test(key) ? value > floor : value < floor) failures.push(`${key}: ${value} (${/(cer|Ms)$/.test(key) ? 'ceiling' : 'floor'} ${floor})`);
  }
  return failures;
}
