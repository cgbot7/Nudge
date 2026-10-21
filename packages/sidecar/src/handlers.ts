import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_HOTKEY,
  LockBusyError,
  RefsError,
  approveSheet,
  dataPaths,
  errorMessage,
  findById,
  hybridSearch,
  isStale,
  loadConfig,
  logUsage,
  ollamaClient,
  openDb,
  openInDefaultApp,
  parseHotkey,
  readHookCache,
  readLastProject,
  readManifest,
  readTagVocab,
  scannedPagePreviews,
  setLearned,
  sheetAbsPath,
  sheetSections,
  tagResolver,
  tryRefreshHookCache,
  verifySheet,
  type Config,
  type SearchHit,
  type Sheet,
} from '@refs/core';
import { renderMarkdown } from './markdown.ts';

// What the popup asks the sidecar, one JSON line each way:
//   {"id":1,"method":"search","params":{"q":"docker","mode":"keyword","seq":7}}
//   {"id":1,"result":{...}}  or  {"id":1,"error":{"code":"busy","message":"..."}}
// Config, manifest and index are read per request, so the popup never holds index.db open
// (refs index --rebuild deletes it) and edits to config.json apply right away.

/** Marks around matched words in snippets: private-use characters the popup turns into bold text nodes. */
export const MARK_OPEN = '\u{E000}';
export const MARK_CLOSE = '\u{E001}';
/** The popup waits this long for the lock, then says the library is busy. */
export const POPUP_LOCK_WAIT_MS = 2000;
/** Scanned PDF pages shown beside OCR text. */
const PREVIEW_PDF_PAGES = 3;
const IMAGE_FORMATS: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg' };

export class SidecarError extends Error {
  code: 'busy' | 'not_found' | 'bad_request' | 'error';
  constructor(code: SidecarError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface PopupHit {
  id: string;
  section: number;
  title: string;
  heading: string;
  tags: string[];
  status: Sheet['status'];
  stale: boolean;
  ocr: boolean;
  learned: boolean;
  snippet: string;
}

export interface ProjectInfo {
  name: string;
  path: string;
  tags: string[];
  /** ISO time the prompt hook last saw it, if known. */
  at: string | null;
}

export interface SearchReply {
  seq: number;
  /** Which pass this answers. */
  pass: 'keyword' | 'hybrid';
  /** What the ranking used: hybrid only when embeddings were used. */
  mode: 'keyword' | 'hybrid';
  /** Shown in the popup when a hybrid pass fell back to keyword only. */
  notice?: string;
  /** A newer search came in while this one waited for Ollama; the popup ignores it. */
  superseded?: boolean;
  project: ProjectInfo | null;
  tookMs: number;
  hits: PopupHit[];
}

/** Reads a file only when its modification time changed since the last call. */
function memoByMtime<T>(load: (file: string) => T): (file: string) => T {
  let last: { file: string; mtimeMs: number; size: number; value: T } | null = null;
  return (file) => {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st) return load(file);
    if (last && last.file === file && last.mtimeMs === st.mtimeMs && last.size === st.size) return last.value;
    const value = load(file);
    last = { file, mtimeMs: st.mtimeMs, size: st.size, value };
    return value;
  };
}

const manifestFor = memoByMtime((file) => readManifest(path.dirname(file)));

function config(): Config {
  try {
    return loadConfig().config;
  } catch (e) {
    throw new SidecarError('error', errorMessage(e));
  }
}

function project(): ProjectInfo | null {
  const last = readLastProject(readHookCache());
  if (!last) return null;
  return { name: path.basename(last.path), path: last.path, tags: last.tags, at: last.at?.toISOString() ?? null };
}

function sheetOrThrow(config: Config, id: unknown): Sheet {
  if (typeof id !== 'string' || !id) throw new SidecarError('bad_request', 'id is required');
  const sheet = findById(manifestFor(path.join(config.library, 'manifest.json')), id);
  if (!sheet) throw new SidecarError('not_found', `no sheet with id ${id}`);
  return sheet;
}

function summary(config: Config, s: Sheet) {
  return { id: s.id, title: s.title, status: s.status, learned: s.learned, lastVerified: s.lastVerified, stale: isStale(s, config.staleAfterDays) };
}

/** Runs a library change; a busy lock becomes a "busy" error the popup can show as such. */
async function change<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LockBusyError) throw new SidecarError('busy', e.message);
    if (e instanceof RefsError) throw new SidecarError('error', e.message);
    throw e;
  }
}

function opener(target: string): void {
  // Tests set this so nothing opens on the machine running them.
  if (process.env.REFS_SIDECAR_NO_OPEN) return;
  openInDefaultApp(target);
}

export function createHandlers() {
  let latestSeq = 0;

  return {
    ping() {
      return { pong: true, pid: process.pid };
    },

    /** What the popup needs at start: the hotkey to register, and anything wrong with config.json. */
    hello() {
      let cfg: Config | null = null;
      let configError: string | undefined;
      try {
        cfg = loadConfig().config;
      } catch (e) {
        configError = errorMessage(e);
      }
      const parsed = parseHotkey(cfg?.hotkey ?? DEFAULT_HOTKEY);
      return {
        hotkey: parsed.ok ? parsed.canonical : DEFAULT_HOTKEY,
        ...(parsed.ok ? {} : { hotkeyError: `config.json "hotkey": ${parsed.error}; using ${DEFAULT_HOTKEY}` }),
        ...(configError ? { configError } : {}),
        library: cfg?.library ?? null,
        indexExists: fs.existsSync(dataPaths().db),
      };
    },

    async search(params: { q?: unknown; mode?: unknown; seq?: unknown; limit?: unknown }): Promise<SearchReply> {
      const q = typeof params.q === 'string' ? params.q.trim() : '';
      const pass = params.mode === 'hybrid' ? 'hybrid' : 'keyword';
      const seq = typeof params.seq === 'number' ? params.seq : 0;
      latestSeq = Math.max(latestSeq, seq);
      const limit = typeof params.limit === 'number' ? Math.min(Math.max(params.limit, 1), 50) : 12;
      const cfg = config();
      const proj = project();
      const base = { seq, pass, project: proj } as const;
      if (!q) return { ...base, mode: 'keyword', tookMs: 0, hits: [] };
      if (!fs.existsSync(dataPaths().db)) return { ...base, mode: 'keyword', notice: 'no index yet; run refs index', tookMs: 0, hits: [] };

      const sheets = manifestFor(path.join(cfg.library, 'manifest.json'));
      const db = openDb();
      try {
        const r = await hybridSearch(db, sheets, q, {
          client: pass === 'hybrid' ? ollamaClient(cfg.ollama) : null,
          embedModel: cfg.ollama.embedModel,
          boostTags: proj?.tags ?? [],
          canonical: tagResolver(readTagVocab(cfg.library)),
          limit,
          highlight: [MARK_OPEN, MARK_CLOSE],
          staleAfterDays: cfg.staleAfterDays,
        });
        if (seq < latestSeq) return { ...base, mode: r.mode, superseded: true, tookMs: r.tookMs, hits: [] };
        const learned = new Map(sheets.map((s) => [s.id, s.learned]));
        return {
          ...base,
          mode: r.mode,
          ...(pass === 'hybrid' && r.mode === 'keyword' ? { notice: `keyword only: ${r.notice ?? 'no vectors'}` } : {}),
          tookMs: r.tookMs,
          hits: r.hits.map((h: SearchHit) => ({
            id: h.id,
            section: h.section,
            title: h.title,
            heading: h.heading,
            tags: h.tags,
            status: h.status,
            stale: h.stale,
            ocr: h.ocr,
            learned: learned.get(h.id) ?? false,
            snippet: h.snippet,
          })),
        };
      } finally {
        db.close();
      }
    },

    /**
     * One section (or the whole sheet) ready to show: Markdown rendered and sanitized, other
     * text as plain text, and for OCR sources the original image beside it. Counts as an open.
     */
    async preview(params: { id?: unknown; section?: unknown }) {
      const cfg = config();
      const sheet = sheetOrThrow(cfg, params.id);
      const file = sheetAbsPath(cfg.library, sheet);
      if (!fs.existsSync(file)) throw new SidecarError('not_found', `${sheet.id}: the file is missing from the library (${sheet.file}); run refs doctor`);
      let sections;
      try {
        sections = await sheetSections(cfg.library, sheet);
      } catch (e) {
        throw new SidecarError('error', errorMessage(e));
      }
      const wanted = typeof params.section === 'number' ? params.section : null;
      const chosen = wanted === null ? null : sections.find((s) => s.idx === wanted);
      if (wanted !== null && !chosen) throw new SidecarError('not_found', `${sheet.id} has sections 1 to ${sections.length}; there is no section ${wanted}`);
      const text = chosen ? chosen.text : sections.map((s) => s.text).join('\n\n');

      let body: { kind: 'markdown'; html: string; blocked: string[] } | { kind: 'text'; text: string };
      if (sheet.format === 'md' && !sheet.ocr) {
        const r = renderMarkdown(text, { library: cfg.library, baseDir: path.dirname(file) });
        body = { kind: 'markdown', html: r.html, blocked: r.blocked };
      } else body = { kind: 'text', text };

      const images: { label: string; uri: string }[] = [];
      if (sheet.ocr) {
        const buf = fs.readFileSync(file);
        const type = IMAGE_FORMATS[sheet.format];
        if (type) images.push({ label: path.basename(sheet.file), uri: `data:${type};base64,${buf.toString('base64')}` });
        else if (sheet.format === 'pdf') {
          for (const { page, png } of await scannedPagePreviews(buf, PREVIEW_PDF_PAGES)) images.push({ label: `page ${page}`, uri: `data:image/png;base64,${png.toString('base64')}` });
        }
      }

      logUsage({ event: 'open', id: sheet.id, ...(chosen ? { section: chosen.idx } : {}), via: 'popup' });
      // So the prompt hook stops offering this sheet in "try:". Skipped if a writer holds the lock.
      await tryRefreshHookCache(cfg);
      return {
        sheet: { ...summary(cfg, sheet), tags: sheet.tags, format: sheet.format, file, ocr: sheet.ocr ?? null },
        section: chosen ? { idx: chosen.idx, heading: chosen.heading } : null,
        sections: sections.map((s) => ({ idx: s.idx, heading: s.heading })),
        body,
        images,
      };
    },

    async learned(params: { id?: unknown; learned?: unknown }) {
      const cfg = config();
      const sheet = sheetOrThrow(cfg, params.id);
      const r = await change(() => setLearned(cfg, sheet.id, params.learned !== false, { via: 'popup', waitMs: POPUP_LOCK_WAIT_MS }));
      return { changed: r.changed, sheet: summary(cfg, r.sheet), commitError: r.commitError };
    },

    async verify(params: { id?: unknown }) {
      const cfg = config();
      const sheet = sheetOrThrow(cfg, params.id);
      const r = await change(() => verifySheet(cfg, sheet.id, { via: 'popup', waitMs: POPUP_LOCK_WAIT_MS }));
      return { changed: r.changed, sheet: summary(cfg, r.sheet), commitError: r.commitError };
    },

    async approve(params: { id?: unknown }) {
      const cfg = config();
      const sheet = sheetOrThrow(cfg, params.id);
      const r = await change(() => approveSheet(cfg, sheet.id, { via: 'popup', waitMs: POPUP_LOCK_WAIT_MS }));
      return { changed: r.changed, from: r.from, sheet: summary(cfg, r.sheet), addedToVocab: r.addedToVocab, commitError: r.commitError };
    },

    /** Second Enter: the sheet in its default app. */
    openFile(params: { id?: unknown }) {
      const cfg = config();
      const sheet = sheetOrThrow(cfg, params.id);
      const file = sheetAbsPath(cfg.library, sheet);
      if (!fs.existsSync(file)) throw new SidecarError('not_found', `${sheet.id}: the file is missing from the library (${sheet.file})`);
      opener(file);
      logUsage({ event: 'open', id: sheet.id, via: 'popup' });
      return { opened: file };
    },

    /** A link the user clicked in a preview; only http, https and mailto. */
    openLink(params: { url?: unknown }) {
      const url = typeof params.url === 'string' ? params.url.trim() : '';
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new SidecarError('bad_request', `not a link: ${url.slice(0, 200)}`);
      }
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) throw new SidecarError('bad_request', `only http, https and mailto links open from the popup, not ${parsed.protocol}`);
      opener(parsed.href);
      return { opened: parsed.href };
    },
  };
}

export type Handlers = ReturnType<typeof createHandlers>;
