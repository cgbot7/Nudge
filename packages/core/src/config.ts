import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { configPath, defaultLibrary } from './paths.ts';
import { NudgeError, decodeText, errorMessage, writeFileAtomic } from './util.ts';

const OllamaSchema = z.object({
  host: z.url().default('http://localhost:11434'),
  embedModel: z.string().default('bge-m3'),
  chatModel: z.string().default('mistral-small3.2:24b'),
  visionModel: z.string().default('mistral-small3.2:24b'),
  /** Chat endpoint when it is not the Ollama host (a relay); defaults to host. */
  chatHost: z.url().optional(),
  /** "openai" talks to an OpenAI-compatible /v1/chat/completions endpoint. */
  chatApi: z.enum(['ollama', 'openai']).default('ollama'),
  /** Name of the environment variable holding the chat endpoint's bearer token. Never the token itself. */
  chatApiKeyEnv: z.string().optional(),
});

/** nudge harvest: copy notes that LLM tools wrote to disk into the library. Off until enabled. */
const HarvestSchema = z.object({
  /** Run the harvest inside every nudge index (scheduled runs included). nudge harvest works either way. */
  enabled: z.boolean().default(false),
  sources: z
    .object({
      /** Claude Code memory notes: ~/.claude/projects/<project>/memory/*.md (MEMORY.md, the index, is skipped). */
      'claude-memory': z.boolean().default(true),
      /** Claude Code chats: ~/.claude/projects/<project>/*.jsonl, distilled into drafts. */
      'claude-chats': z.boolean().default(true),
      /** Cursor agent chats: ~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl, distilled into drafts. */
      'cursor-chats': z.boolean().default(true),
      /** Export files you drop into exportsDir: a claude.ai data export or a Google Takeout of Gemini Apps activity. */
      exports: z.boolean().default(true),
    })
    .prefault({}),
  /** New sheets per run, so a first run over a full history does not hold the lock for long. */
  maxPerRun: z.number().int().positive().default(25),
  /** Chats sent to the chat model per run (each takes a while with a local model). */
  maxChatsPerRun: z.number().int().positive().default(5),
  /** Folder for export files (zip or json). Defaults to %USERPROFILE%\nudge-exports. */
  exportsDir: z.string().optional(),
});

export const ConfigSchema = z.object({
  library: z.string().min(1).default(() => defaultLibrary()),
  roots: z.array(z.string()).default([]),
  ollama: OllamaSchema.prefault({}),
  staleAfterDays: z.number().int().positive().default(180),
  unusedAfterDays: z.number().int().positive().default(30),
  hotkey: z.string().default('Ctrl+Alt+Space'),
  ocrMaxPages: z.number().int().positive().default(50),
  harvest: HarvestSchema.prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  config: Config;
  path: string;
  /** False when no config.json exists and defaults are in use. */
  exists: boolean;
}

export function loadConfig(): LoadedConfig {
  const file = configPath();
  if (!fs.existsSync(file)) {
    return { config: resolveLibrary(ConfigSchema.parse({})), path: file, exists: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decodeText(fs.readFileSync(file)));
  } catch (e) {
    throw new NudgeError(`config.json is not valid JSON (${file}): ${errorMessage(e)}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NudgeError(`config.json is invalid (${file}):\n${z.prettifyError(parsed.error)}`);
  }
  return { config: resolveLibrary(parsed.data), path: file, exists: true };
}

/** Write config.json if it does not exist yet. Returns true when it was created. */
export function ensureConfigFile(config: Config): boolean {
  const file = configPath();
  if (fs.existsSync(file)) return false;
  writeFileAtomic(file, JSON.stringify({ ...config, library: config.library.replace(/\\/g, '/') }, null, 2) + '\n');
  return true;
}

function resolveLibrary(config: Config): Config {
  return { ...config, library: path.resolve(config.library) };
}
