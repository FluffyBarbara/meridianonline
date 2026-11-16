'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const log = require('electron-log/main');

/**
 * Обход ошибки omp-cef с не-латинскими путями к «Документам».
 *
 * Клиент CEF (omp-cef, gta.cpp → Gta::GetUserFilesPath) переводит путь к «Документам» в UTF-8,
 * а затем передаёт его в std::filesystem::path как обычную строку — на русской Windows она
 * читается в кодировке CP1251. В итоге «C:\Users\nikit\OneDrive\Документы» превращается
 * в «C:\Users\nikit\OneDrive\Р”РѕРєСѓРјРµРЅС‚С‹»: туда клиент пишет кеш ресурсов, а открывает
 * скачанный .pak по настоящему пути. Файл не находится → http://cef/... даёт ERR_FAILED.
 *
 * Решение: на месте «испорченной» папки создаём junction на настоящую — оба пути ведут в одно место.
 * Затрагивает OneDrive на русской Windows и русские имена пользователей (C:\Users\Никита).
 */

const decoder = (() => {
  try { return new TextDecoder('windows-1251'); } catch { return null; }
})();

/** Как путь увидит omp-cef: байты UTF-8, прочитанные как CP1251. */
function mangle(str) {
  return decoder ? decoder.decode(Buffer.from(str, 'utf8')) : str;
}

/**
 * @returns {null|{real:string, moji:string, links:{linkMoji:string, linkReal:string}[], linkMoji:string, unsupported?:string}}
 *   links — какие ссылки «испорченная папка → настоящая» нужны (по одной на каждую папку пути с кириллицей)
 */
function analyze(documentsDir) {
  if (process.platform !== 'win32' || !documentsDir || !/[^\x00-\x7F]/.test(documentsDir)) return null;
  // Байт 0x98 в CP1251 не определён — Windows не сможет сконвертировать такой путь вовсе
  if (Buffer.from(documentsDir, 'utf8').includes(0x98)) {
    return { real: documentsDir, moji: null, links: [], unsupported: 'В пути к «Документам» есть буква, которую плагин CEF не может обработать (например, заглавная «И»)' };
  }
  const parts = documentsDir.split(/[\\/]+/);
  const links = [];
  for (let k = 0; k < parts.length; k++) {
    if (!/[^\x00-\x7F]/.test(parts[k])) continue;
    const parent = parts.slice(0, k).join(path.sep); // через ранее созданные ссылки этот путь уже настоящий
    links.push({ linkMoji: `${parent}${path.sep}${mangle(parts[k])}`, linkReal: `${parent}${path.sep}${parts[k]}` });
  }
  return { real: documentsDir, moji: mangle(documentsDir), links, linkMoji: links[0].linkMoji };
}

function isLinkTo(link, target) {
  try {
    const st = fs.lstatSync(link);
    if (!st.isSymbolicLink()) return false;
    return path.resolve(fs.realpathSync(link)).toLowerCase() === path.resolve(fs.realpathSync(target)).toLowerCase();
  } catch {
    return false;
  }
}

/** Переносит то, что omp-cef уже записал в «испорченную» папку, и удаляет её, если там только его файлы. */
async function migrateMoji(a) {
  const mojiUser = path.join(a.moji, 'GTA San Andreas User Files');
  const realUser = path.join(a.real, 'GTA San Andreas User Files');

  // Проверяем, что в «испорченной» папке нет ничего, кроме следов omp-cef
  const walkTop = async (dir, rel = '') => {
    const out = [];
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) out.push(path.join(rel, e.name));
    return out;
  };
  const top = await walkTop(a.linkMoji);
  const chainOk = async () => {
    // linkMoji/<путь до документов>/GTA San Andreas User Files/cef — и больше ничего по пути
    let dir = a.linkMoji;
    const rest = path.relative(a.linkMoji, mojiUser).split(/[\\/]/).filter(Boolean);
    for (const seg of rest) {
      const items = await walkTop(dir);
      if (items.length !== 1 || items[0] !== seg) return false;
      dir = path.join(dir, seg);
    }
    const inUser = await walkTop(mojiUser);
    return inUser.every((n) => n === 'cef');
  };
  if (top.length && !(await chainOk())) {
    return { ok: false, reason: `В папке «${a.linkMoji}» есть посторонние файлы — не трогаем её` };
  }

  const mojiCef = path.join(mojiUser, 'cef');
  const realCef = path.join(realUser, 'cef');
  if (fs.existsSync(mojiCef)) {
    await fsp.mkdir(realCef, { recursive: true });
    for (const name of ['config.json', 'client.log']) {
      const src = path.join(mojiCef, name);
      const dst = path.join(realCef, name);
      if (fs.existsSync(src) && !fs.existsSync(dst)) await fsp.copyFile(src, dst).catch(() => {});
    }
    // кеш ресурсов не переносим: он скачается заново
  }
  await fsp.rm(a.linkMoji, { recursive: true, force: true });
  return { ok: true };
}

/**
 * Создаёт junction «испорченная папка → настоящая» (без прав администратора, если родительская папка доступна).
 * @returns {{status:'not-needed'|'ok'|'created'|'needs-admin'|'unsupported'|'error', text:string, analysis?:object}}
 */
async function ensure(documentsDir) {
  const a = analyze(documentsDir);
  if (!a) return { status: 'not-needed', text: 'Путь к «Документам» без кириллицы' };
  if (a.unsupported) return { status: 'unsupported', text: a.unsupported, analysis: a };
  if (a.links.every((l) => isLinkTo(l.linkMoji, l.linkReal))) return { status: 'ok', text: 'Ссылка для CEF уже есть', analysis: a };

  try {
    // Что omp-cef уже успел записать в «испорченную» папку — переносим и удаляем её
    const first = a.links[0];
    if (fs.existsSync(first.linkMoji) && !isLinkTo(first.linkMoji, first.linkReal)) {
      const m = await migrateMoji(a);
      if (!m.ok) return { status: 'error', text: m.reason, analysis: a };
    }
    for (const l of a.links) {
      if (isLinkTo(l.linkMoji, l.linkReal)) continue;
      if (!fs.existsSync(l.linkReal)) break; // глубже настоящих папок нет — дальше ссылки не нужны
      await fsp.symlink(l.linkReal, l.linkMoji, 'junction');
      log.info(`[cefpath] junction ${l.linkMoji} -> ${l.linkReal}`);
    }
    return { status: 'created', text: 'Создана ссылка для CEF на папку «Документы»', analysis: a };
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      return { status: 'needs-admin', text: 'Нужны права администратора', analysis: a };
    }
    log.warn('[cefpath] не удалось создать ссылку:', err.message);
    return { status: 'error', text: err.message, analysis: a };
  }
}

/** Команда PowerShell для создания ссылки с правами администратора (в «Фиксе игры»). */
function elevatedCommand(a) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return a.links
    .map((l) => `if (-not (Test-Path -LiteralPath ${q(l.linkMoji)})) { New-Item -ItemType Junction -Path ${q(l.linkMoji)} -Target ${q(l.linkReal)} | Out-Null }`)
    .join('; ');
}

/** Все места, где omp-cef мог оставить свои файлы (для отчёта). */
function candidateCefDirs(documentsDir, gameDir) {
  const out = [path.join(documentsDir, 'GTA San Andreas User Files', 'cef')];
  const a = analyze(documentsDir);
  if (a?.moji) out.push(path.join(a.moji, 'GTA San Andreas User Files', 'cef'));
  if (gameDir) {
    out.push(path.join(gameDir, 'cef', 'cache'));
    out.push(path.join(path.parse(gameDir).root, 'cef'));
  }
  return [...new Set(out)];
}

module.exports = { analyze, ensure, elevatedCommand, candidateCefDirs, mangle };
