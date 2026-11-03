import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NudgeError, decodeText, errorMessage } from './util.ts';

// Claude Code and OpenCode registration for nudge install and nudge doctor.
// Claude Code: the SessionStart hook goes into ~/.claude/settings.json (user scope, merged
// by key so other settings stay as they are), and the MCP server is registered at user
// scope through `claude mcp add-json`, so Claude Code's own writer edits ~/.claude.json.
// OpenCode: mcp.nudge in ~/.config/opencode/opencode.json and a small plugin file that
// adds `nudge context` to the system prompt of each session.

/**
 * Where the agent configs live. NUDGE_HOME_DIR replaces the home folder (tests use a fake
 * one) and then CLAUDE_CONFIG_DIR and XDG_CONFIG_HOME are ignored, so a sandbox can never
 * reach the real configs.
 */
export function agentPaths() {
  const sandbox = process.env.NUDGE_HOME_DIR;
  const home = sandbox || os.homedir();
  const claudeConfigDir = sandbox ? undefined : process.env.CLAUDE_CONFIG_DIR;
  const claudeDir = claudeConfigDir || path.join(home, '.claude');
  const xdg = sandbox ? undefined : process.env.XDG_CONFIG_HOME;
  const opencodeDir = path.join(xdg || path.join(home, '.config'), 'opencode');
  const jsonc = path.join(opencodeDir, 'opencode.jsonc');
  return {
    home,
    sandboxed: !!sandbox,
    claudeDir,
    claudeSettings: path.join(claudeDir, 'settings.json'),
    claudeJson: claudeConfigDir ? path.join(claudeConfigDir, '.claude.json') : path.join(home, '.claude.json'),
    opencodeDir,
    opencodeConfig: !fs.existsSync(path.join(opencodeDir, 'opencode.json')) && fs.existsSync(jsonc) ? jsonc : path.join(opencodeDir, 'opencode.json'),
    opencodePlugin: path.join(opencodeDir, 'plugins', 'nudge-context.ts'),
  };
}

export const MCP_SERVER_NAME = 'nudge';
export const PLUGIN_MARKER = '// nudge-context: managed by nudge install';

export interface AgentTargets {
  node: string;
  cli: string;
  server: string;
}

export interface ClaudeHookHandler {
  type: 'command';
  command: string;
  args: string[];
  timeout: number;
}

/** Exec form: no shell, so spaces and "&" in paths pass through as they are. */
export function claudeHookHandler(t: AgentTargets): ClaudeHookHandler {
  return { type: 'command', command: t.node, args: [t.cli, 'context', '--cwd', '${CLAUDE_PROJECT_DIR}'], timeout: 15 };
}

export function claudeMcpEntry(t: AgentTargets) {
  return { type: 'stdio', command: t.node, args: [t.server], env: {} };
}

export function opencodeMcpEntry(t: AgentTargets) {
  return { type: 'local', command: [t.node, t.server], enabled: true };
}

const slashKey = (p: unknown) => (typeof p === 'string' ? p.replace(/\\/g, '/').toLowerCase() : '');

/** A SessionStart handler that runs `nudge context`, wherever this checkout was when it was added. */
export function isNudgeContextHandler(h: unknown): boolean {
  if (!h || typeof h !== 'object') return false;
  const { command, args } = h as { command?: unknown; args?: unknown };
  if (Array.isArray(args)) return args.includes('context') && args.some((a) => slashKey(a).endsWith('packages/cli/src/main.ts'));
  return typeof command === 'string' && /packages[\\/]cli[\\/]src[\\/]main\.ts["']?\s+context\b/i.test(command);
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Same program and arguments, ignoring slash direction and case in paths (Windows). */
function sameCommand(a: { command?: unknown; args?: unknown } | undefined, b: { command: string; args: string[] }): boolean {
  if (!a || slashKey(a.command) !== slashKey(b.command) || !Array.isArray(a.args) || a.args.length !== b.args.length) return false;
  return a.args.every((x, i) => slashKey(x) === slashKey(b.args[i]));
}

export type EditAction = 'create' | 'update' | 'none' | 'skip';

export interface FileEdit {
  file: string;
  action: EditAction;
  /** Why it is skipped, or what the update replaces. */
  note?: string;
  /** Copy of the current file, written before changing it. */
  backup: string | null;
  /** New file content (null when nothing is written). */
  content: string | null;
  /** The entry nudge adds or replaces, for the plan shown before applying. */
  entry: unknown;
  /** Top-level keys (or the like) left exactly as they are. */
  kept: string[];
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export function backupName(file: string, now = new Date()): string {
  return `${file}.nudge-backup-${stamp(now)}`;
}

interface JsonDoc {
  data: Record<string, unknown>;
  indent: string;
  eol: string;
  exists: boolean;
}

/** Read a JSON object file, keeping its indentation and line endings. Comments are refused, not lost. */
function readJsonDoc(file: string): JsonDoc {
  if (!fs.existsSync(file)) return { data: {}, indent: '  ', eol: '\n', exists: false };
  const raw = decodeText(fs.readFileSync(file));
  const original = fs.readFileSync(file, 'utf8');
  let data: unknown;
  try {
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    throw new NudgeError(`${file} is not plain JSON (${errorMessage(e)}); nudge will not rewrite it. Add the entry shown by hand.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new NudgeError(`${file} does not hold a JSON object; nudge will not rewrite it.`);
  const indent = /\n([ \t]+)"/.exec(raw)?.[1] ?? '  ';
  return { data: data as Record<string, unknown>, indent, eol: original.includes('\r\n') ? '\r\n' : '\n', exists: true };
}

function writeJson(doc: JsonDoc): string {
  return JSON.stringify(doc.data, null, doc.indent).replace(/\n/g, doc.eol) + doc.eol;
}

function skipped(file: string, note: string, entry: unknown): FileEdit {
  return { file, action: 'skip', note, backup: null, content: null, entry, kept: [] };
}

/** Add or update the nudge SessionStart handler in Claude Code's user settings.json. */
export function planClaudeSettings(t: AgentTargets, now = new Date()): FileEdit {
  const { claudeSettings: file } = agentPaths();
  const handler = claudeHookHandler(t);
  let doc: JsonDoc;
  try {
    doc = readJsonDoc(file);
  } catch (e) {
    return skipped(file, errorMessage(e), handler);
  }
  const kept = Object.keys(doc.data).flatMap((k) => (k === 'hooks' && doc.data.hooks && typeof doc.data.hooks === 'object' ? Object.keys(doc.data.hooks).filter((e) => e !== 'SessionStart').map((e) => `hooks.${e}`) : k === 'hooks' ? [] : [k]));
  const hooks = (doc.data.hooks ?? {}) as Record<string, unknown>;
  if (typeof hooks !== 'object' || Array.isArray(hooks)) return skipped(file, `"hooks" in ${file} is not an object; nudge will not rewrite it.`, handler);
  const groups = (hooks.SessionStart ?? []) as unknown[];
  if (!Array.isArray(groups)) return skipped(file, `"hooks.SessionStart" in ${file} is not a list; nudge will not rewrite it.`, handler);

  const handlersOf = (g: unknown): unknown[] => {
    const list = (g as { hooks?: unknown })?.hooks;
    return Array.isArray(list) ? list : [];
  };
  const others = groups.flatMap(handlersOf).filter((h) => !isNudgeContextHandler(h)).length;
  if (others) kept.push(`${others} other SessionStart hook${others === 1 ? '' : 's'}`);
  let action: EditAction = doc.exists ? 'update' : 'create';
  let note: string | undefined;
  let found = false;
  for (const g of groups) {
    const list = (g as { hooks?: unknown })?.hooks;
    if (!Array.isArray(list)) continue;
    const i = list.findIndex(isNudgeContextHandler);
    if (i < 0) continue;
    found = true;
    if (sameJson(list[i], handler)) action = 'none';
    else {
      note = `replaces ${JSON.stringify(list[i])}`;
      list[i] = handler;
    }
    break;
  }
  if (!found) groups.push({ hooks: [handler] });
  if (action === 'none') return { file, action, backup: null, content: null, entry: handler, kept };
  hooks.SessionStart = groups;
  doc.data.hooks = hooks;
  return { file, action, note, backup: doc.exists ? backupName(file, now) : null, content: writeJson(doc), entry: handler, kept };
}

export interface ClaudeMcpPlan {
  action: 'add' | 'update' | 'none' | 'skip';
  note?: string;
  /** claude.exe that runs the registration. */
  claude: string | null;
  entry: ReturnType<typeof claudeMcpEntry>;
  /** What ~/.claude.json has for nudge now (user scope). */
  current: unknown;
  /** Commands nudge install runs, in order. */
  commands: string[][];
  /** Copy of ~/.claude.json written before running them. */
  backup: string | null;
  file: string;
}

/** The nudge entry in ~/.claude.json at user scope (top-level mcpServers), if any. */
export function readClaudeMcp(): { file: string; entry: unknown; error?: string } {
  const file = agentPaths().claudeJson;
  if (!fs.existsSync(file)) return { file, entry: undefined };
  try {
    const data = JSON.parse(decodeText(fs.readFileSync(file))) as { mcpServers?: Record<string, unknown> };
    return { file, entry: data.mcpServers?.[MCP_SERVER_NAME] };
  } catch (e) {
    return { file, entry: undefined, error: `${file} is not valid JSON: ${errorMessage(e)}` };
  }
}

export function planClaudeMcp(t: AgentTargets, claude: string | null, now = new Date()): ClaudeMcpPlan {
  const entry = claudeMcpEntry(t);
  const { file, entry: current, error } = readClaudeMcp();
  const base = { claude, entry, current, file };
  if (!claude) return { ...base, action: 'skip', note: 'claude was not found on PATH (Claude Code not installed?)', commands: [], backup: null };
  if (error) return { ...base, action: 'skip', note: error, commands: [], backup: null };
  const add = ['mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, JSON.stringify(entry)];
  const backup = fs.existsSync(file) ? backupName(file, now) : null;
  if (current === undefined) return { ...base, action: 'add', commands: [add], backup };
  if (sameCommand(current as { command?: unknown; args?: unknown }, entry)) return { ...base, action: 'none', commands: [], backup: null };
  return { ...base, action: 'update', note: `replaces ${JSON.stringify(current)}`, commands: [['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME], add], backup };
}

/** Add or update mcp.nudge in OpenCode's global config. */
export function planOpenCodeConfig(t: AgentTargets, now = new Date()): FileEdit {
  const { opencodeConfig: file, opencodeDir } = agentPaths();
  const entry = opencodeMcpEntry(t);
  if (!fs.existsSync(opencodeDir)) return skipped(file, `${opencodeDir} does not exist (OpenCode not installed?)`, entry);
  let doc: JsonDoc;
  try {
    doc = readJsonDoc(file);
  } catch (e) {
    return skipped(file, errorMessage(e), entry);
  }
  const mcp = (doc.data.mcp ?? {}) as Record<string, unknown>;
  if (typeof mcp !== 'object' || Array.isArray(mcp)) return skipped(file, `"mcp" in ${file} is not an object; nudge will not rewrite it.`, entry);
  const kept = [...Object.keys(doc.data).filter((k) => k !== 'mcp'), ...Object.keys(mcp).filter((k) => k !== MCP_SERVER_NAME).map((k) => `mcp.${k}`)];
  const current = mcp[MCP_SERVER_NAME] as { command?: unknown } | undefined;
  if (current && Array.isArray(current.command) && sameCommand({ command: current.command[0], args: current.command.slice(1) }, { command: t.node, args: [t.server] }) && (current as { enabled?: unknown }).enabled !== false) {
    return { file, action: 'none', backup: null, content: null, entry, kept };
  }
  const note = current ? `replaces ${JSON.stringify(current)}` : undefined;
  mcp[MCP_SERVER_NAME] = entry;
  doc.data.mcp = mcp;
  if (!doc.exists) doc.data = { $schema: 'https://opencode.ai/config.json', ...doc.data };
  return { file, action: doc.exists ? 'update' : 'create', note, backup: doc.exists ? backupName(file, now) : null, content: writeJson(doc), entry, kept };
}

/**
 * OpenCode plugin: on the first system prompt of each session it runs nudge context for
 * the session's folder (no shell) and keeps adding that text to the session's system prompt.
 * experimental.chat.system.transform is the hook OpenCode 1.19 offers for this.
 */
export function opencodePluginSource(t: AgentTargets): string {
  return `${PLUGIN_MARKER}. Do not edit; nudge install rewrites it.
// Adds the nudge cheat sheet index for the session's folder (nudge context --cwd <dir>) to
// the system prompt, so the agent knows which sheets exist and can fetch them with nudge_get.
import { execFile } from "node:child_process"

const NODE = ${JSON.stringify(t.node)}
const CLI = ${JSON.stringify(t.cli)}
const bySession = new Map<string, Promise<string>>()

function nudgeContext(dir: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(NODE, [CLI, "context", "--cwd", dir], { timeout: 15000, windowsHide: true }, (error, stdout) => {
      resolve(error ? "" : String(stdout).trim())
    })
  })
}

export const NudgeContext = async ({ directory }: { directory: string }) => ({
  "experimental.chat.system.transform": async (input: { sessionID?: string }, output: { system: string[] }) => {
    const key = input.sessionID ?? ""
    let text = bySession.get(key)
    if (!text) {
      text = nudgeContext(directory)
      bySession.set(key, text)
    }
    const value = await text
    if (value) output.system.push(value)
  },
})
`;
}

export function planOpenCodePlugin(t: AgentTargets, now = new Date()): FileEdit {
  const { opencodePlugin: file, opencodeDir } = agentPaths();
  const content = opencodePluginSource(t);
  if (!fs.existsSync(opencodeDir)) return skipped(file, `${opencodeDir} does not exist (OpenCode not installed?)`, null);
  if (!fs.existsSync(file)) return { file, action: 'create', backup: null, content, entry: null, kept: [] };
  const current = fs.readFileSync(file, 'utf8');
  if (!current.startsWith(PLUGIN_MARKER)) return skipped(file, `${file} exists and was not written by nudge; nudge will not overwrite it.`, null);
  if (current === content) return { file, action: 'none', backup: null, content: null, entry: null, kept: [] };
  return { file, action: 'update', backup: backupName(file, now), content, entry: null, kept: [] };
}

export interface AgentPlan {
  claudeSettings: FileEdit;
  claudeMcp: ClaudeMcpPlan;
  opencodeConfig: FileEdit;
  opencodePlugin: FileEdit;
}

export function planAgents(t: AgentTargets, claude: string | null, now = new Date()): AgentPlan {
  return {
    claudeSettings: planClaudeSettings(t, now),
    claudeMcp: planClaudeMcp(t, claude, now),
    opencodeConfig: planOpenCodeConfig(t, now),
    opencodePlugin: planOpenCodePlugin(t, now),
  };
}

function applyFileEdit(edit: FileEdit, what: string): string | null {
  if (edit.action !== 'create' && edit.action !== 'update') return null;
  if (edit.backup) fs.copyFileSync(edit.file, edit.backup);
  fs.mkdirSync(path.dirname(edit.file), { recursive: true });
  fs.writeFileSync(edit.file, edit.content!);
  return `${edit.action === 'create' ? 'created' : 'updated'} ${edit.file} (${what})${edit.backup ? `; backup ${edit.backup}` : ''}`;
}

/** Apply the agent part of an install plan. `runClaude` runs claude.exe with arguments (no shell). */
export function applyAgents(plan: AgentPlan, runClaude: (claude: string, args: string[]) => void): string[] {
  const done: string[] = [];
  const settings = applyFileEdit(plan.claudeSettings, 'Claude Code SessionStart hook');
  if (settings) done.push(settings);
  const m = plan.claudeMcp;
  if ((m.action === 'add' || m.action === 'update') && m.claude) {
    if (m.backup) fs.copyFileSync(m.file, m.backup);
    for (const args of m.commands) runClaude(m.claude, args);
    done.push(`${m.action === 'add' ? 'registered' : 're-registered'} MCP server "${MCP_SERVER_NAME}" in Claude Code (user scope)${m.backup ? `; backup ${m.backup}` : ''}`);
  }
  const config = applyFileEdit(plan.opencodeConfig, 'OpenCode MCP server');
  if (config) done.push(config);
  const plugin = applyFileEdit(plan.opencodePlugin, 'OpenCode session index plugin');
  if (plugin) done.push(plugin);
  return done;
}

export interface AgentStatus {
  claudeHook: boolean;
  /** The nudge entry at user scope in ~/.claude.json, and whether it points at this checkout. */
  claudeMcp: { present: boolean; current: boolean; error?: string };
  opencode: { installed: boolean; mcp: boolean; plugin: boolean };
}

/** Read-only: what is registered now. */
export function agentStatus(t: AgentTargets): AgentStatus {
  const p = agentPaths();
  let claudeHook = false;
  try {
    const hooks = (readJsonDoc(p.claudeSettings).data.hooks as { SessionStart?: { hooks?: unknown[] }[] } | undefined)?.SessionStart ?? [];
    claudeHook = Array.isArray(hooks) && hooks.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => isNudgeContextHandler(h) && sameJson(h, claudeHookHandler(t))));
  } catch {
    // Unreadable settings: reported as not registered.
  }
  const mcp = readClaudeMcp();
  const installed = fs.existsSync(p.opencodeDir);
  let ocMcp = false;
  try {
    const entry = ((readJsonDoc(p.opencodeConfig).data.mcp ?? {}) as Record<string, { command?: unknown }>)[MCP_SERVER_NAME];
    ocMcp = !!entry && Array.isArray(entry.command) && sameCommand({ command: entry.command[0], args: entry.command.slice(1) }, { command: t.node, args: [t.server] });
  } catch {
    // Same as above.
  }
  const plugin = fs.existsSync(p.opencodePlugin) && fs.readFileSync(p.opencodePlugin, 'utf8') === opencodePluginSource(t);
  return {
    claudeHook,
    claudeMcp: { present: mcp.entry !== undefined, current: sameCommand(mcp.entry as { command?: unknown; args?: unknown } | undefined, claudeMcpEntry(t)), ...(mcp.error ? { error: mcp.error } : {}) },
    opencode: { installed, mcp: ocMcp, plugin },
  };
}
