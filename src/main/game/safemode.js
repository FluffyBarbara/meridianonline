'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * «Безопасный запуск»: на время игры отключает графические моды, которые меняют видеорежим
 * (сглаживание, частота обновления, широкоформат, небо, цветокоррекция). Если Direct3D
 * не может создать устройство с их настройками, samp.dll падает при старте.
 * Файлы переименовываются в *.off и возвращаются после выхода из игры (или при следующем запуске лаунчера).
 * Список задаётся в game/manifest.json → "safeMode": [...].
 */

const DEFAULT_LIST = [
  'Multi-sampling fix.asi',
  'RefreshRateFixByDarkP1xel32.ASI',
  'sa_widescreenfix_lite.asi',
  'RealSkybox.SA.asi',
  'skygrad.asi',
  '_colorsmoke.SA.asi',
];

async function disable(gameDir, manifest, settings) {
  await restore(settings);
  const list = Array.isArray(manifest?.safeMode) ? manifest.safeMode : DEFAULT_LIST;
  const renamed = [];
  for (const rel of list) {
    const file = path.join(gameDir, rel);
    try {
      if (fs.existsSync(file)) {
        await fsp.rename(file, `${file}.off`);
        renamed.push(rel);
      }
    } catch {}
  }
  settings.set({ safeModeRenamed: renamed.length ? { gameDir, files: renamed } : null });
  return renamed;
}

async function restore(settings) {
  const st = settings.get('safeModeRenamed');
  if (!st?.files?.length) return [];
  const back = [];
  const left = [];
  for (const rel of st.files) {
    const file = path.join(st.gameDir, rel);
    try {
      if (fs.existsSync(`${file}.off`) && !fs.existsSync(file)) await fsp.rename(`${file}.off`, file);
      back.push(rel);
    } catch {
      left.push(rel); // файл занят (игра ещё закрывается) — вернём в следующий раз
    }
  }
  settings.set({ safeModeRenamed: left.length ? { gameDir: st.gameDir, files: left } : null });
  return back;
}

module.exports = { disable, restore, DEFAULT_LIST };
