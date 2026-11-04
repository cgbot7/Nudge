import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { NudgeError, daysSince, decodeText, errorMessage, writeFileAtomic } from './util.ts';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const SheetFormat = z.enum(['md', 'txt', 'docx', 'pdf', 'png', 'jpg']);
export type SheetFormat = z.infer<typeof SheetFormat>;

export const AllowEntrySchema = z.object({
  rule: z.string(),
  fingerprint: z.string(),
});
export type AllowEntry = z.infer<typeof AllowEntrySchema>;

/** LLM title and tag proposal waiting in the review queue (pending sheets only). */
export const ProposalSchema = z.object({
  title: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /** Proposed tags not yet in tags.json or on any sheet: accepting them adds them to tags.json. */
  newTags: z.array(z.string()).default([]),
  model: z.string(),
  at: isoDate,
  /** Set when the model gave no usable answer; review then asks for tags directly. */
  error: z.string().optional(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/** Present when the text came from OCR, which can mangle code and commands. */
export const OcrInfoSchema = z.object({
  model: z.string(),
  at: isoDate,
  /** Scanned PDF pages that were OCR'd, and how many pages had no text layer in all. */
  pages: z.number().int().nonnegative().optional(),
  scannedPages: z.number().int().nonnegative().optional(),
});
export type OcrInfo = z.infer<typeof OcrInfoSchema>;

/** How an LLM draft was made (source llm). Kept after nudge approve as provenance. */
export const LlmInfoSchema = z.object({
  model: z.string(),
  at: isoDate,
  /** Project the suggestion was made for. */
  project: z.string().optional(),
});
export type LlmInfo = z.infer<typeof LlmInfoSchema>;

/** Where nudge harvest copied a sheet from (source harvested). The origin is only ever read. */
export const HarvestInfoSchema = z.object({
  /** Harvest source name, such as claude-memory or claude-chats. */
  tool: z.string(),
  kind: z.enum(['file', 'chat']),
  /** Normalized path of the file it was copied from. */
  origin: z.string(),
  at: isoDate,
  /** Project the origin belongs to, when the tool keeps one (Claude Code project folder). */
  project: z.string().optional(),
  /** Chats only: the ledger key of the conversation the draft was written from. */
  conversation: z.string().optional(),
});
export type HarvestInfo = z.infer<typeof HarvestInfoSchema>;

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
  source: z.enum(['imported', 'llm', 'harvested']),
  learned: z.boolean().default(false),
  lastVerified: isoDate,
  updatedAt: isoDate,
  secretAllowlist: z.array(AllowEntrySchema).default([]),
  proposal: ProposalSchema.optional(),
  ocr: OcrInfoSchema.optional(),
  llm: LlmInfoSchema.optional(),
  harvest: HarvestInfoSchema.optional(),
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
    throw new NudgeError(`manifest.json is not valid JSON (${file}): ${errorMessage(e)}`);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NudgeError(`manifest.json is invalid (${file}):\n${z.prettifyError(parsed.error)}`);
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
