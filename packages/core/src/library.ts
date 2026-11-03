import fs from 'node:fs';
import path from 'node:path';
import { chunkExtracted, type Section } from './chunk.ts';
import { extract, type ExtractOptions, type Extracted } from './extract/index.ts';
import { OcrUnavailableError } from './extract/image.ts';
import { commitPaths, git, isRepoRoot } from './git.ts';
import { manifestPath, writeManifest, type Sheet } from './manifest.ts';
import { dataPaths, pathKey } from './paths.ts';
import { seedRuleFiles } from './rules.ts';
import { blockingFindings, scanSecrets, type Finding } from './secrets.ts';
import { NudgeError, errorMessage, sha256, today, writeFileAtomic } from './util.ts';

export const LIBRARY_GITIGNORE = 'inbox/\n';
// Git must never rewrite line endings in sheets, or their SHA256 stops matching the manifest.
export const LIBRARY_GITATTRIBUTES = '* -text\n';

/**
 * Create the library folder layout and its Git repo if missing, and seed rules.json
 * and tags.json. Returns human-readable notes about anything it created.
 */
export function ensureLibrary(library: string): string[] {
  const notes: string[] = [];
  const created = !fs.existsSync(library);
  for (const dir of ['sheets', 'drafts']) fs.mkdirSync(path.join(library, dir), { recursive: true });
  if (created) notes.push(`created library at ${library}`);
  if (!fs.existsSync(manifestPath(library))) writeFileAtomic(manifestPath(library), '[]\n');
  const ignore = path.join(library, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, LIBRARY_GITIGNORE);
  const attributes = path.join(library, '.gitattributes');
  if (!fs.existsSync(attributes)) fs.writeFileSync(attributes, LIBRARY_GITATTRIBUTES);
  const seeded = seedRuleFiles(library);

  if (!isRepoRoot(library)) {
    const init = git(library, ['init', '--quiet', '-b', 'main']);
    if (!init.available) throw new NudgeError('git is not installed or not on PATH; the library must be a Git repo.');
    if (!init.ok) throw new NudgeError(`git init failed in ${library}: ${init.stderr}`);
    const commit = commitPaths(library, ['.gitignore', '.gitattributes', 'manifest.json', ...seeded], 'nudge: create library');
    notes.push(commit.ok ? 'initialized library Git repo' : `initialized library Git repo (first commit failed: ${commit.stderr})`);
  } else if (seeded.length) {
    const commit = commitPaths(library, seeded, `nudge: add default ${seeded.join(' and ')}`);
    notes.push(`added default ${seeded.join(' and ')} to the library${commit.ok ? '' : ` (commit failed: ${commit.stderr})`}`);
  }
  return notes;
}

/** Drop folder processed by nudge index; listed in the library's .gitignore. */
export function inboxDir(library: string): string {
  return path.join(library, 'inbox');
}

export function sheetAbsPath(library: string, sheet: Sheet): string {
  return path.join(library, ...sheet.file.split('/'));
}

function extractCacheFile(sha: string): string {
  return path.join(dataPaths().extractCache, `${sha}.txt`);
}

/** Only call for text that passed the secret scan; the cache must never hold a blocked file. */
export function writeExtractCache(sha: string, text: string): void {
  writeFileAtomic(extractCacheFile(sha), text);
}

// OCR text is kept in the library (ocr\<sha256>.txt, committed with the sheet), because
// OCR is slow, needs Ollama and is not deterministic. nudge index --rebuild reads it back
// instead of running the vision model again. Only text that passed the secret scan goes there.

export function ocrTextRel(sha: string): string {
  return `ocr/${sha}.txt`;
}

export function readLibraryOcr(library: string, sha: string): string | null {
  try {
    return fs.readFileSync(path.join(library, 'ocr', `${sha}.txt`), 'utf8');
  } catch {
    return null;
  }
}

/** Returns the library-relative path written. */
export function writeLibraryOcr(library: string, sha: string, text: string): string {
  writeFileAtomic(path.join(library, 'ocr', `${sha}.txt`), text);
  return ocrTextRel(sha);
}

export interface ExtractCachedOptions {
  /** Library whose ocr\ folder holds stored OCR text. */
  library?: string;
  extract?: ExtractOptions;
}

/**
 * Extracted text for a library file, cached by content hash in extract-cache\<sha256>.txt.
 * `fresh` ignores the cache and extracts from the file again (nudge index --rebuild), but
 * OCR text stored in the library is still used. Text from a new OCR run is returned with
 * `ocr` set and not cached: the caller secret-scans it first.
 */
export async function extractCached(format: Sheet['format'], buf: Buffer, sha = sha256(buf), fresh = false, opts: ExtractCachedOptions = {}): Promise<Extracted> {
  const cacheFile = extractCacheFile(sha);
  if (!fresh && fs.existsSync(cacheFile)) return { text: fs.readFileSync(cacheFile, 'utf8'), warnings: [] };
  const stored = opts.library ? readLibraryOcr(opts.library, sha) : null;
  if (stored !== null) {
    writeExtractCache(sha, stored);
    return { text: stored, warnings: [] };
  }
  const result = await extract(format, buf, opts.extract);
  if (!result.ocr) writeExtractCache(sha, result.text);
  return result;
}

/** Sections of a sheet as they are on disk now. */
export async function sheetSections(library: string, sheet: Sheet): Promise<Section[]> {
  const file = sheetAbsPath(library, sheet);
  if (!fs.existsSync(file)) throw new NudgeError(`${sheet.id}: file is missing from the library (${sheet.file}). Run nudge doctor.`);
  const buf = fs.readFileSync(file);
  const { text } = await extractCached(sheet.format, buf, sha256(buf), false, { library });
  return chunkExtracted(sheet.format, text);
}

/** Library-relative paths (forward slashes) of every file under sheets\ and drafts\. */
export function libraryFiles(library: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(dir, e.name), childRel);
      else if (e.isFile() && !e.name.startsWith('~$')) out.push(childRel);
    }
  };
  for (const top of ['sheets', 'drafts']) walk(path.join(library, top), top);
  return out;
}

export interface SyncReport {
  /** Re-extracted with a new sha256 and updatedAt. */
  edited: string[];
  /** Matched to an unknown file with the same hash. */
  renamed: { id: string; from: string; to: string }[];
  /** Still missing after rename matching. Never removed from the manifest; nudge doctor reports them. */
  missing: string[];
  /** Edited, but the new text has likely secrets: not accepted until redacted or allowlisted. */
  blocked: { id: string; file: string; findings: Finding[] }[];
  /** Edited, but the new text could not be extracted. */
  unreadable: { id: string; message: string }[];
  /** Edited, but the new text needs OCR and Ollama is down: the old index entry stays until a later run. */
  deferred: { id: string; message: string }[];
  /** Files in sheets\ or drafts\ that no manifest entry points to. */
  unknown: string[];
  commitError?: string;
}

/**
 * Bring the manifest in line with the library files. Call with the lock held.
 * An edited file gets a new sha256 and updatedAt (lastVerified and status are kept);
 * an unknown file whose hash matches a missing entry is that entry, renamed.
 */
export async function syncLibrary(library: string, sheets: Sheet[], opts: { extract?: ExtractOptions } = {}): Promise<SyncReport> {
  const report: SyncReport = { edited: [], renamed: [], missing: [], blocked: [], unreadable: [], deferred: [], unknown: [] };
  const ocrPaths: string[] = [];
  const date = today();
  for (const sheet of sheets) {
    const file = sheetAbsPath(library, sheet);
    if (!fs.existsSync(file)) {
      report.missing.push(sheet.id);
      continue;
    }
    const buf = fs.readFileSync(file);
    const sha = sha256(buf);
    if (sha === sheet.sha256) continue;
    let result: Extracted;
    try {
      result = await extract(sheet.format, buf, opts.extract);
    } catch (e) {
      if (e instanceof OcrUnavailableError) report.deferred.push({ id: sheet.id, message: e.message });
      else report.unreadable.push({ id: sheet.id, message: errorMessage(e) });
      continue;
    }
    const findings = scanSecrets(result.text, sheet.secretAllowlist);
    if (blockingFindings(findings).length) {
      report.blocked.push({ id: sheet.id, file, findings });
      continue;
    }
    writeExtractCache(sha, result.text);
    if (result.ocr) {
      if (readLibraryOcr(library, sheet.sha256) !== null) {
        fs.rmSync(path.join(library, ...ocrTextRel(sheet.sha256).split('/')), { force: true });
        ocrPaths.push(ocrTextRel(sheet.sha256));
      }
      ocrPaths.push(writeLibraryOcr(library, sha, result.text));
      sheet.ocr = { ...result.ocr, at: date };
    }
    sheet.sha256 = sha;
    sheet.updatedAt = date;
    report.edited.push(sheet.id);
  }

  const known = new Set(sheets.map((s) => pathKey(sheetAbsPath(library, s))));
  report.unknown = libraryFiles(library).filter((rel) => !known.has(pathKey(path.join(library, rel))));
  if (report.missing.length && report.unknown.length) {
    const byHash = new Map<string, string>();
    for (const rel of report.unknown) {
      const sha = sha256(fs.readFileSync(path.join(library, rel)));
      if (!byHash.has(sha)) byHash.set(sha, rel);
    }
    for (const id of [...report.missing]) {
      const sheet = sheets.find((s) => s.id === id)!;
      const rel = byHash.get(sheet.sha256);
      if (!rel) continue;
      byHash.delete(sheet.sha256);
      report.renamed.push({ id, from: sheet.file, to: rel });
      sheet.file = rel;
      report.missing.splice(report.missing.indexOf(id), 1);
      report.unknown.splice(report.unknown.indexOf(rel), 1);
    }
  }

  if (report.edited.length || report.renamed.length) {
    writeManifest(library, sheets);
    const tracked = (rel: string) => git(library, ['ls-files', '--error-unmatch', '--', rel]).ok;
    const paths = [
      'manifest.json',
      ...ocrPaths.filter((rel) => fs.existsSync(path.join(library, rel)) || tracked(rel)),
      ...report.edited.map((id) => sheets.find((s) => s.id === id)!.file),
      ...report.renamed.flatMap((r) => (tracked(r.from) ? [r.from, r.to] : [r.to])),
    ];
    const parts = [report.edited.length && `${report.edited.length} edited`, report.renamed.length && `${report.renamed.length} renamed`].filter(Boolean);
    const commit = commitPaths(library, [...new Set(paths)], `nudge: sync library (${parts.join(', ')})`);
    if (!commit.ok) report.commitError = commit.stderr || 'unknown error';
  }
  return report;
}
