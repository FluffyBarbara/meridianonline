'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

/**
 * Запуск клиента CR-MP с автоподключением к серверу.
 *
 * По умолчанию (можно переопределить в game/manifest.json → "launch"):
 *   1) samp.exe "IP:PORT"   — ник и путь к gta_sa.exe пишутся в HKCU\Software\SAMP;
 *   2) если samp.exe нет — gta_sa.exe -c -n НИК -h IP -p PORT (клиент грузится через ASI-лоадер).
 */

const DEFAULT_LAUNCH = {
  exe: 'samp.exe',
  args: ['{ip}:{port}'],
  fallback: {
    exe: 'gta_sa.exe',
    args: ['-c', '-n', '{nick}', '-h', '{ip}', '-p', '{port}'],
  },
  registry: [
    { key: 'HKCU\\Software\\SAMP', name: 'PlayerName', value: '{nick}' },
    { key: 'HKCU\\Software\\SAMP', name: 'gta_sa_exe', value: '{gameDir}\\gta_sa.exe' },
  ],
  process: 'gta_sa.exe',
  required: ['gta_sa.exe'],
};

const NICK_RE = /^[A-Za-z0-9_\[\]().$@=]{3,20}$/;

function launchConfig(manifest) {
  return { ...DEFAULT_LAUNCH, ...(manifest?.launch || {}) };
}

function fill(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

/** Установлена ли игра в папке. */
function isInstalled(gameDir, manifest) {
  const cfg = launchConfig(manifest);
  if (!gameDir) return false;
  return (cfg.required || []).every((f) => fs.existsSync(path.join(gameDir, f)));
}

function regAdd(key, name, value) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve();
    execFile('reg', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true }, () => resolve());
  });
}

function validateNickname(nick) {
  if (!nick) return 'Введите игровой ник';
  if (!NICK_RE.test(nick)) return 'Ник: 3–20 символов, латиница, цифры и _ (например Ivan_Petrov)';
  return null;
}

async function launchGame({ gameDir, nickname, server, manifest }) {
  const nickErr = validateNickname(nickname);
  if (nickErr) throw new Error(nickErr);
  if (!isInstalled(gameDir, manifest)) throw new Error('Игра не установлена в выбранной папке');

  const cfg = launchConfig(manifest);
  const vars = { ip: server.ip, port: server.port, nick: nickname, gameDir };

  for (const r of cfg.registry || []) {
    await regAdd(r.key, r.name, fill(r.value, vars));
  }

  let run = cfg;
  if (!fs.existsSync(path.join(gameDir, cfg.exe)) && cfg.fallback) run = cfg.fallback;
  const exe = path.join(gameDir, run.exe);
  if (!fs.existsSync(exe)) throw new Error(`Не найден файл ${run.exe} в папке игры`);

  const args = (run.args || []).map((a) => fill(a, vars));
  const child = spawn(exe, args, {
    cwd: gameDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.on('error', () => {});
  child.unref();
  return { exe: run.exe, args };
}

/** Запущен ли процесс игры (Windows: tasklist). */
function isGameRunning(manifest) {
  const proc = launchConfig(manifest).process;
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !proc) return resolve(false);
    execFile('tasklist', ['/FI', `IMAGENAME eq ${proc}`, '/NH', '/FO', 'CSV'], { windowsHide: true }, (err, out) => {
      resolve(!err && String(out).toLowerCase().includes(proc.toLowerCase()));
    });
  });
}

module.exports = { launchGame, isInstalled, isGameRunning, validateNickname };
