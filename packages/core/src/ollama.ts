import type { Config } from './config.ts';
import { NudgeError, errorMessage } from './util.ts';

// The only network client in nudge. It talks to config.ollama.host, and for chat to
// config.ollama.chatHost when one is set (a relay); nothing else.

export type OllamaConfig = Config['ollama'];

export type OllamaErrorKind = 'unreachable' | 'timeout' | 'model-missing' | 'http' | 'bad-response';

export class OllamaError extends NudgeError {
  kind: OllamaErrorKind;
  constructor(kind: OllamaErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Unreachable or timed out: the caller should fall back (keyword only, queue the work). */
export function isOllamaDown(e: unknown): boolean {
  return e instanceof OllamaError && (e.kind === 'unreachable' || e.kind === 'timeout');
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Base64 images, for the vision model (Ollama native API only). */
  images?: string[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  /** JSON schema the reply must follow (Ollama structured output); the OpenAI API gets json_object mode. */
  schema?: object;
  timeoutMs?: number;
}

export type Health = { ok: true; version: string } | { ok: false; reason: string };

export const HEALTH_TIMEOUT_MS = 1500;
const EMBED_TIMEOUT_MS = 60_000;
const CHAT_TIMEOUT_MS = 120_000;
const VISION_TIMEOUT_MS = 180_000;
/** Sheet text sent for tagging stays far below this; it keeps models with huge default contexts from reserving that much memory. */
const CHAT_CONTEXT = 8192;
const VISION_CONTEXT = 16384;

/** "bge-m3" means "bge-m3:latest". */
export function modelKey(name: string): string {
  const n = name.trim().toLowerCase();
  return n.includes(':') ? n : `${n}:latest`;
}

export function hasModel(installed: string[], name: string): boolean {
  const want = modelKey(name);
  return installed.some((m) => modelKey(m) === want);
}

function joinUrl(base: string, route: string): string {
  return base.replace(/\/+$/, '') + route;
}

export class OllamaClient {
  readonly cfg: OllamaConfig;
  constructor(cfg: OllamaConfig) {
    this.cfg = cfg;
  }

  get host(): string {
    return this.cfg.host;
  }

  private async request(url: string, opts: { body?: unknown; timeoutMs: number; model?: string; headers?: Record<string, string> }): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      const origin = new URL(url).origin;
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new OllamaError('timeout', `no answer from ${origin} within ${Math.round(opts.timeoutMs / 1000)}s`);
      }
      throw new OllamaError('unreachable', `Ollama is not reachable at ${origin} (is it running?)`);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: unknown };
        if (j.error !== undefined) detail = typeof j.error === 'string' ? j.error : JSON.stringify(j.error);
      } catch {
        // Not JSON; keep the raw text.
      }
      if (res.status === 404 && opts.model && /not found/i.test(detail)) {
        throw new OllamaError('model-missing', `model "${opts.model}" is not pulled. Run: ollama pull ${opts.model}`);
      }
      throw new OllamaError('http', `${new URL(url).origin} answered ${res.status}: ${detail || res.statusText}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OllamaError('bad-response', `${new URL(url).origin} sent a reply that is not JSON`);
    }
  }

  /** Quick reachability check with a short timeout. Never throws. */
  async health(timeoutMs = HEALTH_TIMEOUT_MS): Promise<Health> {
    try {
      const r = (await this.request(joinUrl(this.host, '/api/version'), { timeoutMs })) as { version?: string };
      return { ok: true, version: String(r.version ?? '?') };
    } catch (e) {
      return { ok: false, reason: errorMessage(e) };
    }
  }

  /** Names of the pulled models. */
  async models(timeoutMs = HEALTH_TIMEOUT_MS * 2): Promise<string[]> {
    const r = (await this.request(joinUrl(this.host, '/api/tags'), { timeoutMs })) as { models?: { name?: string; model?: string }[] };
    return (r.models ?? []).map((m) => String(m.name ?? m.model ?? '')).filter(Boolean);
  }

  /** One embedding per input, in order. */
  async embed(model: string, inputs: string[], timeoutMs = EMBED_TIMEOUT_MS): Promise<number[][]> {
    if (!inputs.length) return [];
    const r = (await this.request(joinUrl(this.host, '/api/embed'), {
      body: { model, input: inputs, truncate: true },
      timeoutMs,
      model,
    })) as { embeddings?: unknown };
    const out = r.embeddings;
    if (!Array.isArray(out) || out.length !== inputs.length || !out.every((v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number'))) {
      throw new OllamaError('bad-response', `embedding reply from ${this.host} has the wrong shape`);
    }
    return out as number[][];
  }

  /** Chat completion; returns the reply text. Uses the relay when chatApi is "openai". */
  async chat(req: ChatRequest): Promise<string> {
    if (this.cfg.chatApi === 'openai') return this.chatOpenAi(req);
    return this.chatNative(this.cfg.chatHost ?? this.host, req, CHAT_CONTEXT, req.timeoutMs ?? CHAT_TIMEOUT_MS);
  }

  /** Describe or transcribe images with the vision model (always the Ollama host). */
  async vision(model: string, prompt: string, images: Buffer[], timeoutMs = VISION_TIMEOUT_MS): Promise<string> {
    const messages: ChatMessage[] = [{ role: 'user', content: prompt, images: images.map((b) => b.toString('base64')) }];
    return this.chatNative(this.host, { model, messages, temperature: 0 }, VISION_CONTEXT, timeoutMs);
  }

  private async chatNative(host: string, req: ChatRequest, numCtx: number, timeoutMs: number): Promise<string> {
    const r = (await this.request(joinUrl(host, '/api/chat'), {
      body: {
        model: req.model,
        messages: req.messages,
        stream: false,
        think: false,
        ...(req.schema ? { format: req.schema } : {}),
        options: { temperature: req.temperature ?? 0.2, num_ctx: numCtx },
      },
      timeoutMs,
      model: req.model,
    })) as { message?: { content?: unknown } };
    const content = r.message?.content;
    if (typeof content !== 'string') throw new OllamaError('bad-response', `chat reply from ${host} has no message content`);
    return content;
  }

  private async chatOpenAi(req: ChatRequest): Promise<string> {
    const base = (this.cfg.chatHost ?? this.host).replace(/\/+$/, '');
    const url = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    const headers: Record<string, string> = {};
    if (this.cfg.chatApiKeyEnv) {
      const key = process.env[this.cfg.chatApiKeyEnv];
      if (!key) throw new OllamaError('http', `chatApiKeyEnv names ${this.cfg.chatApiKeyEnv}, but that environment variable is not set`);
      headers.authorization = `Bearer ${key}`;
    }
    const r = (await this.request(url, {
      body: {
        model: req.model,
        messages: req.messages.map(({ role, content }) => ({ role, content })),
        temperature: req.temperature ?? 0.2,
        ...(req.schema ? { response_format: { type: 'json_object' } } : {}),
      },
      timeoutMs: req.timeoutMs ?? CHAT_TIMEOUT_MS,
      model: req.model,
      headers,
    })) as { choices?: { message?: { content?: unknown } }[] };
    const content = r.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new OllamaError('bad-response', `chat reply from ${new URL(url).origin} has no message content`);
    return content;
  }
}

export function ollamaClient(cfg: OllamaConfig): OllamaClient {
  return new OllamaClient(cfg);
}
