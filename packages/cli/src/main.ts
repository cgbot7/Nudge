#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  OcrUnavailableError,
  NudgeError,
  acceptReview,
  addFile,
  approveSheet,
  buildContext,
  allowFinding,
  applyInstall,
  blockingFindings,
  connectAi,
  dataPaths,
  ensureConfigFile,
  errorMessage,
  findById,
  forTarget,
  hookLine,
  hybridSearch,
  ignoreGap,
  inboxDir,
  loadConfig,
  loadSuggestions,
  logUsage,
  ollamaClient,
  openDb,
  openInDefaultApp,
  parseTagList,
  pendingSheets,
  planInstall,
  readLastProjectTags,
  readManifest,
  readTagVocab,
  realSystem,
  runDoctor,
  runIndex,
  saveDraft,
  saveSuggestions,
  scanProject,
  setLearned,
  sheetAbsPath,
  sheetSections,
  suggestForProject,
  tagResolver,
  tryRefreshHookCache,
  verifySheet,
  type AiServices,
  type Config,
  type FileEdit,
  type ExtractOptions,
  type IndexReport,
  type SearchHit,
  type Sheet,
  type SheetInfo,
  type Suggestion,
} from '@nudge/core';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = (open: number, close: number) => (s: string) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);
const bold = ansi(1, 22);
const dim = ansi(2, 22);
const red = ansi(31, 39);
const green = ansi(32, 39);
const yellow = ansi(33, 39);

const HELP = `nudge: personal cheat sheet index

Usage:
  nudge add <file> [--tags a,b] [--yes]   import one file (md, txt, docx, pdf, png, jpg)
  nudge index [--rebuild]                 import the inbox, sync library changes, update the index
                                         and embeddings, scan projects, write the hook cache
                                         (--rebuild: recreate index.db)
  nudge review                            confirm or edit proposed titles and tags of pending sheets
    [--list] [--accept-all] [<id> --accept] [<id> --tags a,b [--title t]]
  nudge search <query> [--tags a,b] [--limit n] [--keyword] [--json]
  nudge for <path | "tag tag"> [--json]   sheets by tag, gaps and unused reminders
  nudge scan [path]                       re-detect one project, rewrite its hook cache entry
  nudge open <id> [--section <n>] [--app] print a sheet or section; --app opens the default app
  nudge context [--cwd <dir>] [--json]    compact index of matched sheets for an agent's session start
  nudge suggest [path] [--save <n>] [--json]
                                         LLM recommendations for a project; save one as a draft
  nudge approve <id>                      draft or pending to verified (sets lastVerified)
  nudge verify <id>                       set lastVerified to today (clears stale)
  nudge learned <id> [--undo]             stop (or resume) reminders for a sheet
  nudge ignore-gap <tag> [--project] [--undo]
                                         silence a gap everywhere, or only in this project
  nudge allow <file> --finding <n>        allowlist a secret-scan false positive
  nudge install [--dry-run] [--yes]       PowerShell hook, Task Scheduler job, popup at logon, nudge on PATH,
                                         Claude Code hook and MCP server, OpenCode MCP and plugin
  nudge doctor                            check config, library, index, rules, hook and schedule
  nudge help

Projects are detected under the "roots" folders in config.json. Drop files into the
library's inbox folder and nudge index imports them.`;

function out(line = ''): void {
  process.stdout.write(line + '\n');
}

function warn(line: string): void {
  process.stderr.write(`${yellow('warning:')} ${line}\n`);
}

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new NudgeError(`${flag} must be a positive whole number, got "${value}".`);
  return n;
}

function config() {
  return loadConfig().config;
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

function extractOptions(cfg: Config, ai: AiServices | null): ExtractOptions {
  return {
    ocr: ai?.ocr ?? null,
    ocrMaxPages: cfg.ocrMaxPages,
    confirmPartialOcr: process.stdin.isTTY
      ? (scanned, max) => confirm(`${scanned} pages have no text layer, more than ocrMaxPages (${max}). OCR the first ${max} pages only?`)
      : undefined,
  };
}

async function cmdAdd(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { tags: { type: 'string' }, yes: { type: 'boolean', short: 'y' } },
  });
  if (positionals.length !== 1) throw new NudgeError('usage: nudge add <file> [--tags a,b] [--yes]');
  const loaded = loadConfig();
  if (ensureConfigFile(loaded.config)) out(dim(`created config at ${loaded.path}`));
  const cfg = loaded.config;
  const tags = parseTagList(values.tags);
  const ai = await connectAi(cfg);

  let result;
  try {
    result = await addFile(cfg.library, positionals[0]!, {
      tags,
      yes: values.yes,
      confirm: process.stdin.isTTY ? confirm : undefined,
      extract: extractOptions(cfg, ai),
      propose: tags.length ? null : ai.propose,
    });
  } catch (e) {
    if (e instanceof OcrUnavailableError) {
      throw new NudgeError(`${e.message}. Nothing was moved. Start Ollama and run nudge add again, or drop the file into ${inboxDir(cfg.library)} and nudge index imports it once Ollama is up.`);
    }
    throw e;
  }

  switch (result.kind) {
    case 'added': {
      const { sheet } = result;
      for (const n of result.notes) out(dim(n));
      for (const w of result.warnings) warn(w);
      const ocr = sheet.ocr ? ', OCR' : '';
      out(`${green('added')} ${bold(sheet.id)} "${sheet.title}" (${sheet.format}${ocr}, ${result.sections} section${result.sections === 1 ? '' : 's'})`);
      out(`  ${sheet.file}`);
      if (sheet.tags.length) out(`  tags: ${sheet.tags.join(', ')}`);
      else if (result.queued) out(`  tags: none yet, status pending (${result.queued}; nudge index proposes tags once Ollama is up)`);
      else if (process.stdin.isTTY && process.stdout.isTTY) await reviewInteractive(cfg, [sheet]);
      else {
        for (const line of proposalLines(sheet)) out(line);
        out(dim('  status pending: confirm with nudge review'));
      }
      return 0;
    }
    case 'duplicate':
      out(`duplicate: same content as ${bold(result.existing.id)} "${result.existing.title}" (${result.existing.file}). Nothing changed.`);
      return 0;
    case 'blocked': {
      const blocking = blockingFindings(result.findings);
      process.stderr.write(`${red('blocked:')} likely secrets in ${result.file}. Nothing was imported.\n`);
      if (result.format !== 'md' && result.format !== 'txt') process.stderr.write(dim('  (line numbers refer to the extracted text)\n'));
      for (const f of blocking) process.stderr.write(`  ${f.n}. line ${f.line}  ${f.rule}  ${f.masked}\n`);
      process.stderr.write(`Redact them and run nudge add again. If one is a false positive:\n  nudge allow "${result.file}" --finding <n>\n`);
      return 2;
    }
  }
}

function proposalLines(sheet: Sheet): string[] {
  const p = sheet.proposal;
  if (!p) return [`  no proposal yet ${dim('(Ollama was not available)')}`];
  if (p.error) return [`  no proposal ${dim(`(${p.error})`)}`];
  const tags = p.tags.map((t) => (p.newTags.includes(t) ? `${t} ${yellow('(new)')}` : t)).join(', ');
  return [`  proposed title: ${p.title ?? sheet.title}`, `  proposed tags:  ${tags}`];
}

/** Walk pending sheets: accept, edit or skip each. Returns how many were accepted. */
async function reviewInteractive(cfg: Config, sheets: Sheet[]): Promise<number> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let accepted = 0;
  try {
    for (const [i, sheet] of sheets.entries()) {
      out('');
      out(`${bold(sheet.id)}  "${sheet.title}"  ${dim(`(${sheet.format}${sheet.ocr ? ', OCR' : ''}, ${sheet.file}; ${i + 1} of ${sheets.length})`)}`);
      for (const line of proposalLines(sheet)) out(line);
      const usable = !!sheet.proposal?.tags.length;
      const choices = usable ? '[a]ccept  [e]dit  [s]kip  [q]uit' : '[e]dit  [s]kip  [q]uit';
      for (;;) {
        const answer = (await rl.question(`  ${choices} > `)).trim().toLowerCase();
        if (answer === 'q') return accepted;
        if (answer === 's' || answer === '') break;
        let decision: { title?: string; tags?: string[] } | null = null;
        if (answer === 'a' && usable) decision = {};
        else if (answer === 'e') {
          const title = sheet.proposal?.title ?? sheet.title;
          const tags = sheet.proposal?.tags ?? sheet.tags;
          const newTitle = (await rl.question(`  title [${title}]: `)).trim();
          const newTags = parseTagList((await rl.question(`  tags${tags.length ? ` [${tags.join(', ')}]` : ''}: `)).trim());
          decision = { title: newTitle || title, tags: newTags.length ? newTags : tags };
          if (!decision.tags!.length) {
            out(yellow('  a sheet needs at least one tag'));
            continue;
          }
        } else continue;
        const r = await acceptReview(cfg, sheet.id, decision);
        accepted++;
        out(`  ${green('verified')} "${r.sheet.title}" [${r.sheet.tags.join(', ')}]${r.addedToVocab.length ? dim(`; added to tags.json: ${r.addedToVocab.join(', ')}`) : ''}`);
        if (r.commitError) warn(`the Git commit failed: ${r.commitError}`);
        break;
      }
    }
  } finally {
    rl.close();
  }
  return accepted;
}

async function cmdReview(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { list: { type: 'boolean' }, 'accept-all': { type: 'boolean' }, accept: { type: 'boolean' }, tags: { type: 'string' }, title: { type: 'string' } },
  });
  const usage = 'usage: nudge review [--list] [--accept-all] [<id> --accept] [<id> --tags a,b [--title t]]';
  if (positionals.length > 1) throw new NudgeError(usage);
  const cfg = config();
  const pending = pendingSheets(cfg.library);

  if (values.list) {
    if (!pending.length) out('nothing to review.');
    for (const s of pending) {
      out(`${bold(s.id)}  "${s.title}"  ${dim(`(${s.format}${s.ocr ? ', OCR' : ''})`)}`);
      for (const line of proposalLines(s)) out(line);
    }
    return 0;
  }

  const id = positionals[0];
  if (id !== undefined) {
    const tags = parseTagList(values.tags);
    if (!values.accept && !tags.length) throw new NudgeError(`say what to do with ${id}: --accept (take the proposal) or --tags a,b [--title t].\n${usage}`);
    const r = await acceptReview(cfg, id, { tags: tags.length ? tags : undefined, title: values.title });
    out(`${green('verified')} ${r.sheet.id} "${r.sheet.title}" [${r.sheet.tags.join(', ')}]`);
    if (r.addedToVocab.length) out(dim(`added to tags.json: ${r.addedToVocab.join(', ')}`));
    if (r.commitError) warn(`the Git commit failed: ${r.commitError}`);
    return 0;
  }

  if (values['accept-all']) {
    let n = 0;
    for (const s of pending) {
      if (!s.proposal?.tags.length) {
        out(`${yellow('skipped')} ${s.id} "${s.title}": no proposal to accept (nudge review ${s.id} --tags a,b)`);
        continue;
      }
      const r = await acceptReview(cfg, s.id);
      out(`${green('verified')} ${r.sheet.id} "${r.sheet.title}" [${r.sheet.tags.join(', ')}]`);
      if (r.commitError) warn(`the Git commit failed: ${r.commitError}`);
      n++;
    }
    out(`${plural(n, 'sheet')} accepted, ${pending.length - n} still pending.`);
    return 0;
  }

  if (!pending.length) {
    out('nothing to review.');
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new NudgeError(`nudge review is interactive and this is not a terminal. Use --list to see the ${plural(pending.length, 'pending sheet')}, then --accept-all, <id> --accept or <id> --tags a,b.`);
  }
  const accepted = await reviewInteractive(cfg, pending);
  out('');
  out(`${plural(accepted, 'sheet')} accepted, ${pending.length - accepted} still pending.`);
  return 0;
}

async function cmdAllow(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { finding: { type: 'string' } } });
  const n = positiveInt(values.finding, '--finding');
  if (positionals.length !== 1 || n === undefined) throw new NudgeError('usage: nudge allow <file> --finding <n>');
  const cfg = config();
  const result = await allowFinding(cfg.library, positionals[0]!, n, extractOptions(cfg, await connectAi(cfg)));
  const f = result.finding;
  out(`allowed finding ${f.n} (${f.rule}, line ${f.line})${result.sheetId ? ` for ${result.sheetId}` : ''}.`);
  if (!result.sheetId) out('Run nudge add again to import the file.');
  return 0;
}

function formatHit(h: SearchHit): string[] {
  const where = h.heading === h.title || h.heading === 'Intro' ? h.title : `${h.title} > ${h.heading}`;
  const badges = [h.tags.length ? dim(`[${h.tags.join(', ')}]`) : '', h.status !== 'verified' ? yellow(`[${h.status}]`) : '', h.stale ? yellow('[stale]') : '', h.ocr ? dim('[ocr]') : '']
    .filter(Boolean)
    .join(' ');
  return [`${bold(`${h.id}:${h.section}`)}  ${where}${badges ? '  ' + badges : ''}`, `    ${h.snippet}`];
}

async function cmdSearch(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { tags: { type: 'string' }, limit: { type: 'string' }, keyword: { type: 'boolean' }, json: { type: 'boolean' } },
  });
  const query = positionals.join(' ').trim();
  if (!query) throw new NudgeError('usage: nudge search <query> [--tags a,b] [--limit n] [--keyword] [--json]');
  const cfg = config();
  if (!fs.existsSync(dataPaths().db)) throw new NudgeError('no index yet. Run nudge index, or import a sheet with nudge add <file>.');
  const sheets = readManifest(cfg.library);
  const db = openDb();
  let result;
  try {
    result = await hybridSearch(db, sheets, query, {
      client: values.keyword ? null : ollamaClient(cfg.ollama),
      embedModel: cfg.ollama.embedModel,
      boostTags: readLastProjectTags(),
      canonical: tagResolver(readTagVocab(cfg.library)),
      tags: parseTagList(values.tags),
      limit: positiveInt(values.limit, '--limit') ?? 10,
      highlight: values.json ? undefined : useColor ? ['\x1b[1m', '\x1b[22m'] : ['', ''],
      staleAfterDays: cfg.staleAfterDays,
    });
  } finally {
    db.close();
  }
  if (values.keyword && result.mode === 'keyword') result.notice = '--keyword';
  if (values.json) {
    out(JSON.stringify(result, null, 2));
    return 0;
  }
  if (result.mode === 'keyword') out(yellow(`keyword only (${result.notice})`));
  if (!result.hits.length) out(`no matches for "${query}"`);
  for (const h of result.hits) for (const line of formatHit(h)) out(line);
  const boost = result.boostTags.length ? `, boosted for ${result.boostTags.join(', ')}` : '';
  out(dim(`\n${result.mode === 'hybrid' ? 'hybrid' : 'keyword only'}, ${result.tookMs} ms${boost}${result.hits.length ? '. open one: nudge open <id> --section <n>' : ''}`));
  return 0;
}

async function cmdOpen(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { section: { type: 'string' }, app: { type: 'boolean' } },
  });
  if (positionals.length !== 1) throw new NudgeError('usage: nudge open <id> [--section <n>] [--app]');
  const id = positionals[0]!;
  const section = positiveInt(values.section, '--section');
  const cfg = config();
  const { library } = cfg;
  const sheet = findById(readManifest(library), id);
  if (!sheet) throw new NudgeError(`no sheet with id ${id}.`);
  const file = sheetAbsPath(library, sheet);
  if (!fs.existsSync(file)) throw new NudgeError(`${id}: file is missing from the library (${sheet.file}). Run nudge doctor.`);

  const textFormat = sheet.format === 'md' || sheet.format === 'txt';
  if (values.app || (!textFormat && section === undefined)) {
    openInDefaultApp(file);
    out(`opened ${sheet.file}`);
  } else {
    const sections = await sheetSections(library, sheet);
    if (section !== undefined) {
      const s = sections.find((x) => x.idx === section);
      if (!s) throw new NudgeError(`${id} has sections 1 to ${sections.length}; there is no section ${section}.`);
      out(dim(`${sheet.id} "${sheet.title}", section ${s.idx} of ${sections.length}: ${s.heading}`));
      out(s.text);
    } else {
      out(dim(`${sheet.id} "${sheet.title}" (${sections.length} sections; nudge open ${sheet.id} --section <n> for one)`));
      out(fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trimEnd());
    }
  }
  logUsage({ event: 'open', id: sheet.id, section, via: 'cli' });
  // So the hook stops offering this sheet in "try:" right away.
  await tryRefreshHookCache(cfg);
  return 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function printIndexReport(r: IndexReport): void {
  for (const n of r.notes) out(dim(n));
  const s = r.sync;
  for (const e of s.edited) out(`edited: ${e} re-extracted and re-indexed`);
  for (const m of s.renamed) out(`renamed: ${m.id} ${m.from} -> ${m.to}`);
  for (const b of s.blocked) {
    const f = b.findings.find((x) => !x.allowed) ?? b.findings[0]!;
    warn(`${b.id} was edited and now has a likely secret (line ${f.line}, ${f.rule}); it is out of the index until you redact it or run nudge allow "${b.file}" --finding ${f.n}`);
  }
  for (const u of s.unreadable) warn(`${u.id} was edited but could not be read: ${u.message}`);
  for (const d of s.deferred) warn(`${d.id} was edited and needs OCR; the old version stays indexed until Ollama is up (${d.message})`);
  if (!r.ai.up) warn(`Ollama is not available (${r.ai.reason}): keyword index only; tagging, OCR and embeddings wait for the next nudge index`);
  const ib = r.inbox;
  for (const i of ib.imported) {
    for (const w of i.warnings) warn(`${path.basename(i.file)}: ${w}`);
    const tagNote = i.sheet.proposal?.tags.length ? `proposed tags: ${i.sheet.proposal.tags.join(', ')}` : i.queued ? 'tags wait for Ollama' : 'no tag proposal';
    out(`inbox: imported ${path.basename(i.file)} as ${bold(i.sheet.id)} "${i.sheet.title}"${i.sheet.ocr ? ' (OCR)' : ''}, pending (${tagNote})`);
  }
  for (const b of ib.blocked) warn(`inbox: ${path.basename(b.file)} moved to ${path.relative(path.dirname(path.dirname(b.dest)), b.dest)}; see ${path.basename(b.dest)}.reason.txt`);
  for (const d of ib.duplicates) out(`inbox: ${path.basename(d.file)} is the same as ${d.existing}; moved to _duplicates`);
  for (const w of ib.waiting) out(dim(`inbox: ${path.basename(w.file)} left in the inbox for now: ${w.reason}`));
  if (r.retag?.proposed.length) out(`proposed tags for ${r.retag.proposed.join(', ')}`);
  const pending = ib.imported.length + (r.retag?.proposed.length ?? 0);
  if (pending) out(dim('confirm proposed tags with nudge review'));
  if (r.embed) {
    if (r.embed.modelChanged) out('embedding model changed: re-embedding every section');
    if (r.embed.skipped) warn(`embeddings incomplete (${r.embed.remaining} sections left): ${r.embed.skipped}`);
    else if (r.embed.embedded) out(`embedded ${plural(r.embed.embedded, 'section')}`);
  }
  if (s.missing.length) warn(`missing from the library: ${s.missing.join(', ')}. They stay in manifest.json; see nudge doctor.`);
  if (s.unknown.length) warn(`not in manifest.json: ${s.unknown.join(', ')}`);
  for (const w of r.warnings) warn(w);
  const tagged = r.projects.filter((p) => p.tags.length).length;
  out(
    `${r.rebuilt ? 'rebuilt' : 'indexed'}: ${plural(r.sheets, 'sheet')} (${r.indexed} updated, ${r.removed} removed from the index); ` +
      `${plural(r.projects.length, 'project')} scanned (${tagged} with tags); hook cache written`,
  );
}

async function cmdIndex(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { rebuild: { type: 'boolean' }, scheduled: { type: 'boolean' } } });
  if (positionals.length) throw new NudgeError('usage: nudge index [--rebuild]');
  if (values.scheduled) {
    // Task Scheduler run: no console to write to, so failures go to logs\index.log.
    try {
      const r = await runIndex(config(), { rebuild: values.rebuild, scheduled: true });
      if (r) logScheduled(`ok: ${r.sheets} sheets, ${r.indexed} updated, ${r.projects.length} projects`);
    } catch (e) {
      logScheduled(`error: ${errorMessage(e)}`);
      return 1;
    }
    return 0;
  }
  printIndexReport((await runIndex(config(), { rebuild: values.rebuild }))!);
  return 0;
}

function logScheduled(line: string): void {
  try {
    fs.mkdirSync(dataPaths().logs, { recursive: true });
    fs.appendFileSync(path.join(dataPaths().logs, 'index.log'),`${new Date().toISOString()} ${line}\n`);
  } catch {
    // Nowhere left to report to.
  }
}

async function cmdScan(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length > 1) throw new NudgeError('usage: nudge scan [path]');
  const entry = await scanProject(config(), positionals[0] ?? '.');
  out(`scanned ${entry.path}${entry.truncated ? ' (stopped at 5,000 files; tags may be incomplete)' : ''}`);
  out(hookLine(entry));
  return 0;
}

function sheetLine(s: SheetInfo): string {
  const flags = [s.status !== 'verified' ? yellow(`[${s.status}]`) : '', s.stale ? yellow('[stale]') : '', s.learned ? dim('[learned]') : '']
    .filter(Boolean)
    .join(' ');
  return `  ${bold(s.id)}  ${s.title}${flags ? '  ' + flags : ''}`;
}

async function cmdFor(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  const target = positionals.join(' ').trim();
  if (!target) throw new NudgeError('usage: nudge for <path | "tag tag"> [--json]');
  const r = forTarget(config(), target);
  if (values.json) {
    out(JSON.stringify(r, null, 2));
    return 0;
  }
  if (r.project) out(`project: ${r.project}${r.truncated ? dim(' (stopped at 5,000 files)') : ''}`);
  if (!r.tags.length) {
    out(r.project ? 'nudge: no tags (add a rule to rules.json)' : 'no tags given');
    return 0;
  }
  out(`tags: ${r.tags.join(', ')}`);
  for (const group of r.byTag) {
    out('');
    out(bold(group.tag));
    if (!group.sheets.length) out(dim('  no sheets'));
    for (const s of group.sheets) out(sheetLine(s));
  }
  out('');
  out(r.gaps.length ? `gaps: ${r.gaps.join(', ')}` : 'gaps: none');
  if (r.ignoredGaps.length) out(dim(`ignored gaps: ${r.ignoredGaps.join(', ')}`));
  if (r.unused.length) {
    out('');
    out('unused (open one, or nudge learned <id> to stop reminders):');
    for (const s of r.unused) out(`${sheetLine(s)}  ${dim(s.lastUsed ? `last used ${s.lastUsed.slice(0, 10)}` : 'never used')}`);
  }
  return 0;
}

async function cmdContext(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { cwd: { type: 'string' }, json: { type: 'boolean' } } });
  let dir = values.cwd ?? process.cwd();
  // A hook whose ${...} placeholder was not substituted passes it through as written. Only
  // then does CLAUDE_PROJECT_DIR count: Claude Code also exports it to every shell it starts.
  if (/^\$\{?\w+\}?$/.test(dir)) dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const r = buildContext(config(), dir);
  if (values.json) out(JSON.stringify(r, null, 2));
  else if (r.text) out(r.text);
  return 0;
}

const suggestCmd = (dir: string) => (dir === '.' ? 'nudge suggest' : `nudge suggest "${dir}"`);

/** Progress goes to stderr so --json output stays clean. */
function progress(line: string): void {
  process.stderr.write(dim(line) + '\n');
}

const KIND_LABEL = { gap: 'gap', extend: 'extends a topic', new: 'new topic' } as const;

async function cmdSuggest(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { save: { type: 'string' }, json: { type: 'boolean' } } });
  if (positionals.length > 1) throw new NudgeError('usage: nudge suggest [path] [--save <n>] [--json]');
  const dir = positionals[0] ?? '.';
  const cfg = config();
  const pick = positiveInt(values.save, '--save');
  if (pick !== undefined) {
    const saved = loadSuggestions(cfg, dir);
    if (!saved) throw new NudgeError(`no saved suggestions for this project; run ${suggestCmd(dir)} first.`);
    const s = saved.suggestions[pick - 1];
    if (!s) throw new NudgeError(`the last nudge suggest listed ${plural(saved.suggestions.length, 'suggestion')}; there is no ${pick}.`);
    return saveDraftReport(cfg, s, saved.project, saved.tags);
  }

  progress(`asking ${cfg.ollama.chatModel} for suggestions...`);
  const r = await suggestForProject(cfg, dir);
  saveSuggestions(r);
  if (values.json) {
    out(JSON.stringify(r, null, 2));
    return 0;
  }
  const f = r.facts;
  out(`project: ${f.project}`);
  out(`tags: ${f.tags.join(', ')}${f.gaps.length ? `   gaps: ${f.gaps.join(', ')}` : ''}${f.ignoredGaps.length ? dim(`   ignored gaps: ${f.ignoredGaps.join(', ')}`) : ''}`);
  out(`existing sheets: ${f.existing.length}${Object.keys(f.files).length ? dim(`   read: ${Object.keys(f.files).join(', ')} (as data)`) : ''}`);
  out('');
  const retry = r.attempts > 1 ? '; the first reply was unusable, retried at temperature 0' : '';
  out(dim(`${r.model}, ${(r.tookMs / 1000).toFixed(1)} s, schema-valid${retry}`));
  if (!r.suggestions.length) out('no usable suggestions this time.');
  r.suggestions.forEach((s, i) => {
    out(`${bold(`${i + 1}.`)} ${s.title}  ${dim(`[${s.tags.join(', ')}]`)}  ${s.kind === 'gap' ? yellow('(gap)') : dim(`(${KIND_LABEL[s.kind]})`)}`);
    out(`   ${s.reason}`);
    out(dim(`   covers: ${s.outline.join('; ')}`));
  });
  if (r.discarded.length) out(dim(`dropped ${plural(r.discarded.length, 'item')} that broke the rules: ${r.discarded.map((d) => `"${d.title}" (${d.why})`).join(', ')}`));
  if (!r.suggestions.length) return 0;
  out('');
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try {
      answer = (await rl.question(`Save one as a draft? [1-${r.suggestions.length}, Enter to skip] `)).trim();
    } finally {
      rl.close();
    }
    const n = Number(answer);
    if (answer && Number.isInteger(n) && r.suggestions[n - 1]) return saveDraftReport(cfg, r.suggestions[n - 1]!, f.project, f.tags);
    if (answer) out('not a number from the list; nothing saved.');
  }
  out(dim(`save one as a draft: ${suggestCmd(dir)} --save <n>`));
  return 0;
}

async function saveDraftReport(cfg: Config, s: Suggestion, project: string, projectTags: string[]): Promise<number> {
  progress(`writing the draft with ${cfg.ollama.chatModel}...`);
  const r = await saveDraft(cfg, s, { project, projectTags });
  for (const w of r.warnings) warn(w);
  out(`${green('saved draft')} ${bold(r.sheet.id)} "${r.sheet.title}" (${r.sheet.file}, ${plural(r.sections, 'section')})`);
  out(`  status draft: shows as [draft] in nudge search, stays out of nudge context and the try: reminders. Check it, then run nudge approve ${r.sheet.id}`);
  return 0;
}

async function cmdApprove(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length !== 1) throw new NudgeError('usage: nudge approve <id>');
  const r = await approveSheet(config(), positionals[0]!);
  if (!r.changed) out(`${r.sheet.id} is already verified.`);
  else out(`${green('approved')} ${r.sheet.id} "${r.sheet.title}": ${r.from} to verified, lastVerified ${r.sheet.lastVerified}`);
  if (r.addedToVocab.length) out(dim(`added to tags.json: ${r.addedToVocab.join(', ')}`));
  if (r.commitError) warn(`the Git commit failed: ${r.commitError}`);
  return 0;
}

async function cmdVerify(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length !== 1) throw new NudgeError('usage: nudge verify <id>');
  const r = await verifySheet(config(), positionals[0]!);
  out(r.changed ? `verified ${r.sheet.id} "${r.sheet.title}": lastVerified ${r.sheet.lastVerified}` : `${r.sheet.id} was already verified today.`);
  if (r.commitError) warn(`the Git commit failed: ${r.commitError}`);
  return 0;
}

async function cmdLearned(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { undo: { type: 'boolean' } } });
  if (positionals.length !== 1) throw new NudgeError('usage: nudge learned <id> [--undo]');
  const learned = !values.undo;
  const r = await setLearned(config(), positionals[0]!, learned);
  const state = learned ? 'learned; no more reminders for it' : 'not learned; reminders resume once it goes unused';
  out(r.changed ? `${r.sheet.id} "${r.sheet.title}" marked ${state}` : `${r.sheet.id} is already ${learned ? 'learned' : 'not learned'}.`);
  if (r.commitError) warn(`the Git commit failed: ${r.commitError}`);
  return 0;
}

async function cmdIgnoreGap(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'boolean' }, undo: { type: 'boolean' } } });
  if (positionals.length !== 1) throw new NudgeError('usage: nudge ignore-gap <tag> [--project] [--undo]');
  const r = await ignoreGap(config(), positionals[0]!, { projectDir: values.project ? process.cwd() : undefined, undo: values.undo });
  const scope = r.project ? `in ${r.project}` : 'everywhere';
  if (!r.changed) out(`gap ${r.tag} was already ${values.undo ? 'not ignored' : 'ignored'} ${scope}.`);
  else out(values.undo ? `gap ${r.tag} is shown again ${scope}.` : `gap ${r.tag} ignored ${scope}.`);
  if (r.commitError) warn(`the Git commit failed: ${r.commitError}`);
  return 0;
}

async function cmdInstall(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { 'dry-run': { type: 'boolean' }, yes: { type: 'boolean', short: 'y' } } });
  if (positionals.length) throw new NudgeError('usage: nudge install [--dry-run] [--yes]');
  const sys = realSystem();
  const plan = planInstall(sys);
  out(bold('nudge install will change:'));
  out('');
  out('1. PowerShell profiles (marked block; anything else in the file is kept):');
  for (const p of plan.profiles) {
    const what = { create: 'create the file with the block', append: 'append the block', update: 'replace the existing block', none: 'no change, block already current' }[p.action];
    out(`   ${p.host}: ${p.file}`);
    out(`     ${what}${p.backup ? `; back up the current file to ${p.backup}` : ''}`);
  }
  out('   block:');
  for (const l of plan.block.split(/\r?\n/)) out(`     ${l}`);
  out('');
  if (plan.task.current) out(`2. Task Scheduler: no change, task "${plan.task.name}" is already registered with this command and schedule`);
  else {
    out(`2. Task Scheduler: ${plan.task.exists ? 'replace' : 'register'} task "${plan.task.name}" for ${plan.task.spec.userId}`);
    out('   at logon, then every 30 minutes, hidden window, standard rights');
  }
  out(`   runs: ${plan.task.spec.command} ${plan.task.spec.arguments}`);
  out('');
  if (plan.path.after === null) out(`3. PATH: no change, ${plan.path.dir} is already on your user PATH`);
  else {
    out(`3. User PATH (HKCU\\Environment, kept as ${plan.path.kind}): append ${plan.path.dir}`);
    out(`   before: ${plan.path.before ?? '(not set)'}`);
    out(`   after:  ${plan.path.after}`);
  }
  out('');
  const a = plan.agents;
  out('4. Claude Code (user scope, every project):');
  printEdit('settings', a.claudeSettings, 'add a SessionStart hook that runs nudge context');
  const m = a.claudeMcp;
  out(`   MCP server "nudge" (${m.file}, top-level mcpServers):`);
  if (m.action === 'skip') out(`     skipped: ${m.note}`);
  else if (m.action === 'none') out('     no change, already registered with this command');
  else {
    if (m.note) out(`     ${m.note}`);
    if (m.backup) out(`     back up the current file to ${m.backup}, then run:`);
    for (const c of m.commands) out(`     ${m.claude} ${c.map((x) => (/[\s"{]/.test(x) ? `'${x}'` : x)).join(' ')}`);
  }
  out('');
  out('5. OpenCode (global config):');
  printEdit('config', a.opencodeConfig, 'add mcp.nudge');
  printEdit('plugin', a.opencodePlugin, 'write a plugin that adds nudge context to each session (experimental.chat.system.transform)');
  out('');
  const p = plan.popup;
  out(`6. Popup at logon (${p.key}, value "${p.name}"; Task Manager lists it under Startup apps):`);
  if (p.action === 'skip') out(`   skipped: ${p.note}`);
  else if (p.action === 'none') out('   no change, already starts this popup');
  else {
    out(`   ${p.action === 'create' ? 'add the value' : 'replace the value'}${p.backup ? `; back up the Run key first to ${p.backup}` : ''}`);
    if (p.before !== null) out(`   before: ${p.before}`);
    out(`   ${p.before !== null ? 'after: ' : 'value: '}${p.after}`);
  }
  out('');
  out(dim('Not touched: execution policy, other profiles, system PATH, any other agent setting, other startup items.'));
  for (const w of plan.warnings) warn(w);
  if (values['dry-run']) {
    out(dim('\ndry run: nothing was changed.'));
    return 0;
  }
  if (!values.yes) {
    if (!process.stdin.isTTY) throw new NudgeError('refusing to change your machine without confirmation. Re-run in a terminal, or pass --yes.');
    if (!(await confirm('Apply these changes?'))) {
      out('cancelled; nothing changed.');
      return 0;
    }
  }
  for (const line of applyInstall(plan, sys)) out(`${green('done')} ${line}`);
  out('Open a new PowerShell window to load the hook.');
  return 0;
}

function printEdit(label: string, e: FileEdit, what: string): void {
  out(`   ${label}: ${e.file}`);
  if (e.action === 'skip') {
    out(`     skipped: ${e.note}`);
    if (e.entry) out(`     add by hand: ${JSON.stringify(e.entry)}`);
    return;
  }
  if (e.action === 'none') {
    out('     no change, already current');
    return;
  }
  out(`     ${e.action === 'create' ? 'create the file and ' : ''}${what}${e.backup ? `; back up the current file to ${e.backup}` : ''}`);
  if (e.note) out(`     ${e.note}`);
  if (e.entry) out(`     entry: ${JSON.stringify(e.entry)}`);
  if (e.kept.length) out(`     kept as is: ${e.kept.join(', ')}`);
}

async function cmdDoctor(): Promise<number> {
  const checks = await runDoctor();
  const label = { ok: green('ok  '), warn: yellow('warn'), fail: red('fail') };
  for (const c of checks) out(`${label[c.status]}  ${c.name.padEnd(8)} ${c.detail}`);
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  out(fails || warns ? `\n${fails} failed, ${warns} warning${warns === 1 ? '' : 's'}` : `\n${green('all green')}`);
  return fails ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'add':
      return cmdAdd(args);
    case 'allow':
      return cmdAllow(args);
    case 'search':
      return cmdSearch(args);
    case 'review':
      return cmdReview(args);
    case 'open':
      return cmdOpen(args);
    case 'index':
      return cmdIndex(args);
    case 'scan':
      return cmdScan(args);
    case 'for':
      return cmdFor(args);
    case 'context':
      return cmdContext(args);
    case 'suggest':
      return cmdSuggest(args);
    case 'approve':
      return cmdApprove(args);
    case 'verify':
      return cmdVerify(args);
    case 'learned':
      return cmdLearned(args);
    case 'ignore-gap':
      return cmdIgnoreGap(args);
    case 'install':
      return cmdInstall(args);
    case 'doctor':
      return cmdDoctor();
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(HELP);
      return 0;
    default:
      throw new NudgeError(`unknown command "${cmd}". Run nudge help.`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof NudgeError) {
      process.stderr.write(`nudge: ${e.message}\n`);
      process.exitCode = e.exitCode;
    } else if (e instanceof TypeError && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`nudge: ${e.message}. Run nudge help.\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`nudge: unexpected error: ${errorMessage(e)}\n${e instanceof Error ? (e.stack ?? '') : ''}\n`);
      process.exitCode = 1;
    }
  },
);
