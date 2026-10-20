import os from 'node:os';
import path from 'node:path';

// Resolved on every call so tests (and child processes) can point APPDATA and
// LOCALAPPDATA at temporary folders.

export function configDir(): string {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'refs');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

/** %LOCALAPPDATA%\refs: derived data that `refs index --rebuild` can recreate. */
export function dataDir(): string {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'refs');
}

export function dataPaths() {
  const dir = dataDir();
  return {
    dir,
    db: path.join(dir, 'index.db'),
    extractCache: path.join(dir, 'extract-cache'),
    usage: path.join(dir, 'usage.jsonl'),
    lock: path.join(dir, 'refs.lock'),
    pendingAllow: path.join(dir, 'pending-allow.json'),
    hookCache: path.join(dir, 'hook-cache.json'),
    lastProject: path.join(dir, 'last-project.json'),
    logs: path.join(dir, 'logs'),
  };
}

export function defaultLibrary(): string {
  return path.join(os.homedir(), 'refs-library');
}

/** Absolute, forward slashes, lowercase drive letter. */
export function normPath(p: string): string {
  let s = path.resolve(p).replace(/\\/g, '/');
  if (/^[A-Z]:/.test(s)) s = s[0]!.toLowerCase() + s.slice(1);
  return s;
}

/** Windows paths compare case-insensitively. */
export function pathKey(p: string): string {
  return normPath(p).toLowerCase();
}

export function isInside(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent).replace(/\/+$/, '');
  return c === p || c.startsWith(p + '/');
}
