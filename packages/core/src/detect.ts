import fs from 'node:fs';
import path from 'node:path';
import { normPath, pathKey } from './paths.ts';
import { MAX_DEPTH, SKIP_DIRS, signatureNames, type Rule } from './rules.ts';

/** Registered roots, normalized, longest first so nested roots win. */
export function normalizeRoots(roots: string[]): string[] {
  return [...new Set(roots.map(normPath))].sort((a, b) => b.length - a.length);
}

/** The registered root that contains `dir` (or equals it), if any. */
export function rootFor(dir: string, roots: string[]): string | null {
  const key = pathKey(dir);
  for (const r of normalizeRoots(roots)) {
    const rk = pathKey(r).replace(/\/+$/, '');
    if (key === rk || key.startsWith(rk + '/')) return r;
  }
  return null;
}

function listNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** A folder is a project root when it holds .git or a literal signature file from rules.json. */
export function isProjectMarker(dir: string, signatures: Set<string>): boolean {
  return listNames(dir).some((n) => n === '.git' || signatures.has(n.toLowerCase()));
}

/**
 * Project root for a folder: the nearest ancestor inside a registered root that has
 * .git or a signature file, otherwise the first-level folder under the root.
 * Null when the folder is not under a root, or is a root itself.
 */
export function resolveProjectRoot(dir: string, roots: string[], rules: Rule[]): string | null {
  const root = rootFor(dir, roots);
  if (!root || pathKey(dir) === pathKey(root)) return null;
  const signatures = signatureNames(rules);
  let current = normPath(dir);
  for (;;) {
    if (isProjectMarker(current, signatures)) return current;
    const parent = path.posix.dirname(current);
    if (pathKey(parent) === pathKey(root) || parent === current) return current;
    current = parent;
  }
}

/**
 * Every project under the registered roots: each first-level folder, plus any folder
 * inside one (down to MAX_DEPTH, skipping SKIP_DIRS) that is a project root itself,
 * such as a nested repo.
 */
export function discoverProjects(roots: string[], rules: Rule[]): string[] {
  const signatures = signatureNames(rules);
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || SKIP_DIRS.has(e.name.toLowerCase())) continue;
      const child = path.join(dir, e.name);
      if (isProjectMarker(child, signatures)) found.push(normPath(child));
      if (depth < MAX_DEPTH) walk(child, depth + 1);
    }
  };
  for (const root of normalizeRoots(roots)) {
    for (const e of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.')) continue;
      const first = path.join(root, e.name);
      found.push(normPath(first));
      walk(first, 1);
    }
  }
  const seen = new Set<string>();
  return found.filter((p) => !seen.has(pathKey(p)) && seen.add(pathKey(p)));
}
