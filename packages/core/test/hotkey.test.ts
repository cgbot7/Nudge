import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_HOTKEY, parseHotkey } from '../src/hotkey.ts';

const canonical = (s: string) => {
  const r = parseHotkey(s);
  assert.ok(r.ok, `${s}: ${!r.ok ? r.error : ''}`);
  return r.canonical;
};
const error = (s: string) => {
  const r = parseHotkey(s);
  assert.ok(!r.ok, `${s} should be refused`);
  return r.error;
};

test('hotkeys parse to one canonical spelling the global-hotkey crate also accepts', () => {
  assert.equal(canonical(DEFAULT_HOTKEY), 'Ctrl+Alt+Space');
  assert.equal(canonical(' control + option + space '), 'Ctrl+Alt+Space');
  assert.equal(canonical('Alt+Ctrl+Space'), 'Ctrl+Alt+Space', 'modifiers in a fixed order');
  assert.equal(canonical('CmdOrCtrl+Shift+KeyK'), 'Ctrl+Shift+K');
  assert.equal(canonical('super+digit1'), 'Super+1');
  assert.equal(canonical('Shift+F13'), 'Shift+F13');
  assert.equal(canonical('Ctrl+ArrowUp'), 'Ctrl+Up');
  assert.equal(canonical('Ctrl+Alt+`'), 'Ctrl+Alt+`');
  assert.equal(canonical('Ctrl+Num5'), 'Ctrl+Numpad5');
  assert.equal(canonical('Ctrl+Ctrl+P'), 'Ctrl+P', 'a repeated modifier counts once');
});

test('bad hotkeys say what is wrong', () => {
  assert.match(error(''), /empty/);
  assert.match(error('Ctrl++Space'), /empty part/);
  assert.match(error('Ctrl+Alt+'), /empty part/);
  assert.match(error('Ctrl+Alt'), /no key/);
  assert.match(error('Ctrl+Space+Alt'), /after its key "Space"/);
  assert.match(error('Ctrl+K+L'), /after its key "K"/);
  assert.match(error('Ctrl+Hyper+K'), /"Hyper" is not a key/);
  assert.match(error('Ctrl+F25'), /"F25" is not a key/);
  assert.match(error('Space'), /needs Ctrl, Alt, Shift or Super/);
  assert.match(error('Alt'), /"Alt" is not a key/, 'like the crate, a single token is read as a key');
});
