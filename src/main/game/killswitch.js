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

function preset(key) {
  if (key === 'off') return null;
  return PRESETS[key] || PRESETS[DEFAULT_KEY];
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

module.exports = { KillSwitch, PRESETS, DEFAULT_KEY };
