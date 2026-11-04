import fs from 'node:fs';
import path from 'node:path';
import { agentPaths } from '../agents.ts';
import { decodeText } from '../util.ts';

// Each source finds notes an LLM tool wrote to disk and turns one file into Markdown
// ready for the library. Sources only read; nothing in a tool's folder is ever changed.

// Cursor is left out on purpose: its plan files are build plans, not reference notes.
// Cursor content will come from its chats only.
export const SOURCE_NAMES = ['claude-memory'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

export interface Candidate {
  source: SourceName;
  /** Absolute path of the origin file. */
  file: string;
  /** Project the note belongs to, when the tool keeps one. */
  project?: string;
}

export interface Source {
  name: SourceName;
  label: string;
  /** Folder the source reads, for doctor and dry runs. */
  dir(): string;
  list(): Candidate[];
  /** Markdown for the library: an H1 title, the note's summary, then its body. */
  render(file: string, raw: string): string;
}

function listFiles(dir: string, keep: (name: string) => boolean): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && keep(e.name))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

/**
 * The leading `---` block of a Markdown file. Only top-level `key: value` lines on one
 * line are read (enough for name, description and overview); nested YAML is skipped.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { fields: {}, body: src };
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!kv || !kv[2]) continue;
    fields[kv[1]!] = unquote(kv[2].trim());
  }
  return { fields, body: src.slice(m[0].length) };
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** "nudge-milestones" -> "Nudge milestones". */
export function humanize(slug: string): string {
  const s = slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * H1 title, then the summary, then the body. A body that opens with its own H1 keeps it
 * as the title. Lines are LF and the result ends with one newline.
 */
export function compose(title: string, summary: string | undefined, body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').trim().split('\n');
  let heading = `# ${title.replace(/\s+/g, ' ').trim()}`;
  if (/^#\s+\S/.test(lines[0] ?? '')) heading = lines.shift()!.trim();
  const rest = lines.join('\n').trim();
  return [heading, summary?.trim(), rest].filter((p) => p).join('\n\n') + '\n';
}

const claudeMemory: Source = {
  name: 'claude-memory',
  label: 'Claude Code memory',
  dir: () => path.join(agentPaths().claudeDir, 'projects'),
  list() {
    const root = this.dir();
    return listDirs(root).flatMap((project) =>
      listFiles(path.join(root, project, 'memory'), (n) => n.toLowerCase().endsWith('.md') && n.toLowerCase() !== 'memory.md').map((file) => ({
        source: 'claude-memory' as const,
        file,
        project,
      })),
    );
  },
  render(file, raw) {
    const { fields, body } = parseFrontmatter(raw);
    const title = humanize(fields.name || path.basename(file, path.extname(file)));
    return compose(title, fields.description, body);
  },
};

export const SOURCES: Record<SourceName, Source> = {
  'claude-memory': claudeMemory,
};

export function isSourceName(name: string): name is SourceName {
  return (SOURCE_NAMES as readonly string[]).includes(name);
}

/** Read an origin as text (UTF-8 or UTF-16 with BOM, like every other import). */
export function readOrigin(file: string): { buf: Buffer; text: string } {
  const buf = fs.readFileSync(file);
  return { buf, text: decodeText(buf) };
}
