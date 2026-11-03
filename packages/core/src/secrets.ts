import type { AllowEntry } from './manifest.ts';
import { sha256 } from './util.ts';

export interface Finding {
  /** 1-based position among all findings in the text; `nudge allow --finding <n>` uses it. */
  n: number;
  line: number;
  rule: string;
  masked: string;
  fingerprint: string;
  allowed: boolean;
}

interface Detector {
  rule: string;
  re: RegExp;
  /** Capture group holding the secret value; defaults to the whole match. */
  group?: number;
  /** Extra check on the secret value. */
  accept?: (value: string, match: RegExpExecArray) => boolean;
}

// Specific detectors come first; a later match overlapping an earlier one is dropped.
const DETECTORS: Detector[] = [
  { rule: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----\s+([A-Za-z0-9+/=]{40,})/g, group: 1 },
  { rule: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g },
  { rule: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{50,}/g },
  { rule: 'anthropic-key', re: /\bsk-ant-([A-Za-z0-9_-]{20,})/g, accept: (_v, m) => looksRandom(m[1]!) },
  {
    rule: 'openai-key',
    re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?([A-Za-z0-9_-]{20,})/g,
    accept: (_v, m) => looksRandom(m[1]!),
  },
  { rule: 'slack-token', re: /\bxox[abposr]-([A-Za-z0-9-]{10,})/g, accept: (_v, m) => looksRandom(m[1]!) },
  { rule: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/]{20,}/g },
  { rule: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_([A-Za-z0-9]{16,})/g, accept: (_v, m) => looksRandom(m[1]!) },
  {
    rule: 'connection-string-password',
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/([^\s:/@"'`]+):([^\s@/"'`]+)@[^\s"'`]+/gi,
    group: 2,
    accept: (password, m) => password.length >= 4 && password !== m[1] && !DEFAULT_PASSWORDS.has(password.toLowerCase()),
  },
  {
    rule: 'secret-assignment',
    re: /\b[A-Za-z0-9_.-]{0,40}(?:key|token|secret|password|passwd|pwd)[A-Za-z0-9_.-]{0,40}["']?\s*(?::=|=>|[:=])\s*["']?([^\s"'`,;]{12,})/gi,
    group: 1,
    accept: (value) => looksRandom(value),
  },
];

// Defaults that tutorials and cheat sheets use everywhere.
const DEFAULT_PASSWORDS = new Set([
  'password', 'pass', 'passwd', 'secret', 'postgres', 'root', 'admin', 'guest', 'test', 'user', 'mysecretpassword', 'changeme',
]);

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /x{4,}/i, // sk-xxxx, ghp_XXXXXXXX
  /\*{3,}/, // ****
  /\.{3}|\u2026/, // "..." or an ellipsis
  /[<>[\]{}]/, // <API_KEY>, [token], {{secret}}
  /\$\(|\$[A-Za-z_]|%[A-Za-z_]+%/, // $(cmd), $VAR, ${VAR}, %VAR%
  /your|example|placeholder|changeme|redacted|dummy|sample|fake|replace|insert|here/i,
  /0123456|1234567|abcdefg/i,
  /^(?:process\.env|os\.environ|import\.meta|env\.)/i,
];

export function isPlaceholder(value: string): boolean {
  if (/^(.)\1*$/.test(value)) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** High-entropy values with at least two of lowercase, uppercase and digits. */
function looksRandom(value: string): boolean {
  if (/^https?:|[\\(]/.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((re) => re.test(value)).length;
  return classes >= 2 && entropy(value) >= 3.5;
}

export function fingerprint(rule: string, matched: string): string {
  return sha256(`${rule}\0${matched}`).slice(0, 16);
}

function mask(value: string): string {
  return `${value.slice(0, 4)}**** (${value.length} chars)`;
}

/** Scan text for likely secrets. Findings whose fingerprint is allowlisted are marked `allowed`. */
export function scanSecrets(text: string, allowlist: AllowEntry[] = []): Finding[] {
  const allowed = new Set(allowlist.map((a) => a.fingerprint));
  const hits: { start: number; end: number; rule: string; value: string; matched: string }[] = [];
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    for (let m = d.re.exec(text); m; m = d.re.exec(text)) {
      const value = m[d.group ?? 0] ?? m[0];
      const start = m.index;
      const end = start + m[0].length;
      if (isPlaceholder(value)) continue;
      if (d.accept && !d.accept(value, m)) continue;
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      hits.push({ start, end, rule: d.rule, value, matched: m[0] });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  return hits.map((h, i) => {
    const fp = fingerprint(h.rule, h.matched);
    return {
      n: i + 1,
      line: text.slice(0, h.start).split('\n').length,
      rule: h.rule,
      masked: mask(h.value),
      fingerprint: fp,
      allowed: allowed.has(fp),
    };
  });
}

export function blockingFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => !f.allowed);
}
