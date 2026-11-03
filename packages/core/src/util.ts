import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** An expected failure with a message meant for the user (no stack trace). */
export class NudgeError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'NudgeError';
    this.exitCode = exitCode;
  }
}

export function errorCode(e: unknown): string | undefined {
  return e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha256File(file: string): string {
  return sha256(fs.readFileSync(file));
}

/** Local calendar date as YYYY-MM-DD. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Write via temp file and rename so readers never see a half-written file. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      // On Windows a reader holding the target open (the prompt hook, an editor)
      // makes the rename fail for a moment; retry briefly before giving up.
      if (attempt < 10 && RENAME_RETRY_CODES.has(errorCode(e) ?? '')) {
        sleepSync(25);
        continue;
      }
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whole days from a YYYY-MM-DD date to the local calendar date of `now`. */
export function daysSince(isoDate: string, now = new Date()): number {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(y, m - 1, d)) / 86_400_000);
}

/** Decode text files: UTF-8 (with or without BOM) or UTF-16 LE with BOM. Line endings become \n. */
export function decodeText(buf: Buffer): string {
  let text: string;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
  else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = buf.subarray(3).toString('utf8');
  else text = buf.toString('utf8');
  return text.replace(/\r\n?/g, '\n');
}

function asciiFold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Tags are lowercase kebab case. */
export function normalizeTag(tag: string): string {
  return asciiFold(tag.trim().toLowerCase()).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function parseTagList(list: string | undefined): string[] {
  if (!list) return [];
  return [...new Set(list.split(',').map(normalizeTag).filter(Boolean))];
}

export function slugify(title: string, max = 60): string {
  const slug = normalizeTag(title).slice(0, max).replace(/-+$/g, '');
  return slug || 'sheet';
}

/** "docker_notes-v2.md" becomes "Docker notes v2". */
export function titleFromFilename(file: string): string {
  const base = path.basename(file, path.extname(file)).replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base ? base[0]!.toUpperCase() + base.slice(1) : 'Untitled';
}

/**
 * Open a file in its associated app, or a URL in the default browser. explorer.exe takes
 * the target as one argument, so no shell quoting is involved.
 */
export function openInDefaultApp(target: string): void {
  spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
