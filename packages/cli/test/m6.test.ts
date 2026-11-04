import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setupEnv, write, type TestEnv } from '../../core/test/helpers.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
let t: TestEnv;
let origin: string;

function nudge(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env: t.env, cwd: t.work });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

before(() => {
  t = setupEnv();
  const memory = path.join(t.env.NUDGE_HOME_DIR!, '.claude', 'projects', 'C--Projects-App', 'memory');
  origin = write(memory, 'ssh-keys.md', '---\nname: ssh-keys\ndescription: Make and load SSH keys\n---\n\n```bash\nssh-keygen -t ed25519\n```\n');
  write(memory, 'MEMORY.md', '- [SSH keys](ssh-keys.md)\n');
});

test('nudge harvest: dry run, copy, review shows the origin, reject, doctor', async () => {
  let r = await nudge(['harvest', '--source', 'nope']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown source "nope"\. Sources: claude-memory, claude-chats, cursor-chats, exports$/m);

  r = await nudge(['harvest', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /would copy: .*ssh-keys\.md \(claude-memory\)/);
  assert.match(r.stdout, /harvest \(dry run, nothing written\): 1 to copy, 0 to update, 0 unchanged; sources: claude-memory 1, claude-chats 0, cursor-chats not found, exports not found$/m);
  assert.equal(fs.existsSync(t.library), false, 'a dry run does not even create the library');

  r = await nudge(['harvest']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /harvest: copied C--Projects-App\/memory\/ssh-keys\.md as s_0001 "Ssh keys", pending \(tags wait for Ollama\)/);
  assert.match(r.stdout, /confirm or reject them with nudge review/);
  assert.match(r.stderr, /Ollama is not available/);

  r = await nudge(['harvest']);
  assert.match(r.stdout, /harvest: 0 copied, 0 updated, 1 unchanged/);

  r = await nudge(['review', '--list']);
  assert.match(r.stdout, /s_0001 {2}"Ssh keys"/);
  assert.match(r.stdout, /harvested from .*ssh-keys\.md \(claude-memory\)/);

  r = await nudge(['review', '--reject']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /nudge review <id> --reject/);

  r = await nudge(['review', 's_0001', '--reject']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /rejected s_0001 "Ssh keys"; nudge harvest will not read it again:/);
  assert.ok(fs.existsSync(origin));

  r = await nudge(['harvest']);
  assert.match(r.stdout, /0 copied, 0 updated, 0 unchanged, 1 rejected before/);

  r = await nudge(['doctor']);
  assert.match(r.stdout, /harvest.*off in nudge index .*; 0 copied, 1 rejected/);
  assert.match(r.stdout, /harvest.*Claude Code memory: 1 notes in /);
  assert.doesNotMatch(r.stdout, /Cursor plans/);
  assert.match(r.stdout, /harvest.*Cursor chats: .* not found; skipped/);
  assert.match(r.stdout, /harvest.*chats since \d{4}-\d{2}-\d{2}: 0 read, 0 drafts written/);
});

test('a scheduled nudge index logs what the harvest did', async () => {
  const file = path.join(t.env.APPDATA!, 'nudge', 'config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), harvest: { enabled: true } }));
  write(path.dirname(origin), 'git-tips.md', '# Git tips\n\n```bash\ngit switch -c topic\n```\n');
  const log = path.join(t.env.LOCALAPPDATA!, 'nudge', 'logs', 'index.log');

  let r = await nudge(['index', '--scheduled']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1)!, /ok: \d+ sheets, \d+ updated, \d+ projects; harvest: 1 copied$/);

  r = await nudge(['index', '--scheduled']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1)!, /; harvest: nothing new$/);
});
