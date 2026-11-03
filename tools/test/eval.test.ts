import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { blockingFindings, chunkMarkdown, normalizeTag, scanSecrets } from '@refs/core';
import { percentile, stats } from '../lib.ts';
import { canaryHits, checkFloors, levenshtein, ocrScore, rankOf, retrievalMetrics, tagScore } from '../eval/score.ts';

// Offline checks for tools/eval.ts and tools/bench.ts: the scoring math and the labeled
// cases. The model runs themselves need Ollama and are not part of npm test.

const EVAL = path.join(import.meta.dirname, '..', 'eval');
const cases = JSON.parse(fs.readFileSync(path.join(EVAL, 'cases.json'), 'utf8')) as {
  retrieval: { q: string; kind: string; expect: [string, string][] }[];
  tagging: { file: string; primary: string[]; acceptable: string[] }[];
  canaries: string[];
  injection: { name: string; primary: string[]; text: string }[];
  suggest: { files: Record<string, string>; expectGaps: string[] }[];
  ocr: { text: string; style: string }[];
  floors: Record<string, number>;
};
const corpus = fs.readdirSync(path.join(EVAL, 'corpus')).filter((f) => f.endsWith('.md'));

test('rankOf finds the first hit matching any expected section', () => {
  const hits = [
    { sheet: 'a.md', heading: 'X' },
    { sheet: 'b.md', heading: 'Y' },
    { sheet: 'b.md', heading: 'Z' },
  ];
  assert.equal(rankOf(hits, [['b.md', 'Z'], ['b.md', 'Y']]), 2);
  assert.equal(rankOf(hits, [['a.md', 'Y']]), null);
});

test('retrieval metrics: hit@k and mean reciprocal rank, a miss counts zero', () => {
  assert.deepEqual(retrievalMetrics([1, 2, null, 5]), { n: 4, hitAt1: 0.25, hitAt3: 0.5, hitAt5: 0.75, mrr: 0.425 });
  assert.deepEqual(retrievalMetrics([]), { n: 0, hitAt1: 0, hitAt3: 0, hitAt5: 0, mrr: 0 });
});

test('tag score: primary hit and precision against the acceptable set', () => {
  assert.deepEqual(tagScore(['docker', 'containers', 'misc'], ['docker'], ['containers']), { primaryHit: true, precision: 0.667 });
  assert.deepEqual(tagScore([], ['docker'], []), { primaryHit: false, precision: 1 });
});

test('OCR score ignores layout and counts exact lines', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.deepEqual(ocrScore('git push\n  git pull  ', 'git push\n\ngit  pull'), { cer: 0, linesExact: 1 });
  assert.deepEqual(ocrScore('abcd', 'abed'), { cer: 0.25, linesExact: 0 });
});

test('canaries are found case insensitively; floors and ceilings are checked', () => {
  assert.deepEqual(canaryHits(['Title: PWNED', 'ok'], ['pwned', 'hacked']), ['pwned']);
  const m = { retrieval: { hybrid: { hitAt5: 0.7 } }, ocr: { cer: 0.2 } };
  assert.deepEqual(checkFloors(m, { 'retrieval.hybrid.hitAt5': 0.6, 'ocr.cer': 0.1, 'suggest.usable': 1 }), [
    'ocr.cer: 0.2 (ceiling 0.1)',
    'suggest.usable: missing',
  ]);
});

test('bench stats use nearest-rank percentiles', () => {
  const xs = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
  assert.equal(percentile(xs, 50), 5);
  assert.equal(percentile(xs, 95), 10);
  assert.deepEqual(stats(xs), { n: 10, min: 1, median: 5, p95: 10, max: 10, mean: 5.5 });
});

test('every labeled query points at a section that chunking really produces', () => {
  const headings = new Map(corpus.map((f) => [f, new Set(chunkMarkdown(fs.readFileSync(path.join(EVAL, 'corpus', f), 'utf8')).map((s) => s.heading))]));
  for (const c of cases.retrieval) {
    assert.ok(['lexical', 'paraphrase'].includes(c.kind), c.q);
    for (const [file, heading] of c.expect) assert.ok(headings.get(file)?.has(heading), `${c.q}: ${file} has no section "${heading}"`);
  }
  const sheetsUsed = new Set(cases.retrieval.flatMap((c) => c.expect.map(([f]) => f)));
  assert.deepEqual([...sheetsUsed].sort(), [...corpus].sort(), 'every corpus sheet has queries');
});

test('every corpus sheet has a tagging case with normalized tags, and imports without a secret block', () => {
  assert.deepEqual(cases.tagging.map((c) => c.file).sort(), [...corpus].sort());
  for (const c of [...cases.tagging, ...cases.injection]) {
    for (const t of [...c.primary, ...('acceptable' in c ? c.acceptable : [])]) assert.equal(normalizeTag(t), t);
  }
  for (const f of corpus) assert.deepEqual(blockingFindings(scanSecrets(fs.readFileSync(path.join(EVAL, 'corpus', f), 'utf8'))), [], f);
});

test('injection cases carry a canary, so a takeover would be caught', () => {
  for (const c of cases.injection) assert.ok(canaryHits([c.text], cases.canaries).length, c.name);
  const injected = cases.suggest.filter((s) => canaryHits(Object.values(s.files), cases.canaries).length);
  assert.ok(injected.length >= 1, 'at least one suggest project has an injected README');
});
