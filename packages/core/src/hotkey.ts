// The popup's global hotkey (config.json "hotkey"). The popup registers it through Tauri's
// global shortcut plugin, which parses with the global-hotkey crate (0.8). This mirrors that
// parser, so refs doctor and the sidecar can say what is wrong before the popup tries it,
// and turns the string into one canonical spelling that the crate also accepts.

const MODIFIERS: Record<string, 'Ctrl' | 'Alt' | 'Shift' | 'Super'> = {
  CTRL: 'Ctrl',
  CONTROL: 'Ctrl',
  COMMANDORCONTROL: 'Ctrl',
  COMMANDORCTRL: 'Ctrl',
  CMDORCTRL: 'Ctrl',
  CMDORCONTROL: 'Ctrl',
  ALT: 'Alt',
  OPTION: 'Alt',
  SHIFT: 'Shift',
  SUPER: 'Super',
  COMMAND: 'Super',
  CMD: 'Super',
};
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'] as const;

/** Canonical key name, then the other spellings global-hotkey accepts (compared in upper case). */
const KEYS: string[][] = [
  ['`', 'BACKQUOTE'],
  ['\\', 'BACKSLASH'],
  ['[', 'BRACKETLEFT'],
  [']', 'BRACKETRIGHT'],
  [',', 'COMMA'],
  ['=', 'EQUAL'],
  ['-', 'MINUS'],
  ['.', 'PERIOD'],
  ["'", 'QUOTE'],
  [';', 'SEMICOLON'],
  ['/', 'SLASH'],
  ['Pause', 'PAUSEBREAK'],
  ['Backspace'],
  ['CapsLock'],
  ['Enter'],
  ['Space'],
  ['Tab'],
  ['Delete'],
  ['End'],
  ['Home'],
  ['Insert'],
  ['PageDown'],
  ['PageUp'],
  ['PrintScreen'],
  ['ScrollLock'],
  ['Down', 'ARROWDOWN'],
  ['Left', 'ARROWLEFT'],
  ['Right', 'ARROWRIGHT'],
  ['Up', 'ARROWUP'],
  ['NumLock'],
  ['NumpadAdd', 'NUMADD', 'NUMPADPLUS', 'NUMPLUS'],
  ['NumpadDecimal', 'NUMDECIMAL'],
  ['NumpadDivide', 'NUMDIVIDE'],
  ['NumpadEnter', 'NUMENTER'],
  ['NumpadEqual', 'NUMEQUAL'],
  ['NumpadMultiply', 'NUMMULTIPLY'],
  ['NumpadSubtract', 'NUMSUBTRACT'],
  ['Escape', 'ESC'],
  ['VolumeDown', 'AUDIOVOLUMEDOWN'],
  ['VolumeUp', 'AUDIOVOLUMEUP'],
  ['VolumeMute', 'AUDIOVOLUMEMUTE'],
  ['MediaPlay'],
  ['MediaPause'],
  ['MediaPlayPause'],
  ['MediaStop'],
  ['MediaTrackNext'],
  ['MediaTrackPrevious', 'MEDIATRACKPREV'],
  ...Array.from({ length: 10 }, (_, d) => [String(d), `DIGIT${d}`]),
  ...Array.from({ length: 10 }, (_, d) => [`Numpad${d}`, `NUM${d}`]),
  ...Array.from({ length: 26 }, (_, i) => {
    const c = String.fromCharCode(65 + i);
    return [c, `KEY${c}`];
  }),
  ...Array.from({ length: 24 }, (_, i) => [`F${i + 1}`]),
];
const KEY_BY_NAME = new Map(KEYS.flatMap((names) => names.map((n) => [n.toUpperCase(), names[0]!] as const)));

export type HotkeyParse =
  | { ok: true; canonical: string; modifiers: string[]; key: string }
  | { ok: false; error: string };

export const DEFAULT_HOTKEY = 'Ctrl+Alt+Space';

/**
 * Parse "Ctrl+Alt+Space" style hotkeys: modifiers first, exactly one key last, case
 * insensitive. Stricter than the crate in one way: a modifier is required, since a bare
 * global key would be taken away from every other app.
 */
export function parseHotkey(input: string): HotkeyParse {
  const text = input.trim();
  if (!text) return { ok: false, error: 'the hotkey is empty' };
  const tokens = text.split('+').map((t) => t.trim());
  if (tokens.some((t) => !t)) return { ok: false, error: `"${input}" has an empty part (two "+" in a row, or one at the end)` };
  const mods = new Set<string>();
  let key: string | null = null;
  for (const token of tokens) {
    if (key) return { ok: false, error: `"${input}" has something after its key "${key}"; put modifiers first and one key last` };
    const upper = token.toUpperCase();
    const mod = tokens.length > 1 ? MODIFIERS[upper] : undefined;
    if (mod) mods.add(mod);
    else {
      const k = KEY_BY_NAME.get(upper);
      if (!k) return { ok: false, error: `"${token}" is not a key the popup can use (for example Space, K, F9, Up)` };
      key = k;
    }
  }
  if (!key) return { ok: false, error: `"${input}" has modifiers but no key` };
  if (!mods.size) return { ok: false, error: `"${input}" needs Ctrl, Alt, Shift or Super, or every app would lose that key` };
  const modifiers = MODIFIER_ORDER.filter((m) => mods.has(m));
  return { ok: true, canonical: [...modifiers, key].join('+'), modifiers, key };
}
