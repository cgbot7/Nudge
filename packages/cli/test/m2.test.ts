import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireLock } from '../../core/src/lock.ts';
import { DOCKER_MD, setupEnv, write } from '../../core/test/helpers.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const HOOK = fileURLToPath(new URL('../../../shell/refs-hook.ps1', import.meta.url));
const t = setupEnv();
const root = path.join(t.root, 'Projects & Stuff');
const app = path.join(root, 'web app');

function refs(args: string[], cwd = t.work) {
  const r = spawnSync(process.execPath, [MAIN, ...args], { env: t.env, encoding: 'utf8', cwd });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Run a PowerShell 5.1 script with the hook dot-sourced, in the sandbox environment. */
function ps(script: string) {
  const full = `$ErrorActionPreference = 'Stop'\n. '${HOOK.replace(/'/g, "''")}'\n${script}`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', full], {
    env: t.env,
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout.replace(/\r\n/g, '\n'), stderr: r.stderr };
}

const q = (p: string) => `'${p.replace(/'/g, "''")}'`;

before(() => {
  write(app, 'package.json', JSON.stringify({ devDependencies: { playwright: '^1.50.0' } }));
  write(app, 'Dockerfile', 'FROM node:24\n');
  fs.mkdirSync(path.join(app, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(t.env.APPDATA!, 'refs', 'config.json'),
    JSON.stringify({ library: t.library.replace(/\\/g, '/'), roots: [root.replace(/\\/g, '/')] }),
  );
  assert.equal(refs(['add', write(t.work, 'docker-notes.md', DOCKER_MD), '--tags', 'docker']).code, 0);
  assert.equal(refs(['add', write(t.work, 'node.md', '# Node "npm" tips\n\nRun package scripts with npm run and check versions with node --version.\n'), '--tags', 'node']).code, 0);
});

test('refs index, refs for, refs search with stale, verify and learned', () => {
  let r = refs(['index']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /indexed: 2 sheets \(0 updated, 0 removed from the index\); 1 project scanned \(1 with tags\); hook cache written/);

  r = refs(['for', '.'], path.join(app, 'src', 'lib'));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^project: .*\/web app$/m);
  assert.match(r.stdout, /^tags: node, docker, playwright$/m);
  assert.match(r.stdout, /^docker\n {2}s_0001 {2}Docker basics$/m);
  assert.match(r.stdout, /^playwright\n {2}no sheets$/m);
  assert.match(r.stdout, /^gaps: playwright$/m);
  assert.match(r.stdout, /s_0001 {2}Docker basics {2}never used/);

  const json = JSON.parse(refs(['for', 'docker playwright', '--json']).stdout) as { tags: string[]; gaps: string[] };
  assert.deepEqual(json.tags, ['docker', 'playwright']);
  assert.deepEqual(json.gaps, ['playwright']);

  const manifestFile = path.join(t.library, 'manifest.json');
  const sheets = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { lastVerified: string }[];
  sheets[0]!.lastVerified = '2020-01-01';
  fs.writeFileSync(manifestFile, JSON.stringify(sheets, null, 2));
  r = refs(['search', 'containers']);
  assert.match(r.stdout, /^s_0001:\d+ .*\[docker\] \[stale\]$/m);
  r = refs(['verify', 's_0001']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /verified s_0001 "Docker basics": lastVerified \d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(refs(['search', 'containers']).stdout, /\[stale\]/);

  r = refs(['learned', 's_0001']);
  assert.match(r.stdout, /s_0001 "Docker basics" marked learned/);
  assert.doesNotMatch(refs(['for', 'docker']).stdout, /unused/);
  assert.match(refs(['learned', 's_0001', '--undo']).stdout, /not learned/);
  assert.match(refs(['verify', 's_9999']).stderr, /no sheet with id s_9999/);
});

test('refs scan and refs ignore-gap --project', () => {
  let r = refs(['scan'], path.join(app, 'src'));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^scanned .*\/web app\nrefs \[node, docker, playwright\] 2 sheets \| gap: playwright \| try: ".+" \| refs for \.$/m);

  r = refs(['ignore-gap', 'playwright', '--project'], app);
  assert.match(r.stdout, /gap playwright ignored in .*\/web app\./);
  assert.match(refs(['scan', app]).stdout, /^refs \[node, docker, playwright\] 2 sheets \| try:/m);
  assert.match(refs(['ignore-gap', 'playwright', '--project', '--undo'], app).stdout, /shown again/);
  assert.match(refs(['scan', t.work]).stderr, /not under a registered root/);
});

test('a scheduled index exits quietly when the lock is held', async () => {
  const lock = await acquireLock({ command: 'test' });
  try {
    const r = refs(['index', '--scheduled']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout + r.stderr, '');
  } finally {
    lock.release();
  }
});

test('refs install --dry-run shows the plan and changes nothing', () => {
  const r = refs(['install', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(path.join(t.env.REFS_DOCUMENTS_DIR!, 'PowerShell', 'profile.ps1')));
  assert.match(r.stdout, /Task Scheduler: register task "refs-test-/);
  assert.match(r.stdout, /conhost\.exe --headless .* index --scheduled/);
  assert.match(r.stdout, /dry run: nothing was changed/);
  assert.equal(fs.existsSync(t.env.REFS_DOCUMENTS_DIR!), false);
  assert.match(refs(['install']).stderr, /without confirmation/);
});

test('PowerShell hook: one line per project entry, rotation, subfolders silent', () => {
  // Earlier tests used s_0001; start from a clean usage history so both sheets rotate.
  fs.rmSync(path.join(t.env.LOCALAPPDATA!, 'refs', 'usage.jsonl'), { force: true });
  assert.equal(refs(['index']).code, 0);
  const r = ps(`
Set-Location -LiteralPath ${q(app)}; Invoke-RefsHook
Write-Host '--sub'
Set-Location -LiteralPath ${q(path.join(app, 'src', 'lib'))}; Invoke-RefsHook
Write-Host '--root'
Set-Location -LiteralPath ${q(root)}; Invoke-RefsHook
Write-Host '--again'
Set-Location -LiteralPath ${q(path.join(app, 'src'))}; Invoke-RefsHook
Write-Host '--prompt'
Set-Location -LiteralPath ${q(t.work)}; [void](prompt); Set-Location -LiteralPath ${q(app)}; $p = prompt
Write-Host "prompt=[$p]"
`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
  const line = (tryTitle: string) => `refs [node, docker, playwright] 2 sheets | gap: playwright | try: "${tryTitle}" | refs for .`;
  assert.equal(
    r.stdout,
    [line('Docker basics'), '--sub', '--root', '--again', line('Node "npm" tips'), '--prompt', line('Docker basics'), `prompt=[PS ${app}> ]`, ''].join('\n'),
  );
  const last = JSON.parse(fs.readFileSync(path.join(t.env.LOCALAPPDATA!, 'refs', 'last-project.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(last.path, app.replace(/\\/g, '/').replace(/^[A-Z]:/, (d) => d.toLowerCase()));
  assert.deepEqual(last.tags, ['node', 'docker', 'playwright']);
  assert.deepEqual(Object.values(last.rotation as object), [3]);
});

test('PowerShell hook: missing or corrupt cache prints nothing and never throws', () => {
  const cache = path.join(t.env.LOCALAPPDATA!, 'refs', 'hook-cache.json');
  const saved = fs.readFileSync(cache);
  try {
    fs.writeFileSync(cache, '{"version":1,"roots":["c:/x"],"projects":[\n{"key":"');
    let r = ps(`Set-Location -LiteralPath ${q(app)}; Invoke-RefsHook; Write-Host done`);
    assert.equal(r.stdout, 'done\n');
    assert.equal(r.stderr, '');
    fs.rmSync(cache);
    r = ps(`Set-Location -LiteralPath ${q(app)}; Invoke-RefsHook; Write-Host done`);
    assert.equal(r.stdout, 'done\n');
    assert.equal(r.stderr, '');
  } finally {
    fs.writeFileSync(cache, saved);
  }
});

test('PowerShell hook: an unknown project prints once and is scanned in the background', async () => {
  assert.equal(refs(['index']).code, 0);
  const fresh = path.join(root, 'new tool');
  write(fresh, 'go.mod', 'module tool\n');
  fs.mkdirSync(path.join(fresh, 'cmd'));
  const r = ps(`
Set-Location -LiteralPath ${q(fresh)}; Invoke-RefsHook
Set-Location -LiteralPath ${q(path.join(fresh, 'cmd'))}; Invoke-RefsHook
`);
  assert.equal(r.stdout, 'refs: new project, scanning\n');
  const cache = path.join(t.env.LOCALAPPDATA!, 'refs', 'hook-cache.json');
  const deadline = Date.now() + 20_000;
  while (!fs.readFileSync(cache, 'utf8').includes('/new tool"')) {
    assert.ok(Date.now() < deadline, 'the background refs scan did not add the project');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const after = ps(`Set-Location -LiteralPath ${q(fresh)}; Invoke-RefsHook`);
  assert.equal(after.stdout, 'refs [go] 0 sheets | gap: go | refs for .\n');
});
