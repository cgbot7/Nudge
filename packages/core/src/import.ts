import fs from 'node:fs';
import path from 'node:path';
import { chunkExtracted, firstH1 } from './chunk.ts';
import { openDb, indexSheet } from './db.ts';
import { extract, formatFromPath, type ExtractOptions } from './extract/index.ts';
import { commitPaths, trackingRepo } from './git.ts';
import { ensureLibrary, inboxDir, writeExtractCache, writeLibraryOcr } from './library.ts';
import type { ProposeFn } from './llm.ts';
import { withLock } from './lock.ts';
import { findBySha, nextId, readManifest, writeManifest, type AllowEntry, type Proposal, type Sheet, type SheetFormat } from './manifest.ts';
import { dataPaths, isInside, normPath, pathKey } from './paths.ts';
import { blockingFindings, scanSecrets, type Finding } from './secrets.ts';
import {
  NudgeError,
  errorCode,
  errorMessage,
  normalizeTag,
  sha256,
  sha256File,
  slugify,
  titleFromFilename,
  today,
  writeFileAtomic,
} from './util.ts';

const LARGE_FILE_BYTES = 20 * 1024 * 1024;

export interface AddOptions {
  tags?: string[];
  /** Skip confirmations (file tracked by another Git repo). */
  yes?: boolean;
  /** Ask the user a yes/no question. Without it, anything needing confirmation fails unless `yes`. */
  confirm?: (question: string) => Promise<boolean>;
  /** OCR, page limit and partial-OCR question for images and scanned PDFs. */
  extract?: ExtractOptions;
  /** LLM title and tag proposal for imports without --tags. Without it the sheet waits in the queue. */
  propose?: ProposeFn | null;
  /** The file sits in the library's inbox (which is inside the library folder). */
  fromInbox?: boolean;
  /** Injectable for tests. */
  fsOps?: FsOps;
}

export interface FsOps {
  rename?: (from: string, to: string) => void;
  unlink?: (file: string) => void;
}

export type AddResult =
  | { kind: 'added'; sheet: Sheet; sections: number; notes: string[]; warnings: string[]; queued?: string }
  | { kind: 'duplicate'; existing: Sheet }
  | { kind: 'blocked'; file: string; format: SheetFormat; findings: Finding[] };

interface Prepared {
  abs: string;
  base: string;
  format: SheetFormat;
  warnings: string[];
}

/** Checks that need no lock: the file exists, is supported and is not already a sheet. */
function prepare(library: string, file: string, opts: AddOptions): Prepared {
  const abs = path.resolve(file);
  const base = path.basename(abs);
  if (/^~\$/.test(base)) throw new NudgeError(`${base} is an Office lock file; ignored.`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new NudgeError(`file not found: ${abs}`);
  }
  if (!stat.isFile()) throw new NudgeError(`not a file: ${abs}`);
  if (isInside(abs, library) && !(opts.fromInbox && isInside(abs, inboxDir(library)))) throw new NudgeError(`${abs} is already inside the library.`);
  const format = formatFromPath(abs);
  if (!format) throw new NudgeError(`unsupported file type "${path.extname(abs)}". Supported: .md, .markdown, .txt, .docx, .pdf, .png, .jpg, .jpeg`);

  const warnings: string[] = [];
  if (stat.size > LARGE_FILE_BYTES) {
    warnings.push(`large file (${(stat.size / 1024 / 1024).toFixed(1)} MB): Git history grows with every version of it.`);
  }
  return { abs, base, format, warnings };
}

/** Import pipeline: hash, extract (OCR), scan, propose tags, move, record, index, commit. */
export async function addFile(library: string, file: string, opts: AddOptions = {}): Promise<AddResult> {
  const prepared = prepare(library, file, opts);
  return withLock('add', () => importPrepared(library, prepared, opts));
}

/** addFile for a caller that already holds the nudge.lock (nudge index processing the inbox). */
export async function importLocked(library: string, file: string, opts: AddOptions = {}): Promise<AddResult> {
  return importPrepared(library, prepare(library, file, opts), opts);
}

async function importPrepared(library: string, { abs, base, format, warnings }: Prepared, opts: AddOptions): Promise<AddResult> {
  const notes = ensureLibrary(library);
  const sheets = readManifest(library);
  const buf = fs.readFileSync(abs);
  const sha = sha256(buf);
  const existing = findBySha(sheets, sha);
  if (existing) return { kind: 'duplicate', existing };

  const extracted = await extract(format, buf, opts.extract);
  warnings.push(...extracted.warnings);

  // OCR text is scanned like any other text before anything is moved or cached.
  const allowlist = pendingAllowFor(abs);
  const findings = scanSecrets(extracted.text, allowlist);
  if (blockingFindings(findings).length) return { kind: 'blocked', file: abs, format, findings };

  const sections = chunkExtracted(format, extracted.text);
  if (!sections.length) throw new NudgeError(`no text found in ${base}; nothing to index.`);

  const repo = trackingRepo(abs);
  if (repo && !opts.yes) {
    const question = `${base} is tracked by the Git repo at ${repo}; moving it shows as a deletion there. Move it anyway?`;
    if (!opts.confirm) throw new NudgeError(`${question.replace(' Move it anyway?', '')} Re-run with --yes to move it.`);
    if (!(await opts.confirm(question))) throw new NudgeError('cancelled; nothing changed.');
  }
  assertNotLocked(abs);

  const tags = [...new Set((opts.tags ?? []).map(normalizeTag).filter(Boolean))];
  let proposal: Proposal | undefined;
  let queued: string | undefined;
  if (!tags.length) {
    const outcome = opts.propose ? await opts.propose({ filename: base, text: extracted.text }) : { kind: 'queued' as const, reason: 'Ollama is not available' };
    if (outcome.kind === 'proposal') proposal = outcome.proposal;
    else queued = outcome.reason;
  }

  writeExtractCache(sha, extracted.text);
  const id = nextId(sheets);
  const title = (format === 'md' || format === 'docx' ? firstH1(extracted.text) : null) ?? titleFromFilename(abs);
  const ext = format === 'jpg' ? '.jpg' : `.${format}`;
  const rel = `sheets/${id}-${slugify(title)}${ext}`;
  const dest = path.join(library, ...rel.split('/'));

  const moved = moveFile(abs, dest, sha, opts.fsOps);
  if (moved.keptOriginal) warnings.push(`copied into the library, but the original could not be deleted (${moved.reason}). Both copies exist now; delete ${abs} yourself.`);
  if (repo) warnings.push(`the move shows as a deletion in ${repo}; commit it there when ready.`);

  const date = today();
  const usedAllow = allowlist.filter((a) => findings.some((f) => f.fingerprint === a.fingerprint));
  const sheet: Sheet = {
    id,
    title,
    file: rel,
    originalPath: normPath(abs),
    sha256: sha,
    format,
    tags,
    status: tags.length ? 'verified' : 'pending',
    source: 'imported',
    learned: false,
    lastVerified: date,
    updatedAt: date,
    secretAllowlist: usedAllow,
    ...(proposal ? { proposal } : {}),
    ...(extracted.ocr ? { ocr: { ...extracted.ocr, at: date } } : {}),
  };
  const ocrRel = extracted.ocr ? writeLibraryOcr(library, sha, extracted.text) : null;
  try {
    writeManifest(library, [...sheets, sheet]);
  } catch (e) {
    if (!moved.keptOriginal) restoreMove(dest, abs);
    if (ocrRel) fs.rmSync(path.join(library, ...ocrRel.split('/')), { force: true });
    throw new NudgeError(`could not write manifest.json (${errorMessage(e)}); the file was put back.`);
  }
  clearPendingAllow(abs);

  try {
    const db = openDb();
    try {
      indexSheet(db, sheet, sections);
    } finally {
      db.close();
    }
  } catch (e) {
    warnings.push(`imported, but indexing failed: ${errorMessage(e)}`);
  }

  const commit = commitPaths(library, ['manifest.json', rel, ...(ocrRel ? [ocrRel] : [])], `nudge: add ${id} ${title}`);
  if (!commit.ok) warnings.push(`imported, but the Git commit failed: ${commit.stderr || 'unknown error'}`);

  return { kind: 'added', sheet, sections: sections.length, notes, warnings, queued };
}

/** Word and other editors hold files open; opening for write fails on a locked file. */
function assertNotLocked(file: string): void {
  try {
    fs.closeSync(fs.openSync(file, 'r+'));
  } catch (e) {
    const code = errorCode(e);
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      throw new NudgeError(`${path.basename(file)} is locked or read-only (open in another program?). Close it and try again; it was left in place.`);
    }
    throw e;
  }
}

export interface MoveResult {
  keptOriginal: boolean;
  reason?: string;
}

/**
 * Move src to dest. Same drive: rename. Across drives: copy, verify the hash, then
 * delete the original; if that delete fails, both copies are kept and reported.
 */
export function moveFile(src: string, dest: string, expectedSha: string, ops: FsOps = {}): MoveResult {
  const { rename = fs.renameSync, unlink = fs.unlinkSync } = ops;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) throw new NudgeError(`refusing to overwrite ${dest}`);
  try {
    rename(src, dest);
    return { keptOriginal: false };
  } catch (e) {
    const code = errorCode(e);
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      throw new NudgeError(`could not move ${path.basename(src)} (${code}: locked or in use?); it was left in place.`);
    }
    if (code !== 'EXDEV') throw e;
  }
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  if (sha256File(dest) !== expectedSha) {
    fs.rmSync(dest, { force: true });
    throw new NudgeError(`copy of ${path.basename(src)} did not verify (hash mismatch); the original was left in place.`);
  }
  try {
    unlink(src);
    return { keptOriginal: false };
  } catch (e) {
    return { keptOriginal: true, reason: errorCode(e) ?? errorMessage(e) };
  }
}

function restoreMove(dest: string, src: string): void {
  try {
    fs.renameSync(dest, src);
  } catch {
    fs.copyFileSync(dest, src);
    fs.rmSync(dest, { force: true });
  }
}

// Allowlist entries for files not yet in the library, keyed by path. Moved onto the
// manifest entry at import. Losing this file only means allowing the finding again.

type PendingAllow = Record<string, AllowEntry[]>;

function readPendingAllow(): PendingAllow {
  try {
    return JSON.parse(fs.readFileSync(dataPaths().pendingAllow, 'utf8')) as PendingAllow;
  } catch {
    return {};
  }
}

function pendingAllowFor(file: string): AllowEntry[] {
  return readPendingAllow()[pathKey(file)] ?? [];
}

function clearPendingAllow(file: string): void {
  const all = readPendingAllow();
  if (!(pathKey(file) in all)) return;
  delete all[pathKey(file)];
  writeFileAtomic(dataPaths().pendingAllow, JSON.stringify(all, null, 2) + '\n');
}

export interface AllowResult {
  finding: Finding;
  /** Set when the file is already a library sheet and its manifest entry was updated. */
  sheetId?: string;
}

/** Allowlist finding `n` (as numbered by the scan) for a file, storing only its fingerprint. */
export async function allowFinding(library: string, file: string, n: number, extractOpts: ExtractOptions = {}): Promise<AllowResult> {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new NudgeError(`file not found: ${abs}`);
  const format = formatFromPath(abs);
  if (!format) throw new NudgeError(`unsupported file type "${path.extname(abs)}".`);
  const { text } = await extract(format, fs.readFileSync(abs), extractOpts);
  const findings = scanSecrets(text);
  const finding = findings.find((f) => f.n === n);
  if (!finding) {
    throw new NudgeError(findings.length ? `no finding ${n}; this file has findings 1 to ${findings.length}.` : 'no secret-scan findings in this file.');
  }
  const entry: AllowEntry = { rule: finding.rule, fingerprint: finding.fingerprint };

  return withLock('allow', () => {
    if (isInside(abs, library)) {
      const sheets = readManifest(library);
      const sheet = sheets.find((s) => pathKey(path.join(library, s.file)) === pathKey(abs));
      if (!sheet) throw new NudgeError(`${abs} is inside the library but not in manifest.json.`);
      if (!sheet.secretAllowlist.some((a) => a.fingerprint === entry.fingerprint)) sheet.secretAllowlist.push(entry);
      writeManifest(library, sheets);
      commitPaths(library, ['manifest.json'], `nudge: allowlist ${finding.rule} finding in ${sheet.id}`);
      return { finding, sheetId: sheet.id };
    }
    const all = readPendingAllow();
    const list = (all[pathKey(abs)] ??= []);
    if (!list.some((a) => a.fingerprint === entry.fingerprint)) list.push(entry);
    writeFileAtomic(dataPaths().pendingAllow, JSON.stringify(all, null, 2) + '\n');
    return { finding };
  });
}
