import type { Config } from './config.ts';
import { ocrEngine, type Ocr } from './extract/image.ts';
import { tagProposer, type ProposeFn } from './llm.ts';
import { readManifest } from './manifest.ts';
import { ollamaClient, type OllamaClient } from './ollama.ts';

export interface AiServices {
  client: OllamaClient;
  up: boolean;
  /** Why Ollama is unusable, when it is. */
  downReason?: string;
  /** null while Ollama is down or no visionModel is set. */
  ocr: Ocr | null;
  /** null while Ollama is down: imports wait in the review queue for a later nudge index. */
  propose: ProposeFn | null;
}

/** One short health check; everything slow (tagging, OCR, embeddings) is skipped when it fails. */
export async function connectAi(config: Config): Promise<AiServices> {
  const client = ollamaClient(config.ollama);
  const health = await client.health();
  if (!health.ok) return { client, up: false, downReason: health.reason, ocr: null, propose: null };
  const { chatModel, visionModel } = config.ollama;
  return {
    client,
    up: true,
    ocr: visionModel ? ocrEngine(client, visionModel) : null,
    propose: chatModel ? tagProposer(client, chatModel, config.library, () => readManifest(config.library)) : null,
  };
}
