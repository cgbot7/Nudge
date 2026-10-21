import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFakeOllama, type FakeOllama } from '../../core/test/fakeollama.ts';
import { DEAD_OLLAMA, DOCKER_MD, FAKE_GITHUB_TOKEN, makeDocx, setupEnv, write, type TestEnv } from '../../core/test/helpers.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
let t: TestEnv;
let fake: FakeOllama;

before(async () => {
  fake = await startFakeOllama();
  t = setupEnv({ ollamaHost: fake.url });
});

after(async () => {
  await fake.close();
});

// Async, because the fake Ollama answers from this process: spawnSync would block it.
function refs(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env: t.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function setOllamaHost(host: string): void {
  const file = path.join(t.env.APPDATA!, 'refs', 'config.json');
  const c = JSON.parse(fs.readFileSync(file, 'utf8')) as { ollama: { host: string } };
  c.ollama.host = host;
  fs.writeFileSync(file, JSON.stringify(c));
}

test('inbox, review, hybrid and keyword-only search, doctor', async () => {
  const inbox = path.join(t.library, 'inbox');
  fs.mkdirSync(t.library, { recursive: true });
  write(inbox, 'docker-notes.md', DOCKER_MD);
  write(inbox, 'ollama-pull.png', 'png bytes');
  write(inbox, 'git-tips.docx', makeDocx([{ text: 'Git tips', style: 'Heading1' }, { text: `token: ${FAKE_GITHUB_TOKEN}` }]));
  fake.ocr = () => 'ollama pull llama3.2\npulling manifest\nsuccess';
  fake.chatReplies.push(JSON.stringify({ title: 'Docker container basics', tags: ['docker'] }), JSON.stringify({ title: 'Pull a model with Ollama', tags: ['ollama'] }));

  let r = await refs('index');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /inbox: imported docker-notes\.md as s_0001 "Docker basics", pending \(proposed tags: docker\)/);
  assert.match(r.stdout, /inbox: imported ollama-pull\.png as s_0002 "Ollama pull" \(OCR\), pending \(proposed tags: ollama\)/);
  assert.match(r.stderr, /inbox: git-tips\.docx moved to _blocked[\\/]git-tips\.docx; see git-tips\.docx\.reason\.txt/);
  assert.match(r.stdout, /embedded 5 sections/);
  assert.match(r.stdout, /confirm proposed tags with refs review/);

  r = await refs('review');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /refs review is interactive and this is not a terminal\. Use --list to see the 2 pending sheets, then --accept-all, <id> --accept or <id> --tags a,b\./);

  r = await refs('review', '--list');
  assert.match(r.stdout, /s_0001 {2}"Docker basics" {2}\(md\)\n {2}proposed title: Docker container basics\n {2}proposed tags: {2}docker/);

  r = await refs('review', 's_0002', '--tags', 'ollama,llm', '--title', 'Ollama pull command');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /verified s_0002 "Ollama pull command" \[ollama, llm\]/);
  assert.match(r.stdout, /added to tags\.json: llm/);
  r = await refs('review', '--accept-all');
  assert.match(r.stdout, /verified s_0001 "Docker container basics" \[docker\]\n1 sheet accepted, 0 still pending\./);

  r = await refs('search', 'download', 'a', 'model');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^s_0002:1 {2}Ollama pull command {2}\[ollama, llm\] \[ocr\]/m);
  assert.match(r.stdout, /hybrid, \d+ ms/);
  assert.doesNotMatch(r.stdout, /keyword only/);

  const json = JSON.parse((await refs('search', 'remove stopped containers', '--json')).stdout) as { mode: string; tookMs: number; hits: { id: string; heading: string; via: string[] }[] };
  assert.equal(json.mode, 'hybrid');
  assert.equal(typeof json.tookMs, 'number');
  assert.equal(json.hits[0]?.heading, 'Containers');
  assert.deepEqual(json.hits[0]?.via, ['keyword', 'vector']);

  r = await refs('doctor');
  assert.match(r.stdout, /^ok {4}ollama {3}version 0\.0\.0-fake/m);
  assert.match(r.stdout, /^ok {4}models {3}embed: fake-embed$/m);
  assert.match(r.stdout, /^ok {4}vectors {2}5 of 5 sections embedded with fake-embed$/m);
  assert.match(r.stdout, /^warn {2}inbox {4}0 waiting, 1 blocked, 0 duplicates/m);
  assert.match(r.stdout, /^ok {4}review {3}nothing waiting$/m);

  setOllamaHost(DEAD_OLLAMA);
  r = await refs('search', 'remove', 'stopped', 'containers');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^keyword only \(Ollama not reachable at http:\/\/127\.0\.0\.1:9\)\ns_0001:2 {2}Docker container basics > Containers/);
  const kw = JSON.parse((await refs('search', 'remove stopped containers', '--json')).stdout) as { mode: string; notice: string };
  assert.equal(kw.mode, 'keyword');
  assert.match(kw.notice, /not reachable/);

  const shot = write(t.work, 'shot.png', 'more png');
  r = await refs('add', shot);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /OCR.*Nothing was moved\. Start Ollama and run refs add again, or drop the file into .*inbox/);
  assert.ok(fs.existsSync(shot));
  r = await refs('doctor');
  assert.match(r.stdout, /^warn {2}ollama {3}Ollama is not reachable at http:\/\/127\.0\.0\.1:9/m);
});
