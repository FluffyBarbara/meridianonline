#!/usr/bin/env node
'use strict';

/**
 * Эталонный список файлов сборки для «Фикса игры»: путь, размер, SHA-256.
 *   node scripts/make-filelist.js <папка игры> <версия> [game/files.json]
 * Вызывается из pack-game.js автоматически.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const SKIP = [/\.log$/i, /^meridian\.json$/i, /^\.meridian-download\//i];

async function walk(root, dir = '', out = []) {
  for (const e of await fsp.readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, rel, out);
    else if (e.isFile() && !SKIP.some((r) => r.test(rel))) out.push(rel);
  }
  return out;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

async function makeFileList(root, version) {
  const files = (await walk(root)).sort((a, b) => a.localeCompare(b));
  const list = [];
  for (const rel of files) {
    const full = path.join(root, rel);
    list.push([rel, (await fsp.stat(full)).size, await sha256(full)]);
  }
  return { version, generatedAt: new Date().toISOString(), files: list };
}

module.exports = { makeFileList };

if (require.main === module) {
  const [src, version, out = path.join(__dirname, '..', 'game', 'files.json')] = process.argv.slice(2);
  if (!src || !version) {
    console.error('Использование: node scripts/make-filelist.js <папка игры> <версия> [файл]');
    process.exit(1);
  }
  makeFileList(path.resolve(src), version).then((data) => {
    fs.writeFileSync(out, JSON.stringify(data) + '\n');
    console.log(`✔ ${data.files.length} файлов → ${out}`);
  });
}
