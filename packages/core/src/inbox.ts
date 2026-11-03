import fs from 'node:fs';
import path from 'node:path';
import { OcrUnavailableError } from './extract/image.ts';
import { importLocked, type AddOptions } from './import.ts';
import { inboxDir } from './library.ts';
import type { Sheet } from './manifest.ts';
import { blockingFindings, type Finding } from './secrets.ts';
import { NudgeError, errorMessage } from './util.ts';

export const BLOCKED_DIR = '_blocked';
export const DUPLICATES_DIR = '_duplicates';
const REASON_SUFFIX = '.reason.txt';
/** Files Windows and Explorer drop into folders on their own. */
const SYSTEM_FILES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

export interface InboxReport {
  imported: { file: string; sheet: Sheet; warnings: string[]; queued?: string }[];
  blocked: { file: string; dest: string; reason: string }[];
  duplicates: { file: string; dest: string; existing: string }[];
  /** Left in the inbox for a later run: needs OCR while Ollama is down, or locked by another program. */
  waiting: { file: string; reason: string }[];
  /** Office lock files (~$*), never touched. */
  ignored: string[];
}

/** `name.ext`, or `name (2).ext` and so on when that is taken. */
function freeName(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)) || fs.existsSync(path.join(dir, candidate + REASON_SUFFIX)); n++) {
    candidate = `${stem} (${n})${ext}`;
  }
  return candidate;
}

/** Move a failed inbox file into _blocked or _duplicates with a reason file beside it. */
function park(library: string, file: string, sub: string, reason: string): string {
  const dir = path.join(inboxDir(library), sub);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, freeName(dir, path.basename(file)));
  fs.renameSync(file, dest);
  fs.writeFileSync(dest + REASON_SUFFIX, reason.replace(/\n/g, '\r\n'));
  return dest;
}

function stamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

export function secretReason(inboxFile: string, format: string, findings: Finding[]): string {
  const blocking = blockingFindings(findings);
  const lines = [
    `nudge did not import this file (${stamp()}): likely secrets found.`,
    format === 'md' || format === 'txt' ? '' : 'Line numbers refer to the text extracted from the file.',
    '',
    ...blocking.map((f) => `  ${f.n}. line ${f.line}  rule ${f.rule}  ${f.masked}`),
    '',
    'Redact the secret and move the file back to the inbox; the next nudge index imports it.',
    'If a finding is a false positive, move the file back to the inbox and run:',
    `  nudge allow "${inboxFile}" --finding <n>`,
  ];
  return lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n') + '\n';
}

/** A reason file whose blocked file was moved away (back to the inbox, or deleted) says nothing any more. */
function dropStaleReasons(library: string): void {
  for (const sub of [BLOCKED_DIR, DUPLICATES_DIR]) {
    const dir = path.join(inboxDir(library), sub);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.endsWith(REASON_SUFFIX) && !fs.existsSync(path.join(dir, n.slice(0, -REASON_SUFFIX.length)))) {
        fs.rmSync(path.join(dir, n), { force: true });
      }
    }
  }
}

/**
 * Import every file at the top of inbox\ like nudge add (moved, pending, own commit).
 * Secrets and unreadable files go to _blocked, known content to _duplicates, each with a
 * reason file. Call with the nudge.lock held.
 */
export async function processInbox(library: string, opts: Pick<AddOptions, 'extract' | 'propose'>): Promise<InboxReport> {
  const report: InboxReport = { imported: [], blocked: [], duplicates: [], waiting: [], ignored: [] };
  const inbox = inboxDir(library);
  fs.mkdirSync(inbox, { recursive: true });
  dropStaleReasons(library);
  const entries = fs.readdirSync(inbox, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
  for (const name of entries) {
    const file = path.join(inbox, name);
    if (name.startsWith('~$')) {
      report.ignored.push(file);
      continue;
    }
    if (SYSTEM_FILES.has(name.toLowerCase()) || name.endsWith('.tmp')) continue;
    try {
      const r = await importLocked(library, file, { ...opts, fromInbox: true, yes: true });
      if (r.kind === 'added') report.imported.push({ file, sheet: r.sheet, warnings: r.warnings, queued: r.queued });
      else if (r.kind === 'duplicate') {
        const reason = `nudge did not import this file (${stamp()}): same content as ${r.existing.id} "${r.existing.title}" (${r.existing.file}).\nDelete it, or keep it here; nudge never touches it again.\n`;
        report.duplicates.push({ file, dest: park(library, file, DUPLICATES_DIR, reason), existing: r.existing.id });
      } else {
        const reason = secretReason(file, r.format, r.findings);
        report.blocked.push({ file, dest: park(library, file, BLOCKED_DIR, reason), reason });
      }
    } catch (e) {
      const message = errorMessage(e);
      if (e instanceof OcrUnavailableError || /locked or (read-only|in use)/.test(message)) {
        report.waiting.push({ file, reason: message });
        continue;
      }
      if (!(e instanceof NudgeError)) throw e;
      const reason = `nudge did not import this file (${stamp()}): ${message}\nFix it and move it back to the inbox, or import it with nudge add.\n`;
      try {
        report.blocked.push({ file, dest: park(library, file, BLOCKED_DIR, reason), reason: message });
      } catch (moveError) {
        report.waiting.push({ file, reason: `${message} (and it could not be moved to ${BLOCKED_DIR}: ${errorMessage(moveError)})` });
      }
    }
  }
  return report;
}

export interface InboxCounts {
  waiting: number;
  blocked: number;
  duplicates: number;
}

export function inboxCounts(library: string): InboxCounts {
  const count = (dir: string, top: boolean) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.endsWith(REASON_SUFFIX) && !(top && (e.name.startsWith('~$') || SYSTEM_FILES.has(e.name.toLowerCase())))).length;
    } catch {
      return 0;
    }
  };
  const inbox = inboxDir(library);
  return { waiting: count(inbox, true), blocked: count(path.join(inbox, BLOCKED_DIR), false), duplicates: count(path.join(inbox, DUPLICATES_DIR), false) };
}
