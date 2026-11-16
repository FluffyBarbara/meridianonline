'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { app, screen } = require('electron');

/**
 * «Отчёт для поддержки»: всё, что нужно, чтобы понять причину вылета у игрока, в одном текстовом файле.
 */

const GAME_LOGS = [
  'fastman92limitAdjuster.log', // крэш-лог со стеком и списком модулей
  'RefreshRateFixByDarkP1xel32.LOG',
  'AutoCleanStreaming.log',
  'RealSkybox.SA.log',
  'modloader/modloader.log',
  'vorbisHook.dll', // это текстовый лог CEF, несмотря на расширение
];

function ps(command) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('');
    // UTF-8, иначе русская Windows отдаёт текст в OEM-кодировке (cp866) и он превращается в «�����»
    const utf8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', utf8 + command],
      { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(String(out || '').trim()));
  });
}

async function tail(file, lines) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    const all = text.split(/\r?\n/);
    return (all.length > lines ? [`… (показаны последние ${lines} строк из ${all.length})`] : []).concat(all.slice(-lines)).join('\n');
  } catch {
    return null;
  }
}

async function listDir(dir) {
  try {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    const rows = [];
    for (const e of items) {
      let size = '';
      if (e.isFile()) { try { size = ` (${(await fsp.stat(path.join(dir, e.name))).size} Б)`; } catch {} }
      rows.push(`${e.isDirectory() ? '[папка] ' : ''}${e.name}${size}`);
    }
    return rows.join('\n') || '(пусто)';
  } catch {
    return '(не найдена)';
  }
}

async function buildReport({ gameDir, nickname, manifest, fileList, prereqs, launcherVersion, lastLaunch, gpu }) {
  const out = [];
  const section = (title, body) => out.push(`\n==================== ${title} ====================\n${body ?? '(нет данных)'}`);

  out.push(`Отчёт Meridian Online Launcher — ${new Date().toLocaleString('ru-RU')}`);
  out.push(`Лаунчер ${launcherVersion} · сборка игры ${manifest?.version || '—'} · ник ${nickname || '—'}`);

  // Система
  const sys = await ps([
    '$o = Get-CimInstance Win32_OperatingSystem;',
    '"Windows: $($o.Caption) $($o.Version) $($o.OSArchitecture), сборка $($o.BuildNumber)";',
    '"Процессор: $((Get-CimInstance Win32_Processor | Select-Object -First 1).Name)";',
    '"ОЗУ: $([math]::Round($o.TotalVisibleMemorySize/1MB,1)) ГБ, свободно $([math]::Round($o.FreePhysicalMemory/1MB,1)) ГБ";',
    'Get-CimInstance Win32_VideoController | ForEach-Object { "Видеокарта: $($_.Name) | драйвер $($_.DriverVersion) от $($_.DriverDate) | $($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution) @ $($_.CurrentRefreshRate) Гц | статус $($_.Status) | $($_.PNPDeviceID) | $($_.InfFilename)" };',
    '$dp = Get-CimInstance Win32_OptionalFeature -Filter "Name=\'DirectPlay\'" -ErrorAction SilentlyContinue; "DirectPlay: InstallState=$($dp.InstallState)";',
  ].join(' '));
  section('Система', sys || `${os.type()} ${os.release()} ${os.arch()}, ОЗУ ${(os.totalmem() / 1073741824).toFixed(1)} ГБ`);
  if (gpu?.checked) {
    section('Драйвер видеокарты', gpu.problem
      ? `✖ НЕ УСТАНОВЛЕН: Windows работает через «${gpu.problem.adapter}», аппаратного Direct3D нет — GTA не запустится.\nПроизводитель видеокарты: ${gpu.problem.vendorName || 'не определён'}. Драйвер: ${gpu.problem.url}`
      : `✔ ${gpu.adapters.join('\n✔ ')}`);
  }

  try {
    const displays = screen.getAllDisplays().map((d, i) =>
      `Экран ${i + 1}: ${d.size.width}x${d.size.height} (физически ${Math.round(d.size.width * d.scaleFactor)}x${Math.round(d.size.height * d.scaleFactor)}), масштаб ${Math.round(d.scaleFactor * 100)}%, ${d.displayFrequency || '?'} Гц${d.id === screen.getPrimaryDisplay().id ? ', основной' : ''}`);
    section('Экраны', displays.join('\n'));
  } catch {}

  // Компоненты
  try {
    const list = await prereqs.check(manifest);
    section('Компоненты Windows', list.map((p) => `${p.installed ? '✔' : '✖'} ${p.name}`).join('\n'));
  } catch {}

  // Папка игры
  const nonAscii = /[^\x00-\x7F]/.test(gameDir);
  section('Папка игры', `${gameDir}${nonAscii ? '\n⚠ В пути есть не латинские символы — это может ломать CR-MP' : ''}\n\n${await listDir(gameDir)}`);

  // Посторонние файлы
  if (fileList?.files) {
    const known = new Set(fileList.files.map((f) => f[0].toLowerCase()));
    const extra = [];
    for (const e of await fsp.readdir(gameDir, { withFileTypes: true }).catch(() => [])) {
      if (e.isFile() && !known.has(e.name.toLowerCase()) && !/\.(log|off)$/i.test(e.name) && e.name !== 'meridian.json') extra.push(e.name);
    }
    section('Файлы в корне игры, которых нет в сборке', extra.join('\n') || 'нет');
  }

  // Реестр
  const reg = await ps([
    '"[HKCU\\Software\\SAMP]"; Get-ItemProperty -Path "HKCU:\\Software\\SAMP" -ErrorAction SilentlyContinue | Select-Object PlayerName, gta_sa_exe | Format-List | Out-String;',
    '"[Режимы совместимости HKCU]"; (Get-Item "HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers" -ErrorAction SilentlyContinue).Property | Where-Object { $_ -match "gta_sa|samp" } | ForEach-Object { "$_ = $((Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers").$_)" };',
    '"[Режимы совместимости HKLM]"; (Get-Item "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers" -ErrorAction SilentlyContinue).Property | Where-Object { $_ -match "gta_sa|samp" } | ForEach-Object { "$_ = $((Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers").$_)" };',
    '"[Антивирусы]"; Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue | ForEach-Object { $_.displayName };',
  ].join(' '));
  if (reg) section('Реестр и антивирусы', reg);

  // Настройки GTA
  const userFiles = path.join(app.getPath('documents'), 'GTA San Andreas User Files');
  section('Документы\\GTA San Andreas User Files', `${userFiles}\n${await listDir(userFiles)}`);

  // Клиент CEF (omp-cef): лог, настройки и скачанные с сервера ресурсы
  const cefDir = path.join(userFiles, 'cef');
  const cefLog = await tail(path.join(cefDir, 'client.log'), 250);
  section('CEF: client.log', cefLog || '(нет — клиент CEF ещё не запускался)');
  try { section('CEF: config.json', await fsp.readFile(path.join(cefDir, 'config.json'), 'utf8')); } catch {}
  const cacheRoot = path.join(cefDir, 'cache');
  const cacheRows = [];
  for (const server of await fsp.readdir(cacheRoot, { withFileTypes: true }).catch(() => [])) {
    if (!server.isDirectory()) continue;
    cacheRows.push(`[${server.name}]`);
    for (const f of await fsp.readdir(path.join(cacheRoot, server.name), { withFileTypes: true }).catch(() => [])) {
      let info = '';
      try {
        const st = await fsp.stat(path.join(cacheRoot, server.name, f.name));
        info = ` — ${st.size} Б, изменён ${st.mtime.toLocaleString('ru-RU')}`;
      } catch {}
      cacheRows.push(`  ${f.name}${info}`);
    }
  }
  section('CEF: кеш ресурсов сервера', cacheRows.join('\n') || '(пусто)');

  if (lastLaunch) section('Последний запуск', JSON.stringify(lastLaunch, null, 2));

  // Логи игры
  for (const rel of GAME_LOGS) {
    const t = await tail(path.join(gameDir, rel), rel.startsWith('fastman92') ? 400 : 60);
    if (t) section(`Лог: ${rel}`, t);
  }

  // Лог лаунчера
  const launcherLog = path.join(app.getPath('userData'), 'logs', 'main.log');
  section('Лог лаунчера', await tail(launcherLog, 150));

  return out.join('\n');
}

async function saveReport(text) {
  const name = `Meridian-отчёт-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
  let dir = app.getPath('desktop');
  try { await fsp.access(dir); } catch { dir = app.getPath('documents'); }
  const file = path.join(dir, name);
  await fsp.writeFile(file, '﻿' + text, 'utf8');
  return file;
}

module.exports = { buildReport, saveReport };
