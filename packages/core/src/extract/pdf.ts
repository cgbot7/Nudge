import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Text layer of each page, in order. A page without a text layer yields "". */
export async function extractPdfPages(buf: Buffer): Promise<string[]> {
  // pdfjs takes ownership of the array it is given, so pass a copy.
  const task = getDocument({ data: new Uint8Array(buf), verbosity: 0, disableFontFace: true });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let out = '';
      let lastY: number | null = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5] as number;
        if (lastY !== null && Math.abs(y - lastY) > 1 && !out.endsWith('\n')) out += '\n';
        out += item.str;
        if (item.hasEOL) out += '\n';
        lastY = y;
      }
      pages.push(out.replace(/[ \t]+\n/g, '\n').trim());
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** Render pages (1-based numbers) to PNG at 2x (144 dpi), for OCR. pdfjs brings its own canvas. */
export async function renderPdfPages(buf: Buffer, pageNumbers: number[], scale = 2): Promise<Buffer[]> {
  const task = getDocument({ data: new Uint8Array(buf), verbosity: 0 });
  try {
    const doc = await task.promise;
    const out: Buffer[] = [];
    for (const n of pageNumbers) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      // In Node, pdfjs creates @napi-rs/canvas canvases (its optional dependency).
      const factory = doc.canvasFactory as { create(w: number, h: number): { canvas: { toBuffer(type: string): Buffer }; context: unknown } };
      const target = factory.create(viewport.width, viewport.height);
      await page.render({ canvas: target.canvas, canvasContext: target.context, viewport } as unknown as Parameters<typeof page.render>[0]).promise;
      out.push(target.canvas.toBuffer('image/png'));
      page.cleanup();
    }
    return out;
  } finally {
    await task.destroy();
  }
}
