import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { NudgeError, decodeText, errorMessage, writeFileAtomic } from '../util.ts';

// harvest-seen.json lives in the library, like gap-ignores.json: which origins were
// copied, and which ones you rejected, is your intent and not derived data. So deleting
// %LOCALAPPDATA%\nudge and running nudge index --rebuild never offers a rejected note again.

export const LEDGER_FILE = 'harvest-seen.json';

const FileEntrySchema = z.object({
  /** Normalized origin path (forward slashes, lowercase drive letter). */
  origin: z.string(),
  /** sha256 of the origin file when it was last looked at. */
  originSha: z.string(),
  /** The sheet it became. Absent when it was skipped, rejected, or matched a sheet nudge did not harvest. */
  sheetId: z.string().optional(),
  /** sha256 of what harvest last wrote to the library. A different library file means you edited it. */
  librarySha: z.string().optional(),
  /** Removed in nudge review: never copied again, even when the origin changes. */
  rejected: z.boolean().optional(),
  /** Why this version of the origin was not imported (no text, for example). Retried when the origin changes. */
  skipped: z.string().optional(),
});
export type LedgerFileEntry = z.infer<typeof FileEntrySchema>;

const LedgerSchema = z.object({
  /** Keyed by pathKey(origin). */
  files: z.record(z.string(), FileEntrySchema).default({}),
});
export type Ledger = z.infer<typeof LedgerSchema>;

export function ledgerPath(library: string): string {
  return path.join(library, LEDGER_FILE);
}

export function readLedger(library: string): Ledger {
  const file = ledgerPath(library);
  if (!fs.existsSync(file)) return { files: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(decodeText(fs.readFileSync(file)));
  } catch (e) {
    throw new NudgeError(`${LEDGER_FILE} is not valid JSON (${file}): ${errorMessage(e)}`);
  }
  const parsed = LedgerSchema.safeParse(raw);
  if (!parsed.success) throw new NudgeError(`${LEDGER_FILE} is invalid (${file}):\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function writeLedger(library: string, ledger: Ledger): void {
  const sorted = Object.fromEntries(Object.entries(ledger.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileAtomic(ledgerPath(library), JSON.stringify({ files: sorted }, null, 2) + '\n');
}

/** After nudge review rejects a harvested sheet: its origins are never copied again. Returns them. */
export function rejectInLedger(library: string, id: string): string[] {
  const ledger = readLedger(library);
  const origins: string[] = [];
  for (const entry of Object.values(ledger.files)) {
    if (entry.sheetId !== id) continue;
    entry.rejected = true;
    delete entry.sheetId;
    delete entry.librarySha;
    origins.push(entry.origin);
  }
  if (origins.length) writeLedger(library, ledger);
  return origins;
}
