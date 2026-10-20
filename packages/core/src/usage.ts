import fs from 'node:fs';
import path from 'node:path';
import type { Sheet } from './manifest.ts';
import { dataPaths } from './paths.ts';

export interface UsageEvent {
  ts: string;
  event: 'open' | 'agent_fetch' | 'learned';
  id: string;
  section?: number;
  via?: 'cli' | 'popup' | 'mcp';
}

/** Append one event to usage.jsonl. Appends of a single short line do not need the lock. */
export function logUsage(event: Omit<UsageEvent, 'ts'>): void {
  const file = dataPaths().usage;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}

/** All events in usage.jsonl; unreadable lines are skipped. */
export function readUsage(): UsageEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(dataPaths().usage, 'utf8');
  } catch {
    return [];
  }
  const events: UsageEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as UsageEvent;
      if (typeof e.id === 'string' && typeof e.ts === 'string' && !Number.isNaN(Date.parse(e.ts))) events.push(e);
    } catch {
      // A torn or hand-edited line; usage history is best effort.
    }
  }
  return events;
}

/** Sheet id to its most recent use (any event counts: open, agent_fetch, learned). */
export function lastUsedById(events: UsageEvent[]): Map<string, Date> {
  const last = new Map<string, Date>();
  for (const e of events) {
    const at = new Date(e.ts);
    const prev = last.get(e.id);
    if (!prev || at > prev) last.set(e.id, at);
  }
  return last;
}

/** Unused: not learned, and never used or not used in the last `unusedAfterDays` days. */
export function isUnused(sheet: Sheet, lastUsed: Date | undefined, unusedAfterDays: number, now = new Date()): boolean {
  if (sheet.learned) return false;
  return !lastUsed || now.getTime() - lastUsed.getTime() > unusedAfterDays * 86_400_000;
}

/**
 * Reminder candidates in rotation order: never used first, then least recently used,
 * ties by id. Drafts are left out; they are not trusted enough to push.
 */
export function unusedSheets(sheets: Sheet[], lastUsed: Map<string, Date>, unusedAfterDays: number, now = new Date()): Sheet[] {
  return sheets
    .filter((s) => s.status !== 'draft' && isUnused(s, lastUsed.get(s.id), unusedAfterDays, now))
    .sort((a, b) => (lastUsed.get(a.id)?.getTime() ?? 0) - (lastUsed.get(b.id)?.getTime() ?? 0) || a.id.localeCompare(b.id));
}
