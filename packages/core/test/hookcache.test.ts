import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { ignoreGap, setLearned, verifySheet } from '../src/actions.ts';
import { ConfigSchema, type Config } from '../src/config.ts';
import { hookLine, readHookCache, refreshHookCache, type ProjectEntry } from '../src/hookcache.ts';
import { addFile } from '../src/import.ts';
import { forTarget, runIndex, scanProject } from '../src/indexer.ts';
import { isStale, readManifest, writeManifest, type Sheet } from '../src/manifest.ts';
import { dataPaths, normPath } from '../src/paths.ts';
import { isUnused, logUsage, unusedSheets } from '../src/usage.ts';
import { today } from '../src/util.ts';
import { DOCKER_MD, setupEnv, write, type TestEnv } from './helpers.ts';

let t: TestEnv;
let config: Config;
let root: string;
let app: string;
beforeEach(async () => {
  t = setupEnv();
  root = path.join(t.root, 'Projects & Stuff');
  app = path.join(root, 'web app');
  write(app, 'package.json', JSON.stringify({ devDependencies: { playwright: '^1.50.0' } }));
  write(app, 'Dockerfile', 'FROM node:24\n');
  fs.mkdirSync(path.join(app, 'src', 'components'), { recursive: true });
  config = ConfigSchema.parse({ library: t.library, roots: [root] });
  for (const [name, text, tags] of [
    ['docker-notes.md', DOCKER_MD, ['docker']],
    ['node.md', '# Node tips\n\nRun package scripts with npm run and check versions with node --version.\n', ['nodejs']],
    ['volumes.md', '# Docker volumes\n\nNamed volumes survive container removal; list them with docker volume ls.\n', ['docker']],
  ] as const) {
    const r = await addFile(t.library, write(t.work, name, text), { tags: [...tags] });
    assert.equal(r.kind, 'added');
  }
});

function entry(dir = app): ProjectEntry {
  const e = readHookCache()?.projects.find((p) => p.path === normPath(dir));
  assert.ok(e, `no cache entry for ${dir}`);
  return e;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const isoDaysAgo = (n: number) => today(daysAgo(n));

function editSheet(id: string, change: (s: Sheet) => void) {
  const sheets = readManifest(t.library);
  change(sheets.find((s) => s.id === id)!);
  writeManifest(t.library, sheets);
}

test('refs index writes the hook cache: tags, counts, gaps and try', async () => {
  await runIndex(config);
  const e = entry();
  assert.deepEqual(e.tags, ['node', 'docker', 'playwright']);
  assert.equal(e.sheets, 3, 'nodejs is an alias of node in tags.json');
  assert.equal(e.stale, 0);
  assert.deepEqual(e.gaps, ['playwright']);
  assert.deepEqual(e.try, ['Docker basics', 'Node tips', 'Docker volumes']);
  assert.equal(hookLine(e), 'refs [node, docker, playwright] 3 sheets | gap: playwright | try: "Docker basics" | refs for .');
  assert.equal(hookLine(e, 1), 'refs [node, docker, playwright] 3 sheets | gap: playwright | try: "Node tips" | refs for .');
  assert.deepEqual(readHookCache()?.roots, [normPath(root).toLowerCase()]);
});

test('the cache file is JSON with one project per line, each starting with its key', async () => {
  write(root, 'notes/readme.txt', 'nothing to detect');
  await runIndex(config);
  const text = fs.readFileSync(dataPaths().hookCache, 'utf8');
  JSON.parse(text);
  const lines = text.trimEnd().split('\n');
  assert.match(lines[0]!, /^\{"version":1,"generatedAt":"[^"]+","roots":\[[^\]]*\],"projects":\[$/);
  assert.equal(lines.at(-1), ']}');
  const projectLines = lines.slice(1, -1);
  assert.equal(projectLines.length, 2);
  for (const l of projectLines) assert.match(l, /^\{"key":"[^"]+",/);
  assert.equal(hookLine(entry(path.join(root, 'notes'))), 'refs: no tags (add a rule to rules.json)');
});

test('unused: never used or not used in unusedAfterDays, and not learned', () => {
  const sheet = { learned: false } as Sheet;
  assert.equal(isUnused(sheet, undefined, 30), true);
  assert.equal(isUnused(sheet, daysAgo(29), 30), false);
  assert.equal(isUnused(sheet, daysAgo(31), 30), true);
  assert.equal(isUnused({ learned: true } as Sheet, undefined, 30), false);
  const a = { id: 's_0001', learned: false, status: 'verified' } as Sheet;
  const b = { id: 's_0002', learned: false, status: 'verified' } as Sheet;
  const draft = { id: 's_0003', learned: false, status: 'draft' } as Sheet;
  const order = unusedSheets([a, b, draft], new Map([['s_0001', daysAgo(40)]]), 30).map((s) => s.id);
  assert.deepEqual(order, ['s_0002', 's_0001'], 'never used first, drafts left out');
});

test('stale: lastVerified more than staleAfterDays ago', () => {
  assert.equal(isStale({ lastVerified: isoDaysAgo(180) } as Sheet, 180), false);
  assert.equal(isStale({ lastVerified: isoDaysAgo(181) } as Sheet, 180), true);
});

test('opening a sheet drops it from try: until unusedAfterDays passes', async () => {
  await runIndex(config);
  logUsage({ event: 'open', id: 's_0001', via: 'cli' });
  refreshHookCache(config);
  assert.deepEqual(entry().try, ['Node tips', 'Docker volumes']);
  refreshHookCache(config, daysAgo(-31));
  assert.deepEqual(entry().try, ['Node tips', 'Docker volumes', 'Docker basics'], 'unused again after 30 days, least recent last');
});

test('refs learned retires reminders; --undo lets them resume once the sheet goes unused', async () => {
  await runIndex(config);
  const r = await setLearned(config, 's_0003', true);
  assert.equal(r.changed, true);
  assert.equal(readManifest(t.library)[2]!.learned, true);
  assert.deepEqual(entry().try, ['Docker basics', 'Node tips']);
  refreshHookCache(config, daysAgo(-400));
  assert.deepEqual(entry().try, ['Docker basics', 'Node tips'], 'learned is never offered again');
  assert.equal((await setLearned(config, 's_0003', true)).changed, false);

  await setLearned(config, 's_0003', false);
  assert.equal(readManifest(t.library)[2]!.learned, false);
  assert.deepEqual(entry().try, ['Docker basics', 'Node tips'], 'marking learned counted as a use');
  refreshHookCache(config, daysAgo(-31));
  assert.deepEqual(entry().try, ['Docker basics', 'Node tips', 'Docker volumes']);
});

test('stale sheets show in the hook line; refs verify clears them', async () => {
  editSheet('s_0001', (s) => (s.lastVerified = isoDaysAgo(200)));
  await runIndex(config);
  assert.equal(entry().stale, 1);
  assert.match(hookLine(entry()), /^refs \[node, docker, playwright\] 3 sheets \(1 stale\) \| gap: playwright/);
  const r = await verifySheet(config, 's_0001');
  assert.equal(r.sheet.lastVerified, today());
  assert.equal(entry().stale, 0);
  assert.equal(readManifest(t.library)[0]!.status, 'verified');
});

test('gaps can be ignored globally or for one project', async () => {
  const other = path.join(root, 'tests');
  write(other, 'package.json', JSON.stringify({ dependencies: { '@playwright/test': '1' } }));
  await runIndex(config);
  assert.deepEqual(entry(other).gaps, ['playwright']);

  const p = await ignoreGap(config, 'Playwright', { projectDir: path.join(app, 'src') });
  assert.equal(p.project, normPath(app));
  assert.deepEqual(entry().gaps, []);
  assert.deepEqual(entry(other).gaps, ['playwright'], 'project ignores stay in their project');

  await ignoreGap(config, 'playwright');
  assert.deepEqual(entry(other).gaps, []);
  const stored = JSON.parse(fs.readFileSync(path.join(t.library, 'gap-ignores.json'), 'utf8'));
  assert.deepEqual(stored.global, ['playwright']);

  await ignoreGap(config, 'playwright', { undo: true });
  assert.deepEqual(entry(other).gaps, ['playwright']);
  assert.deepEqual(forTarget(config, app).ignoredGaps, ['playwright']);
});

test('refs scan re-detects one project and keeps the other entries', async () => {
  const other = path.join(root, 'tool');
  fs.mkdirSync(other);
  await runIndex(config);
  assert.deepEqual(entry(other).tags, []);
  write(other, 'go.mod', 'module tool\n');
  const e = await scanProject(config, other);
  assert.deepEqual(e.tags, ['go']);
  assert.deepEqual(entry(other).gaps, ['go']);
  assert.deepEqual(entry().tags, ['node', 'docker', 'playwright']);
  await assert.rejects(scanProject(config, t.work), /not under a registered root/);
  await assert.rejects(scanProject(config, root), /registered root itself/);
});

test('a project added by refs scan below the discovery depth survives the next index', async () => {
  const deep = path.join(root, 'a', 'b', 'c', 'd', 'e');
  write(deep, 'Cargo.toml', '[package]\n');
  await scanProject(config, deep);
  await runIndex(config);
  assert.deepEqual(entry(deep).tags, ['rust']);
});

test('refs for groups sheets by tag, with gaps and unused reminders', async () => {
  const r = forTarget(config, 'docker node playwright');
  assert.equal(r.project, null);
  assert.deepEqual(r.byTag.map((g) => [g.tag, g.sheets.map((s) => s.id)]), [
    ['docker', ['s_0001', 's_0003']],
    ['node', ['s_0002']],
    ['playwright', []],
  ]);
  assert.deepEqual(r.gaps, ['playwright']);
  assert.deepEqual(r.unused.map((s) => s.id), ['s_0001', 's_0002', 's_0003']);

  const byPath = forTarget(config, path.join(app, 'src', 'components'));
  assert.equal(byPath.project, normPath(app));
  assert.deepEqual(byPath.tags, ['node', 'docker', 'playwright']);
});
