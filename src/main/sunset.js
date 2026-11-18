'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const log = require('electron-log/main');

/**
 * Режим закрытия проекта.
 *
 * Версия 1.0.16 — финальная. При запуске лаунчер показывает экран «проект закрыт»,
 * играть через него уже нельзя, и он удаляет сам себя: запускает штатный
 * деинсталлятор (тот, что ставил лаунчер) и вместе с ним свою папку настроек.
 *
 * Деинсталлятор удаляет ТОЛЬКО файлы самого лаунчера и его настройки.
 * Папку с игрой, документы и любые другие данные пользователя он не трогает.
 */

const SUNSET = true;

function isSunset() {
  return SUNSET;
}

/** Путь к штатному деинсталлятору рядом с исполняемым файлом лаунчера. */
function uninstallerPath() {
  try {
    const p = path.join(path.dirname(process.execPath), 'Uninstall Meridian Online.exe');
    if (fs.existsSync(p)) return p;
  } catch {}
  return null;
}

/** Запасной путь: команда удаления из реестра (если файл деинсталлятора не нашли). */
function registryUninstallString() {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, out) => {
        if (err || !out) return resolve(null);
        for (const block of String(out).split(/\r?\n\r?\n/)) {
          if (!/Meridian Online/i.test(block)) continue;
          const m = /QuietUninstallString\s+REG_SZ\s+(.+)/i.exec(block)
            || /UninstallString\s+REG_SZ\s+(.+)/i.exec(block);
          if (m) return resolve(m[1].trim());
        }
        resolve(null);
      },
    );
  });
}

/**
 * Удаляет лаунчер. Только в установленной версии под Windows.
 * Деинсталлятор запускается отдельным процессом, чтобы пережить закрытие лаунчера.
 */
async function selfRemove() {
  if (process.platform !== 'win32' || !app.isPackaged) {
    log.info('[sunset] самоудаление работает только в установленной Windows-версии — пропускаю');
    return { ok: false, skipped: true };
  }
  const { spawn } = require('child_process');
  try {
    const exe = uninstallerPath();
    if (exe) {
      log.info('[sunset] запускаю штатный деинсталлятор:', exe);
      // /S — без вопросов; деинсталлятор сам закроет лаунчер и удалит его файлы и настройки
      spawn(exe, ['/S'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return { ok: true };
    }
    const cmd = await registryUninstallString();
    if (cmd) {
      log.info('[sunset] деинсталлятор из реестра:', cmd);
      spawn('cmd', ['/c', cmd, '/S'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return { ok: true };
    }
    log.warn('[sunset] деинсталлятор не найден — удалить лаунчер автоматически не удалось');
    return { ok: false, notFound: true };
  } catch (err) {
    log.warn('[sunset] ошибка самоудаления:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { isSunset, selfRemove, uninstallerPath };
