#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  RefsError,
  addFile,
  allowFinding,
  blockingFindings,
  dataPaths,
  ensureConfigFile,
  errorMessage,
  findById,
  keywordSearch,
  loadConfig,
  logUsage,
  openDb,
  parseTagList,
  readManifest,
  runDoctor,
  sheetAbsPath,
  sheetSections,
  type SearchHit,
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
  refs search <query> [--tags a,b] [--limit n] [--json]
  refs open <id> [--section <n>] [--app] print a sheet or section; --app opens the default app
  refs allow <file> --finding <n>        allowlist a secret-scan false positive
  refs doctor                            check config, library, manifest, index and lock
  refs help

Coming in later milestones: index, for, scan, install (2); review (3);
context, suggest, approve (4); verify, learned, ignore-gap.`;

const LATER: Record<string, number> = {
  index: 2, for: 2, scan: 2, install: 2, verify: 2, learned: 2, 'ignore-gap': 2,
  review: 3, context: 4, suggest: 4, approve: 4,
};

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
  const badges = [h.tags.length ? dim(`[${h.tags.join(', ')}]`) : '', h.status !== 'verified' ? yellow(`[${h.status}]`) : '']
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
  const { library } = config();
  if (!fs.existsSync(dataPaths().db)) throw new RefsError('no index yet. Import a sheet with refs add <file> first.');
  const sheets = readManifest(library);
  const db = openDb();
  let hits: SearchHit[];
  try {
    hits = keywordSearch(db, sheets, query, {
      tags: parseTagList(values.tags),
      limit: positiveInt(values.limit, '--limit') ?? 10,
      highlight: values.json ? undefined : useColor ? ['\x1b[1m', '\x1b[22m'] : ['', ''],
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
  const { library } = config();
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
