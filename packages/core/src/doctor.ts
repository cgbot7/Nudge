import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { indexedSheets, openDb, sectionCount } from './db.ts';
import { gitAvailable, isRepoRoot } from './git.ts';
import { sheetAbsPath } from './library.ts';
import { lockStatus } from './lock.ts';
import { readManifest, type Sheet } from './manifest.ts';
import { dataPaths, pathKey } from './paths.ts';
import { errorMessage, sha256File } from './util.ts';

export interface Check {
  status: 'ok' | 'warn' | 'fail';
  name: string;
  detail: string;
}

function list(ids: string[], max = 8): string {
  return ids.length > max ? `${ids.slice(0, max).join(', ')} and ${ids.length - max} more` : ids.join(', ');
}

export function runDoctor(): Check[] {
  const checks: Check[] = [];
  const add = (status: Check['status'], name: string, detail: string) => checks.push({ status, name, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 24 ? 'ok' : 'fail', 'node', `v${process.versions.node}${major >= 24 ? '' : ' (need 24 or newer)'}`);

  let library: string;
  try {
    const loaded = loadConfig();
    library = loaded.config.library;
    add(loaded.exists ? 'ok' : 'warn', 'config', loaded.exists ? loaded.path : `${loaded.path} not found; using defaults (written on first refs add)`);
  } catch (e) {
    add('fail', 'config', errorMessage(e));
    return checks;
  }

  add(gitAvailable() ? 'ok' : 'fail', 'git', gitAvailable() ? 'available' : 'git is not on PATH');

  if (!fs.existsSync(library)) {
    add('warn', 'library', `${library} does not exist yet; refs add <file> creates it`);
    return checks;
  }
  add(isRepoRoot(library) ? 'ok' : 'fail', 'library', isRepoRoot(library) ? library : `${library} is not a Git repo root`);

  let sheets: Sheet[];
  try {
    sheets = readManifest(library);
    add('ok', 'manifest', `${sheets.length} sheet${sheets.length === 1 ? '' : 's'}`);
  } catch (e) {
    add('fail', 'manifest', errorMessage(e));
    return checks;
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
  if (missing.length) add('fail', 'files', `missing from the library: ${list(missing)} (renamed or deleted outside refs?)`);
  if (changed.length) add('warn', 'files', `edited since import: ${list(changed)}; the index still has the old text`);
  if (unknown.length) add('warn', 'files', `in sheets\\ but not in manifest.json: ${list(unknown)}`);
  if (!missing.length && !changed.length && !unknown.length) add('ok', 'files', 'manifest matches the library files');

  const dbFile = dataPaths().db;
  if (!fs.existsSync(dbFile)) {
    add(sheets.length ? 'warn' : 'ok', 'index', sheets.length ? `${dbFile} is missing` : 'empty (no sheets yet)');
  } else {
    try {
      const db = openDb(dbFile);
      try {
        const indexed = indexedSheets(db);
        const notIndexed = sheets.filter((s) => !indexed.has(s.id)).map((s) => s.id);
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

  const lock = lockStatus();
  if (!lock.held) add('ok', 'lock', 'free');
  else if (lock.stale) add('warn', 'lock', `stale lock from process ${lock.info?.pid ?? '?'}; the next write clears it`);
  else add('warn', 'lock', `held by process ${lock.info?.pid ?? '?'} (${lock.info?.command ?? 'unknown'}) since ${lock.info?.at ?? '?'}`);

  return checks;
}
