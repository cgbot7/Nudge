import path from 'node:path';
import type { SheetFormat } from '../manifest.ts';
import { RefsError, errorMessage } from '../util.ts';
import { extractMarkdown, extractPlainText } from './markdown.ts';

// mammoth and pdfjs are loaded only when needed, so search and open start fast.

/** Separates PDF pages in extracted text (and in the extract cache). */
export const PAGE_BREAK = '\f';

export interface Extracted {
  text: string;
  warnings: string[];
}

const EXTENSIONS: Record<string, SheetFormat> = {
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'txt',
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
};

export function formatFromPath(file: string): SheetFormat | null {
  return EXTENSIONS[path.extname(file).toLowerCase()] ?? null;
}

export async function extract(format: SheetFormat, buf: Buffer): Promise<Extracted> {
  try {
    switch (format) {
      case 'md':
        return { text: extractMarkdown(buf), warnings: [] };
      case 'txt':
        return { text: extractPlainText(buf), warnings: [] };
      case 'docx': {
        const { extractDocx } = await import('./docx.ts');
        return await extractDocx(buf);
      }
      case 'pdf': {
        const { extractPdfPages } = await import('./pdf.ts');
        const pages = await extractPdfPages(buf);
        const empty = pages.filter((p) => !p).length;
        if (pages.length > 0 && empty === pages.length) {
          throw new RefsError('this PDF has no text layer (scanned). OCR for scanned PDFs arrives in milestone 3.');
        }
        const warnings = empty ? [`${empty} of ${pages.length} PDF pages have no text layer and were skipped (OCR arrives in milestone 3).`] : [];
        return { text: pages.join(PAGE_BREAK), warnings };
      }
      case 'png':
      case 'jpg':
        throw new RefsError('images need OCR, which arrives in milestone 3.');
    }
  } catch (e) {
    if (e instanceof RefsError) throw e;
    throw new RefsError(`could not extract text from this ${format.toUpperCase()} file: ${errorMessage(e)}`);
  }
}
