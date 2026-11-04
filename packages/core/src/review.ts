import fs from 'node:fs';
import type { Config } from './config.ts';
import { openDb, removeSheet } from './db.ts';
import { commitPaths } from './git.ts';
import { LEDGER_FILE, rejectInLedger } from './harvest/ledger.ts';
import { refreshHookCache } from './hookcache.ts';
import { extractCached, sheetAbsPath } from './library.ts';
import type { ProposeFn } from './llm.ts';
import { withLock } from './lock.ts';
import { findById, readManifest, writeManifest, type Sheet } from './manifest.ts';
import { addTagsToVocab } from './rules.ts';
import { NudgeError, errorMessage, normalizeTag, today } from './util.ts';

/** The review queue: pending sheets, oldest first. */
export function pendingSheets(library: string): Sheet[] {
  return readManifest(library).filter((s) => s.status === 'pending');
}

/** A draft nudge harvest wrote from a chat: reviewed like a pending sheet. */
export function isHarvestedDraft(sheet: Sheet): boolean {
  return sheet.status === 'draft' && !!sheet.harvest;
}

/** What nudge review walks through: pending sheets, then drafts harvested from chats. */
export function reviewQueue(library: string): Sheet[] {
  const sheets = readManifest(library);
  return [...sheets.filter((s) => s.status === 'pending'), ...sheets.filter(isHarvestedDraft)];
}

export interface ReviewDecision {
  /** Final title; defaults to the proposed title, then the current one. */
  title?: string;
  /** Final tags; defaults to the proposed tags. */
  tags?: string[];
}

export interface ReviewResult {
  sheet: Sheet;
  /** Tags that were new to the library and are now in tags.json. */
  addedToVocab: string[];
  commitError?: string;
}

/**
 * Confirm a pending sheet (or a draft harvested from a chat): it becomes verified with
 * lastVerified today, takes the chosen (or proposed) title and tags, and its proposal is
 * dropped. New tags join tags.json. A harvested draft's own tags count as its proposal.
 */
export function acceptReview(config: Config, id: string, decision: ReviewDecision = {}, opts: { waitMs?: number } = {}): Promise<ReviewResult> {
  return withLock('review', () => {
    const sheets = readManifest(config.library);
    const sheet = findById(sheets, id);
    if (!sheet) throw new NudgeError(`no sheet with id ${id}.`);
    const draft = isHarvestedDraft(sheet);
    if (sheet.status !== 'pending' && !draft) throw new NudgeError(`${id} is ${sheet.status}, not pending; there is nothing to review.`);
    const tags = [...new Set((decision.tags ?? sheet.proposal?.tags ?? (draft ? sheet.tags : [])).map(normalizeTag).filter(Boolean))];
    if (!tags.length) throw new NudgeError(`${id} has no proposed tags; give them with --tags a,b.`);
    const title = (decision.title ?? sheet.proposal?.title ?? sheet.title).trim() || sheet.title;

    sheet.title = title;
    sheet.tags = tags;
    sheet.status = 'verified';
    sheet.lastVerified = today();
    delete sheet.proposal;
    writeManifest(config.library, sheets);
    const addedToVocab = addTagsToVocab(config.library, tags);
    const commit = commitPaths(config.library, ['manifest.json', ...(addedToVocab.length ? ['tags.json'] : [])], `nudge: review ${id} (verified: ${tags.join(', ')})`);
    refreshHookCache(config);
    return { sheet, addedToVocab, commitError: commit.ok ? undefined : commit.stderr || 'unknown error' };
  }, opts);
}

export interface RejectResult {
  sheet: Sheet;
  /** Origins that nudge harvest will never copy again. */
  origins: string[];
  commitError?: string;
}

/**
 * Reject a harvested sheet: it leaves the manifest, the library and the index, and its
 * origins are marked rejected in harvest-seen.json. Git history keeps the old copy, and
 * the origin itself is never touched.
 */
export function rejectReview(config: Config, id: string, opts: { waitMs?: number } = {}): Promise<RejectResult> {
  return withLock('review', () => {
    const { library } = config;
    const sheets = readManifest(library);
    const sheet = findById(sheets, id);
    if (!sheet) throw new NudgeError(`no sheet with id ${id}.`);
    if (!sheet.harvest) throw new NudgeError(`${id} was not harvested; only harvested sheets can be rejected. Delete a sheet you imported yourself by hand.`);
    writeManifest(library, sheets.filter((s) => s.id !== id));
    fs.rmSync(sheetAbsPath(library, sheet), { force: true });
    const origins = rejectInLedger(library, id);
    try {
      const db = openDb();
      try {
        removeSheet(db, id);
      } finally {
        db.close();
      }
    } catch {
      // The next nudge index drops it from the index anyway.
    }
    const commit = commitPaths(library, ['manifest.json', sheet.file, ...(origins.length ? [LEDGER_FILE] : [])], `nudge: reject harvested ${id} ${sheet.title}`);
    refreshHookCache(config);
    return { sheet, origins, commitError: commit.ok ? undefined : commit.stderr || 'unknown error' };
  }, opts);
}

export interface RetagReport {
  proposed: string[];
  /** Still waiting (Ollama went away part way, or the model is missing). */
  queued: string[];
  warnings: string[];
  commitError?: string;
}

/**
 * Ask for proposals for pending sheets that have none yet (imported while Ollama was
 * down). Call with the nudge.lock held; writes and commits manifest.json once.
 */
export async function retagQueued(library: string, propose: ProposeFn): Promise<RetagReport> {
  const report: RetagReport = { proposed: [], queued: [], warnings: [] };
  const sheets = readManifest(library);
  const todo = sheets.filter((s) => s.status === 'pending' && !s.proposal);
  for (const sheet of todo) {
    if (report.queued.length) {
      report.queued.push(sheet.id);
      continue;
    }
    let text: string;
    try {
      const buf = fs.readFileSync(sheetAbsPath(library, sheet));
      text = (await extractCached(sheet.format, buf, sheet.sha256, false, { library })).text;
    } catch (e) {
      report.warnings.push(`${sheet.id}: could not read it for tagging (${errorMessage(e)})`);
      continue;
    }
    const outcome = await propose({ filename: sheet.file.split('/').pop()!, text });
    if (outcome.kind === 'queued') {
      report.queued.push(sheet.id);
      continue;
    }
    sheet.proposal = outcome.proposal;
    report.proposed.push(sheet.id);
  }
  if (report.proposed.length) {
    writeManifest(library, sheets);
    const commit = commitPaths(library, ['manifest.json'], `nudge: tag proposals for ${report.proposed.join(', ')}`);
    if (!commit.ok) report.commitError = commit.stderr || 'unknown error';
  }
  return report;
}
