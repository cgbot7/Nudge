import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { loadConfig, type Config } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { compose, parseFrontmatter, runHarvest, SOURCES } from '../src/harvest/index.ts';
import { ledgerPath, readLedger } from '../src/harvest/ledger.ts';
import { runIndex } from '../src/indexer.ts';
import { readManifest } from '../src/manifest.ts';
import { dataDir, normPath } from '../src/paths.ts';
import { rejectReview } from '../src/review.ts';
import { keywordSearch } from '../src/search.ts';
import { sha256 } from '../src/util.ts';
import { FAKE_GITHUB_TOKEN, setupEnv, write, type TestEnv } from './helpers.ts';

let t: TestEnv;
let home: string;
let memory: string;

const MEMORY_NOTE = `---
name: docker-volumes
description: "How named volumes and bind mounts differ"
metadata:
  type: reference
---

Named volumes live under Docker's own storage.

## Commands

\`\`\`bash
docker volume ls
docker volume prune
\`\`\`
`;

beforeEach(() => {
  t = setupEnv();
  home = t.env.NUDGE_HOME_DIR!;
  memory = path.join(home, '.claude', 'projects', 'C--Projects-Web & App', 'memory');
});

function cfg(harvest: Record<string, unknown> = {}): Config {
  const file = path.join(t.env.APPDATA!, 'nudge', 'config.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...data, harvest }));
  return loadConfig().config;
}

function gitLog(): string {
  return execFileSync('git', ['-C', t.library, 'log', '--format=%s'], { encoding: 'utf8' });
}

function libraryText(file: string): string {
  return fs.readFileSync(path.join(t.library, file), 'utf8');
}

test('frontmatter: one-line fields read, nested YAML skipped, quotes removed', () => {
  const fm = parseFrontmatter('﻿---\r\nname: a-b\r\ndescription: "say \\"hi\\""\r\nother: \'it\'\'s\'\r\nlist:\r\n  - x\r\n---\r\nbody\r\n');
  assert.deepEqual(fm.fields, { name: 'a-b', description: 'say "hi"', other: "it's" });
  assert.equal(fm.body, 'body\n');
  assert.deepEqual(parseFrontmatter('# no frontmatter\n'), { fields: {}, body: '# no frontmatter\n' });
  assert.equal(compose('Title', 'Summary.', '# Own heading\n\nText'), '# Own heading\n\nSummary.\n\nText\n');
  assert.equal(compose('Title', undefined, 'Text'), '# Title\n\nText\n');
});

test('Claude memory source skips MEMORY.md and strips the frontmatter', () => {
  write(memory, 'MEMORY.md', '- [Docker volumes](docker-volumes.md)\n');
  write(memory, 'docker-volumes.md', MEMORY_NOTE);
  write(memory, 'notes.txt', 'not a note');
  write(path.join(home, '.cursor', 'plans'), 'fix_ce14ca31.plan.md', '# A Cursor plan\n');

  const notes = SOURCES['claude-memory'].list();
  assert.deepEqual(notes.map((c) => path.basename(c.file)), ['docker-volumes.md']);
  assert.equal(notes[0]!.project, 'C--Projects-Web & App');
  const md = SOURCES['claude-memory'].render(notes[0]!.file, MEMORY_NOTE);
  assert.match(md, /^# Docker volumes\n\nHow named volumes and bind mounts differ\n\nNamed volumes/);
  assert.doesNotMatch(md, /metadata|type: reference/);
  // Cursor files are not a harvest source (Cursor comes in through its chats only).
  assert.deepEqual(Object.keys(SOURCES), ['claude-memory']);
});

test('copies notes into the library without touching the origin, once', async () => {
  const origin = write(memory, 'docker-volumes.md', MEMORY_NOTE);
  write(memory, 'git-tips.md', '# Git tips\n\nUse git switch -c to start a branch.\n');
  const before = fs.readFileSync(origin);

  const r = await runHarvest(cfg());
  assert.equal(r.added.length, 2);
  assert.deepEqual(fs.readFileSync(origin), before, 'origin is byte for byte the same');

  const sheets = readManifest(t.library);
  const s = sheets.find((x) => x.title === 'Docker volumes')!;
  assert.equal(s.source, 'harvested');
  assert.equal(s.status, 'pending');
  assert.equal(s.title, 'Docker volumes');
  assert.equal(s.originalPath, normPath(origin));
  assert.deepEqual(s.harvest, { tool: 'claude-memory', kind: 'file', origin: normPath(origin), at: s.updatedAt, project: 'C--Projects-Web & App' });
  assert.match(libraryText(s.file), /^# Docker volumes\n/);

  const ledger = readLedger(t.library);
  assert.equal(Object.keys(ledger.files).length, 2);
  assert.equal(Object.values(ledger.files).find((e) => e.sheetId === s.id)!.originSha, sha256(before));
  assert.match(gitLog(), /nudge: harvest \(2 new\)/);
  assert.match(gitLog(), /nudge: add s_0001/);

  const again = await runHarvest(cfg());
  assert.equal(again.added.length, 0);
  assert.equal(again.unchanged, 2);
  assert.equal(readManifest(t.library).length, 2);
});

test('a changed origin updates an untouched copy, and nudge index re-indexes it', async () => {
  const origin = write(memory, 'docker-volumes.md', MEMORY_NOTE);
  const config = cfg({ enabled: true });
  await runIndex(config);
  const s = readManifest(t.library)[0]!;

  fs.writeFileSync(origin, MEMORY_NOTE.replace('docker volume prune', 'docker volume inspect zebravolume'));
  const r = await runIndex(config);
  assert.deepEqual(r!.harvest!.updated.map((u) => u.id), [s.id]);
  assert.deepEqual(r!.sync.edited, [s.id]);
  assert.match(libraryText(s.file), /zebravolume/);
  const after = readManifest(t.library)[0]!;
  assert.equal(after.sha256, sha256(libraryText(s.file)));
  assert.equal(after.lastVerified, s.lastVerified);

  const db = openDb();
  try {
    assert.equal(keywordSearch(db, readManifest(t.library), 'zebravolume')[0]?.id, s.id);
  } finally {
    db.close();
  }
});

test('an edited library copy is never overwritten from its origin', async () => {
  const origin = write(memory, 'docker-volumes.md', MEMORY_NOTE);
  await runHarvest(cfg());
  const s = readManifest(t.library)[0]!;
  fs.appendFileSync(path.join(t.library, s.file), '\nMy own note.\n');
  const mine = libraryText(s.file);

  fs.writeFileSync(origin, MEMORY_NOTE + '\nNew at the origin.\n');
  const r = await runHarvest(cfg());
  assert.deepEqual(r.edited.map((e) => e.id), [s.id]);
  assert.equal(r.updated.length, 0);
  assert.equal(libraryText(s.file), mine);
  // Reported once, not on every run.
  assert.equal((await runHarvest(cfg())).edited.length, 0);
});

test('reject removes the sheet and the origin is never copied again, even after a rebuild', async () => {
  const origin = write(memory, 'docker-volumes.md', MEMORY_NOTE);
  const config = cfg({ enabled: true });
  await runIndex(config);
  const s = readManifest(t.library)[0]!;

  const r = await rejectReview(config, s.id);
  assert.deepEqual(r.origins, [normPath(origin)]);
  assert.equal(readManifest(t.library).length, 0);
  assert.equal(fs.existsSync(path.join(t.library, s.file)), false);
  assert.equal(fs.existsSync(origin), true, 'the origin stays');
  assert.match(gitLog(), new RegExp(`nudge: reject harvested ${s.id}`));
  assert.equal(execFileSync('git', ['-C', t.library, 'status', '--porcelain'], { encoding: 'utf8' }), '');

  fs.writeFileSync(origin, MEMORY_NOTE + '\nchanged\n');
  fs.rmSync(dataDir(), { recursive: true, force: true });
  const again = await runIndex(config, { rebuild: true });
  assert.equal(again!.harvest!.rejected, 1);
  assert.equal(again!.harvest!.added.length, 0);
  assert.equal(readManifest(t.library).length, 0);
  assert.ok(fs.existsSync(ledgerPath(t.library)));

  await assert.rejects(() => rejectReview(config, 's_0099'), /no sheet with id s_0099/);
});

test('only harvested sheets can be rejected', async () => {
  write(memory, 'docker-volumes.md', MEMORY_NOTE);
  const config = cfg();
  await runHarvest(config);
  const sheets = readManifest(t.library);
  sheets[0]!.source = 'imported';
  fs.writeFileSync(path.join(t.library, 'manifest.json'), JSON.stringify(sheets));
  await assert.rejects(() => rejectReview(config, sheets[0]!.id), /was not harvested/);
});

test('a note with a likely secret is not copied and is retried later', async () => {
  const origin = write(memory, 'tokens.md', `---\nname: tokens\n---\n\nexport GITHUB_TOKEN=${FAKE_GITHUB_TOKEN}\n`);
  const r = await runHarvest(cfg());
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0]!.origin, normPath(origin));
  assert.equal(readManifest(t.library).length, 0);
  assert.equal(fs.readdirSync(path.join(t.library, 'sheets')).length, 0);
  assert.equal(readLedger(t.library).files[normPath(origin).toLowerCase()], undefined);

  fs.writeFileSync(origin, '---\nname: tokens\n---\n\nexport GITHUB_TOKEN=<your token>\n');
  assert.equal((await runHarvest(cfg())).added.length, 1);
});

test('same note in two projects becomes one sheet', async () => {
  write(memory, 'docker-volumes.md', MEMORY_NOTE);
  write(path.join(home, '.claude', 'projects', 'C--Other', 'memory'), 'docker-volumes.md', MEMORY_NOTE);
  const r = await runHarvest(cfg());
  assert.equal(r.added.length, 1);
  assert.equal(r.duplicates.length, 1);
  assert.equal(readManifest(t.library).length, 1);
  assert.equal(Object.values(readLedger(t.library).files).filter((e) => e.sheetId === r.added[0]!.sheet.id).length, 2);
});

test('dry run writes nothing; sources can be turned off; maxPerRun defers the rest', async () => {
  write(memory, 'a.md', '# Alpha\n\nalpha text\n');
  write(memory, 'b.md', '# Beta\n\nbeta text\n');
  write(path.join(home, '.claude', 'projects', 'C--Other', 'memory'), 'c.md', '# Gamma\n\ngamma text\n');

  const dry = await runHarvest(cfg(), { dryRun: true });
  assert.equal(dry.wouldAdd.length, 3);
  assert.equal(fs.existsSync(ledgerPath(t.library)), false);
  assert.equal(readManifest(t.library).length, 0);

  const off = await runHarvest(cfg({ sources: { 'claude-memory': false } }), { dryRun: true });
  assert.deepEqual(off.sources, []);
  assert.equal(off.wouldAdd.length, 0);

  const capped = await runHarvest(cfg({ maxPerRun: 1 }));
  assert.equal(capped.added.length, 1);
  assert.equal(capped.deferred, 2);
  assert.equal((await runHarvest(cfg({ maxPerRun: 5 }))).added.length, 2);
});

test('nudge index leaves the harvest alone while harvest.enabled is off', async () => {
  write(memory, 'docker-volumes.md', MEMORY_NOTE);
  const r = await runIndex(cfg());
  assert.equal(r!.harvest, null);
  assert.equal(readManifest(t.library).length, 0);
});
