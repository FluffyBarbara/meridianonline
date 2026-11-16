'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const cefpath = require('./cefpath');

/**
 * «Фикс игры» — набор известных лечений вылетов CR-MP / SA-MP:
 *  1. закрыть зависшие gta_sa.exe / samp.exe;
 *  2. проверить файлы сборки по эталонному списку (game/files.json);
 *  3. убрать в карантин посторонние моды (.asi, CLEO, d3d9.dll и т.п.), которых нет в сборке;
 *  4. сбросить настройки графики GTA (Документы\GTA San Andreas User Files\gta_sa.set);
 *  5. снять режимы совместимости Windows с gta_sa.exe / samp.exe и отключить «оптимизацию во весь экран»;
 *  6. одним запросом прав администратора: починить DirectX / Visual C++ / DirectPlay,
 *     добавить папку игры в исключения Защитника Windows, снять режимы совместимости «для всех пользователей».
 */

const LAYERS_KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers';
const GOOD_LAYERS = '~ DISABLEDXMAXIMIZEDWINDOWEDMODE HIGHDPIAWARE';
const QUARANTINE_DIR = '_disabled_mods';
const HASH_LIMIT = 64 * 1024 * 1024; // большие .img проверяем по размеру, остальное — по SHA-256
// Файлы, которые игра и моды переписывают сами (настройки, логи): проверяем только наличие
const MUTABLE = /(\.(ini|cfg|txt|log|set|json)$)|(^vorbisHook\.dll$)/i;

// Где искать посторонние моды
const MOD_EXT = /\.(asi|dll|cs|cleo)$/i;
const MOD_DIRS = ['cleo', 'scripts', 'modloader', 'plugins'];

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30000 }, (err, stdout) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || '') }));
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
      .on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function walk(root, dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(path.join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, rel, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

class GameFixer extends EventEmitter {
  constructor({ prereqs, documentsDir }) {
    super();
    this.prereqs = prereqs;
    this.documentsDir = documentsDir;
    this.busy = false;
  }

  progress(step, extra = {}) {
    this.emit('progress', { state: 'fixing', step, ...extra });
  }

  /**
   * @param {object} o
   * @param {string} o.gameDir
   * @param {object} o.manifest
   * @param {object|null} o.fileList  { files: [[path, size, sha256]] }
   * @param {string} o.nickname
   * @param {{components:boolean, defender:boolean, resetSettings:boolean}} o.options
   */
  async run({ gameDir, manifest, fileList, nickname, options }) {
    if (this.busy) return { ok: false, error: 'Фикс уже выполняется' };
    this.busy = true;
    const steps = [];
    const add = (id, title, status, text = '') => steps.push({ id, title, status, text });
    let needReinstall = false;
    let damaged = [];

    try {
      const win = process.platform === 'win32';

      // 1. Зависшие процессы
      this.progress('Закрываем зависшие процессы игры');
      if (win) {
        const killed = [];
        for (const exe of ['gta_sa.exe', 'samp.exe']) {
          const r = await run('taskkill', ['/F', '/T', '/IM', exe]);
          if (r.code === 0) killed.push(exe);
        }
        add('kill', 'Зависшие процессы', 'ok', killed.length ? `Закрыто: ${killed.join(', ')}` : 'Не найдены');
      } else add('kill', 'Зависшие процессы', 'skip', 'Только для Windows');

      // 2. Файлы игры
      if (fileList?.files?.length) {
        const files = fileList.files;
        const total = files.reduce((s, f) => s + (f[1] <= HASH_LIMIT && !MUTABLE.test(f[0]) ? f[1] : 0), 0) || 1;
        let done = 0;
        let lastEmit = 0;
        const missing = [];
        for (const [rel, size, hash] of files) {
          const full = path.join(gameDir, rel);
          let st;
          try { st = await fsp.stat(full); } catch { missing.push(rel); continue; }
          if (MUTABLE.test(rel)) continue;
          if (st.size !== size) { damaged.push(rel); continue; }
          if (size <= HASH_LIMIT) {
            try { if ((await sha256(full)) !== hash) damaged.push(rel); } catch { damaged.push(rel); }
            done += size;
          }
          if (Date.now() - lastEmit > 200) {
            lastEmit = Date.now();
            this.progress('Проверяем файлы игры', { percent: (done / total) * 100 });
          }
        }
        damaged = [...missing, ...damaged];
        needReinstall = damaged.length > 0;
        add('files', 'Файлы игры', damaged.length ? 'fail' : 'ok',
          damaged.length
            ? `Повреждено или удалено: ${damaged.length} (${damaged.slice(0, 4).join(', ')}${damaged.length > 4 ? '…' : ''})`
            : `Все ${files.length} файлов в порядке`);
      } else {
        add('files', 'Файлы игры', 'skip', 'Эталонный список файлов недоступен');
      }

      // 3. Посторонние моды
      if (fileList?.files?.length) {
        this.progress('Ищем посторонние моды');
        const known = new Set(fileList.files.map((f) => f[0].toLowerCase()));
        const candidates = [];
        for (const e of await fsp.readdir(gameDir, { withFileTypes: true }).catch(() => [])) {
          if (e.isFile() && /\.(asi|dll)$/i.test(e.name)) candidates.push(e.name);
        }
        for (const d of MOD_DIRS) {
          for (const rel of await walk(gameDir, d)) if (MOD_EXT.test(rel)) candidates.push(rel);
        }
        const foreign = candidates.filter((rel) => !known.has(rel.toLowerCase()) && !rel.includes('/.'));
        const qdir = path.join(gameDir, QUARANTINE_DIR, stamp());
        const moved = [];
        for (const rel of foreign) {
          try {
            const dst = path.join(qdir, rel);
            await fsp.mkdir(path.dirname(dst), { recursive: true });
            await fsp.rename(path.join(gameDir, rel), dst);
            moved.push(rel);
          } catch {}
        }
        add('mods', 'Посторонние моды', moved.length ? 'warn' : 'ok',
          moved.length
            ? `Отключено ${moved.length}: ${moved.slice(0, 4).join(', ')}${moved.length > 4 ? '…' : ''}. Они перенесены в папку ${QUARANTINE_DIR}`
            : 'Не найдены');
      }

      // 4. Настройки графики GTA
      if (options.resetSettings) {
        this.progress('Сбрасываем настройки графики GTA');
        const set = path.join(this.documentsDir, 'GTA San Andreas User Files', 'gta_sa.set');
        if (fs.existsSync(set)) {
          try {
            await fsp.rename(set, `${set}.backup-${stamp()}`);
            add('settings', 'Настройки графики GTA', 'ok', 'Сброшены (старые сохранены рядом как gta_sa.set.backup)');
          } catch (e) {
            add('settings', 'Настройки графики GTA', 'fail', `Не удалось сбросить: ${e.message}`);
          }
        } else add('settings', 'Настройки графики GTA', 'ok', 'Файл настроек ещё не создан — сбрасывать нечего');
      }

      // 4.0. Путь к «Документам» с кириллицей ломает omp-cef — создаём ссылку
      let cefLinkAdmin = null;
      if (win) {
        this.progress('Проверяем путь к «Документам» для интерфейса');
        const r = await cefpath.ensure(this.documentsDir);
        if (r.status === 'needs-admin') cefLinkAdmin = r.analysis;
        const title = 'Путь к «Документам» (CEF)';
        if (r.status === 'not-needed') add('cefpath', title, 'ok', 'Без кириллицы — исправление не нужно');
        else if (r.status === 'ok' || r.status === 'created') add('cefpath', title, 'ok', `${r.text}: интерфейс сервера будет загружаться правильно`);
        else if (r.status === 'needs-admin') add('cefpath', title, 'warn', 'Нужна ссылка в системной папке — будет создана с правами администратора');
        else add('cefpath', title, 'fail', `${r.text}. Интерфейс сервера может не открываться (ERR_FAILED)`);
      }

      // 4.1. Кеш интерфейса CEF (omp-cef): при следующем входе на сервер ресурсы скачаются заново
      {
        this.progress('Очищаем кеш интерфейса (CEF)');
        const cache = path.join(this.documentsDir, 'GTA San Andreas User Files', 'cef', 'cache');
        if (fs.existsSync(cache)) {
          try {
            await fsp.rm(cache, { recursive: true, force: true });
            add('cef', 'Кеш интерфейса (CEF)', 'ok', 'Очищен — при входе на сервер интерфейс скачается заново');
          } catch (e) {
            add('cef', 'Кеш интерфейса (CEF)', 'warn', `Не удалось очистить: ${e.message}. Закройте игру и повторите`);
          }
        } else add('cef', 'Кеш интерфейса (CEF)', 'ok', 'Кеша ещё нет');
      }

      // 5. Режимы совместимости
      if (win) {
        this.progress('Снимаем режимы совместимости Windows');
        const q = await run('reg', ['query', LAYERS_KEY]);
        const removed = [];
        for (const line of q.out.split(/\r?\n/)) {
          const m = line.match(/^\s{4}(.+?)\s{4}REG_\w+\s{4}(.*)$/);
          if (m && /\\(gta_sa|samp)\.exe$/i.test(m[1].trim())) {
            const r = await run('reg', ['delete', LAYERS_KEY, '/v', m[1].trim(), '/f']);
            if (r.code === 0) removed.push(`${path.basename(m[1].trim())}: ${m[2].trim()}`);
          }
        }
        await run('reg', ['add', LAYERS_KEY, '/v', path.join(gameDir, 'gta_sa.exe'), '/t', 'REG_SZ', '/d', GOOD_LAYERS, '/f']);
        add('compat', 'Режимы совместимости', 'ok',
          removed.length ? `Сняты: ${removed.join('; ')}. Оптимизация во весь экран отключена` : 'Оптимизация во весь экран отключена для gta_sa.exe');

        // Записи SA-MP в реестре
        await run('reg', ['add', 'HKCU\\Software\\SAMP', '/v', 'gta_sa_exe', '/t', 'REG_SZ', '/d', path.join(gameDir, 'gta_sa.exe'), '/f']);
        if (nickname) await run('reg', ['add', 'HKCU\\Software\\SAMP', '/v', 'PlayerName', '/t', 'REG_SZ', '/d', nickname, '/f']);
      }

      // 6. Всё, что требует прав администратора, — одним запросом
      if (win && (options.components || options.defender || cefLinkAdmin)) {
        this.progress('Компоненты Windows и защитник');
        const pq = (s) => `'${String(s).replace(/'/g, "''")}'`;
        const extra = [{
          id: 'hklm-compat',
          ps: "$k='HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'; if (Test-Path $k) { (Get-Item $k).Property | Where-Object { $_ -match '\\\\(gta_sa|samp)\\.exe$' } | ForEach-Object { Remove-ItemProperty -Path $k -Name $_ } }",
        }];
        if (options.defender) {
          extra.push({ id: 'defender', ps: `Add-MpPreference -ExclusionPath ${pq(gameDir)} -ErrorAction Stop` });
        }
        if (cefLinkAdmin) extra.push({ id: 'cefpath', ps: cefpath.elevatedCommand(cefLinkAdmin) });
        const r = options.components
          ? await this.prereqs.install(manifest, { force: true, extra })
          : await this.prereqs.install({ ...manifest, prerequisites: [] }, { extra });
        if (r.declined) {
          add('admin', 'Компоненты Windows', 'warn', 'Запрос прав администратора отклонён — DirectX, Visual C++, DirectPlay и исключение антивируса не применены');
        } else {
          if (options.components) {
            add('components', 'DirectX, Visual C++, DirectPlay',
              r.failed?.length ? 'fail' : 'ok',
              r.failed?.length ? `Не удалось: ${r.failed.join(', ')}` : `Переустановлены: ${(r.installed || []).join(', ') || 'всё на месте'}${r.reboot ? '. Перезагрузите компьютер' : ''}`);
          }
          if (options.defender) {
            add('defender', 'Защитник Windows', r.extra?.defender === 0 ? 'ok' : 'warn',
              r.extra?.defender === 0 ? 'Папка игры добавлена в исключения' : 'Не удалось (возможно, стоит другой антивирус — добавьте папку игры в его исключения вручную)');
          }
        }
      }

      return { ok: true, steps, needReinstall, damaged: damaged.length };
    } catch (err) {
      add('error', 'Ошибка', 'fail', err.message);
      return { ok: false, steps, needReinstall, error: err.message };
    } finally {
      this.busy = false;
      this.emit('progress', { state: 'idle' });
    }
  }
}

module.exports = { GameFixer, QUARANTINE_DIR, GOOD_LAYERS, LAYERS_KEY };
