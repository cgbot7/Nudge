import { spawnSync } from 'node:child_process';
import path from 'node:path';

export interface GitResult {
  ok: boolean;
  /** False when the git executable itself could not be started. */
  available: boolean;
  stdout: string;
  stderr: string;
}

/** Run git without a shell, so paths with spaces or "&" pass through untouched. */
export function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error) return { ok: false, available: false, stdout: '', stderr: r.error.message };
  return { ok: r.status === 0, available: true, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

export function gitAvailable(): boolean {
  return git(process.cwd(), ['--version']).available;
}

export function isRepoRoot(dir: string): boolean {
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  return r.ok && path.resolve(r.stdout).toLowerCase() === path.resolve(dir).toLowerCase();
}

/** The repo root if `file` is tracked by git, otherwise null. */
export function trackingRepo(file: string): string | null {
  const dir = path.dirname(file);
  const tracked = git(dir, ['ls-files', '--error-unmatch', '--', path.basename(file)]);
  if (!tracked.ok) return null;
  const root = git(dir, ['rev-parse', '--show-toplevel']);
  return root.ok ? path.resolve(root.stdout) : dir;
}

/** Stage and commit only the given paths (relative to `repo`). */
export function commitPaths(repo: string, paths: string[], message: string): GitResult {
  const add = git(repo, ['add', '-A', '--', ...paths]);
  if (!add.ok) return add;
  return git(repo, ['commit', '--quiet', '-m', message, '--', ...paths]);
}
