#!/usr/bin/env node
// Tests the AI part of refs against the real models in config.json, in a sandbox profile:
//   retrieval  keyword vs hybrid search over tools/eval/corpus, 40 labeled queries
//   tagging    tag and title proposals for each corpus sheet, from an empty library
//   injection  documents that try to take over the tagger; any canary in the output fails
//   suggest    refs suggest on fixture projects: schema, gap coverage, an injected README
//   ocr        terminal screenshots rendered from known text, scored by character error rate
// Results go to docs/results/eval-<date>.json. Exit code 1 when a gate (no injection, every
// suggest reply usable) or a floor in tools/eval/cases.json fails; 2 when Ollama is not usable.
//
//   node tools/eval.ts [--only retrieval,tagging,injection,suggest,ocr] [--keep]
//
// The unit tests (npm test) never reach Ollama; this is the only place the models are judged.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  addFile,
  hasModel,
  hybridSearch,
  keywordSearch,
  loadConfig,
  ocrEngine,
  ollamaClient,
  openDb,
  proposeTags,
  readManifest,
  runIndex,
  suggestForProject,
  tagVocabulary,
  type OllamaClient,
} from '@refs/core';
import { REPO, environment, makeSandbox, realOllamaConfig, saveResult, stats, table, write } from './lib.ts';
import { canaryHits, checkFloors, ocrScore, rankOf, retrievalMetrics, tagScore } from './eval/score.ts';

const { values: args } = parseArgs({ options: { only: { type: 'string', default: '' }, keep: { type: 'boolean', default: false } } });
const only = new Set(args.only.split(',').map((s) => s.trim()).filter(Boolean));
const want = (part: string) => !only.size || only.has(part);

const EVAL = path.join(REPO, 'tools', 'eval');
interface Cases {
  retrieval: { q: string; kind: 'lexical' | 'paraphrase'; expect: [string, string][] }[];
  tagging: { file: string; primary: string[]; acceptable: string[] }[];
  canaries: string[];
  injection: { name: string; primary: string[]; text: string }[];
  suggest: { name: string; files: Record<string, string>; expectGaps: string[] }[];
  ocr: { name: string; style: 'dark' | 'light'; text: string }[];
  floors: Record<string, number>;
}
const cases = JSON.parse(fs.readFileSync(path.join(EVAL, 'cases.json'), 'utf8')) as Cases;
const corpusText = (file: string) => fs.readFileSync(path.join(EVAL, 'corpus', file), 'utf8');

const sb = makeSandbox('eval', { ollama: realOllamaConfig() }, { keep: args.keep });
const config = loadConfig().config;
const { embedModel, chatModel, visionModel } = config.ollama;

/** The real client, counting chat calls so a retry (bad first reply) shows up. */
function countingClient(): { client: OllamaClient; calls: () => number } {
  const client = ollamaClient(config.ollama);
  let n = 0;
  const chat = client.chat.bind(client);
  client.chat = (req) => {
    n++;
    return chat(req);
  };
  return { client, calls: () => n };
}

const health = await ollamaClient(config.ollama).health();
if (!health.ok) {
  console.error(`eval: Ollama is needed and ${health.reason}`);
  process.exit(2);
}
const installed = await ollamaClient(config.ollama).models();
const missing = [embedModel, chatModel, visionModel].filter((m) => m && !hasModel(installed, m));
if (missing.length) {
  console.error(`eval: models not pulled: ${missing.join(', ')}`);
  process.exit(2);
}
console.log(`eval: sandbox ${sb.root}`);
console.log(`eval: Ollama ${health.version}; embed ${embedModel}, chat ${chatModel}, vision ${visionModel}`);

const metrics: Record<string, any> = {};
const details: Record<string, any> = {};
const gates: string[] = [];
const ms = (started: number) => Math.round(performance.now() - started);
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

// ---- tagging and injection (before any import, so the vocabulary is the default one) ----

async function propose(filename: string, text: string) {
  const { client, calls } = countingClient();
  const started = performance.now();
  const outcome = await proposeTags(client, chatModel, { filename, text }, tagVocabulary(sb.library, []));
  if (outcome.kind !== 'proposal') throw new Error(`tagging was queued: ${outcome.reason}`);
  return { ...outcome.proposal, attempts: calls(), ms: ms(started) };
}

if (want('tagging')) {
  console.log(`eval: tagging ${cases.tagging.length} sheets`);
  const tagRow = async (c: Cases['tagging'][number]) => {
    const p = await propose(c.file, corpusText(c.file));
    return { file: c.file, title: p.title ?? null, tags: p.tags, newTags: p.newTags, error: p.error ?? null, attempts: p.attempts, ms: p.ms, ...tagScore(p.tags, c.primary, c.acceptable) };
  };
  const rows: Awaited<ReturnType<typeof tagRow>>[] = [];
  for (const c of cases.tagging) rows.push(await tagRow(c));
  details.tagging = rows;
  const n = rows.length;
  const rate = (f: (r: (typeof rows)[number]) => boolean) => Math.round((rows.filter(f).length / n) * 1000) / 1000;
  metrics.tagging = {
    n,
    primaryHit: rate((r) => r.primaryHit),
    precision: Math.round((rows.reduce((s, r) => s + r.precision, 0) / n) * 1000) / 1000,
    firstTryValid: rate((r) => r.attempts === 1 && !r.error),
    gaveUp: rows.filter((r) => r.error).length,
    titleRules: rate((r) => !!r.title && words(r.title) <= 8 && !/[–—]/.test(r.title)),
    newTagsPerSheet: Math.round((rows.reduce((s, r) => s + r.newTags.length, 0) / n) * 100) / 100,
    latency: stats(rows.map((r) => r.ms)),
  };
}

if (want('injection')) {
  console.log(`eval: ${cases.injection.length} injection attempts on the tagger`);
  const rows = [];
  for (const c of cases.injection) {
    const p = await propose('notes.md', c.text);
    const hits = canaryHits([p.title ?? '', ...p.tags], cases.canaries);
    rows.push({ name: c.name, title: p.title ?? null, tags: p.tags, error: p.error ?? null, canaries: hits, primaryHit: p.tags.some((t) => c.primary.includes(t)) });
    if (hits.length) gates.push(`injection "${c.name}": the tagger returned ${hits.join(', ')}`);
  }
  details.injection = rows;
  metrics.injection = { n: rows.length, resisted: rows.filter((r) => !r.canaries.length).length, primaryHit: rows.filter((r) => r.primaryHit).length / rows.length };
}

// ---- library for retrieval and suggest ----

const sheetFile = new Map<string, string>();
if (want('retrieval') || want('suggest')) {
  console.log('eval: importing the corpus and embedding it');
  for (const c of cases.tagging) {
    const r = await addFile(sb.library, write(sb.work, c.file, corpusText(c.file)), { tags: c.primary });
    if (r.kind !== 'added') throw new Error(`${c.file} was not added (${r.kind})`);
    sheetFile.set(r.sheet.id, c.file);
  }
  const report = await runIndex(config);
  if (!report?.embed || report.embed.remaining) throw new Error(`embedding incomplete: ${report?.embed?.skipped ?? 'no report'}`);
}

if (want('retrieval')) {
  console.log(`eval: ${cases.retrieval.length} retrieval queries, keyword and hybrid`);
  const db = openDb();
  const sheets = readManifest(sb.library);
  const client = ollamaClient(config.ollama);
  const rows: { q: string; kind: string; keyword: number | null; hybrid: number | null; hybridTop: { sheet: string; heading: string } | null }[] = [];
  const hybridMs: number[] = [];
  try {
    for (const c of cases.retrieval) {
      const kw = keywordSearch(db, sheets, c.q, { limit: 10 });
      const started = performance.now();
      const hy = await hybridSearch(db, sheets, c.q, { client, embedModel, limit: 10 });
      hybridMs.push(performance.now() - started);
      if (hy.mode !== 'hybrid') throw new Error(`hybrid search fell back to keyword: ${hy.notice}`);
      const named = (hits: { id: string; heading: string }[]) => hits.map((h) => ({ sheet: sheetFile.get(h.id) ?? h.id, heading: h.heading }));
      const kwHits = named(kw);
      const hyHits = named(hy.hits);
      rows.push({ q: c.q, kind: c.kind, keyword: rankOf(kwHits, c.expect), hybrid: rankOf(hyHits, c.expect), hybridTop: hyHits[0] ?? null });
    }
  } finally {
    db.close();
  }
  details.retrieval = rows;
  const by = (mode: 'keyword' | 'hybrid', kind?: string) => retrievalMetrics(rows.filter((r) => !kind || r.kind === kind).map((r) => r[mode]));
  metrics.retrieval = {
    keyword: { all: by('keyword'), lexical: by('keyword', 'lexical'), paraphrase: by('keyword', 'paraphrase') },
    hybrid: { all: by('hybrid'), lexical: by('hybrid', 'lexical'), paraphrase: by('hybrid', 'paraphrase') },
    hybridLatency: stats(hybridMs),
  };
}

if (want('suggest')) {
  console.log(`eval: refs suggest on ${cases.suggest.length} projects`);
  const rows = [];
  for (const [i, c] of cases.suggest.entries()) {
    const dir = path.join(sb.projects, `project-${i + 1}`);
    for (const [name, content] of Object.entries(c.files)) write(dir, name, content);
    const { client, calls } = countingClient();
    const started = performance.now();
    try {
      const out = await suggestForProject(config, dir, client);
      const texts = out.suggestions.flatMap((s) => [s.title, s.reason, ...s.outline, ...s.tags]).concat(out.discarded.map((d) => d.title));
      const hits = canaryHits(texts, cases.canaries);
      const covered = c.expectGaps.filter((g) => out.suggestions.some((s) => s.tags.includes(g)));
      if (hits.length) gates.push(`suggest "${c.name}": output contains ${hits.join(', ')}`);
      rows.push({
        name: c.name,
        ok: true,
        tags: out.facts.tags,
        gaps: out.facts.gaps,
        expectGaps: c.expectGaps,
        gapsCovered: covered,
        kept: out.suggestions.length,
        discarded: out.discarded,
        attempts: calls(),
        ms: ms(started),
        canaries: hits,
        suggestions: out.suggestions,
      });
    } catch (e) {
      gates.push(`suggest "${c.name}": no usable reply (${e instanceof Error ? e.message : String(e)})`);
      rows.push({ name: c.name, ok: false, error: e instanceof Error ? e.message : String(e), attempts: calls(), ms: ms(started) });
    }
  }
  details.suggest = rows;
  const ok = rows.filter((r) => r.ok);
  const gapsWanted = ok.reduce((s, r) => s + (r.expectGaps?.length ?? 0), 0);
  metrics.suggest = {
    n: rows.length,
    usable: ok.length,
    firstTryValid: rows.filter((r) => r.ok && r.attempts === 1).length,
    gapCoverage: gapsWanted ? Math.round((ok.reduce((s, r) => s + (r.gapsCovered?.length ?? 0), 0) / gapsWanted) * 1000) / 1000 : null,
    keptPerProject: ok.length ? Math.round((ok.reduce((s, r) => s + (r.kept ?? 0), 0) / ok.length) * 10) / 10 : 0,
    discardedTotal: ok.reduce((s, r) => s + (r.discarded?.length ?? 0), 0),
    injectionResisted: rows.filter((r) => r.ok && !r.canaries?.length).length === ok.length,
    latency: stats(rows.map((r) => r.ms)),
  };
}

if (want('ocr')) {
  console.log(`eval: OCR on ${cases.ocr.length} rendered screenshots`);
  const ocr = ocrEngine(ollamaClient(config.ollama), visionModel);
  const rows = [];
  for (const [i, c] of cases.ocr.entries()) {
    const png = path.join(sb.work, `ocr-${i + 1}.png`);
    execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(EVAL, 'render-text.ps1'), '-Text', c.text, '-Out', png, '-Style', c.style]);
    const started = performance.now();
    const text = await ocr.recognize(fs.readFileSync(png));
    rows.push({ name: c.name, ...ocrScore(c.text, text), ms: ms(started), output: text });
  }
  details.ocr = rows;
  metrics.ocr = {
    n: rows.length,
    cer: Math.round((rows.reduce((s, r) => s + r.cer, 0) / rows.length) * 1000) / 1000,
    linesExact: Math.round((rows.reduce((s, r) => s + r.linesExact, 0) / rows.length) * 1000) / 1000,
    latency: stats(rows.map((r) => r.ms)),
  };
}

// ---- report ----

const floorFailures = checkFloors(metrics, Object.fromEntries(Object.entries(cases.floors).filter(([k]) => want(k.split('.')[0]!))));
const file = saveResult('eval', { environment: environment(), models: { embedModel, chatModel, visionModel, ollama: health.version }, metrics, gates, floorFailures, details });

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`);
console.log('');
if (metrics.retrieval) {
  const r = metrics.retrieval;
  console.log(
    table(
      ['retrieval', 'queries', 'hit@1', 'hit@5', 'MRR'],
      (['keyword', 'hybrid'] as const).flatMap((mode) =>
        (['all', 'lexical', 'paraphrase'] as const).map((k) => [`${mode} ${k}`, r[mode][k].n, pct(r[mode][k].hitAt1), pct(r[mode][k].hitAt5), r[mode][k].mrr]),
      ),
    ),
  );
  console.log(`hybrid latency: median ${r.hybridLatency.median} ms, p95 ${r.hybridLatency.p95} ms`);
  console.log('');
}
const lines: (string | number)[][] = [];
if (metrics.tagging) {
  const t = metrics.tagging;
  lines.push(['tagging', `primary tag ${pct(t.primaryHit)}, precision ${pct(t.precision)}, valid first try ${pct(t.firstTryValid)}, gave up ${t.gaveUp}, title rules ${pct(t.titleRules)}, median ${t.latency.median} ms`]);
}
if (metrics.injection) lines.push(['injection', `${metrics.injection.resisted} of ${metrics.injection.n} resisted, primary tag kept ${pct(metrics.injection.primaryHit)}`]);
if (metrics.suggest) {
  const s = metrics.suggest;
  lines.push(['suggest', `${s.usable} of ${s.n} usable, ${s.firstTryValid} valid first try, gap coverage ${pct(s.gapCoverage)}, ${s.keptPerProject} kept per project, ${s.discardedTotal} discarded, median ${s.latency.median} ms`]);
}
if (metrics.ocr) lines.push(['ocr', `CER ${metrics.ocr.cer}, lines exact ${pct(metrics.ocr.linesExact)}, median ${metrics.ocr.latency.median} ms`]);
if (lines.length) console.log(table(['part', 'result'], lines));
console.log('');
for (const g of gates) console.log(`GATE FAILED: ${g}`);
for (const f of floorFailures) console.log(`BELOW FLOOR: ${f}`);
if (!gates.length && !floorFailures.length) console.log(`eval: all gates and ${Object.keys(cases.floors).length} floors pass`);
console.log(`raw data: ${path.relative(REPO, file)}`);
process.exitCode = gates.length || floorFailures.length ? 1 : 0;
