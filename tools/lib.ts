import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Shared by tools/bench.ts and tools/eval.ts. Both run in a throwaway profile, like the
// tests, so the real library, index, hook cache and config are never read or written.
// Unlike the tests they may talk to the real Ollama: that is what they measure.

export const REPO = path.resolve(import.meta.dirname, '..');

export interface Sandbox {
  root: string;
  library: string;
  /** Folder outside the library for files to import. */
  work: string;
  /** Registered root holding the sandbox projects. */
  projects: string;
  env: NodeJS.ProcessEnv;
}

/** The ollama block of the real config.json, read before the sandbox replaces APPDATA. */
export function realOllamaConfig(): Record<string, unknown> {
  const file = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'refs', 'config.json');
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as { ollama?: Record<string, unknown> };
    return c.ollama ?? {};
  } catch {
    return {};
  }
}

/**
 * Fresh APPDATA, LOCALAPPDATA, library and project root under the temp folder. Sets
 * process.env too, since core paths are resolved from the environment on every call.
 * The folder is removed on exit unless `keep` is set.
 */
export function makeSandbox(name: string, config: Record<string, unknown>, opts: { keep?: boolean } = {}): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `refs-${name}-`));
  if (!opts.keep) process.on('exit', () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const library = path.join(root, 'library');
  const work = path.join(root, 'work');
  const projects = path.join(root, 'projects');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'),
    GIT_AUTHOR_NAME: 'refs bench',
    GIT_AUTHOR_EMAIL: 'refs-bench@localhost',
    GIT_COMMITTER_NAME: 'refs bench',
    GIT_COMMITTER_EMAIL: 'refs-bench@localhost',
    NO_COLOR: '1',
    // Same overrides as the tests: nothing touches the real profiles, task, agents or Run key.
    REFS_DOCUMENTS_DIR: path.join(root, 'documents'),
    REFS_TASK_NAME: `refs-${name}-${path.basename(root)}`,
    REFS_HOME_DIR: path.join(root, 'home'),
    REFS_RUN_KEY: `HKCU\\Software\\refs-${name}\\${path.basename(root)}`,
    REFS_RUN_VALUE_NAME: `refs popup ${name}`,
  };
  Object.assign(process.env, env);
  fs.mkdirSync(path.join(env.APPDATA!, 'refs'), { recursive: true });
  const full = { library: slash(library), roots: [slash(projects)], ...config };
  fs.writeFileSync(path.join(env.APPDATA!, 'refs', 'config.json'), JSON.stringify(full, null, 2));
  return { root, library, work, projects, env: { ...process.env, ...env } };
}

export function slash(p: string): string {
  return p.replace(/\\/g, '/');
}

export function write(dir: string, name: string, content: string | Buffer): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

export interface Stats {
  n: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentile (p in 0..100) of an unsorted sample. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

export function stats(values: number[]): Stats {
  const round = (x: number) => Math.round(x * 10) / 10;
  if (!values.length) return { n: 0, min: NaN, median: NaN, p95: NaN, max: NaN, mean: NaN };
  return {
    n: values.length,
    min: round(Math.min(...values)),
    median: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    max: round(Math.max(...values)),
    mean: round(values.reduce((a, b) => a + b, 0) / values.length),
  };
}

/** Machine and toolchain facts to store next to every result, so numbers stay comparable. */
export function environment(): Record<string, string> {
  const cpus = os.cpus();
  return {
    date: new Date().toISOString(),
    os: `${os.type()} ${os.release()}`,
    cpu: `${cpus[0]?.model.trim() ?? '?'} (${cpus.length} threads)`,
    memoryGb: (os.totalmem() / 1024 ** 3).toFixed(0),
    node: process.version,
  };
}

/** Results go to docs/results/<kind>-<yyyy-mm-dd-hhmm>.json (UTC), one file per run; returns the path written. */
export function saveResult(kind: string, data: unknown): string {
  const dir = path.join(REPO, 'docs', 'results');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const file = path.join(dir, `${kind}-${at.slice(0, 10)}-${at.slice(11, 13)}${at.slice(14, 16)}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

/** A fixed-width table for the console. */
export function table(head: string[], rows: (string | number)[][]): string {
  const cells = [head, ...rows.map((r) => r.map(String))];
  const widths = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(cells[0]!), line(widths.map((w) => '-'.repeat(w))), ...cells.slice(1).map(line)].join('\n');
}
