#!/usr/bin/env node
// Measures the SPEC.md performance budgets in a sandbox profile and saves the raw numbers
// to docs/results/bench-<date>.json:
//   hook adds under 50 ms to the prompt          tools/hook-timing.ps1 in pwsh
//   keyword results under 100 ms                 the popup's sidecar, request to reply
//   hybrid results under 1 s with Ollama warm    the same, with the real Ollama and embedModel
//   popup visible under 300 ms after the hotkey  tools/popup-timing.ps1 and the built popup
//
//   node tools/bench.ts [--sheets 150] [--sections 16] [--runs 50] [--skip hook,search,hybrid,popup,cli] [--keep]
//
// The library is synthetic (random technical prose, fixed seed) and sized like the SPEC's
// "few thousand sections". Hybrid search uses the embedModel from the real config.json;
// nothing else of the real profile is read. The popup step presses a global hotkey
// (Ctrl+Alt+Shift+F12) on this desktop, so it needs the real popup to be closed first.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { addFile, embeddingCoverage, loadConfig, ollamaClient, openDb, runIndex, sectionCount } from '@refs/core';
import { REPO, environment, makeSandbox, realOllamaConfig, saveResult, stats, table, write, type Stats } from './lib.ts';

const { values: args } = parseArgs({
  options: {
    sheets: { type: 'string', default: '150' },
    sections: { type: 'string', default: '16' },
    runs: { type: 'string', default: '50' },
    skip: { type: 'string', default: '' },
    keep: { type: 'boolean', default: false },
  },
});
const SHEETS = Number(args.sheets);
const SECTIONS = Number(args.sections);
const RUNS = Number(args.runs);
const skip = new Set(args.skip.split(',').map((s) => s.trim()).filter(Boolean));
const HOTKEY = 'Ctrl+Alt+Shift+F12';
const COLD_SESSIONS = 10;

const BUDGETS = { hook: 50, keyword: 100, hybrid: 1000, popup: 300 };

// ---- synthetic library -------------------------------------------------------------

/** mulberry32: small seeded PRNG, so every run builds the same library. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TECH = (
  'docker container image volume network compose kubernetes pod deployment helm git branch commit rebase merge stash remote ' +
  'tag cherry-pick bisect node npm package workspace script typescript compiler tsconfig module import export python venv pip ' +
  'requirements pytest fixture decorator generator asyncio sqlite index query fts5 vacuum wal transaction trigger postgres ' +
  'migration schema powershell profile pipeline cmdlet module registry environment variable path ollama model embedding prompt ' +
  'token context quantization gpu cuda vram playwright browser locator selector trace screenshot fixture rust cargo crate ' +
  'borrow lifetime trait tauri webview window tray shortcut sidecar regex lookahead group capture ssh key agent tunnel port ' +
  'forward nginx proxy certificate tls dns cache redis queue worker cron scheduler task logon service firewall http header ' +
  'cookie session json yaml toml csv parser stream buffer encoding utf8 unicode bash shell alias function loop array'
).split(' ');
const COMMON = (
  'run list show remove create update check start stop restart build install upgrade clean prune copy move rename find search ' +
  'filter sort count print open close read write save load export import enable disable inspect debug fix test measure ' +
  'quickly safely always never usually first last every each other new old local global default custom hidden full partial ' +
  'when before after with without inside outside instead because so then also only'
).split(' ');

function sheetMarkdown(r: () => number, n: number): { md: string; tags: string[] } {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const words = (count: number) => Array.from({ length: count }, () => (r() < 0.45 ? pick(TECH) : pick(COMMON))).join(' ');
  const topic = [pick(TECH), pick(TECH)];
  const lines = [`# ${topic.join(' ')} notes ${n}`, '', words(20) + '.', ''];
  for (let s = 0; s < SECTIONS - 1; s++) {
    lines.push(`## ${words(2 + Math.floor(r() * 3))}`, '', words(50 + Math.floor(r() * 70)) + '.', '', '```bash', `${pick(TECH)} ${pick(COMMON)} --${pick(TECH)}`, '```', '');
  }
  return { md: lines.join('\n'), tags: [...new Set(topic.map((t) => t.replace(/[^a-z0-9-]/g, '')))] };
}

async function buildLibrary(sb: ReturnType<typeof makeSandbox>): Promise<{ importMs: number }> {
  const r = rng(42);
  const started = performance.now();
  for (let i = 0; i < SHEETS; i++) {
    const { md, tags } = sheetMarkdown(r, i + 1);
    const res = await addFile(sb.library, write(sb.work, `notes-${i + 1}.md`, md), { tags });
    if (res.kind !== 'added') throw new Error(`synthetic sheet ${i + 1} was not added (${res.kind})`);
  }
  // A real sheet for the two projects the hook enters, so their line names a sheet.
  await addFile(sb.library, write(sb.work, 'docker-basics.md', '# Docker basics\n\n## Volumes\n\nNamed volumes survive container removal.\n'), { tags: ['docker'] });
  return { importMs: performance.now() - started };
}

/** Two real-looking projects the hook enters, plus filler projects so the cache has many lines. */
function buildProjects(sb: ReturnType<typeof makeSandbox>): { a: string; b: string } {
  const make = (name: string, files: Record<string, string>) => {
    const dir = path.join(sb.projects, name);
    for (const [f, c] of Object.entries(files)) write(dir, f, c);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    return dir;
  };
  const pkg = (deps: string[]) => JSON.stringify({ name: 'p', dependencies: Object.fromEntries(deps.map((d) => [d, '1.0.0'])) });
  const a = make('web-app', { 'package.json': pkg(['playwright']), Dockerfile: 'FROM node:24\n' });
  const b = make('api & tools', { 'package.json': pkg(['ollama']), 'compose.yaml': 'services: {}\n', 'tsconfig.json': '{}' });
  for (let i = 0; i < 40; i++) make(`filler-${i}`, i % 2 ? { 'requirements.txt': 'torch\n' } : { 'Cargo.toml': '[package]\n' });
  return { a, b };
}

// ---- measurements ------------------------------------------------------------------

function pwsh(script: string, params: string[], env: NodeJS.ProcessEnv): unknown {
  const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(REPO, 'tools', script), ...params], {
    env,
    encoding: 'utf8',
    timeout: 300_000,
  });
  const json = out.trim().split(/\r?\n/).at(-1) ?? '';
  return JSON.parse(json);
}

interface HookResult {
  warmEnter: Stats;
  warmSubfolder: Stats;
  coldFirst: Stats;
  line: string;
  powershell: string;
  raw: { enter: number[]; subfolder: number[]; coldFirst: number[] };
}

function measureHook(env: NodeJS.ProcessEnv, a: string, b: string): HookResult {
  const hook = path.join(REPO, 'shell', 'refs-hook.ps1');
  const params = ['-Hook', hook, '-ProjectA', a, '-ProjectB', b];
  const warm = pwsh('hook-timing.ps1', [...params, '-Runs', String(RUNS)], env) as { enter: number[]; subfolder: number[]; line: string; ps: string };
  const cold: number[] = [];
  for (let i = 0; i < COLD_SESSIONS; i++) cold.push((pwsh('hook-timing.ps1', [...params, '-Runs', '0'], env) as { first: number }).first);
  return {
    warmEnter: stats(warm.enter),
    warmSubfolder: stats(warm.subfolder),
    coldFirst: stats(cold),
    line: warm.line,
    powershell: warm.ps,
    raw: { enter: warm.enter, subfolder: warm.subfolder, coldFirst: cold },
  };
}

/** The popup's backend, driven the way the popup drives it: one JSON line each way. */
function startSidecar(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [path.join(REPO, 'packages', 'sidecar', 'src', 'main.ts')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map<number, (msg: { result?: any; error?: { message: string } }) => void>();
  readline.createInterface({ input: child.stdout! }).on('line', (line) => {
    const msg = JSON.parse(line) as { id: number; result?: any; error?: { message: string } };
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  let next = 1;
  return {
    async call(method: string, params: object): Promise<{ ms: number; result: any }> {
      const id = next++;
      const started = performance.now();
      const msg = await new Promise<{ result?: any; error?: { message: string } }>((resolve) => {
        pending.set(id, resolve);
        child.stdin!.write(JSON.stringify({ id, method, params: { ...params, seq: id } }) + '\n');
      });
      if (msg.error) throw new Error(`sidecar ${method}: ${msg.error.message}`);
      return { ms: performance.now() - started, result: msg.result };
    },
    close: () => child.stdin!.end(),
  };
}

const QUERIES = [
  'docker volume prune', 'git rebase branch', 'remove stopped container', 'npm workspace script', 'sqlite fts5 index',
  'powershell profile path', 'ollama model gpu', 'playwright locator trace', 'rust cargo crate', 'tauri tray shortcut',
  'regex lookahead group', 'ssh tunnel port forward', 'python venv requirements', 'cron scheduler logon task', 'nginx proxy certificate',
  'json yaml parser', 'redis queue worker', 'typescript tsconfig module', 'kubernetes pod deployment', 'utf8 encoding stream',
];

interface SearchModeResult {
  /** Request to reply through the sidecar: what the popup waits for. */
  roundTrip: Stats;
  /** hybridSearch's own tookMs, without the JSON line hop. */
  engine: Stats;
  mode: string;
  notice?: string;
  hits: number;
  /** The first request of this pass (index, model or cache warm-up). */
  firstMs: number;
}

async function measureSearch(env: NodeJS.ProcessEnv, pass: 'keyword' | 'hybrid'): Promise<SearchModeResult> {
  const sc = startSidecar(env);
  try {
    const first = await sc.call('search', { q: 'docker container', mode: pass });
    for (const q of QUERIES.slice(0, 3)) await sc.call('search', { q, mode: pass });
    const round: number[] = [];
    const engine: number[] = [];
    let hits = 0;
    let mode = '';
    let notice: string | undefined;
    const rounds = Math.max(1, Math.round(RUNS / QUERIES.length) * 2);
    for (let i = 0; i < rounds; i++) {
      for (const q of QUERIES) {
        const { ms, result } = await sc.call('search', { q, mode: pass });
        round.push(ms);
        engine.push(result.tookMs);
        hits += result.hits.length;
        mode = result.mode;
        notice ??= result.notice;
      }
    }
    return { roundTrip: stats(round), engine: stats(engine), mode, notice, hits: Math.round(hits / round.length), firstMs: Math.round(first.ms) };
  } finally {
    sc.close();
  }
}

/** refs search from a fresh process: Node start, module load and the search. For reference; no budget applies. */
function measureCli(env: NodeJS.ProcessEnv): Stats {
  const times: number[] = [];
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    const r = spawnSync(process.execPath, [path.join(REPO, 'packages', 'cli', 'src', 'main.ts'), 'search', QUERIES[i % QUERIES.length]!, '--json'], { env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`refs search failed: ${r.stderr}`);
    times.push(performance.now() - started);
  }
  return stats(times);
}

function popupRunning(): boolean {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq refs-popup.exe', '/NH'], { encoding: 'utf8' });
  return /refs-popup\.exe/i.test(r.stdout ?? '');
}

interface PopupResult {
  visible?: Stats;
  painted?: Stats;
  missed?: number;
  skipped?: string;
  raw?: { visible: number[]; painted: number[] };
}

function measurePopup(env: NodeJS.ProcessEnv): PopupResult {
  const exe = path.join(REPO, 'apps', 'popup', 'src-tauri', 'target', 'release', 'refs-popup.exe');
  if (!fs.existsSync(exe)) return { skipped: 'the popup is not built (npm run popup:build)' };
  if (popupRunning()) return { skipped: 'refs-popup.exe is already running (one instance only); quit it from its tray menu and run again' };
  const r = pwsh('popup-timing.ps1', ['-Exe', exe, '-Node', process.execPath, '-Sidecar', path.join(REPO, 'packages', 'sidecar', 'src', 'main.ts'), '-Runs', '20'], env) as {
    visible: number[];
    painted: number[];
    missed: number;
  };
  return { visible: stats(r.visible), painted: stats(r.painted), missed: r.missed, raw: { visible: r.visible, painted: r.painted } };
}

// ---- run ---------------------------------------------------------------------------

const ollama = { embedModel: 'bge-m3', ...realOllamaConfig() };
const sb = makeSandbox('bench', { ollama, hotkey: HOTKEY }, { keep: args.keep });
console.log(`bench: sandbox ${sb.root}`);

console.log(`bench: building ${SHEETS} sheets x ${SECTIONS} sections`);
const { importMs } = await buildLibrary(sb);
const { a, b } = buildProjects(sb);
const config = loadConfig().config;
const health = await ollamaClient(config.ollama).health();
console.log(`bench: refs index (Ollama ${health.ok ? `up, embedding with ${config.ollama.embedModel}` : 'down, keyword only'})`);
let started = performance.now();
const report = await runIndex(config);
const indexMs = performance.now() - started;
const db = openDb();
const library = { sheets: SHEETS + 1, sections: sectionCount(db), embedded: embeddingCoverage(db, config.ollama.embedModel).embedded, projects: report?.projects.length ?? 0 };
db.close();
console.log(`bench: ${library.sections} sections, ${library.embedded} embedded, ${library.projects} projects`);

const result: Record<string, unknown> = {
  environment: environment(),
  budgets: BUDGETS,
  settings: { sheets: SHEETS, sectionsPerSheet: SECTIONS, runs: RUNS, embedModel: config.ollama.embedModel, ollama: health.ok ? health.version : 'down' },
  library,
  setup: { importMs: Math.round(importMs), indexMs: Math.round(indexMs) },
};

const rows: (string | number)[][] = [];
const verdict = (value: number | undefined, budget: number) => (value === undefined || Number.isNaN(value) ? 'n/a' : value < budget ? 'pass' : 'FAIL');
let failed = false;
const judge = (name: string, s: Stats | undefined, budget: number, note: string) => {
  const v = verdict(s?.p95, budget);
  if (v === 'FAIL') failed = true;
  rows.push([name, s?.median ?? '-', s?.p95 ?? '-', s?.max ?? '-', `< ${budget}`, v, note]);
};
const info = (name: string, s: Stats | undefined, note: string) => rows.push([name, s?.median ?? '-', s?.p95 ?? '-', s?.max ?? '-', '-', 'info', note]);

if (!skip.has('hook')) {
  console.log('bench: prompt hook');
  const hook = measureHook(sb.env, a, b);
  result.hook = hook;
  judge('hook: enter project (warm)', hook.warmEnter, BUDGETS.hook, `pwsh ${hook.powershell}, ${hook.warmEnter.n} runs`);
  info('hook: subfolder (warm)', hook.warmSubfolder, 'prints nothing');
  info('hook: first prompt (cold)', hook.coldFirst, `${COLD_SESSIONS} fresh sessions`);
}
if (!skip.has('search')) {
  console.log('bench: keyword search through the sidecar');
  const kw = await measureSearch(sb.env, 'keyword');
  result.keyword = kw;
  judge('search: keyword', kw.roundTrip, BUDGETS.keyword, `sidecar round trip, ${kw.roundTrip.n} queries`);
}
if (!skip.has('hybrid')) {
  if (!health.ok || !library.embedded) {
    result.hybrid = { skipped: health.ok ? 'no embeddings' : 'Ollama is not running' };
    rows.push(['search: hybrid', '-', '-', '-', `< ${BUDGETS.hybrid}`, 'skipped', String((result.hybrid as { skipped: string }).skipped)]);
  } else {
    console.log('bench: hybrid search through the sidecar (warming the embedding model first)');
    const hy = await measureSearch(sb.env, 'hybrid');
    result.hybrid = hy;
    judge('search: hybrid (Ollama warm)', hy.roundTrip, BUDGETS.hybrid, `mode ${hy.mode}, first call ${hy.firstMs} ms`);
  }
}
if (!skip.has('cli')) {
  console.log('bench: refs search as a fresh process');
  const cli = measureCli(sb.env);
  result.cli = cli;
  info('cli: refs search --json', cli, 'includes Node start');
}
if (!skip.has('popup')) {
  console.log('bench: popup hotkey (presses Ctrl+Alt+Shift+F12 on this desktop)');
  const popup = measurePopup(sb.env);
  result.popup = popup;
  if (popup.skipped) rows.push(['popup: hotkey to visible', '-', '-', '-', `< ${BUDGETS.popup}`, 'skipped', popup.skipped]);
  else {
    judge('popup: key press to visible', popup.visible, BUDGETS.popup, `outside the app, ${popup.missed} missed`);
    judge('popup: hotkey to painted', popup.painted, BUDGETS.popup, "popup's own log, after 2 frames");
  }
}

const file = saveResult('bench', result);
console.log('');
console.log(table(['measure', 'median ms', 'p95 ms', 'max ms', 'budget', 'result', 'notes'], rows));
console.log('');
console.log(`library: ${library.sheets} sheets, ${library.sections} sections, ${library.embedded} embedded; import ${Math.round(importMs / 1000)} s, index ${Math.round(indexMs / 1000)} s`);
console.log(`raw data: ${path.relative(REPO, file)}`);
process.exitCode = failed ? 1 : 0;
