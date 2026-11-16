'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Загрузка JSON из репозитория с кешем на диске и запасной копией внутри лаунчера.
 * Порядок: сеть → кеш последней удачной загрузки → встроенная копия.
 */

async function fetchJson(url, timeout = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    // Параметр против кеша CDN raw.githubusercontent.com
    const res = await fetch(`${url}?t=${Date.now()}`, {
      signal: ctrl.signal,
      headers: { 'Cache-Control': 'no-cache' },
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

async function loadRemoteJson({ url, cacheName, bundled }) {
  try {
    const data = await fetchJson(url);
    try {
      fs.mkdirSync(path.dirname(cachePath(cacheName)), { recursive: true });
      fs.writeFileSync(cachePath(cacheName), JSON.stringify(data), 'utf8');
    } catch {}
    return { data, source: 'remote' };
  } catch (err) {
    for (const [p, source] of [[cachePath(cacheName), 'cache'], [bundledPath(bundled), 'bundled']]) {
      try {
        return { data: JSON.parse(fs.readFileSync(p, 'utf8')), source };
      } catch {}
    }
    throw err;
  }
}

module.exports = { loadRemoteJson, fetchJson };
