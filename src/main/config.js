'use strict';

/**
 * Главные настройки лаунчера.
 * Всё, что можно менять без выпуска новой версии лаунчера (новости, ссылки,
 * сервера, слайды), лежит в репозитории: content/launcher.json и game/manifest.json.
 */

const REPO_OWNER = 'FluffyBarbara';
const REPO_NAME = 'meridianonline';
const REPO_BRANCH = 'main';

const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}`;
const API_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents`;
const CDN_BASE = `https://cdn.jsdelivr.net/gh/${REPO_OWNER}/${REPO_NAME}@${REPO_BRANCH}`;

module.exports = {
  APP_NAME: 'Meridian Online',
  APP_ID: 'online.meridian.launcher',

  REPO_OWNER,
  REPO_NAME,

  // Удалённый конфиг: сервера, новости, ссылки, слайды.
  // Несколько адресов: если провайдер блокирует raw.githubusercontent.com, пробуем GitHub API и CDN jsDelivr.
  CONTENT_URLS: [
    `${RAW_BASE}/content/launcher.json`,
    `${API_BASE}/content/launcher.json?ref=${REPO_BRANCH}`,
    `${CDN_BASE}/content/launcher.json`,
  ],
  // Манифест сборки игры: версия, архивы для скачивания, параметры запуска.
  GAME_MANIFEST_URLS: [
    `${RAW_BASE}/game/manifest.json`,
    `${API_BASE}/game/manifest.json?ref=${REPO_BRANCH}`,
    `${CDN_BASE}/game/manifest.json`,
  ],

  // Сервер по умолчанию (если удалённый конфиг недоступен).
  DEFAULT_SERVER: {
    id: 'white',
    name: 'WHITE',
    ip: '80.242.59.112',
    port: 2557,
  },

  // Папка игры по умолчанию (на Windows). Можно сменить в настройках.
  DEFAULT_GAME_DIR_WIN: 'C:\\Games\\Meridian Online',

  // Как часто опрашивать сервер (онлайн / пинг), мс.
  SERVER_POLL_INTERVAL: 15000,

  // Таймаут проверки обновлений лаунчера на старте, мс.
  UPDATE_CHECK_TIMEOUT: 12000,
};
