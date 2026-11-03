import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '@nudge/core';
import markdownit from 'markdown-it';

// Sheets are untrusted text, so the popup preview is rendered here, not in the webview:
// - raw HTML is never passed through (html: false escapes it), so no tags or scripts;
// - only http, https and mailto become links, marked for the popup to open externally
//   after a click; every other target (javascript:, file:, relative paths) stays plain text;
// - images load only from inside the library (png, jpg, gif, webp up to 5 MB), inlined as
//   data: URIs; remote, data: and anything else become a visible placeholder.
// The popup's content security policy (no inline script, img-src 'self' data:) backs this up.

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Longer sheets are shown as plain text: rendering cost grows with size. */
export const RENDER_MAX_CHARS = 512 * 1024;

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const EXTERNAL = /^(https?:\/\/|mailto:)/i;
/** A scheme ("javascript:", "c:") or a protocol-relative "//host" is not a library-relative path. */
const NOT_RELATIVE = /^([a-z][a-z0-9+.-]*:|\/\/|\\\\)/i;

export interface RenderOptions {
  library: string;
  /** Folder that relative image paths resolve against (the sheet's folder). */
  baseDir: string;
}

export interface Rendered {
  html: string;
  /** Images and links that were not allowed, for the preview footer. */
  blocked: string[];
}

/** Per-render state, carried in markdown-it's env object. */
interface RenderState {
  opts: RenderOptions;
  blocked: string[];
  /** One entry per open link: true when it was rendered as an external link. */
  links: boolean[];
}

const state = (env: unknown) => env as RenderState;

const md = markdownit({ html: false, linkify: true, typographer: false });
// Link reference definitions are off: markdown-it 15.0.2 renders a long multi-line one in
// quadratic time (GHSA-gfr2-rv44-r23c, fixed in 15.0.3). Inline links still work.
md.disable('reference');
// Let every target through the parser; the render rules below decide what it becomes,
// so a refused link still shows its text instead of literal Markdown.
md.validateLink = () => true;

const esc = md.utils.escapeHtml;

/** A data: URI for an image inside the library, or the reason it is refused. */
export function libraryImage(src: string, opts: RenderOptions): { uri: string } | { refused: string } {
  const target = src.trim();
  if (!target) return { refused: 'empty' };
  if (NOT_RELATIVE.test(target) || path.isAbsolute(target)) return { refused: EXTERNAL.test(target) ? 'remote' : 'not a library file' };
  let rel: string;
  try {
    rel = decodeURIComponent(target.split(/[?#]/)[0]!);
  } catch {
    return { refused: 'bad path' };
  }
  const file = path.resolve(opts.baseDir, rel);
  if (!isInside(file, opts.library)) return { refused: 'outside the library' };
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) return { refused: 'not a png, jpg, gif or webp image' };
  let size: number;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { refused: 'not found' };
    size = st.size;
  } catch {
    return { refused: 'not found' };
  }
  if (size > IMAGE_MAX_BYTES) return { refused: 'larger than 5 MB' };
  return { uri: `data:${type};base64,${fs.readFileSync(file).toString('base64')}` };
}

md.renderer.rules.link_open = (tokens, idx, _options, env) => {
  const s = state(env);
  const href = String(tokens[idx]!.attrGet('href') ?? '');
  const external = EXTERNAL.test(href);
  s.links.push(external);
  if (external) return `<a href="${esc(href)}" title="${esc(href)}" data-external="1">`;
  s.blocked.push(`link ${href}`);
  return `<span class="link-off" title="${esc(`not opened from the popup: ${href}`)}">`;
};

md.renderer.rules.link_close = (_tokens, _idx, _options, env) => (state(env).links.pop() ? '</a>' : '</span>');

md.renderer.rules.image = (tokens, idx, _options, env) => {
  const s = state(env);
  const token = tokens[idx]!;
  const src = String(token.attrGet('src') ?? '');
  const alt = token.content;
  const image = libraryImage(src, s.opts);
  if ('uri' in image) return `<img src="${image.uri}" alt="${esc(alt)}">`;
  s.blocked.push(`image ${src} (${image.refused})`);
  return `<span class="img-off">[image${alt ? ` "${esc(alt)}"` : ''} not shown: ${esc(image.refused)}]</span>`;
};

export function renderMarkdown(text: string, opts: RenderOptions): Rendered {
  if (text.length > RENDER_MAX_CHARS) {
    return { html: `<pre>${esc(text)}</pre>`, blocked: [`formatting (longer than ${RENDER_MAX_CHARS / 1024} KB, shown as plain text)`] };
  }
  const s: RenderState = { opts, blocked: [], links: [] };
  return { html: md.render(text, s as unknown as Record<string, unknown>), blocked: s.blocked };
}
