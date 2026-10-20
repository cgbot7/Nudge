import fs from 'node:fs';
import path from 'node:path';
import { chunkExtracted, type Section } from './chunk.ts';
import { extract } from './extract/index.ts';
import { commitPaths, git, isRepoRoot } from './git.ts';
import { manifestPath, type Sheet } from './manifest.ts';
import { dataPaths } from './paths.ts';
import { RefsError, sha256, writeFileAtomic } from './util.ts';

export const LIBRARY_GITIGNORE = 'inbox/\n';
// Git must never rewrite line endings in sheets, or their SHA256 stops matching the manifest.
export const LIBRARY_GITATTRIBUTES = '* -text\n';

/**
 * Create the library folder layout and its Git repo if missing.
 * Returns human-readable notes about anything it created.
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

  if (!isRepoRoot(library)) {
    const init = git(library, ['init', '--quiet', '-b', 'main']);
    if (!init.available) throw new RefsError('git is not installed or not on PATH; the library must be a Git repo.');
    if (!init.ok) throw new RefsError(`git init failed in ${library}: ${init.stderr}`);
    const commit = commitPaths(library, ['.gitignore', '.gitattributes', 'manifest.json'], 'refs: create library');
    notes.push(commit.ok ? 'initialized library Git repo' : `initialized library Git repo (first commit failed: ${commit.stderr})`);
  }
  return notes;
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

/** Extracted text for a library file, cached by content hash in extract-cache\<sha256>.txt. */
export async function extractCached(format: Sheet['format'], buf: Buffer, sha = sha256(buf)): Promise<{ text: string; warnings: string[] }> {
  const cacheFile = extractCacheFile(sha);
  if (fs.existsSync(cacheFile)) return { text: fs.readFileSync(cacheFile, 'utf8'), warnings: [] };
  const result = await extract(format, buf);
  writeExtractCache(sha, result.text);
  return result;
}

/** Sections of a sheet as they are on disk now. */
export async function sheetSections(library: string, sheet: Sheet): Promise<Section[]> {
  const file = sheetAbsPath(library, sheet);
  if (!fs.existsSync(file)) throw new RefsError(`${sheet.id}: file is missing from the library (${sheet.file}). Run refs doctor.`);
  const buf = fs.readFileSync(file);
  const { text } = await extractCached(sheet.format, buf);
  return chunkExtracted(sheet.format, text);
}
