import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rewriteImports } from '../build.ts';
import { MARK_CLOSE, MARK_OPEN, SearchScheduler, ago, badges, snippetParts, type Timers } from '../src/logic.ts';

interface Reply {
  seq: number;
  pass: 'keyword' | 'hybrid';
  superseded?: boolean;
  q: string;
}

/** Timers the test fires by hand, and replies it releases in any order. */
function harness() {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const fake: Timers = {
    set: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clear: (t) => ((t as { cleared: boolean }).cleared = true),
  };
  const calls: { q: string; pass: Reply['pass']; seq: number; resolve: (r?: Partial<Reply>) => void }[] = [];
  const shown: Reply[] = [];
  const errors: unknown[] = [];
  const s = new SearchScheduler<Reply>({
    run: (q, pass, seq) => new Promise((resolve) => calls.push({ q, pass, seq, resolve: (extra = {}) => resolve({ seq, pass, q, ...extra }) })),
    show: (r) => shown.push(r),
    fail: (e) => errors.push(e),
    delayMs: 250,
    timers: fake,
  });
  const pending = () => timers.filter((t) => !t.cleared);
  const flush = () => new Promise((r) => setImmediate(r));
  return { s, timers, pending, calls, shown, errors, flush };
}

test('each keystroke asks for a keyword pass at once and one hybrid pass after the pause', async () => {
  const h = harness();
  h.s.input('d');
  h.s.input('do');
  h.s.input('docker');
  assert.deepEqual(h.calls.map((c) => [c.q, c.pass, c.seq]), [['d', 'keyword', 1], ['do', 'keyword', 2], ['docker', 'keyword', 3]]);
  assert.equal(h.pending().length, 1, 'earlier hybrid timers were cancelled');
  assert.equal(h.pending()[0]!.ms, 250);
  h.pending()[0]!.fn();
  assert.deepEqual(h.calls.at(-1)!.pass, 'hybrid');
  assert.equal(h.calls.at(-1)!.seq, 3, 'the hybrid pass carries the keystroke it belongs to');
});

test('stale replies are dropped and a late keyword reply never replaces the hybrid ranking', async () => {
  const h = harness();
  h.s.input('doc');
  h.s.input('docker');
  h.pending()[0]!.fn();
  const [kw1, kw2, hy2] = h.calls;
  hy2!.resolve();
  await h.flush();
  kw2!.resolve();
  kw1!.resolve();
  await h.flush();
  assert.deepEqual(h.shown.map((r) => [r.q, r.pass]), [['docker', 'hybrid']]);

  h.s.input('dockerf');
  const hy = h.calls.at(-1)!;
  h.s.input('dockerfile');
  hy.resolve({ superseded: true });
  h.calls.at(-1)!.resolve();
  await h.flush();
  assert.deepEqual(h.shown.map((r) => [r.q, r.pass]), [['docker', 'hybrid'], ['dockerfile', 'keyword']]);
});

test('an empty box asks only for the (empty) keyword pass; errors of stale searches are ignored', async () => {
  const h = harness();
  h.s.input('  ');
  assert.equal(h.pending().length, 0);
  const failing = new SearchScheduler<Reply>({ run: () => Promise.reject(new Error('down')), show: () => {}, fail: (e) => h.errors.push(e), timers: { set: () => 0, clear: () => {} } });
  failing.input('a');
  failing.input('b');
  await h.flush();
  assert.equal(h.errors.length, 1, 'only the newest search reports its error');
});

test('snippet marks become parts, never HTML', () => {
  assert.deepEqual(snippetParts(`run ${MARK_OPEN}docker${MARK_CLOSE} ps <b>`), [
    { text: 'run ', mark: false },
    { text: 'docker', mark: true },
    { text: ' ps <b>', mark: false },
  ]);
  assert.deepEqual(snippetParts(''), []);
});

test('badges and ages', () => {
  assert.deepEqual(badges({ status: 'draft', stale: true, ocr: true, learned: true }).map((b) => b.label), ['draft', 'stale', 'OCR', 'learned']);
  assert.deepEqual(badges({ status: 'pending', stale: false, ocr: null, learned: false }).map((b) => b.label), ['pending']);
  assert.deepEqual(badges({ status: 'verified', stale: false, ocr: false, learned: false }), []);
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(ago('2026-10-21T11:59:40Z', now), 'just now');
  assert.equal(ago('2026-10-21T11:15:00Z', now), '45 min ago');
  assert.equal(ago('2026-10-21T09:00:00Z', now), '3 h ago');
  assert.equal(ago('2026-10-18T12:00:00Z', now), '3 days ago');
  assert.equal(ago(null, now), '');
});

test('the build rewrites relative .ts imports and the vue import only', () => {
  const code = `import { h } from 'vue';\nimport { App } from './app.ts';\nimport x from "../y/z.ts";\nconst s = 'vue';\nimport other from 'other.ts';\n`;
  assert.equal(
    rewriteImports(code),
    `import { h } from './vendor/vue.runtime.esm-browser.prod.js';\nimport { App } from './app.js';\nimport x from "../y/z.js";\nconst s = 'vue';\nimport other from 'other.ts';\n`,
  );
});
