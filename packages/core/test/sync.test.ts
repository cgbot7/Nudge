import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { ConfigSchema, type Config } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { runDoctor } from '../src/doctor.ts';
import { addFile } from '../src/import.ts';
import { runIndex } from '../src/indexer.ts';
import { acquireLock } from '../src/lock.ts';
import { readManifest, writeManifest } from '../src/manifest.ts';
import { dataPaths } from '../src/paths.ts';
import { keywordSearch } from '../src/search.ts';
import { sha256, today } from '../src/util.ts';
import { DOCKER_MD, FAKE_GITHUB_TOKEN, fakeSystem, setupEnv, write, type TestEnv } from './helpers.ts';

let t: TestEnv;
let config: Config;
beforeEach(() => {
  t = setupEnv();
  config = ConfigSchema.parse({ library: t.library });
});

const NODE_MD = `# Node tips

## npm scripts

Run package scripts with npm run, and list them all with npm run without arguments.

## Versions

Check the active runtime with node --version and switch versions with a version manager.
`;

function search(query: string) {
  const db = openDb();
  try {
    return keywordSearch(db, readManifest(t.library), query);
  } finally {
    db.close();
  }
}

const git = (...args: string[]) => execFileSync('git', ['-C', t.library, ...args], { encoding: 'utf8' });

async function addDocker() {
  const r = await addFile(t.library, write(t.work, 'docker-notes.md', DOCKER_MD), { tags: ['docker'] });
  assert.equal(r.kind, 'added');
  return readManifest(t.library)[0]!;
}

test('an edited sheet is re-extracted and re-indexed; lastVerified and status are kept', async () => {
  const sheet = await addDocker();
  const sheets = readManifest(t.library);
  sheets[0]!.lastVerified = '2026-01-02';
  sheets[0]!.updatedAt = '2026-01-02';
  writeManifest(t.library, sheets);
  const file = path.join(t.library, sheet.file);
  const edited = DOCKER_MD + '\n## Networks\n\nCreate a bridge network with docker network create and attach containers to it.\n';
  fs.writeFileSync(file, edited);

  const r = await runIndex(config);
  assert.deepEqual(r?.sync.edited, ['s_0001']);
  const after = readManifest(t.library)[0]!;
  assert.equal(after.sha256, sha256(edited));
  assert.equal(after.updatedAt, today());
  assert.equal(after.lastVerified, '2026-01-02');
  assert.equal(after.status, 'verified');
  assert.equal(search('bridge network')[0]?.heading, 'Networks');
  assert.match(git('log', '-1', '--format=%s'), /refs: sync library \(1 edited\)/);
  assert.equal(git('status', '--porcelain'), '');

  const again = await runIndex(config);
  assert.equal(again?.indexed, 0, 'nothing changed, nothing re-indexed');
});

test('a renamed sheet is matched to its entry by hash', async () => {
  const sheet = await addDocker();
  fs.mkdirSync(path.join(t.library, 'sheets', 'containers'));
  fs.renameSync(path.join(t.library, sheet.file), path.join(t.library, 'sheets', 'containers', 'docker.md'));

  const r = await runIndex(config);
  assert.deepEqual(r?.sync.renamed, [{ id: 's_0001', from: sheet.file, to: 'sheets/containers/docker.md' }]);
  assert.deepEqual(r?.sync.missing, []);
  assert.equal(readManifest(t.library)[0]!.file, 'sheets/containers/docker.md');
  assert.equal(search('stopped containers')[0]?.id, 's_0001');
  assert.equal(git('status', '--porcelain'), '');
});

test('a missing sheet stays in the manifest, leaves the index, and doctor reports it', async () => {
  const sheet = await addDocker();
  fs.rmSync(path.join(t.library, sheet.file));
  write(path.join(t.library, 'sheets'), 'unrelated.md', '# Other\n\nSomething else entirely, not the docker notes.\n');

  const r = await runIndex(config);
  assert.deepEqual(r?.sync.missing, ['s_0001']);
  assert.deepEqual(r?.sync.unknown, ['sheets/unrelated.md']);
  assert.equal(readManifest(t.library).length, 1, 'never silently removed');
  assert.deepEqual(search('stopped containers'), []);

  const checks = runDoctor(fakeSystem(t.env.REFS_DOCUMENTS_DIR!).sys);
  assert.ok(checks.some((c) => c.status === 'fail' && c.name === 'files' && /missing from the library: s_0001/.test(c.detail)));
  assert.ok(checks.some((c) => c.status === 'warn' && c.name === 'files' && /unrelated\.md/.test(c.detail)));
});

test('an edit that adds a secret is not accepted and leaves the index', async () => {
  const sheet = await addDocker();
  fs.appendFileSync(path.join(t.library, sheet.file), `\ntoken=${FAKE_GITHUB_TOKEN}\n`);
  const r = await runIndex(config);
  assert.equal(r?.sync.blocked[0]?.id, 's_0001');
  assert.equal(readManifest(t.library)[0]!.sha256, sheet.sha256, 'manifest keeps the last clean hash');
  assert.deepEqual(search('stopped containers'), []);
  const cached = fs.readdirSync(dataPaths().extractCache).map((f) => fs.readFileSync(path.join(dataPaths().extractCache, f), 'utf8'));
  assert.ok(!cached.some((text) => text.includes(FAKE_GITHUB_TOKEN)), 'the secret never reaches the extract cache');
});

test('a tag edit in manifest.json re-indexes the sheet', async () => {
  await addDocker();
  const sheets = readManifest(t.library);
  sheets[0]!.tags = ['docker', 'containers'];
  writeManifest(t.library, sheets);
  const r = await runIndex(config);
  assert.equal(r?.indexed, 1);
});

test('--rebuild recreates index.db from the library alone with the same search results', async () => {
  await addDocker();
  await addFile(t.library, write(t.work, 'node.md', NODE_MD), { tags: ['node'] });
  await runIndex(config);
  const queries = ['remove stopped containers', 'prune', 'npm scripts', 'volume', 'version'];
  const before = queries.map((q) => search(q));
  assert.ok(before.every((hits) => hits.length > 0));

  for (const f of fs.readdirSync(dataPaths().dir)) if (f.startsWith('index.db')) fs.rmSync(path.join(dataPaths().dir, f));
  fs.rmSync(dataPaths().extractCache, { recursive: true });
  const r = await runIndex(config, { rebuild: true });
  assert.equal(r?.rebuilt, true);
  assert.equal(r?.indexed, 2);
  assert.deepEqual(queries.map((q) => search(q)), before);
});

test('a scheduled index exits quietly when another writer holds the lock', async () => {
  const lock = await acquireLock({ command: 'test' });
  try {
    const started = Date.now();
    assert.equal(await runIndex(config, { scheduled: true }), null);
    assert.ok(Date.now() - started < 2000, 'does not wait');
  } finally {
    lock.release();
  }
});
