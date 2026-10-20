import mammoth from 'mammoth';

/** DOCX to Markdown-like text: Word headings become # headings so chunking can split on them. */
export async function extractDocx(buf: Buffer): Promise<{ text: string; warnings: string[] }> {
  const result = await mammoth.convertToHtml({ buffer: buf });
  const warnings = result.messages.filter((m) => m.type === 'error').map((m) => m.message);
  return { text: htmlToMarkdown(result.value), warnings };
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/**
 * Mammoth emits simple, well-formed HTML, so a few targeted replacements are enough.
 * Entities are decoded last so escaped "<" in the text never looks like a tag.
 */
export function htmlToMarkdown(html: string): string {
  const text = html
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_m, n: string, inner: string) => {
      return `\n\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`;
    })
    .replace(/<li[^>]*>/g, '\n- ')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(p|li|ul|ol|tr|table)>/g, '\n')
    .replace(/<\/t[dh]>/g, '\t')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
