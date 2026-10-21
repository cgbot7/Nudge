import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { IMAGE_MAX_BYTES, RENDER_MAX_CHARS, renderMarkdown } from '../src/markdown.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-md-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const library = path.join(root, 'lib & more');
const sheets = path.join(library, 'sheets');
fs.mkdirSync(path.join(sheets, 'img'), { recursive: true });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082', 'hex');
fs.writeFileSync(path.join(sheets, 'img', 'shot one.png'), PNG);
fs.writeFileSync(path.join(sheets, 'img', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
fs.writeFileSync(path.join(sheets, 'img', 'huge.png'), Buffer.alloc(IMAGE_MAX_BYTES + 1));
fs.writeFileSync(path.join(root, 'outside.png'), PNG);

const render = (md: string) => renderMarkdown(md, { library, baseDir: sheets });
/** Every tag name in the output, to prove nothing outside markdown-it's own set gets through. */
const tags = (html: string) => [...new Set([...html.matchAll(/<([a-z][a-z0-9]*)/g)].map((m) => m[1]))].sort();

test('script tags and raw HTML are shown as text, never as elements', () => {
  const r = render('# Title\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n<iframe src="https://x.test"></iframe> <b onclick="x()">bold?</b>\n\n<style>body{display:none}</style>');
  assert.ok(r.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(r.html.includes('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;'));
  assert.ok(r.html.includes('&lt;iframe'));
  // The only element besides headings and paragraphs: the iframe's URL, linkified in its escaped text.
  assert.deepEqual(tags(r.html), ['a', 'h1', 'p']);
  assert.deepEqual([...r.html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]), ['https://x.test']);
  assert.doesNotMatch(r.html, /<(script|img|iframe|b|style)\b/i);
  assert.doesNotMatch(r.html, /<[^>]*\son\w+=/i, 'no event handler attributes on any element');
});

test('only http, https and mailto become links, marked to open externally after a click', () => {
  const r = render(
    '[ok](https://docs.docker.com/engine/) [mail](mailto:me@example.com) [js](javascript:alert(1)) [JS](JaVaScRiPt:alert(1)) ' +
      '[vb](vbscript:msgbox) [data](data:text/html,<script>alert(1)</script>) [file](file:///C:/Windows/win.ini) [rel](other.md) <javascript:alert(3)>\n\nbare https://example.com/a?b=1&c=2',
  );
  const links = [...r.html.matchAll(/<a href="([^"]*)"[^>]*>/g)];
  assert.deepEqual(links.map((m) => m[1]), ['https://docs.docker.com/engine/', 'mailto:me@example.com', 'https://example.com/a?b=1&amp;c=2']);
  assert.ok(links.every((m) => m[0].includes('data-external="1"')));
  assert.doesNotMatch(r.html, /href="(javascript|vbscript|data|file):/i);
  assert.match(r.html, /<span class="link-off" title="not opened from the popup: javascript:alert\(1\)">js<\/span>/);
  assert.deepEqual(r.blocked.filter((b) => b.startsWith('link')).length, 7);
});

test('images load only from inside the library, as data URIs; remote and other images become placeholders', () => {
  const r = render(
    '![shot](img/shot%20one.png) ![remote](https://tracker.test/pixel.png) ![proto](//tracker.test/p.png) ![data](data:image/png;base64,AAAA) ' +
      '![up](../../outside.png) ![abs](C:/Windows/web/x.png) ![svg](img/logo.svg) ![huge](img/huge.png) ![gone](img/missing.png)',
  );
  const imgs = [...r.html.matchAll(/<img src="([^"]*)" alt="([^"]*)">/g)];
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0]![1], `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(imgs[0]![2], 'shot');
  assert.deepEqual(r.blocked, [
    'image https://tracker.test/pixel.png (remote)',
    'image //tracker.test/p.png (not a library file)',
    'image data:image/png;base64,AAAA (not a library file)',
    'image ../../outside.png (outside the library)',
    'image C:/Windows/web/x.png (not a library file)',
    'image img/logo.svg (not a png, jpg, gif or webp image)',
    'image img/huge.png (larger than 5 MB)',
    'image img/missing.png (not found)',
  ]);
  assert.match(r.html, /<span class="img-off">\[image "remote" not shown: remote\]<\/span>/);
  assert.doesNotMatch(r.html, /tracker\.test\/pixel\.png"/, 'no remote URL in any src');
});

test('alt text and code are escaped; code blocks stay code', () => {
  const r = render('![a"><script>x</script>](https://x.test/i.png)\n\n```html\n<script>alert(1)</script>\n```\n\n`<b>`');
  assert.doesNotMatch(r.html, /<script>/);
  assert.match(r.html, /<pre><code class="language-html">&lt;script&gt;alert\(1\)&lt;\/script&gt;\n<\/code><\/pre>/);
  assert.match(r.html, /<code>&lt;b&gt;<\/code>/);
});

test('link reference definitions are off (markdown-it 15.0.2 advisory), and huge sheets are shown as plain text', () => {
  const r = render('[docs][1]\n\n[1]: javascript:alert(1)\n');
  assert.doesNotMatch(r.html, /<a /);
  const longLabel = `[${'a\n'.repeat(20_000)}]: x`;
  const started = performance.now();
  render(longLabel);
  assert.ok(performance.now() - started < 1000, 'a long multi-line reference label renders quickly');
  const big = renderMarkdown('<script>x</script>'.repeat(RENDER_MAX_CHARS / 10), { library, baseDir: sheets });
  assert.match(big.html, /^<pre>&lt;script&gt;/);
  assert.match(big.blocked[0]!, /shown as plain text/);
});
