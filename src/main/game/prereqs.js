'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

/**
 * Системные компоненты, без которых клиент CR-MP не запускается:
 * DirectX 9.0c (d3dx9_*.dll) и Visual C++ Redistributable (x86 — игра 32-битная).
 *
 * Проверка — по файлам в SysWOW64 (32-битные DLL на 64-битной Windows) и реестру.
 * Установка — официальные установщики Microsoft в тихом режиме, одним запросом прав администратора.
 * Список нужных компонентов задаётся в game/manifest.json → "prerequisites".
 */

const CATALOG = {
  directx: {
    name: 'DirectX 9.0c',
    files: ['d3dx9_25.dll', 'd3dx9_43.dll', 'd3dx9_31.dll'],
    url: 'https://download.microsoft.com/download/1/7/1/1718CCC4-6315-4D8E-9543-8E28A4E18C4C/dxwebsetup.exe',
    file: 'dxwebsetup.exe',
    args: ['/Q'],
  },
  vc2015: {
    name: 'Visual C++ 2015–2022 (x86)',
    files: ['msvcp140.dll', 'vcruntime140.dll'],
    registry: { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x86', minMinor: 30 },
    url: 'https://aka.ms/vs/17/release/vc_redist.x86.exe',
    file: 'vc_redist_2015-2022_x86.exe',
    args: ['/install', '/quiet', '/norestart'],
  },
  vc2013: {
    name: 'Visual C++ 2013 (x86)',
    files: ['msvcr120.dll', 'msvcp120.dll'],
    url: 'https://aka.ms/highdpimfc2013x86enu',
    file: 'vcredist_2013_x86.exe',
    args: ['/install', '/quiet', '/norestart'],
  },
  vc2012: {
    name: 'Visual C++ 2012 (x86)',
    files: ['msvcr110.dll', 'msvcp110.dll'],
    url: 'https://download.microsoft.com/download/1/6/B/16B06F60-3B20-4FF2-B699-5E9B7962F9AE/VSU_4/vcredist_x86.exe',
    file: 'vcredist_2012_x86.exe',
    args: ['/install', '/quiet', '/norestart'],
  },
  vc2010: {
    name: 'Visual C++ 2010 (x86)',
    files: ['msvcr100.dll', 'msvcp100.dll'],
    url: 'https://download.microsoft.com/download/1/6/5/165255E7-1014-4D0A-B094-B6A430A6BFFC/vcredist_x86.exe',
    file: 'vcredist_2010_x86.exe',
    args: ['/q', '/norestart'],
  },
  vc2008: {
    name: 'Visual C++ 2008 (x86)',
    winsxs: 'x86_microsoft.vc90.crt_',
    url: 'https://download.microsoft.com/download/5/D/8/5D8C65CB-C849-4025-8E95-C3966CAFD8AE/vcredist_x86.exe',
    file: 'vcredist_2008_x86.exe',
    args: ['/q'],
  },
};

const DEFAULT_LIST = ['directx', 'vc2015'];

// Коды возврата, которые считаются успехом (3010/1641 — нужна перезагрузка, 1638/5100 — уже есть новее)
const OK_CODES = new Set([0, 3010, 1641, 1638, 5100]);

function winDir() {
  return process.env.SystemRoot || process.env.windir || 'C:\\Windows';
}

function sys32Dir() {
  const wow = path.join(winDir(), 'SysWOW64');
  return fs.existsSync(wow) ? wow : path.join(winDir(), 'System32');
}

function regQuery(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key], { windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const values = {};
      for (const line of String(out).split(/\r?\n/)) {
        const m = line.trim().match(/^(\S+)\s+REG_\w+\s+(.*)$/);
        if (m) values[m[1]] = m[2].trim();
      }
      resolve(values);
    });
  });
}

function resolveList(manifest) {
  const list = manifest?.prerequisites ?? DEFAULT_LIST;
  return list
    .map((p) => (typeof p === 'string' ? { id: p, ...CATALOG[p] } : { ...CATALOG[p.id], ...p }))
    .filter((p) => p && p.url);
}

async function isInstalled(p) {
  if (p.registry) {
    const v = await regQuery(p.registry.key);
    if (v && v.Installed && parseInt(v.Installed, 16) === 1) {
      const minor = parseInt(v.Minor, 16);
      if (!p.registry.minMinor || isNaN(minor) || minor >= p.registry.minMinor) return true;
      return false; // установлена, но слишком старая
    }
  }
  if (p.winsxs) {
    try {
      return (await fsp.readdir(path.join(winDir(), 'WinSxS'))).some((d) => d.toLowerCase().startsWith(p.winsxs));
    } catch {
      return true; // не смогли проверить — не мешаем запуску
    }
  }
  if (p.files) return p.files.every((f) => fs.existsSync(path.join(sys32Dir(), f)));
  return true;
}

class Prereqs extends EventEmitter {
  constructor(cacheDir) {
    super();
    this.cacheDir = cacheDir;
    this.busy = false;
  }

  /** Список компонентов с отметкой, установлены ли они. */
  async check(manifest) {
    const list = resolveList(manifest);
    if (process.platform !== 'win32') return list.map((p) => ({ id: p.id, name: p.name, installed: true }));
    return Promise.all(list.map(async (p) => ({ id: p.id, name: p.name, installed: await isInstalled(p) })));
  }

  async missing(manifest) {
    return (await this.check(manifest)).filter((p) => !p.installed);
  }

  emitState(state, extra = {}) {
    this.emit('progress', { state, ...extra });
  }

  async download(p, index, count) {
    const target = path.join(this.cacheDir, p.file);
    if (fs.existsSync(target) && fs.existsSync(target + '.ok')) return target;
    await fsp.mkdir(this.cacheDir, { recursive: true });
    const res = await fetch(p.url, { redirect: 'follow', headers: { 'User-Agent': 'MeridianLauncher' } });
    if (!res.ok) throw new Error(`Не удалось скачать ${p.name} (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    let done = 0;
    let last = 0;
    const out = fs.createWriteStream(target + '.part');
    await new Promise((resolve, reject) => {
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        done += chunk.length;
        if (!out.write(chunk)) { body.pause(); out.once('drain', () => body.resume()); }
        if (Date.now() - last > 200) {
          last = Date.now();
          this.emitState('prereq-download', { name: p.name, index, count, percent: total ? (done / total) * 100 : 0 });
        }
      });
      body.on('error', reject);
      body.on('end', () => out.end(resolve));
      out.on('error', reject);
    });
    await fsp.rename(target + '.part', target);
    await fsp.writeFile(target + '.ok', '');
    return target;
  }

  /** Запуск установщиков одним окном UAC через PowerShell. */
  runElevated(jobs) {
    const resultFile = path.join(this.cacheDir, `result-${Date.now()}.json`);
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const lines = ['$r = @{}'];
    for (const j of jobs) {
      const args = j.args.map(q).join(',');
      lines.push(`try { $p = Start-Process -FilePath ${q(j.path)} -ArgumentList ${args} -Wait -PassThru; $r[${q(j.id)}] = $p.ExitCode } catch { $r[${q(j.id)}] = -1 }`);
    }
    lines.push(`$r | ConvertTo-Json | Set-Content -LiteralPath ${q(resultFile)} -Encoding UTF8`);
    const inner = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
    const outer = `Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${inner}'`;

    return new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer], { windowsHide: true }, async (err) => {
        let codes = null;
        try { codes = JSON.parse((await fsp.readFile(resultFile, 'utf8')).replace(/^\uFEFF/, '')); } catch {}
        fsp.unlink(resultFile).catch(() => {});
        resolve({ declined: !!err && !codes, codes: codes || {} });
      });
    });
  }

  /**
   * Скачать и установить недостающие компоненты.
   * @returns {{ok:boolean, installed:string[], failed:string[], declined?:boolean, reboot?:boolean}}
   */
  async install(manifest) {
    if (this.busy) return { ok: false, error: 'Установка компонентов уже идёт' };
    if (process.platform !== 'win32') return { ok: true, installed: [], failed: [] };
    this.busy = true;
    try {
      const need = await this.missing(manifest);
      if (!need.length) return { ok: true, installed: [], failed: [] };
      const full = resolveList(manifest).filter((p) => need.some((n) => n.id === p.id));

      const jobs = [];
      for (let i = 0; i < full.length; i++) {
        const p = full[i];
        this.emitState('prereq-download', { name: p.name, index: i + 1, count: full.length, percent: 0 });
        jobs.push({ id: p.id, path: await this.download(p, i + 1, full.length), args: p.args });
      }

      this.emitState('prereq-install', { names: full.map((p) => p.name) });
      const { declined, codes } = await this.runElevated(jobs);
      if (declined) return { ok: false, declined: true, installed: [], failed: full.map((p) => p.name) };

      const after = await this.check(manifest);
      const failed = after.filter((p) => !p.installed && need.some((n) => n.id === p.id)).map((p) => p.name);
      const reboot = Object.values(codes).some((c) => c === 3010 || c === 1641);
      const badCodes = Object.entries(codes).filter(([, c]) => !OK_CODES.has(Number(c)));
      return {
        ok: failed.length === 0,
        installed: full.map((p) => p.name).filter((n) => !failed.includes(n)),
        failed,
        reboot,
        codes: badCodes.length ? Object.fromEntries(badCodes) : undefined,
      };
    } catch (err) {
      return { ok: false, error: err.message, installed: [], failed: [] };
    } finally {
      this.busy = false;
      this.emitState('prereq-done');
    }
  }
}

module.exports = { Prereqs, CATALOG };
