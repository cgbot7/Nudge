import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for Ollama on 127.0.0.1 with canned answers, so tests never touch the real one.
// Embeddings are a bag of "concepts" hashed into 64 dimensions; words in one synonym group
// share a concept, so "download a model" lands near "ollama pull llama3".

const SYNONYMS: string[][] = [
  ['download', 'downloading', 'pull', 'pulling', 'fetch'],
  ['model', 'models', 'llama3', 'llm'],
  ['remove', 'delete', 'prune', 'rm'],
  ['container', 'containers'],
];
const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'with', 'how', 'do', 'i', 'in', 'is', 'it', 'one', 'them', 'all']);
const DIMS = 64;

function concept(word: string): string {
  const group = SYNONYMS.find((g) => g.includes(word));
  return group ? group[0]! : word;
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function fakeEmbedding(text: string): number[] {
  const v: number[] = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOP.has(w)) continue;
    v[hash(concept(w)) % DIMS]! += 1;
  }
  if (!v.some((x) => x !== 0)) v[0] = 1;
  return v;
}

export interface ChatCall {
  model: string;
  temperature: number | undefined;
  messages: { role: string; content: string; images?: string[] }[];
  format?: unknown;
}

export interface FakeOllama {
  url: string;
  /** Pulled models (as /api/tags lists them). */
  models: string[];
  /** Replies for text chat, used in order; when empty, defaultChat answers. */
  chatReplies: string[];
  defaultChat: string;
  /** OCR answer for each vision call (gets the call number, from 0). */
  ocr: (n: number) => string;
  embedCalls: { model: string; inputs: string[] }[];
  chatCalls: ChatCall[];
  visionCalls: ChatCall[];
  close(): Promise<void>;
}

export async function startFakeOllama(): Promise<FakeOllama> {
  const fake: Omit<FakeOllama, 'url' | 'close'> = {
    models: ['fake-embed:latest', 'fake-chat:latest', 'fake-vision:latest'],
    chatReplies: [],
    defaultChat: JSON.stringify({ title: 'Docker basics', tags: ['docker'] }),
    ocr: () => '',
    embedCalls: [],
    chatCalls: [],
    visionCalls: [],
  };
  const pulled = (name: string) => fake.models.includes(name.includes(':') ? name : `${name}:latest`);
  const notFound = (res: http.ServerResponse, model: string) => send(res, 404, { error: `model "${model}" not found, try pulling it first` });

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, any>) : {};
      switch (`${req.method} ${req.url}`) {
        case 'GET /api/version':
          return send(res, 200, { version: '0.0.0-fake' });
        case 'GET /api/tags':
          return send(res, 200, { models: fake.models.map((name) => ({ name, model: name })) });
        case 'POST /api/embed': {
          if (!pulled(body.model)) return notFound(res, body.model);
          const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
          fake.embedCalls.push({ model: body.model, inputs });
          return send(res, 200, { model: body.model, embeddings: inputs.map(fakeEmbedding) });
        }
        case 'POST /api/chat': {
          if (!pulled(body.model)) return notFound(res, body.model);
          const call: ChatCall = { model: body.model, temperature: body.options?.temperature, messages: body.messages, format: body.format };
          if (body.messages.some((m: { images?: string[] }) => m.images?.length)) {
            fake.visionCalls.push(call);
            return send(res, 200, { message: { role: 'assistant', content: fake.ocr(fake.visionCalls.length - 1) } });
          }
          fake.chatCalls.push(call);
          return send(res, 200, { message: { role: 'assistant', content: fake.chatReplies.shift() ?? fake.defaultChat } });
        }
        case 'POST /v1/chat/completions': {
          fake.chatCalls.push({ model: body.model, temperature: body.temperature, messages: body.messages });
          return send(res, 200, { choices: [{ message: { role: 'assistant', content: fake.chatReplies.shift() ?? fake.defaultChat } }] });
        }
        default:
          return send(res, 404, { error: 'not found' });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
