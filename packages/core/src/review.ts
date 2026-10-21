import fs from 'node:fs';
import type { Config } from './config.ts';
import { commitPaths } from './git.ts';
import { refreshHookCache } from './hookcache.ts';
import { extractCached, sheetAbsPath } from './library.ts';
import type { ProposeFn } from './llm.ts';
import { withLock } from './lock.ts';
import { findById, readManifest, writeManifest, type Sheet } from './manifest.ts';
import { addTagsToVocab } from './rules.ts';
import { RefsError, errorMessage, normalizeTag, today } from './util.ts';

/** The review queue: pending sheets, oldest first. */
export function pendingSheets(library: string): Sheet[] {
  return readManifest(library).filter((s) => s.status === 'pending');
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
 * Confirm a pending sheet: it becomes verified with lastVerified today, takes the
 * chosen (or proposed) title and tags, and its proposal is dropped. New tags join tags.json.
 */
export function acceptReview(config: Config, id: string, decision: ReviewDecision = {}): Promise<ReviewResult> {
  return withLock('review', () => {
    const sheets = readManifest(config.library);
    const sheet = findById(sheets, id);
    if (!sheet) throw new RefsError(`no sheet with id ${id}.`);
    if (sheet.status !== 'pending') throw new RefsError(`${id} is ${sheet.status}, not pending; there is nothing to review.`);
    const tags = [...new Set((decision.tags ?? sheet.proposal?.tags ?? []).map(normalizeTag).filter(Boolean))];
    if (!tags.length) throw new RefsError(`${id} has no proposed tags; give them with --tags a,b.`);
    const title = (decision.title ?? sheet.proposal?.title ?? sheet.title).trim() || sheet.title;

    sheet.title = title;
    sheet.tags = tags;
    sheet.status = 'verified';
    sheet.lastVerified = today();
    delete sheet.proposal;
    writeManifest(config.library, sheets);
    const addedToVocab = addTagsToVocab(config.library, tags);
    const commit = commitPaths(config.library, ['manifest.json', ...(addedToVocab.length ? ['tags.json'] : [])], `refs: review ${id} (verified: ${tags.join(', ')})`);
    refreshHookCache(config);
    return { sheet, addedToVocab, commitError: commit.ok ? undefined : commit.stderr || 'unknown error' };
  });
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
 * down). Call with the refs.lock held; writes and commits manifest.json once.
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
    const commit = commitPaths(library, ['manifest.json'], `refs: tag proposals for ${report.proposed.join(', ')}`);
    if (!commit.ok) report.commitError = commit.stderr || 'unknown error';
  }
  return report;
}
