import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Sheet } from './manifest.ts';
import { pathKey } from './paths.ts';
import { NudgeError, decodeText, errorMessage, normalizeTag, writeFileAtomic } from './util.ts';

// gap-ignores.json lives in the library: it is your intent, not derived data, so it
// survives deleting %LOCALAPPDATA%\nudge and syncs with the library repo.

const GapIgnoresSchema = z.object({
  global: z.array(z.string()).default([]),
  /** Project path key (see pathKey) to tags ignored only there. */
  projects: z.record(z.string(), z.array(z.string())).default({}),
});
export type GapIgnores = z.infer<typeof GapIgnoresSchema>;

export function gapIgnoresPath(library: string): string {
  return path.join(library, 'gap-ignores.json');
}

export function readGapIgnores(library: string): GapIgnores {
  const file = gapIgnoresPath(library);
  if (!fs.existsSync(file)) return { global: [], projects: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(decodeText(fs.readFileSync(file)));
  } catch (e) {
    throw new NudgeError(`gap-ignores.json is not valid JSON (${file}): ${errorMessage(e)}`);
  }
  const parsed = GapIgnoresSchema.safeParse(raw);
  if (!parsed.success) throw new NudgeError(`gap-ignores.json is invalid (${file}):\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function writeGapIgnores(library: string, ignores: GapIgnores): void {
  writeFileAtomic(gapIgnoresPath(library), JSON.stringify(ignores, null, 2) + '\n');
}

/** Add or remove an ignore. Returns false when nothing changed. */
export function setGapIgnore(ignores: GapIgnores, tag: string, project: string | null, ignored: boolean): boolean {
  const t = normalizeTag(tag);
  const key = project ? pathKey(project) : null;
  const list = key ? (ignores.projects[key] ??= []) : ignores.global;
  const has = list.includes(t);
  if (has === ignored) {
    if (key && !list.length) delete ignores.projects[key];
    return false;
  }
  if (ignored) list.push(t);
  else list.splice(list.indexOf(t), 1);
  if (key && !list.length) delete ignores.projects[key];
  return true;
}

export function ignoredFor(ignores: GapIgnores, project: string | null): Set<string> {
  return new Set([...ignores.global, ...(project ? (ignores.projects[pathKey(project)] ?? []) : [])].map(normalizeTag));
}

/** A gap is a detected tag with zero sheets of any status. */
export function computeGaps(tags: string[], sheets: Sheet[], canonical: (t: string) => string, ignored: Set<string>): string[] {
  const covered = new Set(sheets.flatMap((s) => s.tags.map(canonical)));
  return tags.filter((t) => !covered.has(t) && !ignored.has(t));
}
