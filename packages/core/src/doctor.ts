import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { indexedSheets, openDb, sectionCount } from './db.ts';
import { readGapIgnores } from './gaps.ts';
import { gitAvailable, isRepoRoot } from './git.ts';
import { readHookCache } from './hookcache.ts';
import { installStatus, realSystem, taskName, type SystemOps } from './install.ts';
import { sheetAbsPath } from './library.ts';
import { lockStatus } from './lock.ts';
import { readManifest, type Sheet } from './manifest.ts';
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

export function runDoctor(sys: SystemOps = realSystem()): Check[] {
  const checks: Check[] = [];
  const add: Add = (status, name, detail) => checks.push({ status, name, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 24 ? 'ok' : 'fail', 'node', `v${process.versions.node}${major >= 24 ? '' : ' (need 24 or newer)'}`);

  let config: Config;
  try {
    const loaded = loadConfig();
    config = loaded.config;
    add(loaded.exists ? 'ok' : 'warn', 'config', loaded.exists ? loaded.path : `${loaded.path} not found; using defaults (written on first refs add)`);
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
  return checks;
}

function libraryChecks(library: string, add: Add): void {
  if (!fs.existsSync(library)) {
    add('warn', 'library', `${library} does not exist yet; refs add <file> creates it`);
    return;
  }
  add(isRepoRoot(library) ? 'ok' : 'fail', 'library', isRepoRoot(library) ? library : `${library} is not a Git repo root`);

  try {
    const rules = readRules(library);
    readTagVocab(library);
    readGapIgnores(library);
    if (fs.existsSync(rulesPath(library))) add('ok', 'rules', `rules.json valid (${rules.length} rules)`);
    else add('warn', 'rules', 'rules.json not in the library yet; refs index writes the defaults');
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
  if (missing.length) add('fail', 'files', `missing from the library: ${list(missing)} (renamed or deleted outside refs, and no file with the same content was found by refs index)`);
  if (changed.length) add('warn', 'files', `edited since the last index: ${list(changed)}; run refs index`);
  if (unknown.length) add('warn', 'files', `in sheets\\ but not in manifest.json: ${list(unknown)}`);
  if (!missing.length && !changed.length && !unknown.length) add('ok', 'files', 'manifest matches the library files');

  const dbFile = dataPaths().db;
  if (!fs.existsSync(dbFile)) {
    add(sheets.length ? 'warn' : 'ok', 'index', sheets.length ? `${dbFile} is missing; run refs index --rebuild` : 'empty (no sheets yet)');
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
  if (!fs.existsSync(cacheFile)) add('warn', 'cache', `${cacheFile} is missing; run refs index (the hook prints nothing until then)`);
  else {
    const cache = readHookCache();
    if (!cache) add('fail', 'cache', `${cacheFile} is unreadable; run refs index to rewrite it (the hook prints nothing meanwhile)`);
    else add('ok', 'cache', `${cache.projects.length} project${cache.projects.length === 1 ? '' : 's'}, written ${cache.generatedAt}`);
  }

  let status;
  try {
    status = installStatus(sys);
  } catch (e) {
    add('warn', 'hook', errorMessage(e));
    return;
  }
  if (!status.hookIn.length) add('warn', 'hook', 'not in any PowerShell profile; run refs install');
  else {
    const only51 = status.hookIn.every((f) => /[\\/]WindowsPowerShell[\\/]/i.test(f));
    const blocked = !/^(RemoteSigned|Unrestricted|Bypass)$/i.test(status.info.executionPolicy);
    if (only51 && blocked) add('warn', 'hook', `only in the 5.1 profile, and its execution policy (${status.info.executionPolicy}) stops profiles from loading`);
    else add('ok', 'hook', `in ${status.hookIn.join(', ')}`);
  }
  add(status.scheduled ? 'ok' : 'warn', 'schedule', status.scheduled ? `task "${taskName()}" registered` : `task "${taskName()}" not registered; run refs install`);
}
