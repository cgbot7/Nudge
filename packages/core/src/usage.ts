import fs from 'node:fs';
import path from 'node:path';
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
