// Browser-free parts of the popup, unit-tested under Node (apps/popup/test).

/** Marks the sidecar puts around matched words in snippets (private-use characters). */
export const MARK_OPEN = '\u{E000}';
export const MARK_CLOSE = '\u{E001}';

/** Typing pause before the hybrid pass is asked for. */
export const HYBRID_DELAY_MS = 250;

export interface Part {
  text: string;
  mark: boolean;
}

/** Split a snippet into plain and matched parts, rendered as text nodes (never as HTML). */
export function snippetParts(snippet: string): Part[] {
  const parts: Part[] = [];
  let mark = false;
  let text = '';
  for (const ch of snippet) {
    if (ch === MARK_OPEN || ch === MARK_CLOSE) {
      if (text) parts.push({ text, mark });
      text = '';
      mark = ch === MARK_OPEN;
    } else text += ch;
  }
  if (text) parts.push({ text, mark });
  return parts;
}

export interface BadgeSource {
  status: 'pending' | 'verified' | 'draft';
  stale: boolean;
  ocr: boolean | object | null;
  learned: boolean;
}

export interface Badge {
  label: string;
  kind: 'warn' | 'info' | 'ok';
  title: string;
}

export function badges(s: BadgeSource): Badge[] {
  const out: Badge[] = [];
  if (s.status === 'draft') out.push({ label: 'draft', kind: 'warn', title: 'Written by a local LLM, not checked yet' });
  if (s.status === 'pending') out.push({ label: 'pending', kind: 'warn', title: 'Imported, tags not confirmed yet' });
  if (s.stale) out.push({ label: 'stale', kind: 'warn', title: 'Not verified recently' });
  if (s.ocr) out.push({ label: 'OCR', kind: 'info', title: 'Text read from an image; commands may be mangled' });
  if (s.learned) out.push({ label: 'learned', kind: 'ok', title: 'Marked learned' });
  return out;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export interface SearchReplyLike {
  seq: number;
  pass: 'keyword' | 'hybrid';
  superseded?: boolean;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Results as you type: every keystroke asks for a keyword pass at once, and a hybrid pass
 * once typing pauses. Each keystroke gets a new sequence number; a reply for an older one
 * is dropped, and a late keyword reply never replaces the hybrid ranking of the same query.
 */
export class SearchScheduler<R extends SearchReplyLike> {
  private seq = 0;
  private timer: unknown = null;
  private shown: { seq: number; pass: R['pass'] } | null = null;
  private readonly run: (q: string, pass: R['pass'], seq: number) => Promise<R>;
  private readonly show: (reply: R) => void;
  private readonly fail: (error: unknown) => void;
  private readonly delayMs: number;
  private readonly timers: Timers;

  constructor(opts: { run: (q: string, pass: R['pass'], seq: number) => Promise<R>; show: (reply: R) => void; fail: (error: unknown) => void; delayMs?: number; timers?: Timers }) {
    this.run = opts.run;
    this.show = opts.show;
    this.fail = opts.fail;
    this.delayMs = opts.delayMs ?? HYBRID_DELAY_MS;
    this.timers = opts.timers ?? realTimers;
  }

  input(query: string): number {
    const seq = ++this.seq;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.fire(query, 'keyword', seq);
    if (query.trim()) {
      this.timer = this.timers.set(() => {
        this.timer = null;
        this.fire(query, 'hybrid', seq);
      }, this.delayMs);
    }
    return seq;
  }

  /** True when the reply was shown. */
  accept(reply: R): boolean {
    if (reply.superseded || reply.seq !== this.seq) return false;
    if (reply.pass === 'keyword' && this.shown?.seq === reply.seq && this.shown.pass === 'hybrid') return false;
    this.shown = { seq: reply.seq, pass: reply.pass };
    this.show(reply);
    return true;
  }

  private fire(query: string, pass: R['pass'], seq: number): void {
    this.run(query, pass, seq).then(
      (reply) => this.accept(reply),
      (e: unknown) => {
        if (seq === this.seq) this.fail(e);
      },
    );
  }
}
