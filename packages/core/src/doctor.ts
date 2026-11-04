import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { embeddingCoverage, embeddingModels, indexedSheets, openDb, sectionCount } from './db.ts';
import { readGapIgnores } from './gaps.ts';
import { CHAT_SOURCE_LABELS, CHAT_SOURCE_NAMES, chatSourceDir } from './harvest/chats.ts';
import { readLedger } from './harvest/ledger.ts';
import { SOURCES, SOURCE_NAMES } from './harvest/sources.ts';
import { gitAvailable, isRepoRoot } from './git.ts';
import { readHookCache } from './hookcache.ts';
import { inboxCounts } from './inbox.ts';
import { agentPaths, agentStatus } from './agents.ts';
import { parseHotkey } from './hotkey.ts';
import { agentTargets, installStatus, repoPaths, runKey, runValueName, realSystem, taskName, type SystemOps } from './install.ts';
import { probeMcpServer } from './mcpprobe.ts';
import { pingSidecar } from './sidecarprobe.ts';
import { sheetAbsPath } from './library.ts';
import { lockStatus } from './lock.ts';
import { readManifest, type Sheet } from './manifest.ts';
import { hasModel, ollamaClient } from './ollama.ts';
import { dataPaths, pathKey } from './paths.ts';
import { readRules, readTagVocab, rulesPath } from './rules.ts';
import { errorMessage, sha256File } from './util.ts';

export interface Check {
  status: 'ok' | 'warn' | 'fail';
  name: string;
  detail: string;
}

type Add = (status: Check['status'], name: string, detail: string) => void;

function list(ids: string[], max = 8): string {
  return ids.length > max ? `${ids.slice(0, max).join(', ')} and ${ids.length - max} more` : ids.join(', ');
}

export async function runDoctor(sys: SystemOps = realSystem()): Promise<Check[]> {
  const checks: Check[] = [];
  const add: Add = (status, name, detail) => checks.push({ status, name, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 24 ? 'ok' : 'fail', 'node', `v${process.versions.node}${major >= 24 ? '' : ' (need 24 or newer)'}`);

  let config: Config;
  try {
    const loaded = loadConfig();
    config = loaded.config;
    add(loaded.exists ? 'ok' : 'warn', 'config', loaded.exists ? loaded.path : `${loaded.path} not found; using defaults (written on first nudge add)`);
  } catch (e) {
    add('fail', 'config', errorMessage(e));
    return checks;
  }

  add(gitAvailable() ? 'ok' : 'fail', 'git', gitAvailable() ? 'available' : 'git is not on PATH');
  libraryChecks(config.library, add);

  const lock = lockStatus();
  if (!lock.held) add('ok', 'lock', 'free');
  else if (lock.stale) add('warn', 'lock', `stale lock from process ${lock.info?.pid ?? '?'}; the next write clears it`);
  else add('warn', 'lock', `held by process ${lock.info?.pid ?? '?'} (${lock.info?.command ?? 'unknown'}) since ${lock.info?.at ?? '?'}`);

  hookChecks(config, add, sys);
  await ollamaChecks(config, add);
  aiLibraryChecks(config, add);
  harvestChecks(config, add);
  await agentChecks(add, sys);
  await popupChecks(config, add, sys);
  return checks;
}

function harvestChecks(config: Config, add: Add): void {
  const h = config.harvest;
  let ledger;
  try {
    ledger = readLedger(config.library);
  } catch (e) {
    add('fail', 'harvest', errorMessage(e));
    return;
  }
  const entries = Object.values(ledger.files);
  const copied = entries.filter((e) => e.sheetId).length;
  const rejected = entries.filter((e) => e.rejected).length;
  const state = h.enabled ? 'on in nudge index' : 'off in nudge index (set "harvest": {"enabled": true} in config.json; nudge harvest works either way)';
  add('ok', 'harvest', `${state}; ${copied} copied, ${rejected} rejected`);
  for (const name of SOURCE_NAMES) {
    const source = SOURCES[name];
    if (!h.sources[name]) {
      add('ok', 'harvest', `${source.label}: turned off in config.json`);
      continue;
    }
    const dir = source.dir();
    if (!fs.existsSync(dir)) add('ok', 'harvest', `${source.label}: ${dir} not found; skipped`);
    else add('ok', 'harvest', `${source.label}: ${source.list().length} notes in ${dir}`);
  }
  const chats = Object.values(ledger.chats);
  const drafts = chats.reduce((n, c) => n + c.sheetIds.length, 0);
  const since = ledger.chatsSince ? `chats since ${ledger.chatsSince}` : 'chats from the day of the first run';
  add('ok', 'harvest', `${since}: ${chats.length} read, ${drafts} drafts written, ${chats.filter((c) => c.rejected).length} rejected`);
  for (const name of CHAT_SOURCE_NAMES) {
    const label = CHAT_SOURCE_LABELS[name];
    const dir = chatSourceDir(name, h.exportsDir);
    if (!h.sources[name]) add('ok', 'harvest', `${label}: turned off in config.json`);
    else if (!fs.existsSync(dir)) add('ok', 'harvest', name === 'exports' ? `${label}: drop a claude.ai export or a Google Takeout (Gemini Apps, JSON) zip into ${dir}` : `${label}: ${dir} not found; skipped`);
    else add('ok', 'harvest', `${label}: ${dir}`);
  }
}

async function popupChecks(config: Config, add: Add, sys: SystemOps): Promise<void> {
  const { popup, sidecar } = repoPaths();
  if (fs.existsSync(popup)) add('ok', 'popup', `built: ${popup} (${fs.statSync(popup).mtime.toISOString().slice(0, 16).replace('T', ' ')})`);
  else add('warn', 'popup', `not built (${popup}); run npm run popup:build`);

  try {
    const { popupLogon } = installStatus(sys);
    if (popupLogon.current) add('ok', 'logon', `"${runValueName()}" in ${runKey()} starts this popup`);
    else if (popupLogon.value === null) add('warn', 'logon', `the popup does not start at logon ("${runValueName()}" is not in ${runKey()}); run nudge install`);
    else add('warn', 'logon', `"${runValueName()}" in ${runKey()} starts something else (${popupLogon.value}); run nudge install to update it`);
  } catch (e) {
    add('warn', 'logon', errorMessage(e));
  }

  const hotkey = parseHotkey(config.hotkey);
  if (hotkey.ok) add('ok', 'hotkey', hotkey.canonical === config.hotkey ? hotkey.canonical : `${config.hotkey} (as ${hotkey.canonical})`);
  else add('fail', 'hotkey', `config.json "hotkey": ${hotkey.error}. The popup falls back to Ctrl+Alt+Space`);

  const ping = await pingSidecar(process.execPath, sidecar);
  add(ping.ok ? 'ok' : 'fail', 'sidecar', ping.ok ? `starts and answers ping in ${ping.ms} ms` : `${sidecar}: ${ping.error}`);
}

export const MCP_TOOLS = ['nudge_search', 'nudge_get', 'nudge_for_project'];

async function agentChecks(add: Add, sys: SystemOps): Promise<void> {
  const t = agentTargets();
  const probe = await probeMcpServer(t.node, [t.server]);
  const missingTools = MCP_TOOLS.filter((n) => !probe.tools.includes(n));
  if (!probe.ok) add('fail', 'mcp', `the MCP server did not start: ${probe.error}`);
  else if (missingTools.length) add('fail', 'mcp', `the MCP server is missing ${missingTools.join(', ')} (lists ${probe.tools.join(', ') || 'nothing'})`);
  else add('ok', 'mcp', `server starts in ${probe.ms} ms and lists ${probe.tools.join(', ')} (protocol ${probe.protocol ?? '?'})`);

  const paths = agentPaths();
  const status = agentStatus(t);
  let claude: string | null = null;
  try {
    claude = sys.findClaude();
  } catch {
    // Treated as not installed.
  }
  if (!claude && !fs.existsSync(paths.claudeDir)) add('ok', 'claude', 'Claude Code not found; skipped');
  else {
    add(status.claudeHook ? 'ok' : 'warn', 'claude', status.claudeHook ? `SessionStart hook in ${paths.claudeSettings}` : `no current nudge SessionStart hook in ${paths.claudeSettings}; run nudge install`);
    if (status.claudeMcp.error) add('warn', 'claude', status.claudeMcp.error);
    else if (!status.claudeMcp.present) add('warn', 'claude', `MCP server "nudge" not registered at user scope (${paths.claudeJson}); run nudge install`);
    else if (!status.claudeMcp.current) add('warn', 'claude', 'MCP server "nudge" points at another checkout or Node; run nudge install to update it');
    else add('ok', 'claude', `MCP server "nudge" registered at user scope`);
  }
  if (!status.opencode.installed) add('ok', 'opencode', `${paths.opencodeDir} not found; skipped`);
  else {
    add(status.opencode.mcp ? 'ok' : 'warn', 'opencode', status.opencode.mcp ? `MCP server "nudge" in ${paths.opencodeConfig}` : `MCP server "nudge" not registered in ${paths.opencodeConfig}; run nudge install`);
    add(status.opencode.plugin ? 'ok' : 'warn', 'opencode', status.opencode.plugin ? `session index plugin ${paths.opencodePlugin}` : `session index plugin missing or out of date (${paths.opencodePlugin}); run nudge install`);
  }
}

async function ollamaChecks(config: Config, add: Add): Promise<void> {
  const { host, embedModel, chatModel, visionModel, chatApi, chatHost } = config.ollama;
  const client = ollamaClient(config.ollama);
  const health = await client.health();
  if (!health.ok) {
    add('warn', 'ollama', `${health.reason}. Search falls back to keyword only; tagging and OCR wait for a later nudge index`);
    return;
  }
  add('ok', 'ollama', `version ${health.version} at ${host}`);
  let installed: string[];
  try {
    installed = await client.models();
  } catch (e) {
    add('warn', 'models', `could not list models: ${errorMessage(e)}`);
    return;
  }
  const viaRelay = chatApi === 'openai' || (chatHost !== undefined && chatHost !== host);
  const wanted: [string, string][] = [
    ['embed', embedModel],
    ...(viaRelay ? [] : ([['chat', chatModel]] as [string, string][])),
    ['vision', visionModel],
  ];
  for (const [role, model] of wanted) {
    if (!model) add('warn', 'models', `${role}Model is not set in config.json`);
    else if (hasModel(installed, model)) add('ok', 'models', `${role}: ${model}`);
    else add('fail', 'models', `${role}: ${model} is not pulled. Run: ollama pull ${model}`);
  }
  if (viaRelay) add('ok', 'models', `chat: ${chatModel} through ${chatHost ?? host} (${chatApi} API, not checked)`);
}

function aiLibraryChecks(config: Config, add: Add): void {
  const { library } = config;
  if (!fs.existsSync(library)) return;
  const counts = inboxCounts(library);
  const inboxDetail = `${counts.waiting} waiting, ${counts.blocked} blocked, ${counts.duplicates} duplicates`;
  add(counts.blocked ? 'warn' : 'ok', 'inbox', counts.blocked ? `${inboxDetail}; see the reason files in inbox\_blocked` : inboxDetail);
  try {
    const pending = readManifest(library).filter((s) => s.status === 'pending');
    if (pending.length) add('warn', 'review', `${pending.length} pending sheet${pending.length === 1 ? '' : 's'} waiting for nudge review`);
    else add('ok', 'review', 'nothing waiting');
  } catch {
    // The manifest check above already failed.
  }

  const dbFile = dataPaths().db;
  if (!fs.existsSync(dbFile)) return;
  try {
    const db = openDb(dbFile);
    try {
      const model = config.ollama.embedModel;
      const { sections, embedded } = embeddingCoverage(db, model);
      const others = embeddingModels(db).filter((m) => m !== model);
      if (others.length) add('warn', 'vectors', `vectors from ${others.join(', ')} are replaced by ${model} on the next nudge index`);
      if (!sections) add('ok', 'vectors', 'no sections yet');
      else if (embedded === sections) add('ok', 'vectors', `${embedded} of ${sections} sections embedded with ${model}`);
      else add('warn', 'vectors', `${embedded} of ${sections} sections embedded with ${model}; nudge index embeds the rest (needs Ollama)`);
    } finally {
      db.close();
    }
  } catch (e) {
    add('fail', 'vectors', `${dbFile}: ${errorMessage(e)}`);
  }
}

function libraryChecks(library: string, add: Add): void {
  if (!fs.existsSync(library)) {
    add('warn', 'library', `${library} does not exist yet; nudge add <file> creates it`);
    return;
  }
  add(isRepoRoot(library) ? 'ok' : 'fail', 'library', isRepoRoot(library) ? library : `${library} is not a Git repo root`);

  try {
    const rules = readRules(library);
    readTagVocab(library);
    readGapIgnores(library);
    if (fs.existsSync(rulesPath(library))) add('ok', 'rules', `rules.json valid (${rules.length} rules)`);
    else add('warn', 'rules', 'rules.json not in the library yet; nudge index writes the defaults');
  } catch (e) {
    add('fail', 'rules', errorMessage(e));
  }

  let sheets: Sheet[];
  try {
    sheets = readManifest(library);
    add('ok', 'manifest', `${sheets.length} sheet${sheets.length === 1 ? '' : 's'}`);
  } catch (e) {
    add('fail', 'manifest', errorMessage(e));
    return;
  }

  const missing: string[] = [];
  const changed: string[] = [];
  for (const s of sheets) {
    const file = sheetAbsPath(library, s);
    if (!fs.existsSync(file)) missing.push(s.id);
    else if (sha256File(file) !== s.sha256) changed.push(s.id);
  }
  const known = new Set(sheets.map((s) => pathKey(sheetAbsPath(library, s))));
  const sheetsDir = path.join(library, 'sheets');
  const unknown = fs.existsSync(sheetsDir)
    ? fs.readdirSync(sheetsDir).filter((f) => !f.startsWith('~$') && !known.has(pathKey(path.join(sheetsDir, f))))
    : [];
  if (missing.length) add('fail', 'files', `missing from the library: ${list(missing)} (renamed or deleted outside nudge, and no file with the same content was found by nudge index)`);
  if (changed.length) add('warn', 'files', `edited since the last index: ${list(changed)}; run nudge index`);
  if (unknown.length) add('warn', 'files', `in sheets\\ but not in manifest.json: ${list(unknown)}`);
  if (!missing.length && !changed.length && !unknown.length) add('ok', 'files', 'manifest matches the library files');

  const dbFile = dataPaths().db;
  if (!fs.existsSync(dbFile)) {
    add(sheets.length ? 'warn' : 'ok', 'index', sheets.length ? `${dbFile} is missing; run nudge index --rebuild` : 'empty (no sheets yet)');
    return;
  }
  try {
    const db = openDb(dbFile);
    try {
      const indexed = indexedSheets(db);
      const notIndexed = sheets.filter((s) => !indexed.has(s.id) && !missing.includes(s.id)).map((s) => s.id);
      const orphans = [...indexed.keys()].filter((id) => !sheets.some((s) => s.id === id));
      if (notIndexed.length) add('warn', 'index', `not indexed: ${list(notIndexed)}`);
      if (orphans.length) add('warn', 'index', `indexed but not in manifest.json: ${list(orphans)}`);
      if (!notIndexed.length && !orphans.length) add('ok', 'index', `${indexed.size} sheets, ${sectionCount(db)} sections`);
    } finally {
      db.close();
    }
  } catch (e) {
    add('fail', 'index', `${dbFile}: ${errorMessage(e)}`);
  }
}

function hookChecks(config: Config, add: Add, sys: SystemOps): void {
  if (!config.roots.length) add('warn', 'roots', 'no roots registered; add project folders to "roots" in config.json');
  else {
    const absent = config.roots.filter((r) => !fs.existsSync(r));
    add(absent.length ? 'warn' : 'ok', 'roots', absent.length ? `not found: ${absent.join(', ')}` : config.roots.join(', '));
  }

  const cacheFile = dataPaths().hookCache;
  if (!fs.existsSync(cacheFile)) add('warn', 'cache', `${cacheFile} is missing; run nudge index (the hook prints nothing until then)`);
  else {
    const cache = readHookCache();
    if (!cache) add('fail', 'cache', `${cacheFile} is unreadable; run nudge index to rewrite it (the hook prints nothing meanwhile)`);
    else add('ok', 'cache', `${cache.projects.length} project${cache.projects.length === 1 ? '' : 's'}, written ${cache.generatedAt}`);
  }

  let status;
  try {
    status = installStatus(sys);
  } catch (e) {
    add('warn', 'hook', errorMessage(e));
    return;
  }
  if (!status.hookIn.length) add('warn', 'hook', 'not in any PowerShell profile; run nudge install');
  else {
    const only51 = status.hookIn.every((f) => /[\\/]WindowsPowerShell[\\/]/i.test(f));
    const blocked = !/^(RemoteSigned|Unrestricted|Bypass)$/i.test(status.info.executionPolicy);
    if (only51 && blocked) add('warn', 'hook', `only in the 5.1 profile, and its execution policy (${status.info.executionPolicy}) stops profiles from loading`);
    else add('ok', 'hook', `in ${status.hookIn.join(', ')}`);
  }
  add(status.scheduled ? 'ok' : 'warn', 'schedule', status.scheduled ? `task "${taskName()}" registered` : `task "${taskName()}" not registered; run nudge install`);
}
