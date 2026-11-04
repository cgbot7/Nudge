import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { ExtractOptions } from '../extract/index.ts';
import { commitPaths } from '../git.ts';
import { importLocked, pendingAllowFor } from '../import.ts';
import { sheetAbsPath } from '../library.ts';
import type { ProposeFn } from '../llm.ts';
import { findById, readManifest, type Sheet } from '../manifest.ts';
import { normPath, pathKey } from '../paths.ts';
import { blockingFindings, scanSecrets, type Finding } from '../secrets.ts';
import { NudgeError, errorMessage, sha256, slugify, today, writeFileAtomic } from '../util.ts';
import { LEDGER_FILE, readLedger, writeLedger, type LedgerFileEntry } from './ledger.ts';
import { SOURCES, SOURCE_NAMES, readOrigin, type Candidate, type SourceName } from './sources.ts';

export * from './ledger.ts';
export * from './sources.ts';

// nudge harvest: copy notes that LLM tools wrote to disk (Claude Code memory) into the
// library. Unlike nudge add, the origin is never moved: those tools still need their files. New notes go through the normal import (secret scan, tag proposal, pending
// in the review queue). A note that changes at its origin updates its library copy, unless
// you edited the copy; the next library sync then re-indexes it.

export interface HarvestOptions {
  propose?: ProposeFn | null;
  extract?: ExtractOptions;
  /** Report what would change without writing anything. */
  dryRun?: boolean;
  /** Only these sources (still only the enabled ones unless `force`). */
  only?: SourceName[];
  /** Run sources even when harvest.sources turns them off (nudge harvest --source x). */
  force?: boolean;
}

export interface HarvestItem {
  source: SourceName;
  origin: string;
}

export interface HarvestReport {
  dryRun: boolean;
  sources: { name: SourceName; label: string; dir: string; found: boolean; files: number }[];
  added: (HarvestItem & { sheet: Sheet; warnings: string[]; queued?: string })[];
  /** Library copy rewritten from a changed origin. nudge index re-indexes it. */
  updated: (HarvestItem & { id: string })[];
  /** Origin changed, but you edited the library copy, so it was left as it is. */
  edited: (HarvestItem & { id: string })[];
  /** Same content as a sheet already in the library. */
  duplicates: (HarvestItem & { existing: string })[];
  blocked: (HarvestItem & { findings: Finding[] })[];
  failed: (HarvestItem & { reason: string })[];
  /** Dry run only: new notes that would be imported. */
  wouldAdd: HarvestItem[];
  /** Dry run only: library copies that would be rewritten. */
  wouldUpdate: (HarvestItem & { id: string })[];
  /** New notes left for a later run (harvest.maxPerRun). */
  deferred: number;
  unchanged: number;
  rejected: number;
  commitError?: string;
}

function emptyReport(dryRun: boolean): HarvestReport {
  return { dryRun, sources: [], added: [], updated: [], edited: [], duplicates: [], blocked: [], failed: [], wouldAdd: [], wouldUpdate: [], deferred: 0, unchanged: 0, rejected: 0 };
}

/** A temp .md named after the note, so the import sees a sensible file name. */
function writeTemp(dir: string, title: string, text: string): string {
  const file = path.join(dir, `${slugify(title) || 'note'}.md`);
  fs.writeFileSync(file, text);
  return file;
}

function titleOf(text: string): string {
  return /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? 'note';
}

/**
 * Harvest every enabled source. Call with the nudge.lock held. Each new sheet gets its own
 * commit (as nudge add does); harvest-seen.json and rewritten copies are left for the
 * caller's library sync, except that harvest-seen.json is committed here.
 */
export async function runHarvest(config: Config, opts: HarvestOptions = {}): Promise<HarvestReport> {
  const { library } = config;
  const dryRun = !!opts.dryRun;
  const report = emptyReport(dryRun);
  const ledger = readLedger(library);
  let ledgerChanged = false;
  const setEntry = (key: string, entry: LedgerFileEntry) => {
    ledger.files[key] = entry;
    ledgerChanged = true;
  };

  const names = (opts.only?.length ? opts.only : [...SOURCE_NAMES]).filter((n) => opts.force || config.harvest.sources[n]);
  const candidates: Candidate[] = [];
  for (const name of names) {
    const source = SOURCES[name];
    const dir = source.dir();
    const list = source.list();
    report.sources.push({ name, label: source.label, dir: normPath(dir), found: fs.existsSync(dir), files: list.length });
    candidates.push(...list);
  }

  let tempDir: string | null = null;
  let added = 0;
  try {
    for (const c of candidates) {
      const origin = normPath(c.file);
      const item: HarvestItem = { source: c.source, origin };
      const key = pathKey(c.file);
      const entry = ledger.files[key];
      if (entry?.rejected) {
        report.rejected++;
        continue;
      }
      let raw: { buf: Buffer; text: string };
      try {
        raw = readOrigin(c.file);
      } catch (e) {
        report.failed.push({ ...item, reason: `could not read it (${errorMessage(e)})` });
        continue;
      }
      const originSha = sha256(raw.buf);
      if (entry && entry.originSha === originSha) {
        report.unchanged++;
        continue;
      }
      const text = SOURCES[c.source].render(c.file, raw.text);
      const sheets = readManifest(library);
      const sheet = entry?.sheetId ? findById(sheets, entry.sheetId) : undefined;

      if (entry && sheet) {
        // Seen before and still in the library: update the copy in place.
        let current: string;
        try {
          current = sha256(fs.readFileSync(sheetAbsPath(library, sheet)));
        } catch {
          report.failed.push({ ...item, reason: `${sheet.id} is missing from the library (${sheet.file}); see nudge doctor` });
          continue;
        }
        const next = sha256(text);
        if (current !== entry.librarySha) {
          report.edited.push({ ...item, id: sheet.id });
          if (!dryRun) setEntry(key, { ...entry, originSha });
          continue;
        }
        if (next === current) {
          if (!dryRun) setEntry(key, { ...entry, originSha });
          report.unchanged++;
          continue;
        }
        const findings = scanSecrets(text, [...sheet.secretAllowlist, ...pendingAllowFor(c.file)]);
        if (blockingFindings(findings).length) {
          report.blocked.push({ ...item, findings });
          continue;
        }
        if (dryRun) {
          report.wouldUpdate.push({ ...item, id: sheet.id });
          continue;
        }
        writeFileAtomic(sheetAbsPath(library, sheet), text);
        setEntry(key, { ...entry, originSha, librarySha: next });
        report.updated.push({ ...item, id: sheet.id });
        continue;
      }

      // New to the library (or its sheet was removed by hand): import it.
      if (dryRun) {
        report.wouldAdd.push(item);
        continue;
      }
      if (added >= config.harvest.maxPerRun) {
        report.deferred++;
        continue;
      }
      tempDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-harvest-'));
      const temp = writeTemp(tempDir, titleOf(text), text);
      try {
        const r = await importLocked(library, temp, {
          yes: true,
          propose: opts.propose,
          extract: opts.extract,
          harvest: { origin: c.file, info: { tool: c.source, kind: 'file', origin, at: today(), ...(c.project ? { project: c.project } : {}) } },
        });
        if (r.kind === 'added') {
          added++;
          report.added.push({ ...item, sheet: r.sheet, warnings: r.warnings, queued: r.queued });
          setEntry(key, { origin, originSha, sheetId: r.sheet.id, librarySha: r.sheet.sha256 });
        } else if (r.kind === 'duplicate') {
          report.duplicates.push({ ...item, existing: r.existing.id });
          // Only a harvested sheet follows its origin; a sheet you imported yourself is never rewritten.
          const follows = r.existing.source === 'harvested' ? { sheetId: r.existing.id, librarySha: r.existing.sha256 } : {};
          setEntry(key, { origin, originSha, ...follows });
        } else {
          report.blocked.push({ ...item, findings: r.findings });
        }
      } catch (e) {
        if (!(e instanceof NudgeError)) throw e;
        report.failed.push({ ...item, reason: e.message });
        setEntry(key, { origin, originSha, skipped: e.message });
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }

  if (ledgerChanged) {
    writeLedger(library, ledger);
    const parts = [
      report.added.length && `${report.added.length} new`,
      report.updated.length && `${report.updated.length} updated`,
    ].filter(Boolean);
    const commit = commitPaths(library, [LEDGER_FILE], `nudge: harvest${parts.length ? ` (${parts.join(', ')})` : ''}`);
    if (!commit.ok && !/nothing (added )?to commit|no changes added/i.test(commit.stdout + commit.stderr)) report.commitError = commit.stderr || 'unknown error';
  }
  return report;
}
