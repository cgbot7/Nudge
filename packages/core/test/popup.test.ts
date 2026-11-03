import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { runDoctor } from '../src/doctor.ts';
import { applyInstall, installStatus, parseRegQuery, planInstall, planPopupLogon, popupCommand, realSystem, repoPaths, runKey } from '../src/install.ts';
import { pingSidecar } from '../src/sidecarprobe.ts';
import { fakeSystem, setupEnv, write, type TestEnv } from './helpers.ts';

let t: TestEnv;
beforeEach(() => {
  t = setupEnv();
});

const buildPopup = () => write(path.dirname(t.env.NUDGE_POPUP_EXE!), 'nudge-popup.exe', 'stand-in');
const RUN = 'nudge popup test';

test('the sandbox never points at the real Run key, value name or popup', () => {
  assert.match(runKey(), /^HKCU\\Software\\nudge-test\\nudge-test-/);
  assert.equal(repoPaths().popup, t.env.NUDGE_POPUP_EXE);
  assert.ok(repoPaths().popup.startsWith(t.root));
});

test('logon start: skipped until the popup is built, then added once, with quoted paths', () => {
  const { sys, calls } = fakeSystem(t.env.NUDGE_DOCUMENTS_DIR!);
  let plan = planPopupLogon(sys);
  assert.equal(plan.action, 'skip');
  assert.match(plan.note!, /not built yet.*npm run popup:build/);
  applyInstall(planInstall(sys), sys);
  assert.deepEqual(calls.writeRunValue, [], 'nothing registered for a popup that does not exist');

  buildPopup();
  plan = planPopupLogon(sys);
  assert.equal(plan.action, 'create');
  assert.equal(plan.before, null);
  assert.equal(plan.after, `"${t.env.NUDGE_POPUP_EXE}" --node "${process.execPath}" --sidecar "${repoPaths().sidecar}"`);
  assert.equal(plan.backup, null, 'nothing to back up');
  const done = applyInstall(planInstall(sys), sys);
  assert.deepEqual(calls.writeRunValue, [[RUN, plan.after]]);
  assert.ok(done.some((l) => l.startsWith(`added "${RUN}" in ${runKey()}`)));
  assert.deepEqual(installStatus(sys).popupLogon, { value: plan.after, current: true });

  const again = planInstall(sys);
  assert.equal(again.popup.action, 'none');
  applyInstall(again, sys);
  assert.equal(calls.writeRunValue.length, 1, 're-running leaves the entry unchanged');
});

test('logon start: an existing different value is backed up (reg export) before it is replaced', () => {
  buildPopup();
  const old = '"D:\\old checkout\\nudge-popup.exe"';
  const { sys, calls } = fakeSystem(t.env.NUDGE_DOCUMENTS_DIR!, { run: { [RUN]: old, 'Other App': 'other.exe' } });
  const plan = planPopupLogon(sys, new Date(2026, 9, 21, 9, 5, 7));
  assert.equal(plan.action, 'update');
  assert.equal(plan.before, old);
  assert.equal(plan.backup, path.join(t.env.APPDATA!, 'nudge', 'backups', 'run-key.reg.nudge-backup-20261021-090507'));
  applyInstall({ ...planInstall(sys), popup: plan }, sys);
  assert.deepEqual(calls.exportRunKey, [plan.backup]);
  assert.match(fs.readFileSync(plan.backup!, 'utf8'), /"nudge popup test"="\\"D:\\\\old checkout/);
  assert.deepEqual(calls.writeRunValue, [[RUN, popupCommand()]]);
  assert.equal(sys.readRunValue('Other App'), 'other.exe', 'other startup items are untouched');
  // Same command in another case is the same path on Windows.
  const { sys: sys2 } = fakeSystem(t.env.NUDGE_DOCUMENTS_DIR!, { run: { [RUN]: popupCommand().toUpperCase() } });
  assert.equal(planPopupLogon(sys2).action, 'none');
});

test('reg query output is parsed by value name, including names and data with spaces', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    OneDrive    REG_SZ    "C:\\x\\OneDrive.exe" /background\r\n    nudge popup    REG_SZ    "C:\\P & Q\\nudge-popup.exe" --node "C:\\n\\node.exe"\r\n    Empty    REG_SZ\r\n\r\n';
  assert.equal(parseRegQuery(out, 'nudge popup'), '"C:\\P & Q\\nudge-popup.exe" --node "C:\\n\\node.exe"');
  assert.equal(parseRegQuery(out, 'NUDGE POPUP'), '"C:\\P & Q\\nudge-popup.exe" --node "C:\\n\\node.exe"');
  assert.equal(parseRegQuery(out, 'Empty'), '');
  assert.equal(parseRegQuery(out, 'nudge'), null);
});

test('the real reg.exe calls round-trip quotes, spaces and "&" (scratch key, never the Run key)', () => {
  const key = runKey();
  after(() => {
    spawnSync('reg.exe', ['delete', key, '/f'], { windowsHide: true });
  });
  const sys = realSystem();
  assert.equal(sys.readRunValue(RUN), null);
  const value = `"C:\\Program Files\\P & Q\\nudge-popup.exe" --node "C:\\n o\\node.exe" --sidecar "C:\\a&b\\main.ts"`;
  sys.writeRunValue(RUN, value);
  assert.equal(sys.readRunValue(RUN), value);
  const backup = path.join(t.root, 'backups', 'run.reg');
  sys.exportRunKey(backup);
  assert.match(fs.readFileSync(backup).toString('utf16le'), /"nudge popup test"="\\"C:\\\\Program Files\\\\P & Q\\\\nudge-popup\.exe\\"/);
});

test('the sidecar answers a ping; a broken one is reported', async () => {
  const ok = await pingSidecar(process.execPath, repoPaths().sidecar);
  assert.equal(ok.ok, true, ok.error);
  const broken = write(t.work, 'broken.ts', 'process.stdout.write("hello\\n");');
  const bad = await pingSidecar(process.execPath, broken, { timeoutMs: 5000 });
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /not JSON/);
  const silent = write(t.work, 'silent.ts', 'process.exit(3);');
  assert.match((await pingSidecar(process.execPath, silent)).error!, /exited \(code 3\)/);
});

test('doctor: popup built, logon start registered, hotkey valid, sidecar answers', async () => {
  const { sys } = fakeSystem(t.env.NUDGE_DOCUMENTS_DIR!);
  const checks = async () => Object.fromEntries((await runDoctor(sys)).filter((c) => ['popup', 'logon', 'hotkey', 'sidecar'].includes(c.name)).map((c) => [c.name, `${c.status} ${c.detail}`]));
  let c = await checks();
  assert.match(c.popup!, /^warn not built .*npm run popup:build/);
  assert.match(c.logon!, /^warn the popup does not start at logon/);
  assert.equal(c.hotkey, 'ok Ctrl+Alt+Space');
  assert.match(c.sidecar!, /^ok starts and answers ping in \d+ ms$/);

  buildPopup();
  applyInstall(planInstall(sys), sys);
  c = await checks();
  assert.match(c.popup!, /^ok built: /);
  assert.equal(c.logon, `ok "${RUN}" in ${runKey()} starts this popup`);

  const file = path.join(t.env.APPDATA!, 'nudge', 'config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), hotkey: 'alt+ctrl+space' }));
  assert.equal((await checks()).hotkey, 'ok alt+ctrl+space (as Ctrl+Alt+Space)');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), hotkey: 'Space' }));
  assert.match((await checks()).hotkey!, /^fail config\.json "hotkey": "Space" needs Ctrl, Alt, Shift or Super.*falls back to Ctrl\+Alt\+Space/);

  const { sys: moved } = fakeSystem(t.env.NUDGE_DOCUMENTS_DIR!, { run: { [RUN]: '"D:\\elsewhere\\nudge-popup.exe"' } });
  const logon = (await runDoctor(moved)).find((x) => x.name === 'logon')!;
  assert.match(`${logon.status} ${logon.detail}`, /^warn .* starts something else \("D:\\elsewhere/);
});
