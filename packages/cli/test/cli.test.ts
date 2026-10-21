import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOCKER_MD, FAKE_GITHUB_TOKEN, setupEnv, write } from '../../core/test/helpers.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const t = setupEnv();

function refs(...args: string[]) {
  const r = spawnSync(process.execPath, [MAIN, ...args], { env: t.env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('end to end: doctor, add, search, open, blocked add, allow', () => {
  let r = refs('doctor');
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /warn {2}library .*does not exist yet/);

  const src = write(t.work, 'docker-notes.md', DOCKER_MD);
  r = refs('add', src, '--tags', 'docker');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /added s_0001 "Docker basics" \(md, 4 sections\)/);
  assert.match(r.stdout, /tags: docker/);

  r = refs('search', 'remove', 'stopped', 'containers');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^s_0001:2 {2}Docker basics > Containers {2}\[docker\]/m);

  assert.match(r.stdout, /^keyword only \(no embeddings from fake-embed yet; run refs index\)$/m);
  assert.match(r.stdout, /keyword only, \d+ ms/);

  r = refs('search', 'prune', '--json');
  const result = JSON.parse(r.stdout) as { mode: string; notice: string; hits: { id: string; section: number }[] };
  assert.equal(result.mode, 'keyword');
  assert.match(result.notice, /no embeddings/);
  assert.ok(result.hits.length >= 2);
  assert.equal(result.hits[0]?.id, 's_0001');

  r = refs('open', 's_0001', '--section', '4');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /section 4 of 4: Volumes/);
  assert.match(r.stdout, /docker volume inspect/);
  const usage = fs.readFileSync(path.join(t.env.LOCALAPPDATA!, 'refs', 'usage.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(
    usage.map((l) => JSON.parse(l) as Record<string, unknown>).map(({ event, id, section, via }) => ({ event, id, section, via })),
    [{ event: 'open', id: 's_0001', section: 4, via: 'cli' }],
  );
  assert.match(refs('open', 's_0001', '--section', '9').stderr, /sections 1 to 4/);

  const secret = write(t.work, 'tips.md', `# Tips\n\ntoken=${FAKE_GITHUB_TOKEN}\n`);
  r = refs('add', secret);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /blocked:.*\n {2}1\. line 3 {2}github-token {2}ghp_\*\*\*\*/);
  assert.ok(!r.stderr.includes(FAKE_GITHUB_TOKEN), 'the secret itself is never printed');
  assert.equal(refs('allow', secret, '--finding', '1').code, 0);
  assert.equal(refs('add', secret).code, 0);

  r = refs('doctor');
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /^ok {4}files {4}manifest matches the library files$/m);
  assert.match(r.stdout, /^ok {4}index {4}2 sheets/m);
  assert.match(r.stdout, /\n0 failed/);
});

test('usage errors exit non-zero with a message; suggest says clearly that Ollama is down', () => {
  assert.match(refs('frobnicate').stderr, /unknown command/);
  const suggest = refs('suggest', t.work);
  assert.equal(suggest.code, 1);
  assert.match(suggest.stderr, /refs suggest needs the chat model, and Ollama is not reachable at http:\/\/127\.0\.0\.1:9 \(is it running\?\)\. Start Ollama and try again\./);
  assert.match(refs('approve').stderr, /usage: refs approve <id>/);
  assert.match(refs('review', 's_0001').stderr, /--accept/);
  assert.match(refs('search', '--bogus').stderr, /Unknown option/);
  assert.match(refs('open', 's_0001', '--section', 'two').stderr, /positive whole number/);
  assert.equal(refs('open', 's_9999').code, 1);
});
