import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { RefsError, daysSince, decodeText, errorMessage, writeFileAtomic } from './util.ts';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const SheetFormat = z.enum(['md', 'txt', 'docx', 'pdf', 'png', 'jpg']);
export type SheetFormat = z.infer<typeof SheetFormat>;

export const AllowEntrySchema = z.object({
  rule: z.string(),
  fingerprint: z.string(),
});
export type AllowEntry = z.infer<typeof AllowEntrySchema>;

// Loose so fields added by hand or by later milestones survive a rewrite.
export const SheetSchema = z.looseObject({
  id: z.string().regex(/^s_\d{4,}$/, 'expected s_0000'),
  title: z.string().min(1),
  file: z.string().min(1),
  originalPath: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  format: SheetFormat,
  tags: z.array(z.string()),
  status: z.enum(['pending', 'verified', 'draft']),
  source: z.enum(['imported', 'llm']),
  learned: z.boolean().default(false),
  lastVerified: isoDate,
  updatedAt: isoDate,
  secretAllowlist: z.array(AllowEntrySchema).default([]),
});
export type Sheet = z.infer<typeof SheetSchema>;

const ManifestSchema = z.array(SheetSchema).superRefine((sheets, ctx) => {
  const seen = new Set<string>();
  for (const [i, s] of sheets.entries()) {
    if (seen.has(s.id)) ctx.addIssue({ code: 'custom', message: `duplicate id ${s.id}`, path: [i, 'id'] });
    seen.add(s.id);
  }
});

export function manifestPath(library: string): string {
  return path.join(library, 'manifest.json');
}

export function readManifest(library: string): Sheet[] {
  const file = manifestPath(library);
  if (!fs.existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(decodeText(fs.readFileSync(file)));
  } catch (e) {
    throw new RefsError(`manifest.json is not valid JSON (${file}): ${errorMessage(e)}`);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RefsError(`manifest.json is invalid (${file}):\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export function writeManifest(library: string, sheets: Sheet[]): void {
  writeFileAtomic(manifestPath(library), JSON.stringify(sheets, null, 2) + '\n');
}

export function nextId(sheets: Sheet[]): string {
  const max = sheets.reduce((m, s) => Math.max(m, Number(s.id.slice(2))), 0);
  return `s_${String(max + 1).padStart(4, '0')}`;
}

export function findById(sheets: Sheet[], id: string): Sheet | undefined {
  return sheets.find((s) => s.id === id);
}

export function findBySha(sheets: Sheet[], sha: string): Sheet | undefined {
  return sheets.find((s) => s.sha256 === sha);
}

/** Stale: lastVerified is more than `staleAfterDays` days ago. */
export function isStale(sheet: Sheet, staleAfterDays: number, now = new Date()): boolean {
  return daysSince(sheet.lastVerified, now) > staleAfterDays;
}
