import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { RefsError, decodeText, errorMessage, normalizeTag, writeFileAtomic } from './util.ts';

/** Folders a project scan never enters. */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'venv', '.venv', 'dist', 'build', 'models']);
/** Directory levels below the project root that a scan descends into. */
export const MAX_DEPTH = 3;
export const MAX_FILES = 5000;
/** contentRegex is checked against this much of each matched file. */
export const CONTENT_BYTES = 64 * 1024;

const tagName = z
  .string()
  .transform(normalizeTag)
  .refine((t) => t.length > 0, 'tag is empty after normalizing to kebab case');
const nonEmptyList = z.array(z.string().min(1)).min(1);

/**
 * One signature rule. Every key present must match (files AND packageDeps AND ...);
 * inside a list any one entry is enough. Several rules may share a tag (OR).
 */
export const RuleSchema = z
  .strictObject({
    tag: tagName,
    files: nonEmptyList.optional(),
    packageDeps: nonEmptyList.optional(),
    pyDeps: nonEmptyList.optional(),
    contentRegex: z.string().min(1).optional(),
  })
  .superRefine((rule, ctx) => {
    if (!rule.files && !rule.packageDeps && !rule.pyDeps) {
      ctx.addIssue({ code: 'custom', message: 'needs at least one of files, packageDeps, pyDeps' });
    }
    if (rule.contentRegex !== undefined) {
      if (!rule.files) ctx.addIssue({ code: 'custom', message: 'contentRegex needs files (it is checked against the matched files)', path: ['contentRegex'] });
      try {
        new RegExp(rule.contentRegex);
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: `not a valid regular expression: ${errorMessage(e)}`, path: ['contentRegex'] });
      }
    }
  });
export type Rule = z.infer<typeof RuleSchema>;

const RulesFileSchema = z.array(RuleSchema);

// Order matters: the hook line lists detected tags in rule order.
export const DEFAULT_RULES: Rule[] = [
  { tag: 'node', files: ['package.json'] },
  { tag: 'typescript', files: ['tsconfig.json'] },
  { tag: 'docker', files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'] },
  { tag: 'playwright', packageDeps: ['playwright', '@playwright/test'] },
  { tag: 'react', packageDeps: ['react'] },
  { tag: 'vue', packageDeps: ['vue'] },
  { tag: 'electron', packageDeps: ['electron'] },
  { tag: 'tauri', files: ['tauri.conf.json'] },
  { tag: 'python', files: ['pyproject.toml', 'requirements.txt', 'setup.py'] },
  { tag: 'pytorch', pyDeps: ['torch'] },
  { tag: 'ollama', packageDeps: ['ollama'] },
  { tag: 'ollama', pyDeps: ['ollama'] },
  { tag: 'rust', files: ['Cargo.toml'] },
  { tag: 'go', files: ['go.mod'] },
  { tag: 'dotnet', files: ['*.csproj', '*.sln'] },
  { tag: 'godot', files: ['project.godot'] },
  { tag: 'autohotkey', files: ['*.ahk'] },
  { tag: 'powershell', files: ['*.ps1', '*.psm1'] },
  { tag: 'comfyui', files: ['*.json'], contentRegex: '"class_type"' },
];

/** tags.json: canonical tag to its aliases. Loose so later milestones can add fields. */
const TagVocabSchema = z.record(tagName, z.looseObject({ aliases: z.array(z.string()).default([]) }));
export type TagVocab = z.infer<typeof TagVocabSchema>;

export const DEFAULT_TAGS: TagVocab = {
  node: { aliases: ['nodejs', 'node-js'] },
  typescript: { aliases: ['ts'] },
  javascript: { aliases: ['js'] },
  docker: { aliases: ['dockerfile'] },
  python: { aliases: ['py', 'python3'] },
  powershell: { aliases: ['pwsh', 'ps1'] },
  playwright: { aliases: [] },
  ollama: { aliases: [] },
  git: { aliases: [] },
};

export function rulesPath(library: string): string {
  return path.join(library, 'rules.json');
}

export function tagsPath(library: string): string {
  return path.join(library, 'tags.json');
}

/** Write default rules.json and tags.json if missing. Returns the created names (library-relative). */
export function seedRuleFiles(library: string): string[] {
  const created: string[] = [];
  if (!fs.existsSync(rulesPath(library))) {
    const lines = DEFAULT_RULES.map((r) => '  ' + JSON.stringify(r));
    writeFileAtomic(rulesPath(library), `[\n${lines.join(',\n')}\n]\n`);
    created.push('rules.json');
  }
  if (!fs.existsSync(tagsPath(library))) {
    writeFileAtomic(tagsPath(library), JSON.stringify(DEFAULT_TAGS, null, 2) + '\n');
    created.push('tags.json');
  }
  return created;
}

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(decodeText(fs.readFileSync(file)));
  } catch (e) {
    throw new RefsError(`${label} is not valid JSON (${file}): ${errorMessage(e)}`);
  }
}

/** Rules from the library's rules.json; the defaults when it does not exist yet. */
export function readRules(library: string): Rule[] {
  const file = rulesPath(library);
  if (!fs.existsSync(file)) return DEFAULT_RULES;
  const parsed = RulesFileSchema.safeParse(readJson(file, 'rules.json'));
  if (!parsed.success) throw new RefsError(`rules.json is invalid (${file}):\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function readTagVocab(library: string): TagVocab {
  const file = tagsPath(library);
  if (!fs.existsSync(file)) return DEFAULT_TAGS;
  const parsed = TagVocabSchema.safeParse(readJson(file, 'tags.json'));
  if (!parsed.success) throw new RefsError(`tags.json is invalid (${file}):\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Maps any tag or alias to its canonical tag. */
export function tagResolver(vocab: TagVocab): (tag: string) => string {
  const alias = new Map<string, string>();
  for (const [tag, entry] of Object.entries(vocab)) {
    for (const a of entry.aliases) alias.set(normalizeTag(a), tag);
  }
  return (tag) => {
    const t = normalizeTag(tag);
    return alias.get(t) ?? t;
  };
}

const GLOB_CHARS = /[*?[\]{}]/;

/** Literal file names from `files` patterns: their presence makes a folder a project root. */
export function signatureNames(rules: Rule[]): Set<string> {
  const names = new Set<string>();
  for (const r of rules) for (const f of r.files ?? []) if (!GLOB_CHARS.test(f) && !f.includes('/')) names.add(f.toLowerCase());
  return names;
}

/** A pattern without "/" matches the file name at any depth; with "/" it matches the path from the project root. */
export function globMatch(relPath: string, pattern: string): boolean {
  const target = pattern.includes('/') ? relPath : path.posix.basename(relPath);
  return path.matchesGlob(target, pattern);
}

export interface ScanResult {
  /** Project-relative paths with forward slashes. */
  files: string[];
  /** True when the 5,000-file cap stopped the walk. */
  truncated: boolean;
}

/**
 * List files under a project root: at most MAX_DEPTH folders down and MAX_FILES files,
 * skipping SKIP_DIRS, symlinks and junctions, and nested Git repos (their own projects).
 */
export function scanFiles(root: string): ScanResult {
  const files: string[] = [];
  const walk = (dir: string, rel: string, depth: number): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    const subdirs: [string, string][] = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile()) {
        if (files.length >= MAX_FILES) return false;
        files.push(childRel);
      } else if (e.isDirectory() && depth < MAX_DEPTH && !SKIP_DIRS.has(e.name.toLowerCase())) {
        subdirs.push([path.join(dir, e.name), childRel]);
      }
    }
    for (const [abs, childRel] of subdirs) {
      if (fs.existsSync(path.join(abs, '.git'))) continue;
      if (!walk(abs, childRel, depth + 1)) return false;
    }
    return true;
  };
  const complete = walk(root, '', 0);
  return { files, truncated: !complete };
}

function readHead(file: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(CONTENT_BYTES);
    const n = fs.readSync(fd, buf, 0, CONTENT_BYTES, 0);
    return decodeText(buf.subarray(0, n));
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** PEP 503 name normalization, so "Foo_Bar" and "foo-bar" compare equal. */
export function normalizePyName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

function requirementName(spec: string): string | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return m ? normalizePyName(m[1]!) : null;
}

export function parseRequirements(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const name = requirementName(line);
    if (name) names.push(name);
  }
  return names;
}

const POETRY_SECTION = /^tool\.poetry\.(dependencies|dev-dependencies|group\.[^.]+\.dependencies)$/;

/**
 * Dependency names from pyproject.toml without a TOML parser: [project] dependencies,
 * [project.optional-dependencies], [dependency-groups] and Poetry dependency tables.
 */
export function parsePyproject(text: string): string[] {
  const names: string[] = [];
  const addStrings = (s: string) => {
    for (const m of s.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const name = requirementName(m[1] ?? m[2] ?? '');
      if (name) names.push(name);
    }
  };
  let section = '';
  let inArray = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (inArray) {
      addStrings(line);
      if (line.includes(']')) inArray = false;
      continue;
    }
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      section = header[1]!.replace(/["']/g, '');
      continue;
    }
    const kv = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.replace(/["']/g, '');
    const value = kv[2]!;
    if (POETRY_SECTION.test(section)) {
      if (key.toLowerCase() !== 'python') names.push(normalizePyName(key));
    } else if ((section === 'project' && key === 'dependencies') || section === 'project.optional-dependencies' || section === 'dependency-groups') {
      if (!value.startsWith('[')) continue;
      addStrings(value);
      if (!value.includes(']')) inArray = true;
    }
  }
  return names;
}

function packageJsonDeps(text: string): string[] {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    const names: string[] = [];
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg[field];
      if (deps && typeof deps === 'object') names.push(...Object.keys(deps).map((d) => d.toLowerCase()));
    }
    return names;
  } catch {
    return [];
  }
}

/** Tags whose rules match the scanned project, in rule order, without duplicates. */
export function evaluateRules(root: string, scan: ScanResult, rules: Rule[]): string[] {
  const heads = new Map<string, string>();
  const head = (rel: string) => {
    let text = heads.get(rel);
    if (text === undefined) heads.set(rel, (text = readHead(path.join(root, ...rel.split('/')))));
    return text;
  };
  const byName = (test: (base: string) => boolean) => scan.files.filter((f) => test(path.posix.basename(f).toLowerCase()));
  let npm: Set<string> | undefined;
  let py: Set<string> | undefined;
  const npmDeps = () => (npm ??= new Set(byName((b) => b === 'package.json').flatMap((f) => packageJsonDeps(head(f)))));
  const pyDeps = () =>
    (py ??= new Set([
      ...byName((b) => /^requirements.*\.txt$/.test(b)).flatMap((f) => parseRequirements(head(f))),
      ...byName((b) => b === 'pyproject.toml').flatMap((f) => parsePyproject(head(f))),
    ]));

  const tags: string[] = [];
  for (const rule of rules) {
    if (tags.includes(rule.tag)) continue;
    let matched: string[] = [];
    if (rule.files) {
      matched = scan.files.filter((f) => rule.files!.some((g) => globMatch(f, g)));
      if (!matched.length) continue;
    }
    if (rule.packageDeps && !rule.packageDeps.some((d) => npmDeps().has(d.toLowerCase()))) continue;
    if (rule.pyDeps && !rule.pyDeps.some((d) => pyDeps().has(normalizePyName(d)))) continue;
    if (rule.contentRegex !== undefined) {
      const re = new RegExp(rule.contentRegex);
      if (!matched.some((f) => re.test(head(f)))) continue;
    }
    tags.push(rule.tag);
  }
  return tags;
}

export interface Detection {
  tags: string[];
  truncated: boolean;
  files: number;
}

export function detectTags(root: string, rules: Rule[]): Detection {
  const scan = scanFiles(root);
  return { tags: evaluateRules(root, scan, rules), truncated: scan.truncated, files: scan.files.length };
}
