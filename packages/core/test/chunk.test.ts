import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkExtracted, chunkMarkdown, firstH1 } from '../src/chunk.ts';
import { DOCKER_MD } from './helpers.ts';

test('splits by heading, merging a heading with almost no body into the next', () => {
  const sections = chunkMarkdown(DOCKER_MD);
  assert.deepEqual(
    sections.map((s) => [s.idx, s.heading]),
    [
      [1, 'Docker basics'],
      [2, 'Containers'],
      [3, 'Images'],
      [4, 'Volumes'],
    ],
  );
  // The line under "# Docker basics" has 8 words, enough to stand alone.
  assert.match(sections[1]!.text, /^## Containers/);
});

test('short sections merge forward and keep their text', () => {
  const sections = chunkMarkdown('# Title\n\n## Git\n\nShort.\n\n## Rebase\n\nUse git rebase -i to squash, reorder and edit commits before pushing them.\n');
  assert.equal(sections.length, 1);
  assert.equal(sections[0]!.heading, 'Rebase');
  assert.match(sections[0]!.text, /# Title[\s\S]*## Git[\s\S]*Short\.[\s\S]*## Rebase/);
});

test('text before the first heading becomes Intro', () => {
  const sections = chunkMarkdown('Some notes up front that matter.\n\n# Heading\n\nBody text that is long enough to stand alone as a section.\n');
  assert.deepEqual(sections.map((s) => s.heading), ['Intro', 'Heading']);
});

test('ignores # lines inside fenced code blocks', () => {
  const md = '# Shell\n\nThese commands are worth keeping around for later use.\n\n```bash\n# not a heading\nls -la\n```\n';
  const sections = chunkMarkdown(md);
  assert.equal(sections.length, 1);
  assert.match(sections[0]!.text, /# not a heading/);
  assert.equal(firstH1('```\n# comment\n```\n# Real title\n'), 'Real title');
});

test('PDF text splits by page and plain text is one section', () => {
  assert.deepEqual(
    chunkExtracted('pdf', 'first page\fsecond page\f').map((s) => [s.idx, s.heading]),
    [
      [1, 'Page 1'],
      [2, 'Page 2'],
    ],
  );
  assert.deepEqual(chunkExtracted('txt', 'hello\n# not split\n').map((s) => s.heading), ['Intro']);
  assert.deepEqual(chunkExtracted('txt', '  \n'), []);
});
