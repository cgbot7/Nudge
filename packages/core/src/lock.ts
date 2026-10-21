import fs from 'node:fs';
import path from 'node:path';
import { dataPaths } from './paths.ts';
import { RefsError, errorCode, sleep } from './util.ts';

export interface LockInfo {
  pid: number;
  at: string;
  command?: string;
}

export interface Lock {
  release(): void;
}

export class LockBusyError extends RefsError {
  holder: LockInfo | null;
  constructor(holder: LockInfo | null, waitedMs: number) {
    const who = holder ? `process ${holder.pid} since ${holder.at}` : 'another process';
    super(`refs is busy: the library is locked by ${who} (waited ${Math.round(waitedMs / 1000)}s). Try again shortly.`);
    this.holder = holder;
  }
}

function readLock(file: string): LockInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8')) as LockInfo;
    return typeof info.pid === 'number' ? info : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) === 'EPERM';
  }
}

/** A lock is stale when its process is gone, or it is unreadable and older than a minute. */
function isStale(file: string): boolean {
  const info = readLock(file);
  if (info) return !pidAlive(info.pid);
  try {
    return Date.now() - fs.statSync(file).mtimeMs > 60_000;
  } catch {
    return false;
  }
}

/**
 * Single-writer lock on refs.lock. Waits up to `waitMs` (CLI default 10 s),
 * then throws LockBusyError. A stale lock left by a dead process is taken over.
 */
export async function acquireLock(opts: { waitMs?: number; command?: string } = {}): Promise<Lock> {
  const file = dataPaths().lock;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const waitMs = opts.waitMs ?? 10_000;
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      const info: LockInfo = { pid: process.pid, at: new Date().toISOString(), command: opts.command };
      fs.writeSync(fd, JSON.stringify(info));
      fs.closeSync(fd);
      return makeLock(file);
    } catch (e) {
      if (errorCode(e) !== 'EEXIST') throw e;
    }
    if (isStale(file)) {
      try {
        fs.unlinkSync(file);
        continue;
      } catch {
        // Someone else removed or replaced it; fall through to the wait.
      }
    }
    if (Date.now() - started >= waitMs) throw new LockBusyError(readLock(file), Date.now() - started);
    await sleep(100);
  }
}

function makeLock(file: string): Lock {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    if (readLock(file)?.pid === process.pid) fs.rmSync(file, { force: true });
  };
  process.on('exit', release);
  return { release };
}

/** Runs `fn` holding the lock; `waitMs` defaults to the CLI's 10 s (the popup asks for less). */
export async function withLock<T>(command: string, fn: () => Promise<T> | T, opts: { waitMs?: number } = {}): Promise<T> {
  const lock = await acquireLock({ command, waitMs: opts.waitMs });
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

export function lockStatus(): { held: false } | { held: true; info: LockInfo | null; stale: boolean } {
  const file = dataPaths().lock;
  if (!fs.existsSync(file)) return { held: false };
  return { held: true, info: readLock(file), stale: isStale(file) };
}
