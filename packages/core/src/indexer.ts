import fs from 'node:fs';
import path from 'node:path';
import { connectAi } from './ai.ts';
import { chunkExtracted } from './chunk.ts';
import type { Config } from './config.ts';
import { indexSheet, indexedState, openDb, removeSheet, sheetMeta, type DB } from './db.ts';
import { discoverProjects, resolveProjectRoot, rootFor } from './detect.ts';
import { embedIndex, type EmbedReport } from './embed.ts';
import { OcrUnavailableError } from './extract/image.ts';
import type { ExtractOptions } from './extract/index.ts';
import { ignoredFor } from './gaps.ts';
import { commitPaths } from './git.ts';
import { buildEntry, matchSheets, newHookCache, readHookCache, statsContext, writeHookCache, type ProjectEntry, type StatsContext } from './hookcache.ts';
import { processInbox, type InboxReport } from './inbox.ts';
import { ensureLibrary, extractCached, sheetAbsPath, syncLibrary, writeExtractCache, writeLibraryOcr, type SyncReport } from './library.ts';
import { LockBusyError, acquireLock, withLock } from './lock.ts';
import { isStale, readManifest, type Sheet } from './manifest.ts';
import { dataPaths, normPath, pathKey } from './paths.ts';
import { retagQueued, type RetagReport } from './review.ts';
import { detectTags, readRules, type Rule } from './rules.ts';
import { blockingFindings, scanSecrets } from './secrets.ts';
import { unusedSheets } from './usage.ts';
import { RefsError, errorMessage, sha256 } from './util.ts';

export interface IndexReport {
  rebuilt: boolean;
  notes: string[];
  warnings: string[];
  sync: SyncReport;
  inbox: InboxReport;
  /** Ollama status for this run. */
  ai: { up: boolean; reason?: string };
  /** Proposals made for sheets queued while Ollama was down. */
  retag: RetagReport | null;
  embed: EmbedReport | null;
  sheets: number;
  /** Sheets (re-)indexed this run. */
  indexed: number;
  /** Sheets dropped from the index (gone from the manifest, missing, or blocked). */
  removed: number;
  projects: ProjectEntry[];
}

/** Delete index.db and its WAL files so the index is rebuilt from the library alone. */
function deleteIndexDb(): void {
  const db = dataPaths().db;
  for (const f of [db, `${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true });
}

interface IndexLibraryOptions {
  /** Ignore the extract cache (refs index --rebuild). */
  fresh: boolean;
  /** Leave out of this run but keep whatever the index already has for them. */
  keep: Set<string>;
  extract: ExtractOptions;
}

/** Index every sheet whose content, title or tags changed; drop the rest from the index. */
async function indexLibrary(db: DB, library: string, sheets: Sheet[], skip: Set<string>, opts: IndexLibraryOptions, warnings: string[]) {
  const state = indexedState(db);
  const present = new Set<string>([...opts.keep].filter((id) => state.has(id)));
  const ocrStored: string[] = [];
  let indexed = 0;
  for (const sheet of sheets) {
    if (skip.has(sheet.id) || opts.keep.has(sheet.id)) continue;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(sheetAbsPath(library, sheet));
    } catch {
      continue;
    }
    const sha = sha256(buf);
    // Changed again since the sync step; the next run picks it up.
    if (sha !== sheet.sha256) continue;
    const prev = state.get(sheet.id);
    if (!opts.fresh && prev && prev.sha256 === sha && prev.meta === sheetMeta(sheet)) {
      present.add(sheet.id);
      continue;
    }
    try {
      const result = await extractCached(sheet.format, buf, sha, opts.fresh, { library, extract: opts.extract });
      if (result.ocr) {
        // The stored OCR text was missing, so OCR ran again: scan it before it goes anywhere.
        if (blockingFindings(scanSecrets(result.text, sheet.secretAllowlist)).length) {
          warnings.push(`${sheet.id}: new OCR text has a likely secret; left out of the index until you redact the image`);
          continue;
        }
        writeExtractCache(sha, result.text);
        ocrStored.push(writeLibraryOcr(library, sha, result.text));
      }
      indexSheet(db, sheet, chunkExtracted(sheet.format, result.text));
      present.add(sheet.id);
      indexed++;
    } catch (e) {
      if (e instanceof OcrUnavailableError && prev) present.add(sheet.id);
      else warnings.push(`${sheet.id}: could not index (${errorMessage(e)})`);
    }
  }
  let removed = 0;
  for (const id of state.keys()) {
    if (present.has(id)) continue;
    removeSheet(db, id);
    removed++;
  }
  if (ocrStored.length) {
    const commit = commitPaths(library, ocrStored, `refs: store OCR text for ${ocrStored.length} sheet${ocrStored.length === 1 ? '' : 's'}`);
    if (!commit.ok) warnings.push(`OCR text stored, but the Git commit failed: ${commit.stderr || 'unknown error'}`);
  }
  return { indexed, removed };
}

/** Scan every discovered project plus any cached project still under a root (added by refs scan). */
function scanAllProjects(config: Config, rules: Rule[], ctx: StatsContext): ProjectEntry[] {
  const paths = discoverProjects(config.roots, rules);
  const keys = new Set(paths.map(pathKey));
  for (const p of readHookCache()?.projects ?? []) {
    if (!keys.has(p.key) && fs.existsSync(p.path) && rootFor(p.path, config.roots)) {
      paths.push(p.path);
      keys.add(p.key);
    }
  }
  return paths.map((p) => buildEntry(p, detectTags(p, rules), ctx));
}

/**
 * refs index: sync the library, update the index, scan projects, write the hook cache.
 * A scheduled run returns null at once if another writer holds the lock; an
 * interactive one waits up to 10 s.
 */
export async function runIndex(config: Config, opts: { rebuild?: boolean; scheduled?: boolean } = {}): Promise<IndexReport | null> {
  let lock;
  try {
    lock = await acquireLock({ waitMs: opts.scheduled ? 0 : 10_000, command: opts.rebuild ? 'index --rebuild' : 'index' });
  } catch (e) {
    if (opts.scheduled && e instanceof LockBusyError) return null;
    throw e;
  }
  try {
    const { library } = config;
    const notes = ensureLibrary(library);
    const warnings: string[] = [];
    const ai = await connectAi(config);
    const extract: ExtractOptions = { ocr: ai.ocr, ocrMaxPages: config.ocrMaxPages };

    const sync = await syncLibrary(library, readManifest(library), { extract });
    if (sync.commitError) warnings.push(`library synced, but the Git commit failed: ${sync.commitError}`);
    if (opts.rebuild) deleteIndexDb();

    const inbox = await processInbox(library, { extract, propose: ai.propose });
    let retag: RetagReport | null = null;
    if (ai.propose) {
      retag = await retagQueued(library, ai.propose);
      warnings.push(...retag.warnings);
      if (retag.commitError) warnings.push(`tag proposals saved, but the Git commit failed: ${retag.commitError}`);
    }

    const sheets = readManifest(library);
    const skip = new Set([...sync.missing, ...sync.blocked.map((b) => b.id), ...sync.unreadable.map((u) => u.id)]);
    const keep = new Set(sync.deferred.map((d) => d.id));
    const db = openDb();
    let counts;
    let embed: EmbedReport | null = null;
    try {
      counts = await indexLibrary(db, library, sheets, skip, { fresh: !!opts.rebuild, keep, extract }, warnings);
      if (ai.up && config.ollama.embedModel) embed = await embedIndex(db, ai.client, config.ollama.embedModel);
    } finally {
      db.close();
    }

    const rules = readRules(library);
    const ctx = statsContext(config);
    const projects = scanAllProjects(config, rules, ctx);
    writeHookCache(newHookCache(config.roots, projects, ctx.now));
    return {
      rebuilt: !!opts.rebuild,
      notes,
      warnings,
      sync,
      inbox,
      ai: { up: ai.up, reason: ai.downReason },
      retag,
      embed,
      sheets: sheets.length,
      ...counts,
      projects,
    };
  } finally {
    lock.release();
  }
}

function projectRootOrThrow(config: Config, dir: string, rules: Rule[]): string {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new RefsError(`not a folder: ${abs}`);
  if (!config.roots.length) throw new RefsError('no roots registered. Add your project folders to "roots" in config.json.');
  const root = rootFor(abs, config.roots);
  if (!root) throw new RefsError(`${normPath(abs)} is not under a registered root (${config.roots.join(', ')}).`);
  const project = resolveProjectRoot(abs, config.roots, rules);
  if (!project) throw new RefsError(`${normPath(abs)} is a registered root itself; scan a project folder inside it.`);
  return project;
}

/** refs scan: re-detect one project and rewrite its hook cache entry. */
export async function scanProject(config: Config, dir: string): Promise<ProjectEntry> {
  return withLock('scan', () => {
    const rules = readRules(config.library);
    const project = projectRootOrThrow(config, dir, rules);
    const ctx = statsContext(config);
    const entry = buildEntry(project, detectTags(project, rules), ctx);
    const cache = readHookCache();
    const others = (cache?.projects ?? []).filter((p) => p.key !== entry.key);
    writeHookCache(newHookCache(config.roots, [...others, entry], ctx.now));
    return entry;
  });
}

export interface SheetInfo {
  id: string;
  title: string;
  status: Sheet['status'];
  stale: boolean;
  learned: boolean;
  lastUsed: string | null;
}

export interface ForReport {
  /** Project root when the target was a folder. */
  project: string | null;
  tags: string[];
  byTag: { tag: string; sheets: SheetInfo[] }[];
  gaps: string[];
  ignoredGaps: string[];
  unused: SheetInfo[];
  truncated: boolean;
}

/** "." and anything with a slash, backslash or drive colon is a path; other words are tags. */
export function looksLikePath(target: string): boolean {
  return target === '.' || target === '..' || /[\\/:]/.test(target);
}

/** refs for <path | "tag tag">: sheets grouped by tag, gaps and unused reminders. Read-only. */
export function forTarget(config: Config, target: string): ForReport {
  const ctx = statsContext(config);
  const rules = readRules(config.library);
  let project: string | null = null;
  let tags: string[];
  let truncated = false;
  if (looksLikePath(target)) {
    const abs = path.resolve(target);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new RefsError(`not a folder: ${abs}`);
    project = resolveProjectRoot(abs, config.roots, rules) ?? normPath(abs);
    const detection = detectTags(project, rules);
    tags = detection.tags;
    truncated = detection.truncated;
  } else {
    tags = target.split(/[\s,]+/).filter(Boolean);
  }
  tags = [...new Set(tags.map(ctx.canonical).filter(Boolean))];

  const info = (s: Sheet): SheetInfo => ({
    id: s.id,
    title: s.title,
    status: s.status,
    stale: isStale(s, ctx.staleAfterDays, ctx.now),
    learned: s.learned,
    lastUsed: ctx.lastUsed.get(s.id)?.toISOString() ?? null,
  });
  const byTag = tags.map((tag) => ({ tag, sheets: matchSheets([tag], ctx).map(info) }));
  const ignored = ignoredFor(ctx.ignores, project);
  const missingTags = tags.filter((t) => !byTag.find((b) => b.tag === t)!.sheets.length);
  const unused = unusedSheets(matchSheets(tags, ctx), ctx.lastUsed, ctx.unusedAfterDays, ctx.now).map(info);
  return {
    project,
    tags,
    byTag,
    gaps: missingTags.filter((t) => !ignored.has(t)),
    ignoredGaps: missingTags.filter((t) => ignored.has(t)),
    unused,
    truncated,
  };
}
