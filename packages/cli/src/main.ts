#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  RefsError,
  addFile,
  allowFinding,
  applyInstall,
  blockingFindings,
  dataPaths,
  ensureConfigFile,
  errorMessage,
  findById,
  forTarget,
  hookLine,
  ignoreGap,
  keywordSearch,
  loadConfig,
  logUsage,
  openDb,
  parseTagList,
  planInstall,
  readManifest,
  realSystem,
  runDoctor,
  runIndex,
  scanProject,
  setLearned,
  sheetAbsPath,
  sheetSections,
  tryRefreshHookCache,
  verifySheet,
  type IndexReport,
  type SearchHit,
  type SheetInfo,
} from '@refs/core';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = (open: number, close: number) => (s: string) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);
const bold = ansi(1, 22);
const dim = ansi(2, 22);
const red = ansi(31, 39);
const green = ansi(32, 39);
const yellow = ansi(33, 39);

const HELP = `refs: personal cheat sheet index

Usage:
  refs add <file> [--tags a,b] [--yes]   import one file (md, txt, docx, pdf)
  refs index [--rebuild]                 sync library changes, update the index, scan projects,
                                         write the hook cache (--rebuild: recreate index.db)
  refs search <query> [--tags a,b] [--limit n] [--json]
  refs for <path | "tag tag"> [--json]   sheets by tag, gaps and unused reminders
  refs scan [path]                       re-detect one project, rewrite its hook cache entry
  refs open <id> [--section <n>] [--app] print a sheet or section; --app opens the default app
  refs verify <id>                       set lastVerified to today (clears stale)
  refs learned <id> [--undo]             stop (or resume) reminders for a sheet
  refs ignore-gap <tag> [--project] [--undo]
                                         silence a gap everywhere, or only in this project
  refs allow <file> --finding <n>        allowlist a secret-scan false positive
  refs install [--dry-run] [--yes]       PowerShell hook, Task Scheduler job, refs on PATH
  refs doctor                            check config, library, index, rules, hook and schedule
  refs help

Projects are detected under the "roots" folders in config.json.
Coming in later milestones: review (3); context, suggest, approve (4).`;

const LATER: Record<string, number> = { review: 3, context: 4, suggest: 4, approve: 4 };

function out(line = ''): void {
  process.stdout.write(line + '\n');
}

function warn(line: string): void {
  process.stderr.write(`${yellow('warning:')} ${line}\n`);
}

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new RefsError(`${flag} must be a positive whole number, got "${value}".`);
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

async function cmdAdd(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { tags: { type: 'string' }, yes: { type: 'boolean', short: 'y' } },
  });
  if (positionals.length !== 1) throw new RefsError('usage: refs add <file> [--tags a,b] [--yes]');
  const loaded = loadConfig();
  if (ensureConfigFile(loaded.config)) out(dim(`created config at ${loaded.path}`));

  const result = await addFile(loaded.config.library, positionals[0]!, {
    tags: parseTagList(values.tags),
    yes: values.yes,
    confirm: process.stdin.isTTY ? confirm : undefined,
  });

  switch (result.kind) {
    case 'added': {
      const { sheet } = result;
      for (const n of result.notes) out(dim(n));
      for (const w of result.warnings) warn(w);
      out(`${green('added')} ${bold(sheet.id)} "${sheet.title}" (${sheet.format}, ${result.sections} section${result.sections === 1 ? '' : 's'})`);
      out(`  ${sheet.file}`);
      out(sheet.tags.length ? `  tags: ${sheet.tags.join(', ')}` : `  tags: none yet, status pending (add with --tags next time)`);
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
      process.stderr.write(`Redact them and run refs add again. If one is a false positive:\n  refs allow "${result.file}" --finding <n>\n`);
      return 2;
    }
  }
}

async function cmdAllow(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { finding: { type: 'string' } } });
  const n = positiveInt(values.finding, '--finding');
  if (positionals.length !== 1 || n === undefined) throw new RefsError('usage: refs allow <file> --finding <n>');
  const result = await allowFinding(config().library, positionals[0]!, n);
  const f = result.finding;
  out(`allowed finding ${f.n} (${f.rule}, line ${f.line})${result.sheetId ? ` for ${result.sheetId}` : ''}.`);
  if (!result.sheetId) out('Run refs add again to import the file.');
  return 0;
}

function formatHit(h: SearchHit): string[] {
  const where = h.heading === h.title || h.heading === 'Intro' ? h.title : `${h.title} > ${h.heading}`;
  const badges = [h.tags.length ? dim(`[${h.tags.join(', ')}]`) : '', h.status !== 'verified' ? yellow(`[${h.status}]`) : '', h.stale ? yellow('[stale]') : '']
    .filter(Boolean)
    .join(' ');
  return [`${bold(`${h.id}:${h.section}`)}  ${where}${badges ? '  ' + badges : ''}`, `    ${h.snippet}`];
}

async function cmdSearch(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { tags: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean' } },
  });
  const query = positionals.join(' ').trim();
  if (!query) throw new RefsError('usage: refs search <query> [--tags a,b] [--limit n] [--json]');
  const { library, staleAfterDays } = config();
  if (!fs.existsSync(dataPaths().db)) throw new RefsError('no index yet. Run refs index, or import a sheet with refs add <file>.');
  const sheets = readManifest(library);
  const db = openDb();
  let hits: SearchHit[];
  try {
    hits = keywordSearch(db, sheets, query, {
      tags: parseTagList(values.tags),
      limit: positiveInt(values.limit, '--limit') ?? 10,
      highlight: values.json ? undefined : useColor ? ['\x1b[1m', '\x1b[22m'] : ['', ''],
      staleAfterDays,
    });
  } finally {
    db.close();
  }
  if (values.json) {
    out(JSON.stringify(hits, null, 2));
    return 0;
  }
  if (!hits.length) {
    out(`no matches for "${query}"`);
    return 0;
  }
  for (const h of hits) for (const line of formatHit(h)) out(line);
  out(dim('\nopen one: refs open <id> --section <n>'));
  return 0;
}

function openInDefaultApp(file: string): void {
  // explorer.exe opens a file with its associated app and takes the path as one
  // argument, so no shell quoting is involved.
  spawn('explorer.exe', [file], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

async function cmdOpen(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { section: { type: 'string' }, app: { type: 'boolean' } },
  });
  if (positionals.length !== 1) throw new RefsError('usage: refs open <id> [--section <n>] [--app]');
  const id = positionals[0]!;
  const section = positiveInt(values.section, '--section');
  const cfg = config();
  const { library } = cfg;
  const sheet = findById(readManifest(library), id);
  if (!sheet) throw new RefsError(`no sheet with id ${id}.`);
  const file = sheetAbsPath(library, sheet);
  if (!fs.existsSync(file)) throw new RefsError(`${id}: file is missing from the library (${sheet.file}). Run refs doctor.`);

  const textFormat = sheet.format === 'md' || sheet.format === 'txt';
  if (values.app || (!textFormat && section === undefined)) {
    openInDefaultApp(file);
    out(`opened ${sheet.file}`);
  } else {
    const sections = await sheetSections(library, sheet);
    if (section !== undefined) {
      const s = sections.find((x) => x.idx === section);
      if (!s) throw new RefsError(`${id} has sections 1 to ${sections.length}; there is no section ${section}.`);
      out(dim(`${sheet.id} "${sheet.title}", section ${s.idx} of ${sections.length}: ${s.heading}`));
      out(s.text);
    } else {
      out(dim(`${sheet.id} "${sheet.title}" (${sections.length} sections; refs open ${sheet.id} --section <n> for one)`));
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
    warn(`${b.id} was edited and now has a likely secret (line ${f.line}, ${f.rule}); it is out of the index until you redact it or run refs allow "${b.file}" --finding ${f.n}`);
  }
  for (const u of s.unreadable) warn(`${u.id} was edited but could not be read: ${u.message}`);
  if (s.missing.length) warn(`missing from the library: ${s.missing.join(', ')}. They stay in manifest.json; see refs doctor.`);
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
  if (positionals.length) throw new RefsError('usage: refs index [--rebuild]');
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
  if (positionals.length > 1) throw new RefsError('usage: refs scan [path]');
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
  if (!target) throw new RefsError('usage: refs for <path | "tag tag"> [--json]');
  const r = forTarget(config(), target);
  if (values.json) {
    out(JSON.stringify(r, null, 2));
    return 0;
  }
  if (r.project) out(`project: ${r.project}${r.truncated ? dim(' (stopped at 5,000 files)') : ''}`);
  if (!r.tags.length) {
    out(r.project ? 'refs: no tags (add a rule to rules.json)' : 'no tags given');
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
    out('unused (open one, or refs learned <id> to stop reminders):');
    for (const s of r.unused) out(`${sheetLine(s)}  ${dim(s.lastUsed ? `last used ${s.lastUsed.slice(0, 10)}` : 'never used')}`);
  }
  return 0;
}

async function cmdVerify(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length !== 1) throw new RefsError('usage: refs verify <id>');
  const r = await verifySheet(config(), positionals[0]!);
  out(r.changed ? `verified ${r.sheet.id} "${r.sheet.title}": lastVerified ${r.sheet.lastVerified}` : `${r.sheet.id} was already verified today.`);
  if (r.commitError) warn(`the Git commit failed: ${r.commitError}`);
  return 0;
}

async function cmdLearned(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { undo: { type: 'boolean' } } });
  if (positionals.length !== 1) throw new RefsError('usage: refs learned <id> [--undo]');
  const learned = !values.undo;
  const r = await setLearned(config(), positionals[0]!, learned);
  const state = learned ? 'learned; no more reminders for it' : 'not learned; reminders resume once it goes unused';
  out(r.changed ? `${r.sheet.id} "${r.sheet.title}" marked ${state}` : `${r.sheet.id} is already ${learned ? 'learned' : 'not learned'}.`);
  if (r.commitError) warn(`the Git commit failed: ${r.commitError}`);
  return 0;
}

async function cmdIgnoreGap(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'boolean' }, undo: { type: 'boolean' } } });
  if (positionals.length !== 1) throw new RefsError('usage: refs ignore-gap <tag> [--project] [--undo]');
  const r = await ignoreGap(config(), positionals[0]!, { projectDir: values.project ? process.cwd() : undefined, undo: values.undo });
  const scope = r.project ? `in ${r.project}` : 'everywhere';
  if (!r.changed) out(`gap ${r.tag} was already ${values.undo ? 'not ignored' : 'ignored'} ${scope}.`);
  else out(values.undo ? `gap ${r.tag} is shown again ${scope}.` : `gap ${r.tag} ignored ${scope}.`);
  if (r.commitError) warn(`the Git commit failed: ${r.commitError}`);
  return 0;
}

async function cmdInstall(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { 'dry-run': { type: 'boolean' }, yes: { type: 'boolean', short: 'y' } } });
  if (positionals.length) throw new RefsError('usage: refs install [--dry-run] [--yes]');
  const sys = realSystem();
  const plan = planInstall(sys);
  out(bold('refs install will change:'));
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
  out(`2. Task Scheduler: ${plan.task.exists ? 'replace' : 'register'} task "${plan.task.name}" for ${plan.task.spec.userId}`);
  out('   at logon, then every 30 minutes, hidden window, standard rights');
  out(`   runs: ${plan.task.spec.command} ${plan.task.spec.arguments}`);
  out('');
  if (plan.path.after === null) out(`3. PATH: no change, ${plan.path.dir} is already on your user PATH`);
  else {
    out(`3. User PATH (HKCU\\Environment, kept as ${plan.path.kind}): append ${plan.path.dir}`);
    out(`   before: ${plan.path.before ?? '(not set)'}`);
    out(`   after:  ${plan.path.after}`);
  }
  out('');
  out(dim('Not touched: execution policy, other profiles, system PATH. MCP registration comes in milestone 4.'));
  for (const w of plan.warnings) warn(w);
  if (values['dry-run']) {
    out(dim('\ndry run: nothing was changed.'));
    return 0;
  }
  if (!values.yes) {
    if (!process.stdin.isTTY) throw new RefsError('refusing to change your machine without confirmation. Re-run in a terminal, or pass --yes.');
    if (!(await confirm('Apply these changes?'))) {
      out('cancelled; nothing changed.');
      return 0;
    }
  }
  for (const line of applyInstall(plan, sys)) out(`${green('done')} ${line}`);
  out('Open a new PowerShell window to load the hook.');
  return 0;
}

function cmdDoctor(): number {
  const checks = runDoctor();
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
    case 'open':
      return cmdOpen(args);
    case 'index':
      return cmdIndex(args);
    case 'scan':
      return cmdScan(args);
    case 'for':
      return cmdFor(args);
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
      if (cmd in LATER) throw new RefsError(`refs ${cmd} is not built yet (milestone ${LATER[cmd]}).`);
      throw new RefsError(`unknown command "${cmd}". Run refs help.`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof RefsError) {
      process.stderr.write(`refs: ${e.message}\n`);
      process.exitCode = e.exitCode;
    } else if (e instanceof TypeError && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`refs: ${e.message}. Run refs help.\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`refs: unexpected error: ${errorMessage(e)}\n${e instanceof Error ? (e.stack ?? '') : ''}\n`);
      process.exitCode = 1;
    }
  },
);
