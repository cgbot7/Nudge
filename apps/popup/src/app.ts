import { defineComponent, h, nextTick, onMounted, reactive, ref, type VNode } from 'vue';
import { SidecarClient, SidecarFailure, invoke, listen, report } from './ipc.ts';
import { SearchScheduler, ago, badges, snippetParts, type BadgeSource } from './logic.ts';

// The popup window. Render functions instead of templates: the runtime-only Vue build
// needs no compiler and no eval, so the content security policy can forbid both.

interface Hit extends BadgeSource {
  id: string;
  section: number;
  title: string;
  heading: string;
  tags: string[];
  snippet: string;
}

interface SearchReply {
  seq: number;
  pass: 'keyword' | 'hybrid';
  mode: 'keyword' | 'hybrid';
  notice?: string;
  superseded?: boolean;
  project: { name: string; path: string; tags: string[]; at: string | null } | null;
  tookMs: number;
  hits: Hit[];
}

interface SheetSummary {
  id: string;
  title: string;
  status: Hit['status'];
  learned: boolean;
  lastVerified: string;
  stale: boolean;
}

interface Preview {
  sheet: SheetSummary & { tags: string[]; format: string; file: string; ocr: object | null };
  section: { idx: number; heading: string } | null;
  sections: { idx: number; heading: string }[];
  body: { kind: 'markdown'; html: string; blocked: string[] } | { kind: 'text'; text: string };
  images: { label: string; uri: string }[];
}

type Toast = { kind: 'ok' | 'warn' | 'error'; text: string };

const DEFAULT_HOTKEY = 'Ctrl+Alt+Space';

export const App = defineComponent({
  setup() {
    const sidecar = new SidecarClient();
    const input = ref<HTMLInputElement | null>(null);
    const previewEl = ref<HTMLElement | null>(null);
    const state = reactive({
      query: '',
      reply: null as SearchReply | null,
      selected: 0,
      view: 'list' as 'list' | 'preview',
      preview: null as Preview | null,
      loading: false,
      busy: false,
      toast: null as Toast | null,
      problems: [] as string[],
      hotkey: DEFAULT_HOTKEY,
      shownMs: null as number | null,
    });
    let toastTimer: ReturnType<typeof setTimeout> | undefined;
    // WebView2 sends mousemove when the window or the list changes under a cursor that did not
    // move; only a real move may change the selection, or the arrow keys lose to a parked mouse.
    let lastMouse = '';
    /** The user picked a row (arrows or mouse) since the last keystroke. */
    let picked = false;
    const select = (i: number) => {
      state.selected = i;
      picked = true;
    };
    const onHover = (e: MouseEvent, i: number) => {
      const at = `${e.screenX},${e.screenY}`;
      if (at === lastMouse) return;
      const first = lastMouse === '';
      lastMouse = at;
      if (!first) select(i);
    };

    const toast = (kind: Toast['kind'], text: string) => {
      state.toast = { kind, text };
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (state.toast = null), kind === 'ok' ? 2500 : 6000);
    };
    const failure = (e: unknown) => (e instanceof SidecarFailure && e.code === 'busy' ? `Busy: ${e.message}` : e instanceof Error ? e.message : String(e));

    const scheduler = new SearchScheduler<SearchReply>({
      run: (q, pass, seq) => sidecar.request<SearchReply>('search', { q, mode: pass, seq }),
      show: (reply) => {
        // When the hybrid pass re-ranks the same query, a row the user picked stays picked;
        // otherwise the selection is the top of the new ranking.
        const keep = picked && state.reply?.seq === reply.seq ? state.reply.hits[state.selected] : undefined;
        // A keyword pass says nothing about Ollama; keep the last fallback notice until a hybrid pass answers.
        if (reply.pass === 'keyword' && state.reply?.notice) reply.notice = state.reply.notice;
        state.reply = reply;
        const again = keep ? reply.hits.findIndex((x) => x.id === keep.id && x.section === keep.section) : -1;
        state.selected = again >= 0 ? again : 0;
      },
      fail: (e) => toast('error', failure(e)),
    });

    const onInput = (e: Event) => {
      state.query = (e.target as HTMLInputElement).value;
      state.view = 'list';
      picked = false;
      scheduler.input(state.query);
    };

    async function openPreview(hit: Hit) {
      state.loading = true;
      try {
        state.preview = await sidecar.request<Preview>('preview', { id: hit.id, section: hit.section });
        state.view = 'preview';
        await nextTick();
        previewEl.value?.focus();
      } catch (e) {
        toast('error', failure(e));
      } finally {
        state.loading = false;
      }
    }

    async function act(method: 'learned' | 'verify' | 'approve', done: string, unchanged: string) {
      const p = state.preview;
      if (!p || state.busy) return;
      state.busy = true;
      try {
        const r = await sidecar.request<{ changed: boolean; sheet: SheetSummary; commitError?: string }>(method, { id: p.sheet.id });
        Object.assign(p.sheet, r.sheet);
        for (const hit of state.reply?.hits ?? []) if (hit.id === r.sheet.id) Object.assign(hit, { status: r.sheet.status, learned: r.sheet.learned, stale: r.sheet.stale });
        if (r.commitError) toast('warn', `${done}, but the Git commit failed: ${r.commitError}`);
        else toast('ok', r.changed ? done : unchanged);
      } catch (e) {
        toast(e instanceof SidecarFailure && e.code === 'busy' ? 'warn' : 'error', failure(e));
      } finally {
        state.busy = false;
      }
    }

    const markLearned = () => act('learned', 'Marked learned: it will not be offered in try: again', 'Already learned');
    const markVerified = () => act('verify', 'Marked verified today', 'Already verified today');
    const approve = () => act('approve', 'Approved: now a verified sheet', 'Already verified');

    async function openFile() {
      if (!state.preview) return;
      try {
        await sidecar.request('openFile', { id: state.preview.sheet.id });
        await invoke('hide_popup');
      } catch (e) {
        toast('error', failure(e));
      }
    }

    function onPreviewClick(e: MouseEvent) {
      const a = (e.target as HTMLElement).closest('a');
      if (!a) return;
      e.preventDefault();
      // Links open in the default browser only on a click, and only http, https and mailto.
      if (a.dataset.external) sidecar.request('openLink', { url: a.getAttribute('href') }).catch((err: unknown) => toast('error', failure(err)));
    }

    function back() {
      state.view = 'list';
      input.value?.focus();
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        void invoke('hide_popup');
        return;
      }
      const hits = state.reply?.hits ?? [];
      if (state.view === 'list') {
        if (e.key === 'ArrowDown' && hits.length) {
          e.preventDefault();
          select((state.selected + 1) % hits.length);
        } else if (e.key === 'ArrowUp' && hits.length) {
          e.preventDefault();
          select((state.selected - 1 + hits.length) % hits.length);
        } else if (e.key === 'Enter' && hits[state.selected]) {
          e.preventDefault();
          void openPreview(hits[state.selected]!);
        }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        void openFile();
      } else if (e.altKey && e.key.toLowerCase() === 'l') void markLearned();
      else if (e.altKey && e.key.toLowerCase() === 'v') void markVerified();
      else if (e.altKey && e.key.toLowerCase() === 'a' && state.preview?.sheet.status !== 'verified') void approve();
      else if ((e.altKey && e.key === 'ArrowLeft') || (e.key === 'Backspace' && document.activeElement !== input.value)) {
        e.preventDefault();
        back();
      }
    }

    function onShown() {
      lastMouse = '';
      state.view = 'list';
      input.value?.focus();
      input.value?.select();
      // Two frames: the first runs before the shown window is painted, the second after.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          invoke<number | null>('shown_ack').then((ms) => {
            if (ms !== null) state.shownMs = Math.round(ms);
          });
        }),
      );
      if (state.query) scheduler.input(state.query);
    }

    onMounted(async () => {
      document.addEventListener('keydown', onKey);
      await sidecar.start((message) => state.problems.push(message));
      await listen<null>('popup-shown', onShown);
      // The sidecar may still be starting: retry hello for a while.
      let hello: { hotkey: string; hotkeyError?: string; configError?: string } | null = null;
      for (let i = 0; i < 50 && !hello; i++) {
        try {
          hello = await sidecar.request('hello', {}, 5000);
        } catch (e) {
          if (i % 10 === 0) report(`hello attempt ${i + 1} failed: ${failure(e)}`);
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      if (!hello) {
        state.problems.push('The sidecar did not start; see %LOCALAPPDATA%\\nudge\\logs\\popup.log');
        return;
      }
      if (hello.configError) state.problems.push(hello.configError);
      if (hello.hotkeyError) state.problems.push(hello.hotkeyError);
      try {
        state.hotkey = await invoke<string>('set_hotkey', { accelerator: hello.hotkey });
      } catch (e) {
        state.problems.push(`Hotkey: ${String(e)}`);
        report(`hotkey: ${String(e)}`);
      }
    });

    const badgeNodes = (s: BadgeSource) => badges(s).map((b) => h('span', { class: `badge ${b.kind}`, title: b.title }, b.label));
    const where = (title: string, heading: string) => (heading && heading !== title && heading !== 'Intro' ? [h('span', { class: 'title' }, title), h('span', { class: 'heading' }, ` > ${heading}`)] : [h('span', { class: 'title' }, title)]);

    function resultList(): VNode {
      const r = state.reply;
      if (!r) return h('div', { class: 'empty' }, 'Type to search your sheets.');
      if (!r.hits.length) return h('div', { class: 'empty' }, state.query.trim() ? `No sheets match "${state.query.trim()}".` : 'Type to search your sheets.');
      return h(
        'ul',
        { class: 'results' },
        r.hits.map((hit, i) =>
          h('li', { class: ['hit', i === state.selected && 'selected'], key: `${hit.id}:${hit.section}`, onMousemove: (e: MouseEvent) => onHover(e, i), onClick: () => openPreview(hit) }, [
            h('div', { class: 'line' }, [...where(hit.title, hit.heading), ...badgeNodes(hit), hit.tags.length ? h('span', { class: 'tags' }, hit.tags.join(', ')) : null]),
            h('div', { class: 'snippet' }, snippetParts(hit.snippet).map((p) => (p.mark ? h('b', p.text) : p.text))),
          ]),
        ),
      );
    }

    function previewView(): VNode {
      const p = state.preview!;
      const s = p.sheet;
      const body =
        p.body.kind === 'markdown'
          ? h('div', { class: 'md', innerHTML: p.body.html, onClick: onPreviewClick })
          : h('pre', { class: 'text' }, p.body.text);
      const blocked = p.body.kind === 'markdown' && p.body.blocked.length ? h('div', { class: 'blocked' }, `Not shown or not linked: ${p.body.blocked.join('; ')}`) : null;
      return h('div', { class: 'preview', tabindex: -1, ref: previewEl }, [
        h('div', { class: 'phead' }, [
          h('div', { class: 'line' }, [...where(s.title, p.section?.heading ?? ''), ...badgeNodes({ ...s, ocr: s.ocr })]),
          h('div', { class: 'meta' }, `${s.id}${p.section ? `, section ${p.section.idx} of ${p.sections.length}` : ''} | ${s.tags.join(', ') || 'no tags'} | verified ${s.lastVerified}`),
          h('div', { class: 'actions' }, [
            h('button', { onClick: back, title: 'Alt+Left' }, 'Back'),
            h('button', { onClick: markLearned, disabled: state.busy || s.learned, title: 'Alt+L' }, s.learned ? 'Learned' : 'Mark learned'),
            h('button', { onClick: markVerified, disabled: state.busy, title: 'Alt+V' }, 'Mark verified'),
            s.status !== 'verified' ? h('button', { onClick: approve, disabled: state.busy, title: 'Alt+A' }, 'Approve') : null,
            h('button', { class: 'primary', onClick: openFile, title: 'Enter' }, 'Open file'),
          ]),
        ]),
        p.images.length
          ? h('div', { class: 'ocr' }, [h('div', { class: 'originals' }, p.images.map((img) => h('figure', [h('img', { src: img.uri, alt: img.label }), h('figcaption', img.label)]))), body])
          : body,
        blocked,
      ]);
    }

    function footer(): VNode {
      const r = state.reply;
      const proj = r?.project;
      const left = proj
        ? `boosted for ${proj.name} [${proj.tags.join(', ') || 'no tags'}]${proj.at ? `, seen ${ago(proj.at)}` : ''}`
        : 'no current project (cd into one in a terminal)';
      const mode = r && state.query.trim() ? `${r.mode}, ${r.tookMs} ms` : '';
      const hint = state.view === 'list' ? 'Enter preview | Esc hide' : 'Enter open file | Alt+L learned | Esc hide';
      return h('footer', [h('span', left), h('span', { class: 'right' }, [mode, state.shownMs !== null ? ` | shown in ${state.shownMs} ms` : '', ` | ${hint}`].join(''))]);
    }

    return () =>
      h('div', { class: 'popup' }, [
        h('div', { class: 'search' }, [
          h('input', { ref: input, value: state.query, onInput, placeholder: `Search sheets (${state.hotkey})`, spellcheck: false, autofocus: true }),
          state.loading ? h('span', { class: 'spinner' }, 'loading') : null,
        ]),
        ...state.problems.map((p) => h('div', { class: 'notice error' }, p)),
        state.reply?.notice && state.query.trim() ? h('div', { class: 'notice' }, state.reply.notice) : null,
        h('main', [state.view === 'preview' && state.preview ? previewView() : resultList()]),
        state.toast ? h('div', { class: `toast ${state.toast.kind}` }, state.toast.text) : null,
        footer(),
      ]);
  },
});
