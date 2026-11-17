'use strict';

const { globalShortcut } = require('electron');
const { execFile, spawn } = require('child_process');
const log = require('electron-log/main');

/**
 * «Аварийная кнопка»: сочетание клавиш, которое мгновенно завершает зависшую игру,
 * без диспетчера задач.
 *
 * Сочетание регистрируется в Windows (RegisterHotKey через globalShortcut) только пока
 * игра запущена, поэтому срабатывает даже поверх зависшей полноэкранной игры и не
 * отнимает сочетание у других программ в остальное время.
 */

const PRESETS = {
  'ctrl-alt-end': { accel: 'Control+Alt+End', label: 'Ctrl + Alt + End' },
  'ctrl-shift-f12': { accel: 'Control+Shift+F12', label: 'Ctrl + Shift + F12' },
};
const DEFAULT_KEY = 'ctrl-alt-end';

// Процессы клиента: сама игра и загрузчик SA-MP/CR-MP (если ещё висит)
const PROCESSES = ['gta_sa.exe', 'samp.exe'];

// Сочетания, которые Windows не отдаёт программам или которые ломают систему
const RESERVED = new Set(['Control+Alt+Delete', 'Control+Shift+Escape', 'Alt+Tab', 'Alt+Escape', 'Control+Escape', 'Super+L']);
const MODS = ['Control', 'Alt', 'Shift', 'Super'];

const KEY_NAMES = {
  Control: 'Ctrl', Super: 'Win', Return: 'Enter', Escape: 'Esc', Backspace: 'Backspace',
  PageUp: 'Page Up', PageDown: 'Page Down', Up: '↑', Down: '↓', Left: '←', Right: '→',
  numadd: 'Num +', numsub: 'Num −', nummult: 'Num *', numdiv: 'Num /', numdec: 'Num .',
  Plus: '+', Space: 'Пробел', Delete: 'Delete', Insert: 'Insert',
};

/** «Control+Alt+End» → «Ctrl + Alt + End» */
function formatLabel(accel) {
  return String(accel).split('+').map((k) => {
    if (KEY_NAMES[k]) return KEY_NAMES[k];
    const num = /^num(\d)$/.exec(k);
    return num ? `Num ${num[1]}` : k;
  }).join(' + ');
}

/** Приводит сочетание к виду «Модификаторы (в постоянном порядке) + клавиша». */
function normalize(accel) {
  const parts = String(accel || '').split('+').map((p) => p.trim()).filter(Boolean);
  const mods = MODS.filter((m) => parts.includes(m));
  const keys = parts.filter((p) => !MODS.includes(p));
  if (keys.length !== 1) return null;
  return [...mods, keys[0]].join('+');
}

/** Проверка своего сочетания до сохранения: формат, запреты и не занято ли оно другой программой. */
function validate(accel, current) {
  const a = normalize(accel);
  if (!a) return { ok: false, error: 'Нужна одна клавиша вместе с Ctrl, Alt или Win' };
  const label = formatLabel(a);
  if (!/(^|\+)(Control|Alt|Super)\+/.test(a)) {
    return { ok: false, label, error: 'Добавьте Ctrl, Alt или Win — одиночная клавиша мешала бы в игре и чате' };
  }
  if (RESERVED.has(a)) return { ok: false, label, error: `${label} — системное сочетание Windows, его нельзя занять` };
  if (current && current.accel === a) return { ok: true, accel: a, label };
  let ok = false;
  try {
    ok = globalShortcut.register(a, () => {});
    if (ok) globalShortcut.unregister(a);
  } catch {
    return { ok: false, label, error: 'Эту клавишу нельзя назначить' };
  }
  if (!ok) return { ok: false, label, error: `${label} уже занято другой программой` };
  return { ok: true, accel: a, label };
}

function preset(key) {
  if (key === 'off') return null;
  if (PRESETS[key]) return PRESETS[key];
  const a = normalize(key);
  if (a && key !== DEFAULT_KEY) return { accel: a, label: formatLabel(a) };
  return PRESETS[DEFAULT_KEY];
}

function taskkill(images) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve();
    const args = ['/F', '/T'];
    for (const im of images) args.push('/IM', im);
    // Код возврата не смотрим: 128 = один из процессов не найден, это нормально
    execFile('taskkill', args, { windowsHide: true }, () => resolve());
  });
}

/** Если игра запущена «от имени администратора», обычный taskkill не сможет её закрыть. */
function taskkillElevated(images) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    const list = ['/F', '/T', ...images.flatMap((im) => ['/IM', im])].map((a) => `'${a}'`).join(',');
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      `try { Start-Process -FilePath taskkill.exe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList ${list}; exit 0 } catch { exit 1 }`,
    ], { windowsHide: true });
    ps.on('error', () => resolve(false));
    ps.on('exit', (code) => resolve(code === 0));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class KillSwitch {
  /**
   * @param {object} o
   * @param {() => Promise<boolean>} o.isRunning — запущена ли игра
   * @param {(result: {ok: boolean, label: string, error?: string}) => void} o.onResult
   */
  constructor({ isRunning, onResult }) {
    this.isRunning = isRunning;
    this.onResult = onResult;
    this.current = null; // активный пресет
    this.busy = false;
    this.lastAt = 0;
  }

  /** Включает сочетание (вызывается при запуске игры и при смене настройки во время игры). */
  arm(key) {
    this.disarm();
    const p = preset(key);
    if (!p) return { ok: true, off: true };
    let ok = false;
    try {
      ok = globalShortcut.register(p.accel, () => { this.trigger('hotkey'); });
    } catch (err) {
      log.warn('[killswitch] не удалось зарегистрировать', p.accel, err.message);
    }
    if (ok) {
      this.current = p;
      log.info(`[killswitch] ${p.label} — закрыть зависшую игру`);
    } else {
      log.warn(`[killswitch] сочетание ${p.label} занято другой программой`);
    }
    return { ok, label: p.label };
  }

  disarm() {
    if (!this.current) return;
    try { globalShortcut.unregister(this.current.accel); } catch {}
    this.current = null;
  }

  get label() {
    return this.current?.label || null;
  }

  /** Проверка своего сочетания (см. validate). */
  validate(accel) {
    return validate(accel, this.current);
  }

  /** Принудительно завершает игру. Повторные нажатия в течение 3 секунд игнорируются. */
  async trigger(source = 'hotkey') {
    const now = Date.now();
    if (this.busy || now - this.lastAt < 3000) return;
    this.busy = true;
    this.lastAt = now;
    const label = this.current?.label || '';
    log.warn(`[killswitch] игра закрыта принудительно (${source === 'hotkey' ? label : 'из лаунчера'})`);
    try {
      await taskkill(PROCESSES);
      await sleep(1200);
      if (await this.isRunning()) {
        log.warn('[killswitch] процесс не завершился — пробуем с правами администратора');
        await taskkillElevated(PROCESSES);
        await sleep(1200);
      }
      const ok = !(await this.isRunning());
      if (!ok) log.warn('[killswitch] не удалось завершить игру');
      this.onResult({
        ok, label, source,
        error: ok ? undefined : 'Не удалось закрыть игру. Возможно, она запущена от имени администратора — закройте её через диспетчер задач.',
      });
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { KillSwitch, PRESETS, DEFAULT_KEY, formatLabel, normalize, preset };
