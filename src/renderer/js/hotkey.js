// Запись своего сочетания клавиш («Закрыть зависшую игру») в формат Electron Accelerator.
// Клавишу берём по физическому коду (e.code), чтобы сочетание не зависело от раскладки (RU/EN).

export const PRESETS = {
  'ctrl-alt-end': 'Control+Alt+End',
  'ctrl-shift-f12': 'Control+Shift+F12',
};
export const DEFAULT_HOTKEY = 'ctrl-alt-end';

const CODE_MAP = {
  Space: 'Space', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec', NumpadEnter: 'Return', PrintScreen: 'PrintScreen',
};
const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

const KEY_NAMES = {
  Control: 'Ctrl', Super: 'Win', Return: 'Enter', Escape: 'Esc',
  PageUp: 'Page Up', PageDown: 'Page Down', Up: '↑', Down: '↓', Left: '←', Right: '→',
  numadd: 'Num +', numsub: 'Num −', nummult: 'Num *', numdiv: 'Num /', numdec: 'Num .',
  Plus: '+', Space: 'Пробел',
};

/** Значение настройки → сочетание Electron. */
export function toAccel(value) {
  if (!value || value === 'off') return PRESETS[DEFAULT_HOTKEY];
  return PRESETS[value] || value;
}

/** «Control+Alt+End» → «Ctrl + Alt + End» */
export function formatAccel(accel) {
  return String(accel).split('+').map((k) => {
    if (KEY_NAMES[k]) return KEY_NAMES[k];
    const num = /^num(\d)$/.exec(k);
    return num ? `Num ${num[1]}` : k;
  }).join(' + ');
}

function keyFromCode(code) {
  if (CODE_MAP[code]) return CODE_MAP[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(\d)$/.exec(code);
  if (m) return `num${m[1]}`;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return null;
}

/**
 * Разбирает нажатие во время записи.
 * @returns {{ mods: string[], key: string|null, accel: string|null, unsupported: boolean }}
 */
export function readKeyEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (MODIFIER_CODES.test(e.code) || e.key === 'AltGraph') return { mods, key: null, accel: null, unsupported: false };
  const key = keyFromCode(e.code);
  if (!key) return { mods, key: null, accel: null, unsupported: true };
  return { mods, key, accel: [...mods, key].join('+'), unsupported: false };
}
