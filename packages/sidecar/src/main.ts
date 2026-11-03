#!/usr/bin/env node
import readline from 'node:readline';
import { errorMessage } from '@nudge/core';
import { SidecarError, createHandlers, type Handlers } from './handlers.ts';

// The popup's backend: the popup starts it with node.exe and keeps it running while the
// popup runs. One JSON object per line on stdin and stdout. Requests are answered as they
// finish, so a hybrid search waiting on Ollama never holds up a keyword search behind it.
// stdout carries the protocol only; anything else goes to stderr (the popup logs it).
// Nothing else in nudge needs this process: hook, MCP server and CLI work without it.

console.log = console.info = console.warn = console.error;

const handlers = createHandlers();
const write = (msg: object) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(line: string): Promise<void> {
  let req: { id?: unknown; method?: unknown; params?: unknown };
  try {
    req = JSON.parse(line);
  } catch {
    write({ id: null, error: { code: 'bad_request', message: 'not JSON' } });
    return;
  }
  const id = typeof req.id === 'number' || typeof req.id === 'string' ? req.id : null;
  const method = typeof req.method === 'string' ? req.method : '';
  if (!Object.hasOwn(handlers, method)) {
    write({ id, error: { code: 'bad_request', message: `unknown method "${method}"` } });
    return;
  }
  try {
    const params = req.params && typeof req.params === 'object' ? req.params : {};
    const result = await (handlers[method as keyof Handlers] as (p: object) => unknown)(params);
    write({ id, result });
  } catch (e) {
    const code = e instanceof SidecarError ? e.code : 'error';
    if (!(e instanceof SidecarError)) process.stderr.write(`nudge sidecar: ${method}: ${e instanceof Error ? (e.stack ?? e.message) : errorMessage(e)}\n`);
    write({ id, error: { code, message: errorMessage(e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (line.trim()) void handle(line);
});
// The popup closed our stdin (it quit or was killed): nothing left to answer.
rl.on('close', () => process.exit(0));
