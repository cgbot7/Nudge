import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAgents, backupName, planAgents, type AgentPlan, type AgentTargets } from './agents.ts';
import { configDir } from './paths.ts';
import { RefsError } from './util.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** Where this checkout keeps the pieces refs install points at. */
export function repoPaths() {
  return {
    hook: path.join(REPO, 'shell', 'refs-hook.ps1'),
    cli: path.join(REPO, 'packages', 'cli', 'src', 'main.ts'),
    mcp: path.join(REPO, 'packages', 'mcp', 'src', 'server.ts'),
    bin: path.join(REPO, 'bin'),
    sidecar: path.join(REPO, 'packages', 'sidecar', 'src', 'main.ts'),
    /** The built popup; REFS_POPUP_EXE points tests at a stand-in. */
    popup: process.env.REFS_POPUP_EXE || path.join(REPO, 'apps', 'popup', 'src-tauri', 'target', 'release', 'refs-popup.exe'),
  };
}

/** What the agent registrations run: this Node and this checkout's CLI and MCP server. */
export function agentTargets(node = process.execPath): AgentTargets {
  const { cli, mcp } = repoPaths();
  return { node, cli, server: mcp };
}

export const HOOK_BEGIN = '# >>> refs hook (managed by refs install) >>>';
export const HOOK_END = '# <<< refs hook <<<';

/** HKCU Run key that starts the popup at logon. Overridable so tests use a scratch key. */
export function runKey(): string {
  return process.env.REFS_RUN_KEY || 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
}

export function runValueName(): string {
  return process.env.REFS_RUN_VALUE_NAME || 'refs popup';
}

/** Overridable so tests never see or touch the real scheduled task. */
export function taskName(): string {
  return process.env.REFS_TASK_NAME || 'refs index';
}

export interface SystemInfo {
  /** The user's Documents folder (may be redirected to OneDrive). */
  documents: string;
  /** Effective Windows PowerShell 5.1 policy, ignoring the Process scope. */
  executionPolicy: string;
  pwshInstalled: boolean;
  /** Raw HKCU\Environment Path, unexpanded, and its registry kind. */
  userPath: { value: string; kind: string } | null;
}

/** Everything refs install and refs doctor do to the machine goes through here. */
export interface SystemOps {
  info(): SystemInfo;
  writeUserPath(value: string): void;
  taskExists(name: string): boolean;
  /** The registered task's XML, or null when there is none. */
  queryTaskXml(name: string): string | null;
  createTask(name: string, xml: string): void;
  /** claude.exe on PATH, or null. */
  findClaude(): string | null;
  /** Run claude.exe with these arguments, no shell. Throws on failure. */
  runClaude(claude: string, args: string[]): void;
  /** A value under runKey(), or null when it is not there. */
  readRunValue(name: string): string | null;
  writeRunValue(name: string, value: string): void;
  /** reg export of runKey() to a .reg file, a backup you can double-click to restore. */
  exportRunKey(file: string): void;
}

const INFO_SCRIPT = `
$ErrorActionPreference = 'Stop'
$k = Get-Item -LiteralPath 'HKCU:\\Environment'
$p = $k.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')
$kind = $null
if ($null -ne $p) { $kind = $k.GetValueKind('Path').ToString() }
$policy = 'Restricted'
foreach ($scope in 'MachinePolicy', 'UserPolicy', 'CurrentUser', 'LocalMachine') {
  $v = (Get-ExecutionPolicy -Scope $scope).ToString()
  if ($v -ne 'Undefined') { $policy = $v; break }
}
[pscustomobject]@{
  documents = [Environment]::GetFolderPath('MyDocuments')
  executionPolicy = $policy
  pwshInstalled = [bool](Get-Command pwsh.exe -ErrorAction SilentlyContinue)
  path = $p
  kind = $kind
} | ConvertTo-Json -Compress
`;

// New-ItemProperty -PropertyType ExpandString keeps %USERPROFILE% style entries working;
// [Environment]::SetEnvironmentVariable would store REG_SZ. The broadcast lets Explorer
// (and so new terminals) see the change without signing out.
const WRITE_PATH_SCRIPT = `
$ErrorActionPreference = 'Stop'
New-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name Path -Value $env:REFS_NEW_PATH -PropertyType ExpandString -Force | Out-Null
Add-Type -Namespace RefsInstall -Name Win32 -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
$r = [UIntPtr]::Zero
[void][RefsInstall.Win32]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
`;

function powershell(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

export function realSystem(): SystemOps {
  return {
    info() {
      const r = powershell(INFO_SCRIPT);
      if (r.error || r.status !== 0) throw new RefsError(`could not query PowerShell: ${r.error?.message ?? r.stderr.trim()}`);
      const raw = JSON.parse(r.stdout) as { documents: string; executionPolicy: string; pwshInstalled: boolean; path: string | null; kind: string | null };
      return {
        documents: process.env.REFS_DOCUMENTS_DIR || raw.documents,
        executionPolicy: raw.executionPolicy,
        pwshInstalled: raw.pwshInstalled,
        userPath: raw.path === null ? null : { value: raw.path, kind: raw.kind ?? 'String' },
      };
    },
    writeUserPath(value) {
      const r = powershell(WRITE_PATH_SCRIPT, { REFS_NEW_PATH: value });
      if (r.error || r.status !== 0) throw new RefsError(`could not update the user PATH: ${r.error?.message ?? r.stderr.trim()}`);
    },
    taskExists(name) {
      const r = spawnSync('schtasks.exe', ['/Query', '/TN', name], { encoding: 'utf8', windowsHide: true });
      return r.status === 0;
    },
    queryTaskXml(name) {
      const r = spawnSync('schtasks.exe', ['/Query', '/XML', '/TN', name], { encoding: 'utf8', windowsHide: true });
      return r.status === 0 ? r.stdout : null;
    },
    findClaude() {
      const r = spawnSync('where.exe', ['claude.exe'], { encoding: 'utf8', windowsHide: true });
      const first = r.status === 0 ? r.stdout.split(/\r?\n/).find((l) => l.trim()) : undefined;
      return first ? first.trim() : null;
    },
    runClaude(claude, args) {
      // A sandboxed home (tests) must never reach the real ~/.claude.json through claude.exe.
      if (process.env.REFS_HOME_DIR) throw new RefsError('refusing to run claude while REFS_HOME_DIR points at a sandbox home.');
      const r = spawnSync(claude, args, { encoding: 'utf8', windowsHide: true });
      if (r.error || r.status !== 0) throw new RefsError(`claude ${args.slice(0, 2).join(' ')} failed: ${r.error?.message ?? (r.stderr || r.stdout).trim()}`);
    },
    readRunValue(name) {
      const r = spawnSync('reg.exe', ['query', runKey(), '/v', name], { encoding: 'utf8', windowsHide: true });
      return r.status === 0 ? parseRegQuery(r.stdout, name) : null;
    },
    writeRunValue(name, value) {
      const r = spawnSync('reg.exe', ['add', runKey(), '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { encoding: 'utf8', windowsHide: true });
      if (r.error || r.status !== 0) throw new RefsError(`could not write "${name}" in ${runKey()}: ${r.error?.message ?? (r.stderr || r.stdout).trim()}`);
    },
    exportRunKey(file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const r = spawnSync('reg.exe', ['export', runKey(), file, '/y'], { encoding: 'utf8', windowsHide: true });
      if (r.error || r.status !== 0) throw new RefsError(`could not back up ${runKey()}: ${r.error?.message ?? (r.stderr || r.stdout).trim()}`);
    },
    createTask(name, xml) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-task-'));
      const file = path.join(dir, 'task.xml');
      try {
        fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
        const r = spawnSync('schtasks.exe', ['/Create', '/TN', name, '/XML', file, '/F'], { encoding: 'utf8', windowsHide: true });
        if (r.error || r.status !== 0) throw new RefsError(`could not register the scheduled task: ${r.error?.message ?? (r.stderr || r.stdout).trim()}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** The data of value `name` in reg query output ("    <name>    REG_SZ    <data>"). */
export function parseRegQuery(stdout: string, name: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^ {4}(.+?) {4}(REG_\w+)(?: {4}(.*))?$/.exec(line);
    if (m && m[1]!.toLowerCase() === name.toLowerCase()) return m[3] ?? '';
  }
  return null;
}

/** What the Run value holds: the popup, with the Node and sidecar script it starts. */
export function popupCommand(exe = repoPaths().popup, node = process.execPath, sidecar = repoPaths().sidecar): string {
  return `"${exe}" --node "${node}" --sidecar "${sidecar}"`;
}

export interface PopupPlan {
  key: string;
  name: string;
  exe: string;
  /** skip: the popup is not built yet. none: the value already holds this command. */
  action: 'create' | 'update' | 'none' | 'skip';
  note?: string;
  before: string | null;
  after: string;
  /** .reg export of the Run key, written before an existing value is replaced. */
  backup: string | null;
}

/** Start the popup at logon through a value in the HKCU Run key (Task Manager lists it under Startup apps). */
export function planPopupLogon(sys: SystemOps, now = new Date()): PopupPlan {
  const { popup } = repoPaths();
  const name = runValueName();
  const before = sys.readRunValue(name);
  const after = popupCommand();
  const base = { key: runKey(), name, exe: popup, before, after, backup: null };
  if (!fs.existsSync(popup)) return { ...base, action: 'skip', note: `the popup is not built yet (${popup}); run npm run popup:build, then refs install again` };
  // Windows paths compare case-insensitively.
  if (before !== null && before.toLowerCase() === after.toLowerCase()) return { ...base, action: 'none' };
  if (before === null) return { ...base, action: 'create' };
  return { ...base, action: 'update', backup: backupName(path.join(configDir(), 'backups', 'run-key.reg'), now) };
}

/** CurrentUserAllHosts profiles, so the hook also loads in editor terminals. */
export function profileFiles(documents: string): { host: string; file: string }[] {
  return [
    { host: 'PowerShell 7', file: path.join(documents, 'PowerShell', 'profile.ps1') },
    { host: 'Windows PowerShell 5.1', file: path.join(documents, 'WindowsPowerShell', 'profile.ps1') },
  ];
}

export function hookBlock(hookPath: string, eol = '\r\n'): string {
  const q = hookPath.replace(/'/g, "''");
  return [HOOK_BEGIN, `if (Test-Path -LiteralPath '${q}') { . '${q}' }`, HOOK_END].join(eol);
}

export type BlockAction = 'create' | 'append' | 'update' | 'none';

/** Insert or replace the marked block; everything outside the markers is kept as is. */
export function upsertHookBlock(content: string, hookPath: string): { content: string; action: Exclude<BlockAction, 'create'> } {
  const eol = !content || content.includes('\r\n') ? '\r\n' : '\n';
  const block = hookBlock(hookPath, eol);
  const start = content.indexOf(HOOK_BEGIN);
  const end = start >= 0 ? content.indexOf(HOOK_END, start) : -1;
  if (start >= 0 && end >= 0) {
    const next = content.slice(0, start) + block + content.slice(end + HOOK_END.length);
    return { content: next, action: next === content ? 'none' : 'update' };
  }
  const lead = content ? (content.endsWith('\n') ? eol : eol + eol) : '';
  return { content: content + lead + block + eol, action: 'append' };
}

type Encoding = 'utf8bom' | 'utf8' | 'utf16le';

function decodeProfile(buf: Buffer): { text: string; encoding: Encoding } {
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le' };
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8bom' };
  return { text: buf.toString('utf8'), encoding: 'utf8' };
}

/** Keep the profile's encoding; a new profile gets UTF-8 with BOM, which 5.1 reads correctly. */
function encodeProfile(text: string, encoding: Encoding): Buffer {
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (encoding === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  return Buffer.from(text, 'utf8');
}

/** PATH value with `dir` appended, or null when it is already there. */
export function addPathEntry(current: string, dir: string): string | null {
  const norm = (p: string) => p.trim().replace(/[\\/]+$/, '').toLowerCase();
  const parts = current.split(';').filter((p) => p.trim());
  if (parts.some((p) => norm(p) === norm(dir))) return null;
  return [...parts, dir].join(';');
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface TaskSpec {
  userId: string;
  command: string;
  arguments: string;
}

/** At logon, then every 30 minutes; conhost --headless keeps the console window hidden. */
export function taskSpec(cli = repoPaths().cli, node = process.execPath): TaskSpec {
  const domain = process.env.USERDOMAIN;
  const user = process.env.USERNAME ?? os.userInfo().username;
  return {
    userId: domain ? `${domain}\\${user}` : user,
    command: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe'),
    arguments: `--headless "${node}" "${cli}" index --scheduled`,
  };
}

export function taskXml(spec: TaskSpec): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>refs: sync the cheat sheet library, scan projects and refresh the terminal hook cache</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(spec.userId)}</UserId>
      <Repetition>
        <Interval>PT30M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(spec.userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(spec.command)}</Command>
      <Arguments>${xmlEscape(spec.arguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export interface ProfileChange {
  host: string;
  file: string;
  action: BlockAction;
  /** Backup written before changing an existing profile (only if none exists yet). */
  backup: string | null;
  content: Buffer;
}

const xmlUnescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * The parts of a task definition refs cares about; equal parts mean the task needs no change.
 * Windows exports the task with entities decoded, the user as a SID and the default
 * RunLevel left out, so the user is not compared and a missing RunLevel is LeastPrivilege.
 */
export function taskSignature(xml: string): string {
  const pick = (tag: string) => xmlUnescape(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1]?.trim() ?? '');
  return [pick('Command'), pick('Arguments'), pick('Interval'), pick('RunLevel') || 'LeastPrivilege'].map((v) => v.toLowerCase()).join('|');
}

export interface InstallPlan {
  profiles: ProfileChange[];
  block: string;
  /** current: registered with the same command, arguments, schedule and user, so it is left alone. */
  task: { name: string; exists: boolean; current: boolean; spec: TaskSpec; xml: string };
  agents: AgentPlan;
  popup: PopupPlan;
  path: { dir: string; kind: string; before: string | null; after: string | null };
  warnings: string[];
}

/** Work out every change refs install would make, without making any. */
export function planInstall(sys: SystemOps): InstallPlan {
  const info = sys.info();
  const { hook, bin } = repoPaths();
  const profiles = profileFiles(info.documents).map(({ host, file }): ProfileChange => {
    if (!fs.existsSync(file)) {
      return { host, file, action: 'create', backup: null, content: encodeProfile(hookBlock(hook) + '\r\n', 'utf8bom') };
    }
    const { text, encoding } = decodeProfile(fs.readFileSync(file));
    const next = upsertHookBlock(text, hook);
    const backup = `${file}.refs-backup`;
    return { host, file, action: next.action, backup: next.action !== 'none' && !fs.existsSync(backup) ? backup : null, content: encodeProfile(next.content, encoding) };
  });

  const name = taskName();
  const spec = taskSpec();
  const xml = taskXml(spec);
  const existing = sys.queryTaskXml(name);
  const before = info.userPath?.value ?? null;
  const after = addPathEntry(before ?? '', bin);

  const warnings: string[] = [];
  if (!/^(RemoteSigned|Unrestricted|Bypass)$/i.test(info.executionPolicy)) {
    warnings.push(
      `Windows PowerShell 5.1 execution policy is ${info.executionPolicy}, so profiles do not load there and the hook will not run in 5.1. ` +
        `PowerShell 7 defaults to RemoteSigned. To use the hook in 5.1, run this yourself: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`,
    );
  }
  if (!info.pwshInstalled) warnings.push('PowerShell 7 (pwsh) is not installed; its profile is written anyway and takes effect once you install it.');
  return {
    profiles,
    block: hookBlock(hook),
    task: { name, exists: existing !== null, current: existing !== null && taskSignature(existing) === taskSignature(xml), spec, xml },
    agents: planAgents(agentTargets(), sys.findClaude()),
    popup: planPopupLogon(sys),
    path: { dir: bin, kind: info.userPath?.kind ?? 'ExpandString', before, after },
    warnings,
  };
}

/** Apply a plan. Every step is idempotent, so running install again is safe. */
export function applyInstall(plan: InstallPlan, sys: SystemOps): string[] {
  const done: string[] = [];
  for (const p of plan.profiles) {
    if (p.action === 'none') continue;
    if (p.backup) fs.copyFileSync(p.file, p.backup);
    fs.mkdirSync(path.dirname(p.file), { recursive: true });
    fs.writeFileSync(p.file, p.content);
    done.push(`${p.action === 'create' ? 'created' : p.action === 'append' ? 'added the hook to' : 'updated the hook in'} ${p.file}`);
  }
  if (!plan.task.current) {
    sys.createTask(plan.task.name, plan.task.xml);
    done.push(`${plan.task.exists ? 'replaced' : 'registered'} scheduled task "${plan.task.name}"`);
  }
  if (plan.path.after !== null) {
    sys.writeUserPath(plan.path.after);
    done.push(`added ${plan.path.dir} to your user PATH (new terminals see it)`);
  }
  done.push(...applyAgents(plan.agents, (claude, args) => sys.runClaude(claude, args)));
  const p = plan.popup;
  if (p.action === 'create' || p.action === 'update') {
    if (p.backup) sys.exportRunKey(p.backup);
    sys.writeRunValue(p.name, p.after);
    done.push(`${p.action === 'create' ? 'added' : 'updated'} "${p.name}" in ${p.key}: the popup starts at your next logon${p.backup ? `; backup ${p.backup}` : ''}`);
  }
  return done;
}

export interface InstallStatus {
  /** Profiles that contain the marked block. */
  hookIn: string[];
  scheduled: boolean;
  /** The popup's Run value, and whether it starts this checkout's popup. */
  popupLogon: { value: string | null; current: boolean };
  info: SystemInfo;
}

export function installStatus(sys: SystemOps): InstallStatus {
  const info = sys.info();
  const hookIn = profileFiles(info.documents)
    .filter(({ file }) => fs.existsSync(file) && decodeProfile(fs.readFileSync(file)).text.includes(HOOK_BEGIN))
    .map(({ file }) => file);
  const value = sys.readRunValue(runValueName());
  const popupLogon = { value, current: value !== null && value.toLowerCase() === popupCommand().toLowerCase() };
  return { hookIn, scheduled: sys.taskExists(taskName()), popupLogon, info };
}
