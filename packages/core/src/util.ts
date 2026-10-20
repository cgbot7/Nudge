import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** An expected failure with a message meant for the user (no stack trace). */
export class RefsError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'RefsError';
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

/** Write via temp file and rename so readers never see a half-written file. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
