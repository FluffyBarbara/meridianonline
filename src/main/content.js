'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const log = require('electron-log/main');

/**
 * Загрузка JSON из репозитория с кешем на диске и запасной копией внутри лаунчера.
 * Порядок: сеть → кеш последней удачной загрузки → встроенная копия.
 */

async function fetchJson(url, timeout = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    // Параметр против кеша CDN raw.githubusercontent.com
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${sep}t=${Date.now()}`, {
      signal: ctrl.signal,
      headers: {
        'Cache-Control': 'no-cache',
        'User-Agent': 'MeridianLauncher',
        // Для api.github.com — отдать сам файл, а не JSON-обёртку
        Accept: 'application/vnd.github.raw, application/json',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function cachePath(name) {
  return path.join(app.getPath('userData'), 'cache', `${name}.json`);
}

function bundledPath(rel) {
  return path.join(app.getAppPath(), rel);
}

async function loadRemoteJson({ urls, cacheName, bundled }) {
  // Режим разработчика: настройки только из локальных файлов (для проверки без выкладки в репозиторий)
  if (!app.isPackaged && process.env.MERIDIAN_LOCAL_CONTENT) {
    return { data: JSON.parse(fs.readFileSync(bundledPath(bundled), 'utf8')), source: 'remote' };
  }
  let lastErr = null;
  for (const url of urls) {
    try {
      const data = await fetchJson(url);
      try {
        fs.mkdirSync(path.dirname(cachePath(cacheName)), { recursive: true });
        fs.writeFileSync(cachePath(cacheName), JSON.stringify(data), 'utf8');
      } catch {}
      return { data, source: 'remote' };
    } catch (err) {
      lastErr = err;
      log.warn(`[content] ${cacheName}: ${url} недоступен — ${err?.cause?.code || err.message}`);
    }
  }
  {
    const err = lastErr;
    for (const [p, source] of [[cachePath(cacheName), 'cache'], [bundledPath(bundled), 'bundled']]) {
      try {
        return { data: JSON.parse(fs.readFileSync(p, 'utf8')), source };
      } catch {}
    }
    throw err;
  }
}

module.exports = { loadRemoteJson, fetchJson };
