import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import {
  DEFAULT_RULES,
  MAX_FILES,
  detectTags,
  parsePyproject,
  parseRequirements,
  readRules,
  readTagVocab,
  rulesPath,
  scanFiles,
  seedRuleFiles,
  tagResolver,
  type Rule,
} from '../src/rules.ts';
import { RefsError } from '../src/util.ts';
import { setupEnv, write, type TestEnv } from './helpers.ts';

let t: TestEnv;
let proj: string;
beforeEach(() => {
  t = setupEnv();
  proj = path.join(t.work, 'my app');
  fs.mkdirSync(proj, { recursive: true });
});

const tags = (rules: Rule[] = DEFAULT_RULES) => detectTags(proj, rules).tags;

test('files globs, packageDeps and rule order', () => {
  write(proj, 'package.json', JSON.stringify({ devDependencies: { '@playwright/test': '^1.50.0' } }));
  write(proj, 'Dockerfile', 'FROM node:24\n');
  write(proj, 'scripts/tool.AHK', 'MsgBox hi');
  assert.deepEqual(tags(), ['node', 'docker', 'playwright', 'autohotkey']);
});

test('a glob with a slash matches the path from the project root', () => {
  write(proj, 'src-tauri/tauri.conf.json', '{}');
  write(proj, 'other/thing.txt', '');
  assert.deepEqual(tags([{ tag: 'tauri', files: ['src-tauri/*.json'] }]), ['tauri']);
  assert.deepEqual(tags([{ tag: 'x', files: ['*/thing.txt'] }]), ['x']);
  assert.deepEqual(tags([{ tag: 'y', files: ['thing/*.txt'] }]), []);
});

test('contentRegex is checked against the matched files only', () => {
  write(proj, 'workflow.json', '{"3": {"class_type": "KSampler"}}');
  assert.deepEqual(tags([{ tag: 'comfyui', files: ['*.json'], contentRegex: '"class_type"' }]), ['comfyui']);
  fs.rmSync(path.join(proj, 'workflow.json'));
  write(proj, 'notes.txt', '"class_type"');
  assert.deepEqual(tags([{ tag: 'comfyui', files: ['*.json'], contentRegex: '"class_type"' }]), []);
});

test('contentRegex only sees the first 64 KB', () => {
  write(proj, 'big.json', `{"pad": "${'x'.repeat(70 * 1024)}", "class_type": 1}`);
  assert.deepEqual(tags([{ tag: 'comfyui', files: ['*.json'], contentRegex: '"class_type"' }]), []);
});

test('pyDeps from requirements.txt and pyproject.toml, with PEP 503 names', () => {
  assert.deepEqual(parseRequirements('# comment\nTorch>=2.1  # gpu\n-r other.txt\nollama==0.3\nscikit_learn[all]\n'), ['torch', 'ollama', 'scikit-learn']);
  const pyproject = `[project]
name = "x"
dependencies = [
  "requests>=2",
  'Pillow',
]

[project.optional-dependencies]
gpu = ["torch; sys_platform == 'win32'"]

[tool.poetry.dependencies]
python = "^3.11"
Ollama = "^0.3"
`;
  assert.deepEqual(parsePyproject(pyproject), ['requests', 'pillow', 'torch', 'ollama']);

  write(proj, 'requirements.txt', 'torch\n');
  assert.deepEqual(tags(), ['python', 'pytorch']);
  fs.rmSync(path.join(proj, 'requirements.txt'));
  write(proj, 'pyproject.toml', pyproject);
  assert.deepEqual(tags(), ['python', 'pytorch', 'ollama']);
});

test('all keys of a rule must match; separate rules with one tag are OR-ed', () => {
  write(proj, 'package.json', JSON.stringify({ dependencies: { ollama: '1' } }));
  assert.deepEqual(tags([{ tag: 'both', files: ['Dockerfile'], packageDeps: ['ollama'] }]), []);
  assert.deepEqual(tags([{ tag: 'o', pyDeps: ['ollama'] }, { tag: 'o', packageDeps: ['ollama'] }]), ['o']);
});

test('scans skip node_modules, .git, venv, .venv, dist, build and models', () => {
  for (const dir of ['node_modules', '.git', 'venv', '.venv', 'dist', 'Build', 'models']) write(proj, `${dir}/Dockerfile`, '');
  assert.deepEqual(scanFiles(proj).files, []);
  assert.deepEqual(tags(), []);
});

test('scans stop at depth 3 and skip nested Git repos', () => {
  write(proj, 'a/b/c/Dockerfile', '');
  assert.deepEqual(tags(), ['docker']);
  fs.rmSync(path.join(proj, 'a'), { recursive: true });
  write(proj, 'a/b/c/d/Dockerfile', '');
  assert.deepEqual(tags(), []);
  write(proj, 'nested/package.json', '{}');
  fs.mkdirSync(path.join(proj, 'nested', '.git'));
  assert.deepEqual(tags(), [], 'a nested repo is its own project');
});

test('scans stop at 5,000 files and say so', () => {
  const dir = path.join(proj, 'many');
  fs.mkdirSync(dir);
  for (let i = 0; i < MAX_FILES + 10; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), '');
  const scan = scanFiles(proj);
  assert.equal(scan.files.length, MAX_FILES);
  assert.equal(scan.truncated, true);
  assert.equal(detectTags(proj, DEFAULT_RULES).truncated, true);
});

test('seeds rules.json and tags.json once and reads them back', () => {
  fs.mkdirSync(t.library, { recursive: true });
  assert.deepEqual(seedRuleFiles(t.library), ['rules.json', 'tags.json']);
  assert.deepEqual(seedRuleFiles(t.library), []);
  assert.deepEqual(readRules(t.library), DEFAULT_RULES);
  const canonical = tagResolver(readTagVocab(t.library));
  assert.equal(canonical('NodeJS'), 'node');
  assert.equal(canonical('Docker Compose'), 'docker-compose');
});

test('invalid rules.json is reported with the reason', () => {
  fs.mkdirSync(t.library, { recursive: true });
  const bad = (rules: unknown, reason: RegExp) => {
    fs.writeFileSync(rulesPath(t.library), JSON.stringify(rules));
    assert.throws(() => readRules(t.library), (e: unknown) => e instanceof RefsError && reason.test(e.message));
  };
  bad([{ tag: 'x' }], /needs at least one of files, packageDeps, pyDeps/);
  bad([{ tag: 'x', file: ['a'] }], /Unrecognized key/i);
  bad([{ tag: 'x', files: ['*.json'], contentRegex: '(' }], /not a valid regular expression/);
  bad([{ tag: 'x', packageDeps: ['a'], contentRegex: 'a' }], /contentRegex needs files/);
  fs.writeFileSync(rulesPath(t.library), '[{');
  assert.throws(() => readRules(t.library), /rules.json is not valid JSON/);
});
