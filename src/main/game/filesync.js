'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

/**
 * Пофайловая установка и обновление игры из хранилища (S3 / любой HTTP-сервер).
 *
 * В хранилище лежат:
 *   <manifestUrl>            — { "version": "...", "files": [ { "path", "size", "sha256" } ] }
 *   <baseUrl>/<path файла>   — сами файлы игры
 *
 * Скачиваются только отсутствующие и изменённые файлы — обновление весит ровно столько,
 * сколько изменилось. Проверенные хеши кешируются в <папка игры>/meridian-files.json,
 * чтобы не пересчитывать SHA-256 всех 6,5 ГБ при каждой проверке.
 */

const STATE_FILE = 'meridian-files.json';

// Файлы, которые игра, моды и сам игрок меняют: их не перезаписываем (только докачиваем, если удалены)
const VOLATILE_EXACT = new Set(['modloader/modloader.ini', 'samp/settings.ini', 'gta_sa.set', 'vorbishook.dll']);
const VOLATILE_PREFIX = ['modloader/.data/', 'cef/user_data/', 'cef/cache/', 'cef/logs/'];
const VOLATILE_PATTERN = [/\.log$/i, /\.part$/i, /\.tmp$/i];
// Настройки (.ini/.cfg/.set): проверяем только наличие — правки игрока сохраняются
const SOFT_EXT = /\.(ini|cfg|set)$/i;

function isVolatile(rel) {
  const l = rel.toLowerCase();
  return VOLATILE_EXACT.has(l) || VOLATILE_PREFIX.some((p) => l.startsWith(p)) || VOLATILE_PATTERN.some((r) => r.test(l));
}
const PARALLEL = 4;
const MAX_RETRIES = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\/+/, '');

/** URL файла: каждый сегмент пути кодируется отдельно ($, пробелы, скобки, кириллица). */
function fileUrl(baseUrl, rel) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return base + norm(rel).split('/').map(encodeURIComponent).join('/');
}

/** Второй вариант кодирования: S3 иногда хранит ключи с неэкранированными $ & ' ( ) * + , ; = : @ */
function fileUrlAlt(baseUrl, rel) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const seg = (x) => encodeURIComponent(x).replace(/%(24|26|27|28|29|2A|2B|2C|3B|3D|3A|40)/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
  return base + norm(rel).split('/').map(seg).join('/');
}

/**
 * Листинг бакета S3 (ListObjectsV2): реальные ключи файлов без учёта регистра.
 * Нужен, если файл в хранилище загружен с другим регистром букв, чем в манифесте.
 */
async function fetchListing(baseUrl) {
  const m = /^(https?:\/\/[^/]+\/[^/]+)\/(.*)$/.exec(baseUrl.replace(/\/+$/, ''));
  if (!m) return new Map();
  const [, bucket, prefixRaw] = m;
  const prefix = prefixRaw ? `${prefixRaw}/` : '';
  const map = new Map();
  let token = null;
  for (let page = 0; page < 100; page++) {
    let url = `${bucket}/?list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}`;
    if (token) url += `&continuation-token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'MeridianLauncher' } });
    if (!res.ok) break;
    const xml = await res.text();
    const dec = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    for (const c of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const k = /<Key>([\s\S]*?)<\/Key>/.exec(c[1]);
      if (!k) continue;
      const key = dec(k[1]);
      if (!key.startsWith(prefix) || key.endsWith('/')) continue;
      map.set(key.slice(prefix.length).toLowerCase(), key.slice(prefix.length));
    }
    const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
    if (!/<IsTruncated>true<\/IsTruncated>/i.test(xml) || !next) break;
    token = dec(next[1]);
  }
  return map;
}

async function fetchManifest(url, timeout = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${sep}t=${Date.now()}`, { signal: ctrl.signal, headers: { 'User-Agent': 'MeridianLauncher', 'Cache-Control': 'no-cache' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // манифест может быть сохранён с BOM
    const text = (await res.text()).replace(/^﻿/, '');
    const data = JSON.parse(text);
    if (!Array.isArray(data.files)) throw new Error('в манифесте нет списка files');
    return {
      version: String(data.version || ''),
      files: data.files
        .filter((f) => f && f.path && !/\.log$/i.test(f.path)) // логи модов не качаем
        .map((f) => ({ path: norm(f.path), size: Number(f.size) || 0, sha256: String(f.sha256 || '').toLowerCase() })),
    };
  } finally {
    clearTimeout(t);
  }
}

function sha256File(file, onChunk) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
      .on('data', (d) => { h.update(d); onChunk?.(d.length); })
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

async function readState(gameDir) {
  try { return JSON.parse(await fsp.readFile(path.join(gameDir, STATE_FILE), 'utf8')); } catch { return { files: {} }; }
}

async function writeState(gameDir, state) {
  const tmp = path.join(gameDir, `${STATE_FILE}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(state));
  await fsp.rename(tmp, path.join(gameDir, STATE_FILE));
}

/**
 * Какие файлы нужно скачать.
 * @param {(phase:string, extra:object)=>void} report
 * @param {{deep?:boolean}} opts deep — пересчитать хеши всех файлов, игнорируя кеш (для «Фикса игры»)
 */
async function plan(gameDir, remote, report, opts = {}) {
  const state = await readState(gameDir);
  const cache = state.files || {};
  const need = [];
  const toHash = [];

  for (const f of remote.files) {
    const local = path.join(gameDir, f.path);
    let st = null;
    try { st = await fsp.stat(local); } catch {}
    // Изменяемые файлы и настройки: есть — не трогаем, нет — докачиваем
    if (isVolatile(f.path) || SOFT_EXT.test(f.path)) {
      if (!st) need.push(f);
      continue;
    }
    if (!st || st.size !== f.size) { need.push(f); continue; }
    const c = cache[f.path];
    if (!opts.deep && c && c.sha256 === f.sha256 && c.size === st.size && c.mtime === Math.round(st.mtimeMs)) continue;
    toHash.push({ f, st });
  }

  // Хешируем только файлы, для которых кеш устарел или его нет
  const total = toHash.reduce((s, x) => s + x.f.size, 0) || 1;
  let done = 0;
  let last = 0;
  for (const { f, st } of toHash) {
    const hex = await sha256File(path.join(gameDir, f.path), (n) => {
      done += n;
      if (Date.now() - last > 250) { last = Date.now(); report('verifying', { percent: (done / total) * 100, file: f.path }); }
    });
    if (hex === f.sha256) cache[f.path] = { sha256: hex, size: st.size, mtime: Math.round(st.mtimeMs) };
    else need.push(f);
  }
  state.files = cache;
  await writeState(gameDir, state).catch(() => {});
  return { need, state };
}

/** Скачивание одного файла с докачкой (Range) и проверкой SHA-256. */
async function downloadFile(f, baseUrl, gameDir, signal, onBytes, resolver) {
  const target = path.join(gameDir, f.path);
  let url = fileUrl(baseUrl, f.path);
  let triedAlt = false;
  let triedListing = false;
  const part = `${target}.part`;
  await fsp.mkdir(path.dirname(target), { recursive: true });

  for (let attempt = 0; ; attempt++) {
    try {
      let start = 0;
      try { start = (await fsp.stat(part)).size; } catch {}
      if (start > f.size) { await fsp.unlink(part).catch(() => {}); start = 0; }

      const hash = crypto.createHash('sha256');
      if (start > 0) {
        // хеш уже скачанной части
        await new Promise((resolve, reject) => {
          fs.createReadStream(part).on('data', (d) => hash.update(d)).on('error', reject).on('end', resolve);
        });
        onBytes(start, true);
      }

      if (start < f.size || f.size === 0) {
        const headers = { 'User-Agent': 'MeridianLauncher' };
        if (start > 0) headers.Range = `bytes=${start}-`;
        const res = await fetch(url, { headers, signal });
        if (res.status === 404 || res.status === 403) {
          // Как в старом лаунчере: второй вариант кодирования, затем поиск ключа в листинге бакета
          if (!triedAlt) { triedAlt = true; url = fileUrlAlt(baseUrl, f.path); continue; }
          if (!triedListing && resolver) {
            triedListing = true;
            const real = await resolver(f.path);
            if (real) { url = fileUrl(baseUrl, real); continue; }
          }
          const e = new Error(`Файл ${f.path} недоступен в хранилище (HTTP ${res.status})`);
          e.fatal = true;
          throw e;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (start > 0 && res.status !== 206) {
          // сервер не умеет докачку — начинаем файл заново
          await fsp.unlink(part).catch(() => {});
          onBytes(-start, true);
          continue;
        }
        const out = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' });
        await new Promise((resolve, reject) => {
          const body = Readable.fromWeb(res.body);
          body.on('data', (chunk) => {
            hash.update(chunk);
            onBytes(chunk.length);
            if (!out.write(chunk)) { body.pause(); out.once('drain', () => body.resume()); }
          });
          body.on('error', (err) => { out.destroy(); reject(err); });
          body.on('end', () => out.end(resolve));
          out.on('error', reject);
        });
      }

      const hex = hash.digest('hex');
      const lenient = isVolatile(f.path) || SOFT_EXT.test(f.path); // настройки могли поменять без обновления манифеста
      if (f.sha256 && hex !== f.sha256 && !lenient) {
        await fsp.unlink(part).catch(() => {});
        throw new Error(`Файл ${f.path} скачался с ошибкой (не совпала контрольная сумма)`);
      }
      // Заменяем файл (снимаем «только чтение», если стоит)
      await fsp.chmod(target, 0o666).catch(() => {});
      await fsp.rename(part, target);
      const st = await fsp.stat(target);
      return { sha256: hex, size: st.size, mtime: Math.round(st.mtimeMs) };
    } catch (err) {
      if (signal.aborted || err.fatal || attempt >= MAX_RETRIES) throw err;
      await sleep(Math.min(1000 * 2 ** attempt, 15000));
    }
  }
}

/**
 * Синхронизация папки игры с хранилищем.
 * @param {object} src  { manifestUrl, baseUrl }
 * @param {(state:string, extra:object)=>void} report
 * @param {AbortSignal} signal
 */
async function sync(src, gameDir, report, signal, opts = {}) {
  report('preparing', {});
  const remote = await fetchManifest(src.manifestUrl);
  await fsp.mkdir(gameDir, { recursive: true });

  const { need, state } = await plan(gameDir, remote, report, opts);
  const total = need.reduce((s, f) => s + f.size, 0);
  if (total > 0 && opts.beforeDownload) await opts.beforeDownload(total);
  let downloaded = 0;
  let filesDone = 0;
  const samples = [];
  let last = 0;

  const emit = (file) => {
    const now = Date.now();
    if (now - last < 250) return;
    last = now;
    samples.push([now, downloaded]);
    while (samples.length > 2 && now - samples[0][0] > 4000) samples.shift();
    const speed = now > samples[0][0] ? ((downloaded - samples[0][1]) / (now - samples[0][0])) * 1000 : 0;
    report('downloading', {
      downloaded, total,
      percent: total ? (downloaded / total) * 100 : 100,
      speed, eta: speed > 0 ? (total - downloaded) / speed : null,
      file, index: filesDone + 1, count: need.length, mode: 'files',
    });
  };

  // Сначала мелкие файлы — быстро видно прогресс, крупные .img качаются параллельно в конце
  const queue = [...need].sort((a, b) => a.size - b.size);
  let listing = null;
  const resolver = async (rel) => {
    listing = listing || fetchListing(src.baseUrl).catch(() => new Map());
    return (await listing).get(norm(rel).toLowerCase()) || null;
  };
  const failures = []; // { path, error }
  let fatalStop = null; // остановка всей загрузки (нет места на диске и т.п.)
  let saveTimer = null;
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => writeState(gameDir, state).catch(() => {}), 1500);
  };

  const worker = async () => {
    while (queue.length && !fatalStop && !signal.aborted) {
      const f = queue.shift();
      try {
        const info = await downloadFile(f, src.baseUrl, gameDir, signal, (n) => { downloaded += n; emit(f.path); }, resolver);
        state.files[f.path] = info;
        filesDone++;
        saveSoon();
      } catch (err) {
        if (signal.aborted) break;
        if (err.code === 'ENOSPC') { fatalStop = err; break; }
        // Как в старом лаунчере: не обрываем установку из-за одного файла, качаем остальные
        failures.push({ path: f.path, error: err.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, Math.max(1, need.length)) }, worker));
  clearTimeout(saveTimer);
  state.version = remote.version;
  await writeState(gameDir, state).catch(() => {});
  if (signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
  if (fatalStop) throw fatalStop;
  if (failures.length) {
    const list = failures.slice(0, 3).map((x) => x.path).join(', ');
    const e = new Error(`Не удалось скачать файлов: ${failures.length} (${list}${failures.length > 3 ? '…' : ''}). Нажмите «Повторить» — докачаются только они.`);
    e.failures = failures;
    throw e;
  }

  return { version: remote.version, downloadedFiles: need.length, downloadedBytes: total };
}

/** Сколько уже скачано недокачанных .part (для отображения паузы). */
async function partialBytes(gameDir) {
  let sum = 0;
  const walk = async (dir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.part')) sum += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(gameDir);
  return sum;
}

module.exports = { sync, fetchManifest, fetchListing, fileUrl, fileUrlAlt, partialBytes, plan, STATE_FILE };
