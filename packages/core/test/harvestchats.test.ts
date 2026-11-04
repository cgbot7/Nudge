import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { loadConfig, type Config } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import {
  coveredBy,
  htmlToText,
  loadClaudeTranscript,
  loadCursorTranscript,
  looksLikeReference,
  newExchanges,
  parseClaudeAiExport,
  parseGeminiExport,
  runHarvest,
  shortTitle,
  transcriptText,
} from '../src/harvest/index.ts';
import { readLedger } from '../src/harvest/ledger.ts';
import { addFile } from '../src/import.ts';
import { runIndex } from '../src/indexer.ts';
import { readManifest } from '../src/manifest.ts';
import { ollamaClient } from '../src/ollama.ts';
import { acceptReview, rejectReview, reviewQueue } from '../src/review.ts';
import { startFakeOllama, type FakeOllama } from './fakeollama.ts';
import { DOCKER_MD, FAKE_GITHUB_TOKEN, setupEnv, write, type TestEnv } from './helpers.ts';

let fake: FakeOllama;
let t: TestEnv;
let home: string;

before(async () => {
  fake = await startFakeOllama();
});
after(async () => {
  await fake.close();
});
beforeEach(() => {
  t = setupEnv({ ollamaHost: fake.url });
  home = t.env.NUDGE_HOME_DIR!;
  fake.chatReplies.length = 0;
  fake.chatCalls.length = 0;
});

const HOUR = 3600_000;
const LONG_ANSWER = 'Here is how to list and prune volumes.\n\n```bash\ndocker volume ls\ndocker volume prune\n```\n\n' + 'Named volumes outlive containers. '.repeat(8);

function cfg(harvest: Record<string, unknown> = {}): Config {
  const file = path.join(t.env.APPDATA!, 'nudge', 'config.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...data, harvest: { sources: { 'claude-memory': false }, ...harvest } }));
  return loadConfig().config;
}

function client(config: Config) {
  return ollamaClient(config.ollama);
}

function useful(title = 'Docker volumes', tags = ['docker']): string {
  return JSON.stringify({
    useful: true,
    title,
    tags,
    intro: 'Volumes keep data after a container is gone.',
    sections: [
      { heading: 'List and prune', body: '```bash\ndocker volume ls\ndocker volume prune\n```' },
      { heading: 'Good to know', body: '- Named volumes outlive containers.' },
    ],
  });
}

const NOT_USEFUL = JSON.stringify({ useful: false, title: '', tags: [], intro: '', sections: [] });

type Line = Record<string, unknown>;
const userLine = (text: string, extra: Line = {}): Line => ({ type: 'user', message: { role: 'user', content: text }, ...extra });
const assistantLine = (text: string, extra: Line = {}): Line => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });

function claudeChat(project: string, id: string, lines: Line[], ageMs = HOUR): string {
  const file = write(path.join(home, '.claude', 'projects', project), `${id}.jsonl`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
  return file;
}

function appendLines(file: string, lines: Line[], ageMs = HOUR): void {
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
}

test('Claude Code transcripts keep typed text and answers only', async () => {
  const file = claudeChat('C--Proj', 'abc', [
    { type: 'custom-title', customTitle: 'Volume notes' },
    userLine('<command-message>init</command-message>'),
    userLine('How do I prune docker volumes?'),
    assistantLine('Let me check.'),
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'secret tool output' }] } },
    assistantLine(LONG_ANSWER),
    userLine('side question', { isSidechain: true }),
    userLine('meta', { isMeta: true }),
    'not json',
  ] as Line[]);
  fs.appendFileSync(file, '{"type": "user", "message"\n');
  const r = await loadClaudeTranscript(file);
  assert.equal(r.title, 'Volume notes');
  assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(r.messages[0]!.text, 'How do I prune docker volumes?');
  assert.match(r.messages[1]!.text, /^Let me check\.\n\nHere is how/);
  assert.doesNotMatch(JSON.stringify(r.messages), /secret tool output|side question|meta|command-message/);
});

test('Cursor transcripts take the text inside user_query and drop injected blocks', async () => {
  const lines = [
    { role: 'user', message: { content: [{ type: 'text', text: '<available_subagent_types>x</available_subagent_types>' }] } },
    { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Mon</timestamp>\n<user_query>\nhow do I rebase?\n</user_query>' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Use git rebase -i.' }, { type: 'tool_use', name: 'x' }] } },
    { type: 'status', status: 'done' },
  ];
  const file = write(path.join(home, '.cursor', 'projects', 'c-App', 'agent-transcripts', 'id1'), 'id1.jsonl', lines.map((l) => JSON.stringify(l)).join('\n'));
  assert.deepEqual(await loadCursorTranscript(file), [
    { role: 'user', text: 'how do I rebase?' },
    { role: 'assistant', text: 'Use git rebase -i.' },
  ]);
});

test('exchanges: only new ones, a trailing question waits for its answer', () => {
  const m = [
    { role: 'user' as const, text: 'q1' },
    { role: 'assistant' as const, text: 'a1' },
    { role: 'user' as const, text: 'q2' },
  ];
  assert.deepEqual(newExchanges(m, 0), { exchanges: [{ user: 'q1', assistant: 'a1' }], seen: 2 });
  assert.deepEqual(newExchanges([...m, { role: 'assistant', text: 'a2' }], 2), { exchanges: [{ user: 'q2', assistant: 'a2' }], seen: 4 });
  assert.deepEqual(newExchanges(m, 2), { exchanges: [], seen: 2 });

  assert.equal(looksLikeReference({ user: 'fix my bug', assistant: LONG_ANSWER }), true);
  assert.equal(looksLikeReference({ user: 'how do I x?', assistant: 'short' }), false);
  assert.equal(looksLikeReference({ user: 'thanks', assistant: 'You are welcome. '.repeat(20) }), false);
  assert.equal(looksLikeReference({ user: 'what is the syntax for x?', assistant: 'Explained in prose. '.repeat(20) }), true);
  assert.equal(transcriptText([{ user: 'q', assistant: 'a' }]), 'Person:\nq\n\nAssistant:\na');
  assert.equal(shortTitle('PROMPT.md — paste this – now'), 'PROMPT.md, paste this - now');
});

test('export parsers: claude.ai conversations and Gemini activity', () => {
  const claude = parseClaudeAiExport([
    { uuid: 'u1', name: 'Nginx', updated_at: '2026-10-02T10:00:00Z', chat_messages: [{ sender: 'human', text: 'q' }, { sender: 'assistant', text: '', content: [{ type: 'text', text: 'a' }] }] },
  ]);
  assert.deepEqual(claude, { kind: 'claude-ai', chats: [{ id: 'u1', title: 'Nginx', updatedMs: Date.parse('2026-10-02T10:00:00Z'), messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }] }] });
  assert.equal(parseClaudeAiExport([{ header: 'Gemini Apps' }]), null);

  const gemini = parseGeminiExport([
    { header: 'Gemini Apps', title: 'Prompted second', time: '2026-10-05T12:00:00Z', safeHtmlItem: [{ html: '<p>b &amp; c</p>' }] },
    { header: 'Gemini Apps', title: 'Prompted first', time: '2026-10-05T09:00:00Z', safeHtmlItem: [{ html: '<pre><code>ls -la</code></pre>' }] },
    { header: 'Search', title: 'Searched for x', time: '2026-10-05T09:00:00Z' },
  ])!;
  assert.equal(gemini.chats.length, 1);
  assert.equal(gemini.chats[0]!.id, '2026-10-05');
  assert.deepEqual(gemini.chats[0]!.messages, [
    { role: 'user', text: 'first' },
    { role: 'assistant', text: '```\nls -la\n```' },
    { role: 'user', text: 'second' },
    { role: 'assistant', text: 'b & c' },
  ]);
  assert.equal(htmlToText('<ul><li>one</li><li><code>two</code></li></ul>&#39;x&#x27;'), "- one\n- `two`\n'x'");
});

test('a chat with reference material becomes a draft, and is read again only for new exchanges', async () => {
  const config = cfg();
  const file = claudeChat('C--Projects-Web', 'sess1', [userLine('How do I prune docker volumes?'), assistantLine(LONG_ANSWER)]);
  fake.chatReplies.push(useful());

  const r = await runHarvest(config, { client: client(config), since: '2000-01-01' });
  assert.equal(r.chats.drafts.length, 1, JSON.stringify(r.chats));
  const sheet = readManifest(t.library)[0]!;
  assert.equal(sheet.status, 'draft');
  assert.equal(sheet.source, 'llm');
  assert.match(sheet.file, /^drafts\/s_0001-docker-volumes\.md$/);
  assert.deepEqual(sheet.tags, ['docker']);
  assert.equal(sheet.harvest?.kind, 'chat');
  assert.equal(sheet.harvest?.tool, 'claude-chats');
  assert.equal(sheet.harvest?.conversation, 'claude-chats:sess1');
  assert.equal(sheet.harvest?.project, 'C--Projects-Web');
  const text = fs.readFileSync(path.join(t.library, sheet.file), 'utf8');
  assert.match(text, /^# Docker volumes\n\n_Generated by fake-chat on .* by nudge harvest from the chat "How do I prune docker volumes\?"\._/);
  assert.match(fake.chatCalls[0]!.messages[1]!.content, /<transcript>\nPerson:\nHow do I prune docker volumes\?/);

  const entry = readLedger(t.library).chats['claude-chats:sess1']!;
  assert.deepEqual({ seen: entry.seen, sheetIds: entry.sheetIds }, { seen: 2, sheetIds: ['s_0001'] });
  assert.ok(readLedger(t.library).chatsSince);

  // Unchanged: no model call.
  const again = await runHarvest(config, { client: client(config), since: '2000-01-01' });
  assert.equal(again.chats.unchanged, 1);
  assert.equal(fake.chatCalls.length, 1);

  // A new exchange: only it goes to the model.
  appendLines(file, [userLine('And how do I inspect one?'), assistantLine('Inspect it like this.\n\n```bash\ndocker volume inspect data\n```\n' + 'More words here. '.repeat(10))]);
  fake.chatReplies.push(NOT_USEFUL);
  const third = await runHarvest(config, { client: client(config), since: '2000-01-01' });
  assert.equal(third.chats.skipped, 1);
  const sent = fake.chatCalls[1]!.messages[1]!.content.split('<transcript>')[1]!;
  assert.match(sent, /inspect one/);
  assert.doesNotMatch(sent, /prune docker volumes/);
  assert.equal(readLedger(t.library).chats['claude-chats:sess1']!.seen, 4);
});

test('chats without reference material, secrets, old or active chats never reach the model', async () => {
  const config = cfg();
  claudeChat('P', 'chatty', [userLine('hi'), assistantLine('Hello! How can I help today?')]);
  claudeChat('P', 'secret', [userLine('set my token'), assistantLine(`export GITHUB_TOKEN=${FAKE_GITHUB_TOKEN}\n\n\`\`\`bash\necho ok\n\`\`\`\n` + 'x '.repeat(120))]);
  claudeChat('P', 'old', [userLine('How do I prune?'), assistantLine(LONG_ANSWER)], 400 * 24 * HOUR);
  claudeChat('P', 'active', [userLine('How do I prune?'), assistantLine(LONG_ANSWER)], 60_000);

  const r = await runHarvest(config, { client: client(config) });
  assert.equal(fake.chatCalls.length, 0);
  assert.equal(r.chats.nothing, 1);
  assert.deepEqual(r.chats.blocked.map((b) => b.rules.length > 0 && b.chat), ['set my token']);
  assert.equal(r.chats.older, 1);
  assert.equal(r.chats.active, 1);
  assert.equal(readManifest(t.library).length, 0);
  // Blocked chats are recorded, so they are not scanned again.
  assert.equal(readLedger(t.library).chats['claude-chats:secret']!.seen, 2);

  const back = await runHarvest(config, { client: client(config), since: '2000-01-01', dryRun: true });
  assert.deepEqual(back.chats.wouldDistill.map((w) => w.chat), ['How do I prune?']);
});

test('without Ollama or past maxChatsPerRun, chats wait and the ledger does not move', async () => {
  const config = cfg({ maxChatsPerRun: 1 });
  claudeChat('P', 'a', [userLine('How do I prune volumes?'), assistantLine(LONG_ANSWER)], 2 * HOUR);
  claudeChat('P', 'b', [userLine('How do I list volumes?'), assistantLine(LONG_ANSWER)], 3 * HOUR);

  const down = await runHarvest(config, { client: null, since: '2000-01-01' });
  assert.equal(down.chats.waiting, 2);
  assert.equal(down.chats.waitingReason, 'Ollama is not available');
  assert.deepEqual(Object.keys(readLedger(t.library).chats), []);

  fake.chatReplies.push(useful('Prune volumes'), useful('List volumes'));
  const one = await runHarvest(config, { client: client(config), since: '2000-01-01' });
  assert.equal(one.chats.drafts.length, 1);
  assert.equal(one.chats.drafts[0]!.chat, 'How do I prune volumes?', 'newest first');
  assert.equal(one.chats.waiting, 1);
  assert.match(one.chats.waitingReason!, /maxChatsPerRun \(1\)/);
  assert.equal((await runHarvest(config, { client: client(config), since: '2000-01-01' })).chats.drafts.length, 1);
});

test('bad JSON gets one retry, then the chat is recorded as failed', async () => {
  const config = cfg();
  claudeChat('P', 'a', [userLine('How do I prune volumes?'), assistantLine(LONG_ANSWER)]);
  fake.chatReplies.push('not json', '{"useful": true}');
  const r = await runHarvest(config, { client: client(config), since: '2000-01-01' });
  assert.equal(fake.chatCalls.length, 2);
  assert.equal(fake.chatCalls[1]!.temperature, 0);
  assert.match(r.chats.failed[0]!.reason, /no usable reply twice/);
  assert.equal(readManifest(t.library).length, 0);
});

test('harvested drafts are in the review queue; accept verifies, reject stops the chat for good', async () => {
  const config = cfg();
  const file = claudeChat('P', 'a', [userLine('How do I prune volumes?'), assistantLine(LONG_ANSWER)]);
  claudeChat('P', 'b', [userLine('How do I list volumes?'), assistantLine(LONG_ANSWER)], 2 * HOUR);
  fake.chatReplies.push(useful('Prune volumes'), useful('List volumes', ['docker', 'storage']));
  await runHarvest(config, { client: client(config), since: '2000-01-01' });
  assert.deepEqual(reviewQueue(t.library).map((s) => s.title), ['Prune volumes', 'List volumes']);

  const ok = await acceptReview(config, 's_0002');
  assert.equal(ok.sheet.status, 'verified');
  assert.deepEqual(ok.sheet.tags, ['docker', 'storage']);

  const no = await rejectReview(config, 's_0001');
  assert.deepEqual(no.origins, ['chat How do I prune volumes?']);
  assert.equal(fs.existsSync(path.join(t.library, no.sheet.file)), false);
  assert.equal(readLedger(t.library).chats['claude-chats:a']!.rejected, true);
  assert.deepEqual(reviewQueue(t.library), []);

  appendLines(file, [userLine('How do I back one up?'), assistantLine(LONG_ANSWER)]);
  const r = await runHarvest(config, { client: client(config), since: '2000-01-01' });
  assert.equal(r.chats.rejected, 1);
  assert.equal(fake.chatCalls.length, 2);
});

test('export files: a claude.ai zip is distilled and moved to _done, other files to _unknown', async () => {
  const config = cfg({ sources: { 'claude-memory': false, 'claude-chats': false, 'cursor-chats': false } });
  const exports = path.join(home, 'nudge-exports');
  const staging = path.join(t.root, 'staging');
  write(staging, 'conversations.json', JSON.stringify([
    { uuid: 'c1', name: 'Volumes', updated_at: '2020-01-01T00:00:00Z', chat_messages: [{ sender: 'human', text: 'How do I prune volumes?' }, { sender: 'assistant', text: LONG_ANSWER }] },
    { uuid: 'c2', name: 'Hello', updated_at: '2020-01-01T00:00:00Z', chat_messages: [{ sender: 'human', text: 'hi' }, { sender: 'assistant', text: 'hello' }] },
  ]));
  fs.mkdirSync(exports, { recursive: true });
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-c', '-f', path.join(exports, 'claude export.zip'), '-C', staging, 'conversations.json']);
  write(exports, 'notes.txt', 'hello');

  fake.chatReplies.push(useful());
  const r = await runHarvest(config, { client: client(config) });
  assert.equal(r.chats.drafts.length, 1, JSON.stringify(r.chats));
  assert.equal(r.chats.drafts[0]!.source, 'exports');
  assert.equal(r.chats.nothing, 1);
  assert.deepEqual(r.chats.exportsDone.map((f) => path.basename(f)), ['claude export.zip']);
  assert.ok(fs.existsSync(path.join(exports, '_done', 'claude export.zip')));
  assert.ok(fs.existsSync(path.join(exports, '_unknown', 'notes.txt')));
  assert.match(fs.readFileSync(path.join(exports, '_unknown', 'notes.txt.reason.txt'), 'utf8'), /not a \.zip or \.json file/);
  assert.equal(readManifest(t.library)[0]!.harvest?.conversation, 'exports:claude-ai:c1');
});

test('coveredBy: a draft that repeats an indexed sheet scores high, a new topic low', async () => {
  const config = cfg();
  await addFile(t.library, write(t.work, 'docker-notes.md', DOCKER_MD), { tags: ['docker'] });
  await runIndex(config);
  const db = openDb();
  try {
    const same = await coveredBy(db, client(config), 'fake-embed', 'Docker basics', DOCKER_MD);
    assert.equal(same!.id, 's_0001');
    assert.ok(same!.score > 0.88, String(same!.score));
    const other = await coveredBy(db, client(config), 'fake-embed', 'Regex', '# Regex\n\nLookahead with (?=x) and lookbehind with (?<=y).\n');
    assert.ok(other!.score < 0.88, String(other!.score));
  } finally {
    db.close();
  }
});
