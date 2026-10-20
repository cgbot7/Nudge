import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { discoverProjects, resolveProjectRoot, rootFor } from '../src/detect.ts';
import { normPath } from '../src/paths.ts';
import { DEFAULT_RULES } from '../src/rules.ts';
import { setupEnv, write } from './helpers.ts';

let root: string;
let roots: string[];
beforeEach(() => {
  const t = setupEnv();
  root = path.join(t.root, 'Projects & Stuff');
  fs.mkdirSync(root, { recursive: true });
  roots = [root];
});

const resolve = (dir: string) => resolveProjectRoot(path.join(root, dir), roots, DEFAULT_RULES);
const at = (dir: string) => normPath(path.join(root, dir));

test('nearest ancestor with a signature file is the project root', () => {
  write(root, 'app/package.json', '{}');
  fs.mkdirSync(path.join(root, 'app', 'src', 'deep'), { recursive: true });
  assert.equal(resolve('app/src/deep'), at('app'));
  assert.equal(resolve('app'), at('app'));
});

test('.git marks a project root', () => {
  fs.mkdirSync(path.join(root, 'tool', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tool', 'lib'), { recursive: true });
  assert.equal(resolve('tool/lib'), at('tool'));
});

test('without markers the first-level folder under the root is the project', () => {
  fs.mkdirSync(path.join(root, 'notes', 'a', 'b'), { recursive: true });
  assert.equal(resolve('notes/a/b'), at('notes'));
});

test('a nested repo inside a project is its own project', () => {
  write(root, 'mono/package.json', '{}');
  fs.mkdirSync(path.join(root, 'mono', 'vendor', 'lib', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'mono', 'vendor', 'lib', 'src'), { recursive: true });
  assert.equal(resolve('mono/vendor/lib/src'), at('mono/vendor/lib'));
  assert.equal(resolve('mono/vendor'), at('mono'));
});

test('wildcard patterns do not make every folder a project root', () => {
  write(root, 'app/package.json', '{}');
  write(root, 'app/config/settings.json', '{}');
  assert.equal(resolve('app/config'), at('app'));
});

test('outside a root, or the root itself, there is no project', () => {
  assert.equal(resolveProjectRoot(path.dirname(root), roots, DEFAULT_RULES), null);
  assert.equal(resolveProjectRoot(root, roots, DEFAULT_RULES), null);
  assert.equal(rootFor(path.join(root.toUpperCase(), 'X'), roots), normPath(root), 'paths compare case-insensitively');
});

test('discovery finds first-level folders and nested project roots', () => {
  write(root, 'app/package.json', '{}');
  fs.mkdirSync(path.join(root, 'app', 'node_modules', 'dep', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'clients', 'acme', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
  const found = discoverProjects(roots, DEFAULT_RULES).sort();
  assert.deepEqual(found, [at('app'), at('clients'), at('clients/acme')].sort());
});
