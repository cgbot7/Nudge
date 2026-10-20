import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockingFindings, scanSecrets } from '../src/secrets.ts';
import { FAKE_GITHUB_TOKEN } from './helpers.ts';

const rules = (text: string) => scanSecrets(text).map((f) => f.rule);

test('detects provider keys, private keys, connection strings and assignments', () => {
  const awsId = 'AKIA' + 'Q7RZ3MXK2VBN9PLD';
  const text = [
    `token: ${FAKE_GITHUB_TOKEN}`,
    `aws id ${awsId}`,
    `ANTHROPIC=sk-ant-api03-${'Zq8LmP2vX9rT4kWbHs7d'}`,
    `stripe sk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}`,
    `slack xoxb-${'1234-Ab9xQ7rT2mPz'}`,
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
    '-----END OPENSSH PRIVATE KEY-----',
    'DATABASE_URL=postgres://app:Hk82!xQz9w@db.internal:5432/app',
    'api_key = "Zq8LmP2vX9rT4kWb"',
  ].join('\n');
  assert.deepEqual(rules(text), [
    'github-token',
    'aws-access-key',
    'anthropic-key',
    'stripe-key',
    'slack-token',
    'private-key',
    'connection-string-password',
    'secret-assignment',
  ]);
});

test('reports 1-based line numbers and masks the value', () => {
  const [f] = scanSecrets(`line one\nline two\nexport GH=${FAKE_GITHUB_TOKEN}\n`);
  assert.equal(f?.line, 3);
  assert.equal(f?.rule, 'github-token');
  assert.ok(f?.masked.startsWith('ghp_****'));
  assert.ok(!f?.masked.includes(FAKE_GITHUB_TOKEN.slice(8)));
});

test('ignores placeholders and tutorial defaults', () => {
  const text = [
    'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'OPENAI_API_KEY=sk-your-key-here-0000000000',
    'OPENAI_API_KEY=<API_KEY>',
    'export GITHUB_TOKEN=$GITHUB_TOKEN_FROM_VAULT',
    'set API_TOKEN=%API_TOKEN_VALUE%',
    'postgres://postgres:postgres@localhost:5432/db',
    'pip install sk-learn-tutorial-for-beginners',
    'AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN RSA PRIVATE KEY-----',
    '...',
    'password: required-for-login',
    'apiKey: process.env.OPENAI_API_KEY',
  ].join('\n');
  assert.deepEqual(scanSecrets(text), []);
});

test('overlapping matches are reported once, by the most specific rule', () => {
  assert.deepEqual(rules(`GITHUB_TOKEN=${FAKE_GITHUB_TOKEN}`), ['github-token']);
});

test('allowlist fingerprints survive moved lines but not a changed secret', () => {
  const [f] = scanSecrets(`x\nkey: ${FAKE_GITHUB_TOKEN}`);
  assert.ok(f);
  const allow = [{ rule: f.rule, fingerprint: f.fingerprint }];
  assert.equal(blockingFindings(scanSecrets(`\n\n\nkey: ${FAKE_GITHUB_TOKEN}`, allow)).length, 0);
  const other = FAKE_GITHUB_TOKEN.slice(0, -1) + 'Z';
  assert.equal(blockingFindings(scanSecrets(`key: ${other}`, allow)).length, 1);
});
