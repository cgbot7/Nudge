import fs from 'node:fs';
import type { Config } from './config.ts';
import { resolveProjectRoot } from './detect.ts';
import { readGapIgnores, setGapIgnore, writeGapIgnores } from './gaps.ts';
import { commitPaths } from './git.ts';
import { refreshHookCache } from './hookcache.ts';
import { withLock } from './lock.ts';
import { findById, readManifest, writeManifest, type Sheet } from './manifest.ts';
import { normPath } from './paths.ts';
import { readRules } from './rules.ts';
import { logUsage } from './usage.ts';
import { RefsError, normalizeTag, today } from './util.ts';

export interface SheetChange {
  sheet: Sheet;
  /** False when the sheet already was in the requested state. */
  changed: boolean;
  commitError?: string;
}

function updateSheet(config: Config, command: string, id: string, apply: (s: Sheet) => boolean, message: (s: Sheet) => string): Promise<SheetChange> {
  return withLock(command, () => {
    const sheets = readManifest(config.library);
    const sheet = findById(sheets, id);
    if (!sheet) throw new RefsError(`no sheet with id ${id}.`);
    if (!apply(sheet)) return { sheet, changed: false };
    writeManifest(config.library, sheets);
    const commit = commitPaths(config.library, ['manifest.json'], message(sheet));
    refreshHookCache(config);
    return { sheet, changed: true, commitError: commit.ok ? undefined : commit.stderr || 'unknown error' };
  });
}

/** refs learned <id> [--undo]: learned sheets are never offered as reminders again. */
export async function setLearned(config: Config, id: string, learned: boolean): Promise<SheetChange> {
  const result = await updateSheet(
    config,
    'learned',
    id,
    (s) => {
      if (s.learned === learned) return false;
      s.learned = learned;
      return true;
    },
    (s) => `refs: mark ${s.id} ${learned ? 'learned' : 'not learned'}`,
  );
  if (result.changed && learned) logUsage({ event: 'learned', id, via: 'cli' });
  return result;
}

/** refs verify <id>: lastVerified becomes today, which clears stale. Status is unchanged. */
export function verifySheet(config: Config, id: string): Promise<SheetChange> {
  const date = today();
  return updateSheet(
    config,
    'verify',
    id,
    (s) => {
      if (s.lastVerified === date) return false;
      s.lastVerified = date;
      return true;
    },
    (s) => `refs: verify ${s.id}`,
  );
}

export interface IgnoreGapResult {
  tag: string;
  /** Project root for --project, otherwise null (global). */
  project: string | null;
  changed: boolean;
  commitError?: string;
}

/** refs ignore-gap <tag> [--project] [--undo]: stored in the library's gap-ignores.json. */
export function ignoreGap(config: Config, tag: string, opts: { projectDir?: string; undo?: boolean } = {}): Promise<IgnoreGapResult> {
  const t = normalizeTag(tag);
  if (!t) throw new RefsError('usage: refs ignore-gap <tag> [--project] [--undo]');
  return withLock('ignore-gap', () => {
    let project: string | null = null;
    if (opts.projectDir !== undefined) {
      project = resolveProjectRoot(opts.projectDir, config.roots, readRules(config.library));
      if (!project) throw new RefsError(`${normPath(opts.projectDir)} is not inside a project under a registered root, so --project has nothing to attach to.`);
    }
    if (!fs.existsSync(config.library)) throw new RefsError(`the library does not exist yet (${config.library}).`);
    const ignores = readGapIgnores(config.library);
    const changed = setGapIgnore(ignores, t, project, !opts.undo);
    if (!changed) return { tag: t, project, changed };
    writeGapIgnores(config.library, ignores);
    const scope = project ? ` in ${project}` : '';
    const commit = commitPaths(config.library, ['gap-ignores.json'], `refs: ${opts.undo ? 'stop ignoring' : 'ignore'} gap ${t}${scope}`);
    refreshHookCache(config);
    return { tag: t, project, changed, commitError: commit.ok ? undefined : commit.stderr || 'unknown error' };
  });
}
