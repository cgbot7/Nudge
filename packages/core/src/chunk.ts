import { PAGE_BREAK } from './extract/index.ts';
import type { SheetFormat } from './manifest.ts';

export interface Section {
  /** 1-based, used by `nudge open <id> --section <n>`. */
  idx: number;
  heading: string;
  /** Full section text, including its heading line. */
  text: string;
}

/** A heading whose body has fewer words than this merges into the next section. */
const MIN_BODY_WORDS = 8;

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

interface RawSection {
  heading: string | null;
  lines: string[];
  bodyWords: number;
}

function countWords(lines: string[]): number {
  return lines.join(' ').split(/\s+/).filter(Boolean).length;
}

interface Line {
  line: string;
  /** Heading level and text when the line is a heading outside a code fence. */
  heading: { level: number; text: string } | null;
}

function scanLines(text: string): Line[] {
  let fence: string | null = null;
  return text.split('\n').map((line) => {
    const f = FENCE.exec(line);
    if (f) {
      const marker = f[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return { line, heading: null };
    }
    const h = fence === null ? HEADING.exec(line) : null;
    return { line, heading: h?.[2] ? { level: h[1]!.length, text: h[2] } : null };
  });
}

/** Split Markdown by ATX headings, ignoring "#" lines inside fenced code blocks. */
export function chunkMarkdown(text: string): Section[] {
  const raw: RawSection[] = [];
  let current: RawSection = { heading: null, lines: [], bodyWords: 0 };
  for (const { line, heading } of scanLines(text)) {
    if (heading) {
      raw.push(current);
      current = { heading: heading.text, lines: [line], bodyWords: 0 };
    } else {
      current.lines.push(line);
    }
  }
  raw.push(current);

  for (const r of raw) r.bodyWords = countWords(r.heading === null ? r.lines : r.lines.slice(1));

  const sections: Section[] = [];
  let carried: string[] = [];
  raw.forEach((r, i) => {
    if (r.heading === null && r.bodyWords === 0) return; // nothing before the first heading
    const isLast = i === raw.length - 1;
    if (r.heading !== null && r.bodyWords < MIN_BODY_WORDS && !isLast) {
      carried.push(...r.lines);
      return;
    }
    const body = [...carried, ...r.lines].join('\n').trim();
    carried = [];
    sections.push({ idx: sections.length + 1, heading: r.heading ?? 'Intro', text: body });
  });
  return sections;
}

/** Turn extracted text into sections according to the sheet format. */
export function chunkExtracted(format: SheetFormat, text: string): Section[] {
  switch (format) {
    case 'md':
    case 'docx':
      return chunkMarkdown(text);
    case 'pdf': {
      const sections: Section[] = [];
      text.split(PAGE_BREAK).forEach((page, i) => {
        if (page.trim()) sections.push({ idx: sections.length + 1, heading: `Page ${i + 1}`, text: page.trim() });
      });
      return sections;
    }
    default:
      return text.trim() ? [{ idx: 1, heading: 'Intro', text: text.trim() }] : [];
  }
}

/** First level-1 heading, used as the proposed title. */
export function firstH1(text: string): string | null {
  return scanLines(text).find((l) => l.heading?.level === 1)?.heading?.text ?? null;
}
