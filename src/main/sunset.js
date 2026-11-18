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

// ───────────────────────── Удаление: сначала лаунчер, потом игра ─────────────────────────

/** Путь к штатному деинсталлятору рядом с исполняемым файлом лаунчера. */
function uninstallerPath() {
  try {
    const p = path.join(path.dirname(process.execPath), 'Uninstall Meridian Online.exe');
    if (fs.existsSync(p)) return p;
  } catch {}
  return null;
}

/** Запасной путь: команда удаления из реестра. */
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
 * Собирает bat-помощника: удаляет лаунчер, ДОЖИДАЕТСЯ исчезновения его файлов и
 * только потом (если нужно) удаляет папку игры и стирает сам себя.
 * gameDir здесь уже проверен через canDeleteGame — в скрипт попадает только безопасный путь.
 */
function buildHelperScript({ uninstaller, launcherExe, gameDir }) {
  const L = [];
  L.push('@echo off');
  L.push('setlocal enableextensions');
  // 1) удалить лаунчер штатным деинсталлятором
  L.push(`start "" /wait ${uninstaller} /S`);
  // 2) дождаться, пока файл лаунчера исчезнет (до ~80 секунд)
  L.push('set n=0');
  L.push(':waitloop');
  L.push(`if not exist "${launcherExe}" goto removed`);
  L.push('>nul ping -n 3 127.0.0.1');
  L.push('set /a n+=1');
  L.push('if %n% lss 40 goto waitloop');
  L.push(':removed');
  // 3) только теперь — удалить папку игры
  if (gameDir) L.push(`rmdir /s /q "${gameDir}"`);
  // 4) самоуничтожение скрипта
  L.push('(goto) 2>nul & del "%~f0"');
  return L.join('\r\n') + '\r\n';
}

/**
 * Запускает удаление. Порядок гарантируется: сначала полностью уходит лаунчер,
 * затем — папка игры (если пользователь выбрал). gameDir проверяется здесь же.
 */
async function remove({ deleteGame, gameDir } = {}) {
  const safeDir = deleteGame && canDeleteGame(gameDir) ? path.resolve(gameDir) : null;
  if (deleteGame && !safeDir) log.warn('[sunset] папка игры не прошла проверку — удалять не буду:', gameDir);

  if (process.platform !== 'win32' || !app.isPackaged) {
    log.info('[sunset] удаление доступно только в установленной Windows-версии — пропускаю');
    return { ok: false, skipped: true, willDeleteGame: !!safeDir };
  }

  const { spawn } = require('child_process');
  try {
    let uninstaller = uninstallerPath();
    uninstaller = uninstaller ? `"${uninstaller}"` : await registryUninstallString();
    if (!uninstaller) {
      log.warn('[sunset] деинсталлятор не найден');
      return { ok: false, notFound: true };
    }
    const script = buildHelperScript({
      uninstaller,
      launcherExe: process.execPath,
      gameDir: safeDir,
    });
    const bat = path.join(app.getPath('temp'), `meridian-close-${Date.now()}.bat`);
    fs.writeFileSync(bat, script, 'utf8');
    log.info('[sunset] запускаю удаление' + (safeDir ? ' (лаунчер → затем папка игры)' : ' (лаунчер)') + ':', bat);
    spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { ok: true, willDeleteGame: !!safeDir };
  } catch (err) {
    log.warn('[sunset] ошибка удаления:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { isSunset, gameInfo, canDeleteGame, remove, uninstallerPath };
