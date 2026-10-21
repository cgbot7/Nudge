import fs from 'node:fs';
import type { Config } from './config.ts';
import { computeGaps, ignoredFor, readGapIgnores, type GapIgnores } from './gaps.ts';
import { acquireLock } from './lock.ts';
import { isStale, readManifest, type Sheet } from './manifest.ts';
import { dataPaths, normPath, pathKey } from './paths.ts';
import { readTagVocab, tagResolver } from './rules.ts';
import { lastUsedById, readUsage, unusedSheets } from './usage.ts';
import { decodeText, writeFileAtomic } from './util.ts';

export interface ProjectEntry {
  /** pathKey of the project root: what the prompt hook matches against. Must stay the first field. */
  key: string;
  path: string;
  tags: string[];
  /** Sheets carrying any detected tag, any status. */
  sheets: number;
  stale: number;
  gaps: string[];
  /** Relevant unused sheets in "try:" rotation order. */
  unused: { id: string; title: string }[];
  /** Titles of `unused`, for the hook. */
  try: string[];
  /** The hook prints head + (try ? ` | try: "<title>"` : '') + tail. */
  head: string;
  tail: string;
  /** The 5,000-file cap stopped the scan, so tags may be incomplete. */
  truncated: boolean;
  scannedAt: string;
}

export interface HookCache {
  version: 1;
  generatedAt: string;
  /** Registered roots as path keys. */
  roots: string[];
  projects: ProjectEntry[];
}

export const NO_TAGS_LINE = 'refs: no tags (add a rule to rules.json)';

export interface StatsContext {
  sheets: Sheet[];
  canonical: (tag: string) => string;
  lastUsed: Map<string, Date>;
  ignores: GapIgnores;
  staleAfterDays: number;
  unusedAfterDays: number;
  now: Date;
}

export function statsContext(config: Config, now = new Date()): StatsContext {
  return {
    sheets: readManifest(config.library),
    canonical: tagResolver(readTagVocab(config.library)),
    lastUsed: lastUsedById(readUsage()),
    ignores: readGapIgnores(config.library),
    staleAfterDays: config.staleAfterDays,
    unusedAfterDays: config.unusedAfterDays,
    now,
  };
}

/** Sheets carrying any of `tags` (aliases resolved through tags.json). */
export function matchSheets(tags: string[], ctx: StatsContext): Sheet[] {
  const want = new Set(tags.map(ctx.canonical));
  return ctx.sheets.filter((s) => s.tags.some((t) => want.has(ctx.canonical(t))));
}

export function headLine(tags: string[], sheets: number, stale: number, gaps: string[]): string {
  if (!tags.length) return NO_TAGS_LINE;
  let line = `refs [${tags.join(', ')}] ${sheets} sheet${sheets === 1 ? '' : 's'}`;
  if (stale) line += ` (${stale} stale)`;
  if (gaps.length) line += ` | gap: ${gaps.join(', ')}`;
  return line;
}

export function buildEntry(project: string, detection: { tags: string[]; truncated: boolean }, ctx: StatsContext, scannedAt = ctx.now.toISOString()): ProjectEntry {
  const tags = [...new Set(detection.tags.map(ctx.canonical))];
  const matched = matchSheets(tags, ctx);
  const stale = matched.filter((s) => isStale(s, ctx.staleAfterDays, ctx.now)).length;
  const gaps = computeGaps(tags, ctx.sheets, ctx.canonical, ignoredFor(ctx.ignores, project));
  const unused = unusedSheets(matched, ctx.lastUsed, ctx.unusedAfterDays, ctx.now).map((s) => ({ id: s.id, title: s.title }));
  return {
    key: pathKey(project),
    path: normPath(project),
    tags,
    sheets: matched.length,
    stale,
    gaps,
    unused,
    try: unused.map((u) => u.title),
    head: headLine(tags, matched.length, stale, gaps),
    tail: tags.length ? ' | refs for .' : '',
    truncated: detection.truncated,
    scannedAt,
  };
}

/** The line the hook prints for an entry, showing try suggestion `n` (rotation). */
export function hookLine(entry: ProjectEntry, n = 0): string {
  const pick = entry.try.length ? ` | try: "${entry.try[n % entry.try.length]}"` : '';
  return entry.head + pick + entry.tail;
}

/**
 * Valid JSON with one project per line, each line starting with {"key":"...". The
 * PowerShell hook relies on this layout to find its project with a plain string search,
 * because ConvertFrom-Json costs 30+ ms on a cold Windows PowerShell 5.1 session.
 */
export function serializeHookCache(cache: HookCache): string {
  const header = JSON.stringify({ version: cache.version, generatedAt: cache.generatedAt, roots: cache.roots });
  const projects = [...cache.projects].sort((a, b) => a.key.localeCompare(b.key)).map((p) => JSON.stringify(p));
  return `${header.slice(0, -1)},"projects":[\n${projects.join(',\n')}\n]}\n`;
}

export function writeHookCache(cache: HookCache): void {
  writeFileAtomic(dataPaths().hookCache, serializeHookCache(cache));
}

/** The cache, or null when it is missing or unreadable. */
export function readHookCache(): HookCache | null {
  try {
    const cache = JSON.parse(decodeText(fs.readFileSync(dataPaths().hookCache))) as HookCache;
    return cache.version === 1 && Array.isArray(cache.projects) && Array.isArray(cache.roots) ? cache : null;
  } catch {
    return null;
  }
}

/** Tags of the project the prompt hook last saw you enter (last-project.json); [] when unknown. */
export function readLastProjectTags(): string[] {
  try {
    const last = JSON.parse(decodeText(fs.readFileSync(dataPaths().lastProject))) as { tags?: unknown };
    return Array.isArray(last.tags) ? last.tags.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export function newHookCache(roots: string[], projects: ProjectEntry[], now = new Date()): HookCache {
  return { version: 1, generatedAt: now.toISOString(), roots: roots.map(pathKey), projects };
}

/**
 * Recompute counts, gaps and reminders from the tags already in the cache, without
 * rescanning projects. Call with the lock held. Returns null when there is no cache.
 */
export function refreshHookCache(config: Config, now = new Date()): HookCache | null {
  const cache = readHookCache();
  if (!cache) return null;
  const ctx = statsContext(config, now);
  const fresh = newHookCache(
    config.roots,
    cache.projects.map((p) => buildEntry(p.path, p, ctx, p.scannedAt)),
    now,
  );
  writeHookCache(fresh);
  return fresh;
}

/** Best-effort refresh for read-mostly commands (refs open): skipped if another writer holds the lock. */
export async function tryRefreshHookCache(config: Config): Promise<void> {
  let lock;
  try {
    lock = await acquireLock({ waitMs: 0, command: 'refresh hook cache' });
  } catch {
    return;
  }
  try {
    refreshHookCache(config);
  } catch {
    // The next refs index rewrites the cache anyway.
  } finally {
    lock.release();
  }
}
