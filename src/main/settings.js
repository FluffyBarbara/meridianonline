'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const config = require('./config');

/** Простое JSON-хранилище настроек в %APPDATA%/Meridian Online/settings.json */

const DEFAULTS = {
  nickname: '',
  gameDir: process.platform === 'win32'
    ? config.DEFAULT_GAME_DIR_WIN
    : path.join(app.getPath('home'), 'Games', 'Meridian Online'),
  installedVersion: null,
  selectedServer: config.DEFAULT_SERVER.id,
  // Что делать с лаунчером после запуска игры: 'minimize' | 'hide' | 'close' | 'keep'
  afterLaunch: 'minimize',
  // Сочетание клавиш, закрывающее зависшую игру: 'ctrl-alt-end' | 'ctrl-shift-f12' | 'off'
  // или своё сочетание в формате Electron Accelerator, например 'Control+Shift+K'
  killHotkey: 'ctrl-alt-end',
  // Последнее включённое сочетание (чтобы вернуть его после «Выкл»)
  killHotkeyLast: null,
  // Скачивать обновления игры автоматически при запуске лаунчера.
  autoUpdateGame: true,
  // Анимированный фон
  animatedBackground: true,
  settingsVersion: 2,
  // Показывать статус в Discord (по умолчанию выключено, включается в настройках)
  discordPresence: false,
  // Безопасный запуск: временно отключать графические моды
  safeMode: false,
  // Что отключено безопасным запуском (чтобы вернуть после выхода из игры)
  safeModeRenamed: null,
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = { ...DEFAULTS, ...raw };
    // v2: статус в Discord стал выключенным по умолчанию — выключаем у всех, кто его не включал сам
    if (!raw.settingsVersion || raw.settingsVersion < 2) {
      cache.discordPresence = false;
      cache.settingsVersion = 2;
      save();
    }
  } catch {
    cache = { ...DEFAULTS, settingsVersion: 2 };
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, file());
  } catch (err) {
    console.error('Не удалось сохранить настройки:', err);
  }
}

function get(key) {
  const s = load();
  return key ? s[key] : { ...s };
}

function set(patch) {
  load();
  const allowed = Object.keys(DEFAULTS);
  for (const [k, v] of Object.entries(patch || {})) {
    if (allowed.includes(k)) cache[k] = v;
  }
  save();
  return { ...cache };
}

module.exports = { get, set, DEFAULTS };
