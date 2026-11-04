import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import { openDb, type DB } from '../db.ts';
import { recordDraft } from '../drafts.ts';
import { tagVocabulary } from '../llm.ts';
import { readManifest } from '../manifest.ts';
import { normPath } from '../paths.ts';
import { blockingFindings, scanSecrets } from '../secrets.ts';
import { errorMessage, today } from '../util.ts';
import { CHAT_SOURCE_LABELS, chatSourceDir, listChats, readExports, type Chat, type ChatSourceName } from './chats.ts';
import { DUPLICATE_SIMILARITY, coveredBy, distillChat, looksLikeReference, newExchanges, renderChatDraft, transcriptText } from './distill.ts';
import type { HarvestOptions, HarvestReport } from './index.ts';
import type { Ledger, LedgerChatEntry } from './ledger.ts';

/** A transcript written to in the last few minutes is probably a chat still going on. */
const ACTIVE_MS = 10 * 60_000;
export const DONE_DIR = '_done';
export const UNKNOWN_DIR = '_unknown';

/** Local midnight at the start of a YYYY-MM-DD date. */
function dayStartMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

function freeName(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) candidate = `${stem} (${n})${ext}`;
  return candidate;
}

function moveExport(file: string, sub: string, reason?: string): string {
  const dir = path.join(path.dirname(file), sub);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, freeName(dir, path.basename(file)));
  fs.renameSync(file, dest);
  if (reason) fs.writeFileSync(dest + '.reason.txt', `nudge harvest could not read this file: ${reason}\r\n`);
  return dest;
}

/**
 * Read chats for new exchanges and turn the ones with reference material into drafts.
 * Mutates `ledger` and `report`; returns true when the ledger changed. Call with the lock held.
 */
export async function harvestChats(config: Config, ledger: Ledger, report: HarvestReport, names: ChatSourceName[], opts: HarvestOptions): Promise<boolean> {
  const { library } = config;
  const dryRun = !!opts.dryRun;
  const r = report.chats;
  let changed = false;
  if (!ledger.chatsSince && !dryRun) {
    ledger.chatsSince = today();
    changed = true;
  }
  const since = opts.since ?? ledger.chatsSince ?? today();
  r.since = since;
  const sinceMs = dayStartMs(since);
  const now = Date.now();

  // Cheap pass: file times only. Exports are read whole (they are dropped there on purpose).
  const candidates: Chat[] = [];
  const exportChats = new Map<string, Chat[]>();
  for (const name of names) {
    const dir = chatSourceDir(name, config.harvest.exportsDir);
    let chats: Chat[];
    if (name === 'exports') {
      chats = [];
      for (const ex of readExports(dir)) {
        if (ex.error) {
          r.exportsUnknown.push({ file: normPath(ex.file), reason: ex.error });
          if (!dryRun) {
            try {
              moveExport(ex.file, UNKNOWN_DIR, ex.error);
            } catch {
              // Locked or in use: try again on the next run.
            }
          }
          continue;
        }
        exportChats.set(ex.file, ex.chats);
        chats.push(...ex.chats);
      }
    } else chats = listChats(name);
    report.sources.push({ name, label: CHAT_SOURCE_LABELS[name], dir: normPath(dir), found: fs.existsSync(dir), files: chats.length });

    for (const chat of chats) {
      const entry = ledger.chats[chat.key];
      if (entry?.rejected) r.rejected++;
      else if (entry && entry.mtimeMs === chat.mtimeMs) r.unchanged++;
      else if (name !== 'exports' && now - chat.mtimeMs < ACTIVE_MS) r.active++;
      else if (name !== 'exports' && !entry && chat.mtimeMs < sinceMs) r.older++;
      else candidates.push(chat);
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const setEntry = (chat: Chat, entry: LedgerChatEntry) => {
    ledger.chats[chat.key] = { ...entry, title: chat.title };
    changed = true;
  };
  const waitingOrigins = new Set<string>();
  let client = opts.client ?? null;
  if (!client) r.waitingReason = 'Ollama is not available';
  const model = config.ollama.chatModel;
  const embedModel = config.ollama.embedModel;
  let db: DB | null = null;
  let vocab: ReturnType<typeof tagVocabulary> | null = null;
  let asked = 0;

  try {
    for (const chat of candidates) {
      const item = { source: chat.source, origin: chat.origin, chat: chat.title };
      const prev = ledger.chats[chat.key] ?? { source: chat.source, seen: 0, mtimeMs: 0, sheetIds: [] };
      let messages;
      try {
        messages = await chat.load();
      } catch (e) {
        r.failed.push({ ...item, reason: `could not read it (${errorMessage(e)})` });
        continue;
      }
      item.chat = chat.title;
      const { exchanges, seen } = newExchanges(messages, prev.seen);
      const kept = exchanges.filter(looksLikeReference);
      const done = { ...prev, seen, mtimeMs: chat.mtimeMs };
      if (!kept.length) {
        r.nothing++;
        if (!dryRun) setEntry(chat, done);
        continue;
      }
      if (dryRun) {
        r.wouldDistill.push({ ...item, exchanges: kept.length });
        continue;
      }
      if (!client || asked >= config.harvest.maxChatsPerRun) {
        if (client) r.waitingReason = `harvest.maxChatsPerRun (${config.harvest.maxChatsPerRun}) reached`;
        r.waiting++;
        waitingOrigins.add(chat.origin);
        continue;
      }
      const transcript = transcriptText(kept);
      const secrets = blockingFindings(scanSecrets(transcript, []));
      if (secrets.length) {
        // Never sent to the model. Transcripts are not edited later, so the chat is not retried.
        r.blocked.push({ ...item, rules: [...new Set(secrets.map((f) => f.rule))] });
        setEntry(chat, done);
        continue;
      }
      asked++;
      vocab ??= tagVocabulary(library, readManifest(library));
      const outcome = await distillChat(client, model, chat.title, transcript, vocab.tags, vocab.canonical);
      if (outcome.kind === 'down') {
        r.waitingReason = outcome.reason;
        r.waiting++;
        waitingOrigins.add(chat.origin);
        client = null;
        continue;
      }
      if (outcome.kind === 'skip') {
        r.skipped++;
        setEntry(chat, done);
        continue;
      }
      if (outcome.kind === 'failed') {
        r.failed.push({ ...item, reason: outcome.reason });
        setEntry(chat, done);
        continue;
      }
      const at = today();
      const text = renderChatDraft(outcome.title, outcome.reply, model, at, chat.title);
      const draftSecrets = blockingFindings(scanSecrets(text, []));
      if (draftSecrets.length) {
        r.blocked.push({ ...item, rules: [...new Set(draftSecrets.map((f) => f.rule))] });
        setEntry(chat, done);
        continue;
      }
      if (embedModel) {
        try {
          db ??= openDb();
          const cover = await coveredBy(db, client, embedModel, outcome.title, text);
          if (cover && cover.score >= DUPLICATE_SIMILARITY) {
            r.covered.push({ ...item, existing: cover.id, score: Math.round(cover.score * 100) / 100 });
            setEntry(chat, done);
            continue;
          }
        } catch {
          // No vectors or no embedding model: save the draft without the check.
        }
      }
      const saved = recordDraft(library, {
        title: outcome.title,
        tags: outcome.tags,
        text,
        llm: { model, at, ...(chat.project ? { project: chat.project } : {}) },
        harvest: { tool: chat.source, kind: 'chat', origin: chat.origin, at, conversation: chat.key, ...(chat.project ? { project: chat.project } : {}) },
      });
      r.drafts.push({ ...item, sheet: saved.sheet, warnings: saved.warnings });
      setEntry(chat, { ...done, sheetIds: [...prev.sheetIds, saved.sheet.id] });
    }
  } finally {
    db?.close();
  }

  // An export whose chats were all read this run (or earlier) is done.
  if (!dryRun) {
    for (const [file, chats] of exportChats) {
      if (waitingOrigins.has(normPath(file)) || chats.some((c) => ledger.chats[c.key] === undefined)) continue;
      try {
        moveExport(file, DONE_DIR);
        r.exportsDone.push(normPath(file));
      } catch {
        // Locked: moved on a later run.
      }
    }
  }
  return changed;
}
