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
