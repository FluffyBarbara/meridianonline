'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const filesync = require('./filesync');

/**
 * Установщик / обновлятор сборки игры.
 *
 * Сборка описана в game/manifest.json (см. репозиторий):
 *   {
 *     "version": "1.0.0",
 *     "unpackedSize": 2100000000,
 *     "archives": [ { "name": "MeridianOnline.7z.001", "url": "...", "size": 123, "sha256": "..." }, ... ]
 *   }
 * Архивы качаются с докачкой (HTTP Range), проверяются по SHA-256 и распаковываются 7-Zip'ом.
 * Многотомный архив (.7z.001, .7z.002, …) распаковывается с первого тома.
 */

const DOWNLOAD_DIR = '.meridian-download';
const MAX_RETRIES = 6;

function sevenZipPath() {
  // В упакованном приложении бинарник лежит в app.asar.unpacked
  const bin = require('7zip-bin').path7za.replace('app.asar', 'app.asar.unpacked');
  if (process.platform !== 'win32') try { fs.chmodSync(bin, 0o755); } catch {}
  return bin;
}

function archiveName(a) {
  return a.name || decodeURIComponent(new URL(a.url).pathname.split('/').pop());
}

async function existingParent(p) {
  let cur = path.resolve(p);
  for (;;) {
    try { await fsp.access(cur); return cur; } catch {}
    const up = path.dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
}

async function freeSpace(dir) {
  try {
    const st = await fsp.statfs(await existingParent(dir));
    return st.bavail * st.bsize;
  } catch {
    return Infinity;
  }
}

async function sha256File(file, onProgress) {
  const hash = crypto.createHash('sha256');
  const total = (await fsp.stat(file)).size;
  let done = 0;
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
    rs.on('data', (chunk) => { hash.update(chunk); done += chunk.length; onProgress?.(done, total); });
    rs.on('error', reject);
    rs.on('end', resolve);
  });
  return hash.digest('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Удаляет недокачанные .part-файлы пофайловой загрузки. */
async function removeParts(dir) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await removeParts(p);
    else if (e.name.endsWith('.part')) await fsp.unlink(p).catch(() => {});
  }
}

class GameInstaller extends EventEmitter {
  constructor() {
    super();
    this.state = 'idle';
    this.abort = null;
    this.child = null;
    this.progress = null;
  }

  get busy() {
    return ['preparing', 'downloading', 'verifying', 'extracting'].includes(this.state);
  }

  setState(state, extra = {}) {
    this.state = state;
    this.progress = { state, ...extra };
    this.emit('progress', this.progress);
  }

  /** Сколько уже скачано (для отображения при паузе). */
  async partialBytes(gameDir, manifest) {
    if (manifest?.files?.baseUrl) return filesync.partialBytes(gameDir);
    let sum = 0;
    for (const a of manifest.archives || []) {
      const base = path.join(gameDir, DOWNLOAD_DIR, archiveName(a));
      for (const f of [base, base + '.part']) {
        try { sum += (await fsp.stat(f)).size; break; } catch {}
      }
    }
    return sum;
  }

  pause() {
    if (this.state === 'downloading' && this.abort) {
      this.pausing = true;
      this.abort.abort();
    }
  }

  /** Удалить недокачанные файлы (когда загрузка на паузе). */
  async discard(gameDir) {
    if (this.busy) return this.cancel();
    await fsp.rm(path.join(gameDir, DOWNLOAD_DIR), { recursive: true, force: true }).catch(() => {});
    await removeParts(gameDir);
    this.setState('idle');
  }

  cancel() {
    this.cancelling = true;
    this.abort?.abort();
    try { this.child?.kill(); } catch {}
  }

  async install(manifest, gameDir, opts = {}) {
    if (this.busy) throw new Error('Установка уже идёт');
    if (manifest?.files?.baseUrl && manifest?.files?.manifestUrl) return this.installFiles(manifest, gameDir, opts);
    const archives = manifest.archives || [];
    if (!archives.length) throw new Error('Сборка игры ещё не опубликована на сервере обновлений');

    this.pausing = false;
    this.cancelling = false;
    const dlDir = path.join(gameDir, DOWNLOAD_DIR);

    try {
      this.setState('preparing');

      // 1. Права на запись
      try {
        await fsp.mkdir(dlDir, { recursive: true });
        const probe = path.join(dlDir, '.write-test');
        await fsp.writeFile(probe, 'ok');
        await fsp.unlink(probe);
      } catch (err) {
        const e = new Error(`Нет доступа к папке «${gameDir}». Выберите другую папку в настройках.`);
        e.code = 'EACCES';
        throw e;
      }

      // 2. Свободное место
      const totalDownload = archives.reduce((s, a) => s + (a.size || 0), 0);
      const already = await this.partialBytes(gameDir, manifest);
      const need = (totalDownload - already) + (manifest.unpackedSize || totalDownload * 1.3);
      const free = await freeSpace(gameDir);
      if (free < need) {
        const e = new Error(`Недостаточно места на диске: нужно ${(need / 1073741824).toFixed(1)} ГБ, свободно ${(free / 1073741824).toFixed(1)} ГБ.`);
        e.code = 'ENOSPC';
        throw e;
      }

      // 3. Скачивание
      const stats = { total: totalDownload, base: 0, samples: [] };
      for (let i = 0; i < archives.length; i++) {
        const a = archives[i];
        const target = path.join(dlDir, archiveName(a));
        await this.downloadArchive(a, target, stats, i, archives.length);
        stats.base += a.size || (await fsp.stat(target)).size;
      }

      // 4. Распаковка
      await this.extract(path.join(dlDir, archiveName(archives[0])), gameDir);

      // 5. Уборка
      await fsp.rm(dlDir, { recursive: true, force: true });
      await fsp.writeFile(
        path.join(gameDir, 'meridian.json'),
        JSON.stringify({ version: manifest.version, installedAt: new Date().toISOString() }, null, 2),
      );

      this.setState('done', { version: manifest.version });
      return { ok: true, version: manifest.version };
    } catch (err) {
      if (this.pausing) {
        const downloaded = await this.partialBytes(gameDir, manifest);
        const total = archives.reduce((s, a) => s + (a.size || 0), 0);
        this.setState('paused', { downloaded, total, percent: total ? (downloaded / total) * 100 : 0 });
        return { ok: false, paused: true };
      }
      if (this.cancelling) {
        await fsp.rm(dlDir, { recursive: true, force: true }).catch(() => {});
        this.setState('idle');
        return { ok: false, cancelled: true };
      }
      this.setState('error', { message: err.message, code: err.code });
      return { ok: false, error: err.message };
    } finally {
      this.abort = null;
      this.child = null;
    }
  }

  /**
   * Пофайловая установка/обновление из хранилища (game/manifest.json → "files").
   * Качает только отсутствующие и изменённые файлы. opts.deep — перепроверить хеши всех файлов.
   */
  async installFiles(manifest, gameDir, opts = {}) {
    this.pausing = false;
    this.cancelling = false;
    this.abort = new AbortController();
    try {
      this.setState('preparing');
      try {
        await fsp.mkdir(gameDir, { recursive: true });
        const probe = path.join(gameDir, '.meridian-write-test');
        await fsp.writeFile(probe, 'ok');
        await fsp.unlink(probe);
      } catch {
        const e = new Error(`Нет доступа к папке «${gameDir}». Выберите другую папку в настройках.`);
        e.code = 'EACCES';
        throw e;
      }
      const report = (state, extra) => this.setState(state, extra);
      const result = await filesync.sync(manifest.files, gameDir, report, this.abort.signal, {
        deep: !!opts.deep,
        beforeDownload: async (total) => {
          const free = await freeSpace(gameDir);
          const need = total + 200 * 1024 * 1024;
          if (free < need) {
            const e = new Error(`Недостаточно места на диске: нужно ${(need / 1073741824).toFixed(1)} ГБ, свободно ${(free / 1073741824).toFixed(1)} ГБ.`);
            e.code = 'ENOSPC';
            e.fatal = true;
            throw e;
          }
        },
      });
      await fsp.writeFile(
        path.join(gameDir, 'meridian.json'),
        JSON.stringify({ version: result.version, source: 'files', installedAt: new Date().toISOString() }, null, 2),
      );
      this.setState('done', { version: result.version, downloadedFiles: result.downloadedFiles, downloadedBytes: result.downloadedBytes });
      return { ok: true, version: result.version, downloadedFiles: result.downloadedFiles, downloadedBytes: result.downloadedBytes };
    } catch (err) {
      if (this.pausing) {
        const downloaded = await filesync.partialBytes(gameDir);
        this.setState('paused', { downloaded, total: null, percent: 0 });
        return { ok: false, paused: true };
      }
      if (this.cancelling) {
        await removeParts(gameDir);
        this.setState('idle');
        return { ok: false, cancelled: true };
      }
      this.setState('error', { message: err.message, code: err.code });
      return { ok: false, error: err.message };
    } finally {
      this.abort = null;
    }
  }

  async downloadArchive(a, target, stats, index, count) {
    const meta = { file: archiveName(a), index: index + 1, count };

    // Уже скачан и проверен ранее
    if (fs.existsSync(target) && fs.existsSync(target + '.ok')) return;

    if (fs.existsSync(target)) {
      if (await this.verify(a, target, meta)) return;
      await fsp.unlink(target);
    }

    const part = target + '.part';
    let attempt = 0;
    for (;;) {
      try {
        await this.fetchToFile(a, part, stats, meta);
        break;
      } catch (err) {
        if (this.pausing || this.cancelling) throw err;
        if (err.fatal || ++attempt > MAX_RETRIES) throw err;
        this.setState('downloading', { ...this.progress, retry: attempt, message: 'Повторное подключение…' });
        await sleep(Math.min(1000 * 2 ** attempt, 15000));
      }
    }

    await fsp.rename(part, target);
    if (!(await this.verify(a, target, meta))) {
      await fsp.unlink(target).catch(() => {});
      const e = new Error(`Файл ${meta.file} повреждён при загрузке. Попробуйте ещё раз.`);
      throw e;
    }
  }

  async verify(a, file, meta) {
    if (!a.sha256) {
      await fsp.writeFile(file + '.ok', '');
      return true;
    }
    const hex = await sha256File(file, (done, total) => {
      this.setState('verifying', { ...meta, percent: (done / total) * 100 });
    });
    const ok = hex.toLowerCase() === String(a.sha256).toLowerCase();
    if (ok) await fsp.writeFile(file + '.ok', '');
    return ok;
  }

  async fetchToFile(a, part, stats, meta) {
    let start = 0;
    try { start = (await fsp.stat(part)).size; } catch {}
    if (a.size && start >= a.size) start = 0;

    this.abort = new AbortController();
    const headers = { 'User-Agent': 'MeridianLauncher' };
    if (start > 0) headers.Range = `bytes=${start}-`;

    const res = await fetch(a.url, { headers, signal: this.abort.signal, redirect: 'follow' });
    if (res.status === 404) {
      const e = new Error(`Файл ${meta.file} не найден на сервере обновлений (404)`);
      e.fatal = true;
      throw e;
    }
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    if (start > 0 && res.status !== 206) start = 0; // сервер не поддерживает докачку

    const out = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' });
    const body = Readable.fromWeb(res.body);
    let received = start;
    let lastEmit = 0;

    await new Promise((resolve, reject) => {
      body.on('data', (chunk) => {
        received += chunk.length;
        if (!out.write(chunk)) {
          body.pause();
          out.once('drain', () => body.resume());
        }
        const now = Date.now();
        if (now - lastEmit > 250) {
          lastEmit = now;
          this.emitDownload(stats, stats.base + received, meta);
        }
      });
      body.on('error', (err) => { out.destroy(); reject(err); });
      body.on('end', () => out.end(resolve));
      out.on('error', reject);
    });

    if (a.size && received < a.size) throw new Error('Соединение прервано');
  }

  emitDownload(stats, downloaded, meta) {
    const now = Date.now();
    stats.samples.push([now, downloaded]);
    while (stats.samples.length > 2 && now - stats.samples[0][0] > 4000) stats.samples.shift();
    const [t0, b0] = stats.samples[0];
    const speed = now > t0 ? ((downloaded - b0) / (now - t0)) * 1000 : 0;
    const left = Math.max(0, stats.total - downloaded);
    this.setState('downloading', {
      ...meta,
      downloaded,
      total: stats.total,
      percent: stats.total ? (downloaded / stats.total) * 100 : 0,
      speed,
      eta: speed > 0 ? left / speed : null,
    });
  }

  extract(archive, dest) {
    return new Promise((resolve, reject) => {
      this.setState('extracting', { percent: 0 });
      const args = ['x', archive, `-o${dest}`, '-y', '-aoa', '-bsp1', '-bso0', '-bse1'];
      const child = spawn(sevenZipPath(), args, { windowsHide: true });
      this.child = child;
      let errText = '';
      child.stdout.on('data', (d) => {
        const m = String(d).match(/(\d{1,3})%/g);
        if (m) {
          const pct = parseInt(m[m.length - 1], 10);
          this.setState('extracting', { percent: pct });
        }
      });
      child.stderr.on('data', (d) => { errText += String(d); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (this.cancelling) return reject(new Error('cancelled'));
        if (code === 0 || code === 1) return resolve(); // 1 = предупреждения
        reject(new Error(`Ошибка распаковки (7-Zip код ${code}). ${errText.trim().slice(0, 300)}`));
      });
    });
  }
}

module.exports = { GameInstaller, DOWNLOAD_DIR };
