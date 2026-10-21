import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireLock, pathKey, readHookCache, readManifest, readUsage } from '@refs/core';
import { startFakeOllama, type FakeOllama } from '../../core/test/fakeollama.ts';
import { DEAD_OLLAMA, DOCKER_MD, setupEnv, write, type TestEnv } from '../../core/test/helpers.ts';
import { MARK_OPEN, POPUP_LOCK_WAIT_MS } from '../src/handlers.ts';

const SIDECAR = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const CLI = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082', 'hex');

let t: TestEnv;
let fake: FakeOllama;
let app: string;
let side: Sidecar;

// Async, because the fake Ollama answers from this process.
function refs(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: t.env, cwd: t.work });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

interface Reply {
  id: unknown;
  result?: any;
  error?: { code: string; message: string };
}

/** The popup's side of the protocol: JSON lines in, replies matched by id. */
class Sidecar {
  child: ChildProcessWithoutNullStreams;
  stderr = '';
  private next = 1;
  private waiting = new Map<unknown, (r: Reply) => void>();
  private buffer = '';
  constructor() {
    this.child = spawn(process.execPath, [SIDECAR], { env: { ...t.env, REFS_SIDECAR_NO_OPEN: '1' } });
    this.child.stderr.on('data', (d: Buffer) => (this.stderr += d.toString('utf8')));
    this.child.stdout.on('data', (d: Buffer) => {
      this.buffer += d.toString('utf8');
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(this.buffer.slice(0, nl)) as Reply;
        this.buffer = this.buffer.slice(nl + 1);
        this.waiting.get(msg.id)?.(msg);
        this.waiting.delete(msg.id);
      }
    });
  }
  /** Sends several requests in one write, the way fast typing reaches the sidecar. */
  send(...reqs: { method: string; params?: object }[]): Promise<Reply>[] {
    const lines: string[] = [];
    const replies = reqs.map(({ method, params }) => {
      const id = this.next++;
      lines.push(JSON.stringify({ id, method, params }));
      return new Promise<Reply>((resolve) => this.waiting.set(id, resolve));
    });
    this.child.stdin.write(lines.join('\n') + '\n');
    return replies;
  }
  async call(method: string, params: object = {}): Promise<any> {
    const r = await this.send({ method, params })[0]!;
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.result;
  }
}

function setConfig(patch: Record<string, unknown>): void {
  const file = path.join(t.env.APPDATA!, 'refs', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
  fs.writeFileSync(file, JSON.stringify({ ...cfg, ...patch, ollama: { ...cfg.ollama, ...(patch.ollama as object) } }));
}

const tryFor = (id: string) => readHookCache()!.projects.find((p) => p.key === pathKey(app))!.unused.some((u) => u.id === id);

before(async () => {
  fake = await startFakeOllama();
  t = setupEnv({ ollamaHost: fake.url });
  const root = path.join(t.root, 'Projects & Stuff');
  app = path.join(root, 'web app');
  write(app, 'package.json', '{}');
  write(app, 'Dockerfile', 'FROM node:24\n');
  setConfig({ roots: [root.replace(/\\/g, '/')] });

  fake.ocr = () => 'ollama pull llama3\nollama run llama3';
  for (const args of [
    ['add', write(t.work, 'docker-notes.md', DOCKER_MD), '--tags', 'docker'],
    ['add', write(t.work, 'ollama-pull.png', PNG), '--tags', 'ollama'],
  ]) {
    const r = await refs(args);
    assert.equal(r.code, 0, r.stderr);
  }
  fake.chatReplies.push(JSON.stringify({ title: 'Git tips', tags: ['git'] }));
  write(path.join(t.library, 'inbox'), 'git-tips.md', '# Git tips\n\nUndo the last commit with git reset --soft HEAD~1.\n');
  const r = await refs(['index']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readManifest(t.library).map((s) => [s.id, s.status, s.format]), [['s_0001', 'verified', 'md'], ['s_0002', 'verified', 'png'], ['s_0003', 'pending', 'md']]);
  side = new Sidecar();
});

after(async () => {
  side.child.stdin.end();
  await fake.close();
});

test('ping, hello with the hotkey from config.json, and bad requests', async () => {
  assert.deepEqual(await side.call('ping'), { pong: true, pid: side.child.pid });
  let hello = await side.call('hello');
  assert.equal(hello.hotkey, 'Ctrl+Alt+Space');
  assert.equal(hello.hotkeyError, undefined);
  assert.equal(hello.indexExists, true);

  setConfig({ hotkey: 'control+shift+k' });
  assert.equal((await side.call('hello')).hotkey, 'Ctrl+Shift+K', 'config edits apply without a restart');
  setConfig({ hotkey: 'Ctrl+Hyper' });
  hello = await side.call('hello');
  assert.equal(hello.hotkey, 'Ctrl+Alt+Space');
  assert.match(hello.hotkeyError, /"Hyper" is not a key.*using Ctrl\+Alt\+Space/);
  setConfig({ hotkey: 'Ctrl+Alt+Space' });

  const [unknown] = side.send({ method: 'rm -rf' });
  assert.deepEqual((await unknown!).error, { code: 'bad_request', message: 'unknown method "rm -rf"' });
  side.child.stdin.write('not json\n');
  await assert.rejects(side.call('preview', { id: 's_9999' }), { code: 'not_found' });
  await assert.rejects(side.call('preview', { id: 's_0001', section: 99 }), { code: 'not_found', message: /sections 1 to 4/ });
});

test('search: keyword pass first, hybrid pass next, boosted by last-project.json, stale passes superseded', async () => {
  const kw = await side.call('search', { q: 'docker', mode: 'keyword', seq: 1 });
  assert.equal(kw.pass, 'keyword');
  assert.equal(kw.mode, 'keyword');
  assert.equal(kw.notice, undefined);
  assert.equal(kw.project, null, 'no last-project.json yet: no boost');
  assert.ok(kw.tookMs < 100, `keyword pass took ${kw.tookMs} ms`);
  assert.equal(kw.hits[0].id, 's_0001');
  assert.ok(kw.hits[0].snippet.includes(MARK_OPEN), 'matched words are marked');
  assert.deepEqual(Object.keys(kw.hits[0]).sort(), ['heading', 'id', 'learned', 'ocr', 'section', 'snippet', 'stale', 'status', 'tags', 'title']);

  // The prompt hook writes last-project.json; the popup takes the tags from the hook cache.
  write(path.join(t.env.LOCALAPPDATA!, 'refs'), 'last-project.json', JSON.stringify({ key: pathKey(app), path: app.replace(/\\/g, '/'), cwd: app, tags: ['stale-tag'], at: '2026-10-20T08:00:00Z', rotation: {} }));
  const hy = await side.call('search', { q: 'download a model', mode: 'hybrid', seq: 2 });
  assert.equal(hy.pass, 'hybrid');
  assert.equal(hy.mode, 'hybrid');
  assert.equal(hy.notice, undefined);
  assert.equal(hy.hits[0].id, 's_0002', 'the OCR screenshot is found by meaning');
  assert.equal(hy.hits[0].ocr, true);
  // Tags from the hook cache entry (not the outdated ones in the file), the path as the hook wrote it.
  assert.deepEqual(hy.project, { name: 'web app', path: app.replace(/\\/g, '/'), tags: ['node', 'docker'], at: '2026-10-20T08:00:00.000Z' });

  // A hybrid pass still waiting for Ollama when the next keystroke arrives is dropped.
  const [slow, next] = side.send({ method: 'search', params: { q: 'dock', mode: 'hybrid', seq: 3 } }, { method: 'search', params: { q: 'docker', mode: 'keyword', seq: 4 } });
  assert.equal((await slow!).result.superseded, true);
  assert.equal((await slow!).result.hits.length, 0);
  assert.equal((await next!).result.hits[0].id, 's_0001');
});

test('search with Ollama down answers by keyword with a notice', async () => {
  setConfig({ ollama: { host: DEAD_OLLAMA } });
  try {
    const r = await side.call('search', { q: 'docker containers', mode: 'hybrid', seq: 10 });
    assert.equal(r.mode, 'keyword');
    assert.match(r.notice, /^keyword only: Ollama not reachable at http:\/\/127\.0\.0\.1:9/);
    assert.equal(r.hits[0].id, 's_0001');
  } finally {
    setConfig({ ollama: { host: fake.url } });
  }
});

test('preview renders a section, logs an open via popup and takes the sheet out of try:', async () => {
  assert.ok(tryFor('s_0001'), 'offered in try: before');
  const p = await side.call('preview', { id: 's_0001', section: 2 });
  assert.equal(p.body.kind, 'markdown');
  assert.match(p.body.html, /^<h2>Containers<\/h2>/);
  assert.match(p.body.html, /<pre><code class="language-bash"># remove all stopped containers\ndocker container prune\n<\/code><\/pre>/);
  assert.deepEqual(p.section, { idx: 2, heading: 'Containers' });
  assert.deepEqual(p.sections.map((s: { heading: string }) => s.heading), ['Docker basics', 'Containers', 'Images', 'Volumes']);
  assert.equal(p.sheet.file, path.join(t.library, 'sheets', 's_0001-docker-basics.md'));
  assert.deepEqual(p.images, []);
  const last = readUsage().at(-1)!;
  assert.deepEqual({ event: last.event, id: last.id, section: last.section, via: last.via }, { event: 'open', id: 's_0001', section: 2, via: 'popup' });
  assert.equal(tryFor('s_0001'), false, 'the hook cache was refreshed: no longer offered in try:');
});

test('preview of an OCR source gives the text and the original image beside it', async () => {
  const p = await side.call('preview', { id: 's_0002' });
  assert.deepEqual(p.body, { kind: 'text', text: 'ollama pull llama3\nollama run llama3' });
  assert.equal(p.sheet.ocr.model, 'fake-vision');
  assert.deepEqual(p.images, [{ label: 's_0002-ollama-pull.png', uri: `data:image/png;base64,${PNG.toString('base64')}` }]);
});

test('learned, verified and approve go through the actions under the lock', async () => {
  let r = await side.call('learned', { id: 's_0001' });
  assert.equal(r.changed, true);
  assert.equal(r.sheet.learned, true);
  assert.equal(readManifest(t.library)[0]!.learned, true);
  const last = readUsage().at(-1)!;
  assert.deepEqual([last.event, last.id, last.via], ['learned', 's_0001', 'popup']);
  assert.equal((await side.call('learned', { id: 's_0001' })).changed, false);

  const manifest = path.join(t.library, 'manifest.json');
  const sheets = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { lastVerified: string }[];
  sheets[1]!.lastVerified = '2020-01-01';
  fs.writeFileSync(manifest, JSON.stringify(sheets, null, 2));
  const hit = (await side.call('search', { q: 'ollama', mode: 'keyword', seq: 20 })).hits[0];
  assert.equal(hit.stale, true);
  r = await side.call('verify', { id: 's_0002' });
  assert.equal(r.changed, true);
  assert.equal(r.sheet.stale, false);

  r = await side.call('approve', { id: 's_0003' });
  assert.equal(r.from, 'pending');
  assert.equal(r.sheet.status, 'verified');
  assert.deepEqual(readManifest(t.library)[2]!.tags, ['git']);
  assert.equal((await side.call('approve', { id: 's_0003' })).changed, false);
});

test('a busy lock is reported as busy after a short wait instead of hanging', async () => {
  const lock = await acquireLock({ command: 'index (test holder)' });
  try {
    const started = Date.now();
    await assert.rejects(side.call('learned', { id: 's_0002' }), { code: 'busy', message: new RegExp(`locked by process ${process.pid}`) });
    const waited = Date.now() - started;
    assert.ok(waited >= POPUP_LOCK_WAIT_MS - 100 && waited < POPUP_LOCK_WAIT_MS + 3000, `waited ${waited} ms`);
  } finally {
    lock.release();
  }
  assert.equal((await side.call('learned', { id: 's_0002' })).changed, true, 'works again once the lock is free');
});

test('opening files and links: only http, https and mailto links', async () => {
  assert.deepEqual(await side.call('openFile', { id: 's_0001' }), { opened: path.join(t.library, 'sheets', 's_0001-docker-basics.md') });
  assert.deepEqual(await side.call('openLink', { url: 'https://docs.docker.com/a b' }), { opened: 'https://docs.docker.com/a%20b' });
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'ms-settings:privacy', 'not a url']) {
    await assert.rejects(side.call('openLink', { url }), { code: 'bad_request' }, url);
  }
});

test('the sidecar exits when the popup closes its stdin', async () => {
  const other = new Sidecar();
  assert.deepEqual((await other.call('ping')).pong, true);
  const exited = new Promise<number | null>((resolve) => other.child.on('exit', resolve));
  other.child.stdin.end();
  assert.equal(await exited, 0);
  assert.equal(other.stderr, '', 'nothing was logged');
});
