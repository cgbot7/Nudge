import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { configPath, defaultLibrary } from './paths.ts';
import { RefsError, decodeText, errorMessage, writeFileAtomic } from './util.ts';

const OllamaSchema = z.object({
  host: z.url().default('http://localhost:11434'),
  embedModel: z.string().default('bge-m3'),
  chatModel: z.string().default('qwen'),
  visionModel: z.string().default(''),
});

export const ConfigSchema = z.object({
  library: z.string().min(1).default(() => defaultLibrary()),
  roots: z.array(z.string()).default([]),
  ollama: OllamaSchema.prefault({}),
  staleAfterDays: z.number().int().positive().default(180),
  unusedAfterDays: z.number().int().positive().default(30),
  hotkey: z.string().default('Ctrl+Alt+Space'),
  ocrMaxPages: z.number().int().positive().default(50),
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
    throw new RefsError(`config.json is not valid JSON (${file}): ${errorMessage(e)}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RefsError(`config.json is invalid (${file}):\n${z.prettifyError(parsed.error)}`);
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
