import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { runDoctor } from '../src/doctor.ts';
import {
  HOOK_BEGIN,
  HOOK_END,
  addPathEntry,
  applyInstall,
  hookBlock,
  installStatus,
  planInstall,
  repoPaths,
  taskSpec,
  taskXml,
  upsertHookBlock,
} from '../src/install.ts';
import { fakeSystem, setupEnv, type TestEnv } from './helpers.ts';

let t: TestEnv;
let docs: string;
beforeEach(() => {
  t = setupEnv();
  docs = t.env.REFS_DOCUMENTS_DIR!;
});

const profile51 = () => path.join(docs, 'WindowsPowerShell', 'profile.ps1');
const profile7 = () => path.join(docs, 'PowerShell', 'profile.ps1');

test('the profile block is appended once, kept current, and leaves the rest alone', () => {
  const hook = 'C:\\Tools & Stuff\\it\'s\\refs-hook.ps1';
  const original = 'Set-Alias ll Get-ChildItem\r\n';
  const first = upsertHookBlock(original, hook);
  assert.equal(first.action, 'append');
  assert.ok(first.content.startsWith(original));
  assert.match(first.content, /\. 'C:\\Tools & Stuff\\it''s\\refs-hook\.ps1'/, 'single quotes are doubled');
  assert.equal(upsertHookBlock(first.content, hook).action, 'none');

  const moved = upsertHookBlock(first.content + 'Write-Host after\r\n', 'D:\\refs\\shell\\refs-hook.ps1');
  assert.equal(moved.action, 'update');
  assert.ok(moved.content.startsWith(original) && moved.content.endsWith('Write-Host after\r\n'));
  assert.equal(moved.content.split(HOOK_BEGIN).length, 2, 'exactly one block');
  assert.ok(moved.content.includes('D:\\refs\\shell\\refs-hook.ps1') && !moved.content.includes('Tools & Stuff'));
  assert.equal(upsertHookBlock('', hook).content, hookBlock(hook) + '\r\n');
});

test('PATH entry is added once, ignoring case and trailing slashes', () => {
  assert.equal(addPathEntry('C:\\a;C:\\b;', 'C:\\Refs\\bin'), 'C:\\a;C:\\b;C:\\Refs\\bin');
  assert.equal(addPathEntry('C:\\a;c:\\refs\\BIN\\', 'C:\\Refs\\bin'), null);
  assert.equal(addPathEntry('', 'C:\\Refs\\bin'), 'C:\\Refs\\bin');
});

test('task XML: logon trigger repeating every 30 minutes, hidden through conhost, escaped paths', () => {
  const xml = taskXml(taskSpec('C:\\P & Q\\main.ts', 'C:\\Program Files\\nodejs\\node.exe'));
  assert.match(xml, /<LogonTrigger>[\s\S]*<Interval>PT30M<\/Interval>/);
  assert.match(xml, /<Command>[^<]*conhost\.exe<\/Command>/);
  assert.match(xml, /<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node\.exe&quot; &quot;C:\\P &amp; Q\\main\.ts&quot; index --scheduled<\/Arguments>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
});

test('install plans, applies and is idempotent; existing profiles are backed up and keep their encoding', () => {
  fs.mkdirSync(path.dirname(profile51()), { recursive: true });
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# mine\r\n', 'utf16le')]);
  fs.writeFileSync(profile51(), utf16);
  const { sys, calls } = fakeSystem(docs, { policy: 'Restricted', pwsh: false });

  const plan = planInstall(sys);
  assert.deepEqual(plan.profiles.map((p) => [p.host, p.action]), [['PowerShell 7', 'create'], ['Windows PowerShell 5.1', 'append']]);
  assert.match(plan.warnings.join('\n'), /execution policy is Restricted/);
  assert.match(plan.warnings.join('\n'), /pwsh\) is not installed/);
  assert.equal(plan.path.after, `%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;${repoPaths().bin}`);

  applyInstall(plan, sys);
  const new7 = fs.readFileSync(profile7());
  assert.deepEqual([...new7.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'new profile is UTF-8 with BOM for 5.1');
  assert.ok(new7.toString('utf8').includes(HOOK_END));
  const updated51 = fs.readFileSync(profile51());
  assert.deepEqual([...updated51.subarray(0, 2)], [0xff, 0xfe], 'UTF-16 profile stays UTF-16');
  assert.match(updated51.subarray(2).toString('utf16le'), /^# mine\r\n\r\n# >>> refs hook/);
  assert.deepEqual(fs.readFileSync(`${profile51()}.refs-backup`), utf16);
  assert.equal(calls.createTask.length, 1);
  assert.equal(calls.writeUserPath.length, 1);

  const again = planInstall(sys);
  assert.deepEqual(again.profiles.map((p) => p.action), ['none', 'none']);
  assert.equal(again.path.after, null);
  assert.equal(again.task.exists, true);
  applyInstall(again, sys);
  assert.equal(calls.writeUserPath.length, 1, 'PATH is not touched twice');

  const status = installStatus(sys);
  assert.deepEqual(status.hookIn, [profile7(), profile51()]);
  assert.equal(status.scheduled, true);
});

test('doctor reports hook and schedule state', async () => {
  const { sys } = fakeSystem(docs, { policy: 'Restricted' });
  const find = async (name: string) => (await runDoctor(sys)).find((c) => c.name === name);
  assert.equal((await find('hook'))?.status, 'warn');
  assert.equal((await find('schedule'))?.status, 'warn');
  assert.equal((await find('cache'))?.status, 'warn');

  applyInstall(planInstall(sys), sys);
  assert.equal((await find('hook'))?.status, 'ok');
  assert.equal((await find('schedule'))?.status, 'ok');

  fs.mkdirSync(path.join(t.env.LOCALAPPDATA!, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(t.env.LOCALAPPDATA!, 'refs', 'hook-cache.json'), '{not json');
  assert.equal((await find('cache'))?.status, 'fail');
});
