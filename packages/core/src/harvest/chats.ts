import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { agentPaths } from '../agents.ts';
import { normPath } from '../paths.ts';
import { decodeText, errorMessage } from '../util.ts';

// Chat sources for nudge harvest. Each lists conversations cheaply (file times only) and
// loads the messages of the ones that changed. Only the text a person typed and the text
// the assistant answered is kept: tool calls, tool output, thinking and injected system
// blocks are dropped. Everything here only reads.

export const CHAT_SOURCE_NAMES = ['claude-chats', 'cursor-chats', 'exports'] as const;
export type ChatSourceName = (typeof CHAT_SOURCE_NAMES)[number];

export const CHAT_SOURCE_LABELS: Record<ChatSourceName, string> = {
  'claude-chats': 'Claude Code chats',
  'cursor-chats': 'Cursor chats',
  exports: 'Export files (claude.ai, Gemini)',
};

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface Chat {
  source: ChatSourceName;
  /** Ledger key: "<source>:<conversation id>". */
  key: string;
  title: string;
  /** Transcript file, or the export file it came from. */
  origin: string;
  project?: string;
  mtimeMs: number;
  load(): Promise<TranscriptMessage[]>;
}

/** Biggest export JSON nudge reads. */
const MAX_EXPORT_BYTES = 512 * 1024 * 1024;

function dirs(dir: string): string[] {
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

function mtime(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** Merge consecutive messages of the same role and drop empty ones. */
export function tidy(messages: TranscriptMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const m of messages) {
    const text = m.text.replace(/\r\n?/g, '\n').trim();
    if (!text) continue;
    const last = out.at(-1);
    if (last && last.role === m.role) last.text += '\n\n' + text;
    else out.push({ role: m.role, text });
  }
  return out;
}

/** One line, plain punctuation (no em or en dashes), at most `max` characters. */
export function shortTitle(text: string, max = 70): string {
  const line = text
    .replace(/\s*—\s*/g, ', ')
    .replace(/–/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? line.slice(0, max).replace(/\s+\S*$/, '') + '...' : line;
}

async function readJsonLines(file: string, onLine: (o: Record<string, unknown>) => void): Promise<void> {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as unknown;
      if (o && typeof o === 'object') onLine(o as Record<string, unknown>);
    } catch {
      // A line being written right now, or not JSON: skip it.
    }
  }
}

type Part = { type?: unknown; text?: unknown };

function textParts(content: unknown): string[] | null {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return null;
  return (content as Part[]).filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text as string);
}

/** Text that the app injected (slash command output, system reminders) starts with a tag. */
function typedByPerson(text: string): boolean {
  return !/^\s*<[a-zA-Z][\w-]*[\s>]/.test(text);
}

/** Claude Code: one JSON object per line; user and assistant lines carry message.content. */
export async function loadClaudeTranscript(file: string): Promise<{ title: string | null; messages: TranscriptMessage[] }> {
  const messages: TranscriptMessage[] = [];
  let title: string | null = null;
  await readJsonLines(file, (o) => {
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') title = o.customTitle;
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || o.isMeta) return;
    const content = (o.message as { content?: unknown } | undefined)?.content;
    if (o.type === 'user') {
      if (Array.isArray(content) && (content as Part[]).some((p) => p?.type === 'tool_result')) return;
      const text = (textParts(content) ?? []).filter(typedByPerson).join('\n\n');
      messages.push({ role: 'user', text });
    } else {
      messages.push({ role: 'assistant', text: (textParts(content) ?? []).join('\n\n') });
    }
  });
  return { title, messages: tidy(messages) };
}

/** Cursor agent transcripts: {role, message: {content: [...]}} lines; the typed text sits in <user_query>. */
export async function loadCursorTranscript(file: string): Promise<TranscriptMessage[]> {
  const messages: TranscriptMessage[] = [];
  await readJsonLines(file, (o) => {
    if (o.role !== 'user' && o.role !== 'assistant') return;
    const text = (textParts((o.message as { content?: unknown } | undefined)?.content) ?? []).join('\n\n');
    if (o.role === 'assistant') {
      messages.push({ role: 'assistant', text });
      return;
    }
    const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
    if (query) messages.push({ role: 'user', text: query[1]! });
    else if (typedByPerson(text)) messages.push({ role: 'user', text });
  });
  return tidy(messages);
}

export function claudeChatsDir(): string {
  return path.join(agentPaths().claudeDir, 'projects');
}

export function cursorChatsDir(): string {
  return path.join(agentPaths().home, '.cursor', 'projects');
}

export function exportsDir(configured?: string): string {
  return configured ? path.resolve(configured) : path.join(agentPaths().home, 'nudge-exports');
}

function listClaudeChats(): Chat[] {
  const root = claudeChatsDir();
  const out: Chat[] = [];
  for (const project of dirs(root)) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, project)).filter((n) => n.toLowerCase().endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(root, project, name);
      const m = mtime(file);
      if (m === null) continue;
      const id = name.slice(0, -'.jsonl'.length);
      const chat: Chat = {
        source: 'claude-chats',
        key: `claude-chats:${id}`,
        title: id,
        origin: normPath(file),
        project,
        mtimeMs: m,
        async load() {
          const r = await loadClaudeTranscript(file);
          const first = r.messages.find((x) => x.role === 'user');
          chat.title = r.title ?? (first ? shortTitle(first.text) : id);
          return r.messages;
        },
      };
      out.push(chat);
    }
  }
  return out;
}

function listCursorChats(): Chat[] {
  const root = cursorChatsDir();
  const out: Chat[] = [];
  for (const project of dirs(root)) {
    const transcripts = path.join(root, project, 'agent-transcripts');
    for (const id of dirs(transcripts)) {
      const file = path.join(transcripts, id, `${id}.jsonl`);
      const m = mtime(file);
      if (m === null) continue;
      const chat: Chat = {
        source: 'cursor-chats',
        key: `cursor-chats:${id}`,
        title: id,
        origin: normPath(file),
        project,
        mtimeMs: m,
        async load() {
          const messages = await loadCursorTranscript(file);
          const first = messages.find((x) => x.role === 'user');
          if (first) chat.title = shortTitle(first.text);
          return messages;
        },
      };
      out.push(chat);
    }
  }
  return out;
}

// ---- export files ----

/** Gemini Apps activity from Google Takeout keeps the answer as HTML. Enough Markdown to distill. */
export function htmlToText(html: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  const decode = (s: string) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return entities[e.toLowerCase()] ?? m;
    });
  return decode(
    html
      .replace(/<pre[^>]*>\s*(?:<code[^>]*>)?([\s\S]*?)(?:<\/code>)?\s*<\/pre>/gi, (_m, code: string) => `\n\`\`\`\n${code.replace(/<[^>]+>/g, '')}\n\`\`\`\n`)
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<h[1-6][^>]*>/gi, '\n\n')
      .replace(/<\/(p|div|h[1-6]|ul|ol|tr|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ParsedExport {
  kind: 'claude-ai' | 'gemini';
  chats: { id: string; title: string; updatedMs: number; messages: TranscriptMessage[] }[];
}

type ClaudeAiConversation = {
  uuid?: unknown;
  name?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
  chat_messages?: { sender?: unknown; text?: unknown; content?: unknown }[];
};

/** claude.ai Settings > Privacy > Export data: conversations.json is an array of conversations. */
export function parseClaudeAiExport(data: unknown): ParsedExport | null {
  if (!Array.isArray(data) || !data.length || !data.every((c) => c && typeof c === 'object' && Array.isArray((c as ClaudeAiConversation).chat_messages))) return null;
  const chats = (data as ClaudeAiConversation[]).flatMap((c) => {
    if (typeof c.uuid !== 'string') return [];
    const messages = tidy(
      (c.chat_messages ?? []).flatMap((m) => {
        const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null;
        if (!role) return [];
        const text = typeof m.text === 'string' && m.text.trim() ? m.text : (textParts(m.content) ?? []).join('\n\n');
        return [{ role, text } as TranscriptMessage];
      }),
    );
    const updated = Date.parse(String(c.updated_at ?? c.created_at ?? ''));
    const first = messages.find((m) => m.role === 'user');
    const title = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : first ? shortTitle(first.text) : c.uuid;
    return [{ id: c.uuid, title, updatedMs: Number.isFinite(updated) ? updated : 0, messages }];
  });
  return { kind: 'claude-ai', chats };
}

type ActivityItem = { header?: unknown; title?: unknown; time?: unknown; safeHtmlItem?: { html?: unknown }[] };

/**
 * Google Takeout "My Activity > Gemini Apps" as JSON: one item per prompt ("Prompted ..."),
 * newest first, with the answer as HTML. Items are grouped into one chat per day.
 */
export function parseGeminiExport(data: unknown): ParsedExport | null {
  if (!Array.isArray(data) || !data.length) return null;
  const items = (data as ActivityItem[]).filter((i) => i && typeof i === 'object' && typeof i.header === 'string' && /gemini|bard/i.test(i.header) && typeof i.title === 'string');
  if (!items.length) return null;
  const byDay = new Map<string, { at: number; prompt: string; answer: string }[]>();
  for (const i of items) {
    const at = Date.parse(String(i.time ?? ''));
    if (!Number.isFinite(at)) continue;
    const prompt = (i.title as string).replace(/^Prompted\s+/i, '');
    const answer = (i.safeHtmlItem ?? []).map((h) => (typeof h?.html === 'string' ? htmlToText(h.html) : '')).join('\n\n');
    const day = new Date(at).toISOString().slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push({ at, prompt, answer });
    byDay.set(day, list);
  }
  const chats = [...byDay].map(([day, list]) => {
    list.sort((a, b) => a.at - b.at);
    const messages = tidy(list.flatMap((x) => [{ role: 'user' as const, text: x.prompt }, { role: 'assistant' as const, text: x.answer }]));
    return { id: day, title: `Gemini, ${day}`, updatedMs: list.at(-1)!.at, messages };
  });
  return { kind: 'gemini', chats };
}

function systemTar(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'tar.exe');
}

/** Windows' own tar (bsdtar) reads zip files and refuses absolute paths and "..". */
function unzip(file: string, dest: string): void {
  const r = spawnSync(systemTar(), ['-xf', file, '-C', dest], { windowsHide: true, encoding: 'utf8' });
  if (r.error) throw new Error(`could not run ${systemTar()}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`tar could not unpack it: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
}

function findFiles(dir: string, names: Set<string>, depth = 0, out: string[] = []): string[] {
  if (depth > 6) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) findFiles(p, names, depth + 1, out);
    else if (e.isFile() && names.has(e.name.toLowerCase())) out.push(p);
  }
  return out;
}

function parseExportJson(file: string): ParsedExport | null {
  const size = fs.statSync(file).size;
  if (size > MAX_EXPORT_BYTES) throw new Error(`${path.basename(file)} is ${Math.round(size / 1024 / 1024)} MB, more than nudge reads`);
  let data: unknown;
  try {
    data = JSON.parse(decodeText(fs.readFileSync(file)));
  } catch (e) {
    throw new Error(`${path.basename(file)} is not valid JSON (${errorMessage(e)})`);
  }
  return parseClaudeAiExport(data) ?? parseGeminiExport(data);
}

export interface ExportFile {
  /** The file in exportsDir. */
  file: string;
  chats: Chat[];
  /** Set when nothing in it could be read; the file goes to _unknown with this reason. */
  error?: string;
}

/** Every zip or json file at the top of exportsDir, parsed. */
export function readExports(dir: string): ExportFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch {
    return [];
  }
  const out: ExportFile[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.reason.txt') || lower === 'desktop.ini') continue;
    const file = path.join(dir, name);
    if (!lower.endsWith('.zip') && !lower.endsWith('.json')) {
      out.push({ file, chats: [], error: 'not a .zip or .json file' });
      continue;
    }
    let temp: string | null = null;
    try {
      let jsons = [file];
      if (lower.endsWith('.zip')) {
        temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-export-'));
        unzip(file, temp);
        jsons = findFiles(temp, new Set(['conversations.json', 'myactivity.json']));
      }
      const chats: Chat[] = [];
      for (const json of jsons) {
        const parsed = parseExportJson(json);
        if (!parsed) continue;
        for (const c of parsed.chats) {
          const messages = c.messages;
          chats.push({
            source: 'exports',
            key: `exports:${parsed.kind}:${c.id}`,
            title: c.title,
            origin: normPath(file),
            mtimeMs: c.updatedMs,
            load: async () => messages,
          });
        }
      }
      out.push(chats.length ? { file, chats } : { file, chats, error: 'no claude.ai conversations.json or Gemini Apps MyActivity.json found in it' });
    } catch (e) {
      out.push({ file, chats: [], error: errorMessage(e) });
    } finally {
      if (temp) fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  return out;
}

export function listChats(source: Exclude<ChatSourceName, 'exports'>): Chat[] {
  return source === 'claude-chats' ? listClaudeChats() : listCursorChats();
}

export function chatSourceDir(source: ChatSourceName, configuredExports?: string): string {
  if (source === 'claude-chats') return claudeChatsDir();
  if (source === 'cursor-chats') return cursorChatsDir();
  return exportsDir(configuredExports);
}
