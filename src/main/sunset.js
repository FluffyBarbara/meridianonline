'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app } = require('electron');
const log = require('electron-log/main');

/**
 * Режим закрытия проекта.
 *
 * Версия 1.0.17 — финальная. При запуске лаунчер показывает экран «проект закрыт»,
 * играть через него уже нельзя. Он спрашивает, удалить ли папку с игрой, и в любом
 * случае удаляет сам себя: запускает штатный деинсталлятор (тот, что ставил лаунчер)
 * и вместе с ним свою папку настроек.
 *
 * Папку с игрой лаунчер удаляет ТОЛЬКО по явному выбору пользователя и ТОЛЬКО если
 * убедился, что это установка Meridian (в папке лежит наш файл-маркер meridian.json).
 * Чужие и системные папки он не трогает.
 */

const SUNSET = true;
const MARKER = 'meridian.json';

function isSunset() {
  return SUNSET;
}

// ───────────────────────── Папка с игрой ─────────────────────────

/** Можно ли безопасно удалять эту папку как установку игры. */
function canDeleteGame(dir) {
  try {
    if (!dir || typeof dir !== 'string') return false;
    const full = path.resolve(dir);
    // Не корень диска и не слишком короткий путь (C:\, \, /)
    if (full === path.parse(full).root) return false;
    if (full.replace(/[\\/]+$/, '').length < 4) return false;
    // Не домашняя папка и не типовые системные/пользовательские папки
    const home = app.getPath('home');
    const forbidden = [home];
    for (const k of ['appData', 'desktop', 'documents', 'downloads', 'music', 'pictures', 'videos']) {
      try { forbidden.push(app.getPath(k)); } catch {}
    }
    for (const envk of ['WINDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'SystemRoot', 'ProgramData']) {
      if (process.env[envk]) forbidden.push(process.env[envk]);
    }
    const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
    if (forbidden.some((f) => f && norm(f) === norm(full))) return false;
    // Должна существовать, быть папкой и содержать наш маркер
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return false;
    if (!fs.existsSync(path.join(full, MARKER))) return false;
    return true;
  } catch {
    return false;
  }
}

/** Суммарный размер папки (без перехода по символьным ссылкам). */
async function dirSize(dir) {
  let total = 0;
  async function walk(d) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) await walk(p);
        else { const st = await fsp.lstat(p); total += st.size; }
      } catch {}
    }
  }
  await walk(dir);
  return total;
}

/** Сведения для экрана закрытия: есть ли установка игры, путь и размер. */
async function gameInfo(gameDir) {
  if (!canDeleteGame(gameDir)) return { hasGame: false };
  const full = path.resolve(gameDir);
  let size = 0;
  try { size = await dirSize(full); } catch {}
  return { hasGame: true, gameDir: full, size };
}

/** Удаляет папку с игрой. Только после проверки, что это установка Meridian. */
async function removeGame(gameDir) {
  if (!canDeleteGame(gameDir)) {
    log.warn('[sunset] папка игры не прошла проверку — не удаляю:', gameDir);
    return { ok: false, unsafe: true };
  }
  const full = path.resolve(gameDir);
  try {
    log.info('[sunset] удаляю папку игры по выбору пользователя:', full);
    await fsp.rm(full, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    log.warn('[sunset] не удалось удалить папку игры:', err.message);
    return { ok: false, error: err.message };
  }
}

// ───────────────────────── Удаление лаунчера ─────────────────────────

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

module.exports = { isSunset, gameInfo, removeGame, selfRemove, canDeleteGame, uninstallerPath };
