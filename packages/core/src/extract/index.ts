import path from 'node:path';
import type { SheetFormat } from '../manifest.ts';
import { RefsError, errorMessage } from '../util.ts';
import { ocrImage, type Ocr } from './image.ts';
import { extractMarkdown, extractPlainText } from './markdown.ts';

// mammoth and pdfjs are loaded only when needed, so search and open start fast.

/** Separates PDF pages in extracted text (and in the extract cache). */
export const PAGE_BREAK = '\f';

export interface Extracted {
  text: string;
  warnings: string[];
  /** Set when some or all of the text came from OCR. */
  ocr?: { model: string; pages?: number; scannedPages?: number };
}

export interface ExtractOptions {
  /** OCR for images and PDF pages without a text layer. Without it those fail with OcrUnavailableError. */
  ocr?: Ocr | null;
  /** Scanned PDF pages OCR'd at most (config ocrMaxPages). */
  ocrMaxPages?: number;
  /**
   * Asked when a scanned PDF has more pages than ocrMaxPages; true OCRs the first pages
   * only, false cancels. Without it the first pages are OCR'd and a warning says so.
   */
  confirmPartialOcr?: (scanned: number, max: number) => Promise<boolean>;
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

export async function extract(format: SheetFormat, buf: Buffer, opts: ExtractOptions = {}): Promise<Extracted> {
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
        const empty = pages.flatMap((p, i) => (p ? [] : [i + 1]));
        if (!empty.length) return { text: pages.join(PAGE_BREAK), warnings: [] };
        return await ocrPdfPages(buf, pages, empty, opts);
      }
      case 'png':
      case 'jpg': {
        const text = await ocrImage(opts.ocr, buf);
        return { text, warnings: [], ocr: { model: opts.ocr!.model } };
      }
    }
  } catch (e) {
    if (e instanceof RefsError) throw e;
    throw new RefsError(`could not extract text from this ${format.toUpperCase()} file: ${errorMessage(e)}`);
  }
}

/** OCR the pages without a text layer (up to ocrMaxPages) and merge them in page order. */
async function ocrPdfPages(buf: Buffer, pages: string[], empty: number[], opts: ExtractOptions): Promise<Extracted> {
  if (!opts.ocr) await ocrImage(null, buf); // throws OcrUnavailableError
  const warnings: string[] = [];
  const max = opts.ocrMaxPages ?? 50;
  let todo = empty;
  if (empty.length > max) {
    if (opts.confirmPartialOcr && !(await opts.confirmPartialOcr(empty.length, max))) {
      throw new RefsError(`cancelled; ${empty.length} scanned pages is more than ocrMaxPages (${max}). Nothing changed.`);
    }
    todo = empty.slice(0, max);
    warnings.push(`${empty.length} pages have no text layer; only the first ${max} were OCR'd (ocrMaxPages). The rest are not searchable and were not secret-scanned.`);
  }
  const { renderPdfPages } = await import('./pdf.ts');
  const pngs = await renderPdfPages(buf, todo);
  const out = [...pages];
  for (const [i, n] of todo.entries()) out[n - 1] = await opts.ocr!.recognize(pngs[i]!);
  return { text: out.join(PAGE_BREAK), warnings, ocr: { model: opts.ocr!.model, pages: todo.length, scannedPages: empty.length } };
}
