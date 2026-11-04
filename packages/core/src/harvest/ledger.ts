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

const ChatEntrySchema = z.object({
  source: z.string(),
  title: z.string().optional(),
  /** Messages already looked at; only later ones are read on the next run. */
  seen: z.number().int().nonnegative(),
  /** File modification time (or the export's update time) when it was last read. */
  mtimeMs: z.number().nonnegative(),
  /** Drafts written from this chat. */
  sheetIds: z.array(z.string()).default([]),
  /** A draft from it was rejected in nudge review: the chat is never read again. */
  rejected: z.boolean().optional(),
});
export type LedgerChatEntry = z.infer<typeof ChatEntrySchema>;

const LedgerSchema = z.object({
  /** Keyed by pathKey(origin). */
  files: z.record(z.string(), FileEntrySchema).default({}),
  /** Keyed by "<source>:<conversation id>". */
  chats: z.record(z.string(), ChatEntrySchema).default({}),
  /**
   * Chats last changed before this date are never read unless asked (nudge harvest --since),
   * so turning harvest on does not send a whole history through the model. Set on the first run.
   */
  chatsSince: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type Ledger = z.infer<typeof LedgerSchema>;

export function ledgerPath(library: string): string {
  return path.join(library, LEDGER_FILE);
}

export function readLedger(library: string): Ledger {
  const file = ledgerPath(library);
  if (!fs.existsSync(file)) return { files: {}, chats: {} };
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

function sortedRecord<T>(r: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function writeLedger(library: string, ledger: Ledger): void {
  const out = { ...(ledger.chatsSince ? { chatsSince: ledger.chatsSince } : {}), files: sortedRecord(ledger.files), chats: sortedRecord(ledger.chats) };
  writeFileAtomic(ledgerPath(library), JSON.stringify(out, null, 2) + '\n');
}

/**
 * After nudge review rejects a harvested sheet: its origin files are never copied again, and
 * a chat it was written from is never read again. Returns the origins (files) and chat titles.
 */
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
  for (const [key, entry] of Object.entries(ledger.chats)) {
    if (!entry.sheetIds.includes(id)) continue;
    entry.rejected = true;
    entry.sheetIds = entry.sheetIds.filter((s) => s !== id);
    origins.push(`chat ${entry.title ?? key}`);
  }
  if (origins.length) writeLedger(library, ledger);
  return origins;
}
