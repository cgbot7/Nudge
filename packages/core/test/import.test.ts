import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { openDb } from '../src/db.ts';
import { OcrUnavailableError } from '../src/extract/image.ts';
import { addFile, allowFinding, moveFile } from '../src/import.ts';
import { acquireLock, LockBusyError } from '../src/lock.ts';
import { readManifest } from '../src/manifest.ts';
import { dataPaths } from '../src/paths.ts';
import { keywordSearch, type SearchHit } from '../src/search.ts';
import { RefsError, sha256 } from '../src/util.ts';
import { DOCKER_MD, FAKE_GITHUB_TOKEN, makeDocx, makePdf, setupEnv, write, type TestEnv } from './helpers.ts';

let t: TestEnv;
beforeEach(() => {
  t = setupEnv();
});

function search(query: string, tags?: string[]): SearchHit[] {
  const db = openDb();
  try {
    return keywordSearch(db, readManifest(t.library), query, { tags });
  } finally {
    db.close();
  }
}

function gitLog(): string {
  return execFileSync('git', ['-C', t.library, 'log', '--format=%s'], { encoding: 'utf8' });
}

test('imports Markdown: moves the file, records it, indexes sections and commits', async () => {
  const src = write(t.work, 'docker-notes.md', DOCKER_MD);
  const r = await addFile(t.library, src);
  assert.equal(r.kind, 'added');
  if (r.kind !== 'added') return;

  assert.equal(fs.existsSync(src), false, 'original is moved, not copied');
  assert.equal(r.sheet.id, 's_0001');
  assert.equal(r.sheet.title, 'Docker basics');
  assert.equal(r.sheet.file, 'sheets/s_0001-docker-basics.md');
  assert.equal(r.sheet.status, 'pending');
  assert.equal(r.sheet.originalPath, src.replace(/\\/g, '/').replace(/^[A-Z]:/, (d) => d.toLowerCase()));
  assert.equal(r.sheet.sha256, sha256(DOCKER_MD));
  assert.equal(r.sections, 4);
  assert.equal(fs.readFileSync(path.join(t.library, 'sheets', 's_0001-docker-basics.md'), 'utf8'), DOCKER_MD);
  assert.deepEqual(readManifest(t.library).map((s) => s.id), ['s_0001']);
  assert.match(gitLog(), /refs: add s_0001 Docker basics/);
  assert.equal(execFileSync('git', ['-C', t.library, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  assert.equal(fs.readFileSync(path.join(t.library, '.gitattributes'), 'utf8'), '* -text\n');
  assert.ok(fs.existsSync(path.join(dataPaths().extractCache, `${r.sheet.sha256}.txt`)));

  const hits = search('remove stopped containers');
  assert.equal(hits[0]?.id, 's_0001');
  assert.equal(hits[0]?.heading, 'Containers');
  assert.equal(search('volume inspect')[0]?.heading, 'Volumes');
});

test('--tags are normalized and mark the sheet verified; search can filter by tag', async () => {
  const r = await addFile(t.library, write(t.work, 'd.md', DOCKER_MD), { tags: ['Docker', 'Docker Compose'] });
  assert.equal(r.kind, 'added');
  if (r.kind !== 'added') return;
  assert.deepEqual(r.sheet.tags, ['docker', 'docker-compose']);
  assert.equal(r.sheet.status, 'verified');
  assert.equal(search('prune', ['docker']).length > 0, true);
  assert.equal(search('prune', ['node']).length, 0);
});

test('duplicate content reports the existing id and changes nothing', async () => {
  await addFile(t.library, write(t.work, 'a.md', DOCKER_MD));
  const before = fs.readFileSync(path.join(t.library, 'manifest.json'), 'utf8');
  const copy = write(t.work, 'copy of a.md', DOCKER_MD);
  const r = await addFile(t.library, copy);
  assert.equal(r.kind, 'duplicate');
  assert.equal(r.kind === 'duplicate' && r.existing.id, 's_0001');
  assert.ok(fs.existsSync(copy), 'duplicate stays where it was');
  assert.equal(fs.readFileSync(path.join(t.library, 'manifest.json'), 'utf8'), before);
});

test('a likely secret blocks the import until allowlisted', async () => {
  const src = write(t.work, 'git-tips.md', `# Git tips\n\nPush with a token:\n\nexport GH=${FAKE_GITHUB_TOKEN}\n`);
  const r = await addFile(t.library, src);
  assert.equal(r.kind, 'blocked');
  if (r.kind !== 'blocked') return;
  assert.equal(r.findings[0]?.line, 5);
  assert.equal(r.findings[0]?.rule, 'github-token');
  assert.ok(fs.existsSync(src), 'blocked file stays in place');
  assert.deepEqual(readManifest(t.library), []);
  assert.ok(!fs.existsSync(dataPaths().extractCache) || fs.readdirSync(dataPaths().extractCache).length === 0, 'no cached text for a blocked file');

  await assert.rejects(allowFinding(t.library, src, 2), /no finding 2/);
  await allowFinding(t.library, src, 1);
  const again = await addFile(t.library, src);
  assert.equal(again.kind, 'added');
  if (again.kind !== 'added') return;
  assert.deepEqual(again.sheet.secretAllowlist, [{ rule: 'github-token', fingerprint: r.findings[0]!.fingerprint }]);
});

test('imports DOCX with Word headings as sections', async () => {
  const docx = makeDocx([
    { text: 'Ollama cheat sheet', style: 'Heading1' },
    { text: 'Local models served on port 11434 by default for every client.' },
    { text: 'Pulling models', style: 'Heading2' },
    { text: 'Download a model with ollama pull llama3 before the first run.' },
    { text: 'Escaping <tags> & entities survive conversion intact here.' },
  ]);
  const r = await addFile(t.library, write(t.work, 'ollama.docx', docx));
  assert.equal(r.kind, 'added');
  if (r.kind !== 'added') return;
  assert.equal(r.sheet.title, 'Ollama cheat sheet');
  assert.equal(r.sheet.format, 'docx');
  assert.equal(r.sections, 2);
  const hit = search('download a model')[0];
  assert.equal(hit?.id, r.sheet.id);
  assert.equal(hit?.heading, 'Pulling models');
  assert.match(fs.readFileSync(path.join(dataPaths().extractCache, `${r.sheet.sha256}.txt`), 'utf8'), /<tags> & entities/);
});

test('imports text PDFs page by page; pages without a text layer need OCR', async () => {
  const pdf = makePdf([['Kubernetes quick reference', 'kubectl get pods lists pods'], ['kubectl logs shows container output']]);
  const r = await addFile(t.library, write(t.work, 'k8s-ref.pdf', pdf));
  assert.equal(r.kind, 'added');
  if (r.kind !== 'added') return;
  assert.equal(r.sheet.title, 'K8s ref');
  assert.equal(r.sections, 2);
  assert.equal(search('kubectl logs')[0]?.heading, 'Page 2');

  // Ollama is down in this sandbox: a scanned page cannot be OCR'd or secret-scanned, so nothing moves.
  const mixed = write(t.work, 'mixed.pdf', makePdf([['some text'], []]));
  await assert.rejects(addFile(t.library, mixed), OcrUnavailableError);
  assert.ok(fs.existsSync(mixed));
});

test('rejects Office lock files, unsupported types, and images while OCR is unavailable', async () => {
  await assert.rejects(addFile(t.library, write(t.work, '~$notes.docx', 'x')), /Office lock file/);
  await assert.rejects(addFile(t.library, write(t.work, 'a.exe', 'x')), /unsupported file type/);
  const shot = write(t.work, 'shot.png', 'x');
  await assert.rejects(addFile(t.library, shot), /images need OCR/);
  assert.ok(fs.existsSync(shot), 'left in place');
  await assert.rejects(addFile(t.library, path.join(t.work, 'missing.md')), /file not found/);
});

test('a file tracked in another Git repo needs confirmation or --yes', async () => {
  const repo = path.join(t.work, 'other repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'config', 'core.autocrlf', 'false']);
  const src = write(repo, 'notes.md', DOCKER_MD);
  execFileSync('git', ['-C', repo, 'add', 'notes.md']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'notes']);

  await assert.rejects(addFile(t.library, src), /--yes/);
  await assert.rejects(addFile(t.library, src, { confirm: async () => false }), /cancelled/);
  assert.ok(fs.existsSync(src));
  assert.deepEqual(readManifest(t.library), []);

  const r = await addFile(t.library, src, { yes: true });
  assert.equal(r.kind, 'added');
  assert.ok(r.kind === 'added' && r.warnings.some((w) => /deletion in/.test(w)));
});

test('cross-drive moves copy, verify the hash, then delete the original', () => {
  const fail = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  const exdev = { rename: fail('EXDEV') };
  const src = write(t.work, 'x.md', 'hello');
  const dest = path.join(t.root, 'dest', 'x.md');
  assert.deepEqual(moveFile(src, dest, sha256('hello'), exdev), { keptOriginal: false });
  assert.equal(fs.readFileSync(dest, 'utf8'), 'hello');
  assert.equal(fs.existsSync(src), false);

  // When the original cannot be deleted, both copies are kept and reported.
  const kept = write(t.work, 'kept.md', 'keep me');
  const r = moveFile(kept, path.join(t.root, 'dest', 'kept.md'), sha256('keep me'), { ...exdev, unlink: fail('EBUSY') });
  assert.deepEqual(r, { keptOriginal: true, reason: 'EBUSY' });
  assert.ok(fs.existsSync(kept));
  assert.equal(fs.readFileSync(path.join(t.root, 'dest', 'kept.md'), 'utf8'), 'keep me');

  assert.throws(() => moveFile(write(t.work, 'bad.md', 'abc'), path.join(t.root, 'dest', 'bad.md'), sha256('other'), exdev), RefsError);
  assert.ok(fs.existsSync(path.join(t.work, 'bad.md')), 'unverified copy leaves the original');
  assert.equal(fs.existsSync(path.join(t.root, 'dest', 'bad.md')), false);
});

test('search treats FTS syntax in the query as plain words', async () => {
  await addFile(t.library, write(t.work, 'd.md', DOCKER_MD));
  assert.doesNotThrow(() => search('prune AND ( "unbalanced NEAR( -x *'));
  assert.deepEqual(search('the a of'), []);
});

test('the lock admits one writer, times out, and takes over a dead process lock', async () => {
  const lock = await acquireLock({ waitMs: 0 });
  await assert.rejects(acquireLock({ waitMs: 200 }), LockBusyError);
  lock.release();
  (await acquireLock({ waitMs: 0 })).release();

  fs.writeFileSync(dataPaths().lock, JSON.stringify({ pid: 999_999_999, at: new Date().toISOString() }));
  (await acquireLock({ waitMs: 0 })).release();
  assert.equal(fs.existsSync(dataPaths().lock), false);
});
