import { decodeText } from '../util.ts';

/** Markdown and plain text are used as is, apart from encoding and line endings. */
export function extractMarkdown(buf: Buffer): string {
  return decodeText(buf);
}

export const extractPlainText = extractMarkdown;
