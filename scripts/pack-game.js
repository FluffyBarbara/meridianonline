#!/usr/bin/env node
'use strict';

/**
 * Упаковка сборки игры для раздачи через лаунчер.
 *
 *   npm run pack-game -- --src "E:\Meridian\Meridian Online" --version 1.0.0
 *   npm run pack-game -- --src "E:\Meridian\Meridian Online" --version 1.0.0 --upload
 *
 * Что делает:
 *   1. Пакует содержимое папки игры в 7z-архив, порезанный на тома по 1900 МБ
 *      (лимит GitHub на один файл релиза — 2 ГБ).
 *   2. Считает SHA-256 каждого тома и размер распакованной игры.
 *   3. Обновляет game/manifest.json (блок "launch" сохраняется).
 *   4. С флагом --upload создаёт pre-release "game-<версия>" в GitHub и загружает тома
 *      (нужен токен в переменной окружения GITHUB_TOKEN с правом Contents: write).
 *
 * После этого закоммитьте game/manifest.json в main — лаунчеры игроков увидят новую сборку.
 *
 * Параметры:
 *   --src <папка>        папка с готовой игрой (где лежит gta_sa.exe)
 *   --version <x.y.z>    версия сборки
 *   --volume <размер>    размер тома, по умолчанию 1900m
 *   --level <0-9>        степень сжатия 7z, по умолчанию 7
 *   --base-url <url>     свой хостинг вместо GitHub Releases (URL папки с томами)
 *   --upload             загрузить тома в GitHub Releases
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const OWNER = 'FluffyBarbara';
const REPO = 'meridianonline';
const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'game', 'manifest.json');
const OUT = path.join(ROOT, 'dist-game');

function args() {
  const a = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
    o[k] = v;
  }
  return o;
}

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

async function dirSize(dir) {
  let sum = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sum += await dirSize(p);
    else if (e.isFile()) sum += (await fsp.stat(p)).size;
  }
  return sum;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function run7z(argv, cwd) {
  const bin = require('7zip-bin').path7za;
  if (process.platform !== 'win32') try { fs.chmodSync(bin, 0o755); } catch {}
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (d) => {
      const m = String(d).match(/(\d{1,3})%/g);
      if (m) process.stdout.write(`\r  Упаковка: ${m[m.length - 1].padStart(4)}`);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      process.stdout.write('\n');
      code === 0 ? resolve() : reject(new Error(`7-Zip завершился с кодом ${code}`));
    });
  });
}

const gb = (n) => `${(n / 1073741824).toFixed(2)} ГБ`;

async function gh(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${data?.message || text}`);
  return data;
}

async function upload(version, files, token) {
  const tag = `game-${version}`;
  let release;
  try {
    release = await gh('GET', `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${tag}`, token);
    console.log(`  Релиз ${tag} уже есть — дозагружаю тома`);
  } catch {
    release = await gh('POST', `https://api.github.com/repos/${OWNER}/${REPO}/releases`, token, {
      tag_name: tag,
      name: `Сборка игры ${version}`,
      body: 'Файлы игры для лаунчера Meridian Online. Не скачивайте вручную — установите лаунчер.',
      prerelease: true, // pre-release не мешает автообновлению лаунчера
      make_latest: 'false',
    });
    console.log(`  Создан релиз ${tag}`);
  }
  const existing = new Set((release.assets || []).map((a) => a.name));

  for (const f of files) {
    const name = path.basename(f);
    if (existing.has(name)) { console.log(`  ✔ ${name} уже загружен`); continue; }
    const size = (await fsp.stat(f)).size;
    let sent = 0;
    const stream = fs.createReadStream(f, { highWaterMark: 8 * 1024 * 1024 });
    stream.on('data', (d) => {
      sent += d.length;
      process.stdout.write(`\r  ↑ ${name}: ${((sent / size) * 100).toFixed(1)}%   `);
    });
    const res = await fetch(
      `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(size),
        },
        body: stream,
        duplex: 'half',
      },
    );
    process.stdout.write('\n');
    if (!res.ok) throw new Error(`Не удалось загрузить ${name}: ${res.status} ${await res.text()}`);
  }
}

(async () => {
  const o = args();
  if (!o.src || !o.version) fail('Укажите --src <папка игры> и --version <x.y.z>');
  const src = path.resolve(String(o.src));
  const version = String(o.version);
  if (!fs.existsSync(path.join(src, 'gta_sa.exe'))) fail(`В папке ${src} нет gta_sa.exe — это точно папка игры?`);

  const base = `MeridianOnline-${version}`;
  await fsp.mkdir(OUT, { recursive: true });
  for (const f of await fsp.readdir(OUT)) if (f.startsWith(`${base}.7z`)) await fsp.unlink(path.join(OUT, f));

  console.log(`\n▶ Сборка ${version} из ${src}`);
  const unpackedSize = await dirSize(src);
  console.log(`  Размер игры: ${gb(unpackedSize)}`);

  await run7z([
    'a', '-t7z', `-mx=${o.level || 7}`, '-mmt=on', `-v${o.volume || '1900m'}`, '-bsp1', '-bso0',
    '-xr!.meridian-download', '-x!meridian.json', '-xr!*.log',
    path.join(OUT, `${base}.7z`), '*',
  ], src);

  const files = (await fsp.readdir(OUT)).filter((f) => f.startsWith(`${base}.7z`)).sort().map((f) => path.join(OUT, f));
  const baseUrl = o['base-url']
    ? String(o['base-url']).replace(/\/$/, '')
    : `https://github.com/${OWNER}/${REPO}/releases/download/game-${version}`;

  const archives = [];
  for (const f of files) {
    process.stdout.write(`  SHA-256 ${path.basename(f)}… `);
    const size = (await fsp.stat(f)).size;
    const hash = await sha256(f);
    console.log(gb(size));
    archives.push({ name: path.basename(f), url: `${baseUrl}/${encodeURIComponent(path.basename(f))}`, size, sha256: hash });
  }

  if (o.upload) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) fail('Для --upload задайте переменную окружения GITHUB_TOKEN');
    console.log('\n▶ Загрузка в GitHub Releases');
    await upload(version, files, token);
  }

  const manifest = JSON.parse(await fsp.readFile(MANIFEST, 'utf8'));
  Object.assign(manifest, { version, unpackedSize, archives, publishedAt: new Date().toISOString() });
  await fsp.writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`\n✔ Готово. Тома лежат в ${OUT}`);
  console.log('  game/manifest.json обновлён — закоммитьте его в ветку main.');
  if (!o.upload && !o['base-url']) {
    console.log(`  Загрузите тома в релиз с тегом game-${version} (отметьте «Set as a pre-release»).`);
  }
})().catch((e) => fail(e.message));
