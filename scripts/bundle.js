#!/usr/bin/env node
'use strict';

/**
 * Сборка и обфускация лаунчера перед упаковкой.
 *
 *   1. esbuild собирает каждый процесс (main, preload, renderer) в один файл,
 *      втягивая все локальные модули — по файлам исходники больше не растащить.
 *   2. javascript-obfuscator обфусцирует получившиеся файлы.
 *   3. Статика (HTML, CSS, шрифты, картинки, content/, game/) копируется как есть.
 *
 * Результат кладётся в dist-app/ — именно его упаковывает electron-builder.
 * Внешние пакеты (electron, koffi, electron-updater, electron-log, 7zip-bin)
 * остаются в node_modules и подключаются через require в рантайме.
 */

const esbuild = require('esbuild');
const JsObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-app');

// Пакеты, которые нельзя втягивать в бандл (нативные / грузятся по пути / встроенные)
const EXTERNAL = ['electron', 'electron-updater', 'electron-log', 'electron-log/main', '7zip-bin', 'koffi'];

const OBFUSCATE = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.4,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,
  simplify: true,
  renameGlobals: false,
  selfDefending: false,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayThreshold: 0.8,
  stringArrayEncoding: ['base64'],
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: 'variable',
  transformObjectKeys: false, // ключи API (window.meridian.*) должны остаться читаемыми
  unicodeEscapeSequence: false,
};

async function bundleOne({ entry, outfile, platform, format }) {
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    outfile: path.join(OUT, outfile),
    bundle: true,
    platform,
    format,
    target: platform === 'node' ? 'node20' : 'chrome120',
    external: platform === 'node' ? EXTERNAL : [],
    minify: false,
    legalComments: 'none',
    loader: { '.json': 'json' },
    logLevel: 'warning',
  });
}

async function obfuscateFile(file) {
  const code = await fsp.readFile(file, 'utf8');
  const result = JsObfuscator.obfuscate(code, OBFUSCATE);
  await fsp.writeFile(file, result.getObfuscatedCode(), 'utf8');
}

async function copyDir(from, to, filter) {
  await fsp.mkdir(to, { recursive: true });
  for (const e of await fsp.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) await copyDir(src, dst, filter);
    else if (!filter || filter(src)) await fsp.copyFile(src, dst);
  }
}

(async () => {
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });

  console.log('▶ esbuild: сборка процессов');
  await bundleOne({ entry: 'src/main/main.js', outfile: 'src/main/main.js', platform: 'node', format: 'cjs' });
  await bundleOne({ entry: 'src/preload/preload.js', outfile: 'src/preload/preload.js', platform: 'node', format: 'cjs' });
  await bundleOne({ entry: 'src/renderer/js/app.js', outfile: 'src/renderer/js/app.js', platform: 'browser', format: 'esm' });

  console.log('▶ Статика');
  const R = 'src/renderer';
  await fsp.copyFile(path.join(ROOT, R, 'index.html'), path.join(OUT, R, 'index.html'));
  await fsp.copyFile(path.join(ROOT, R, 'splash.html'), path.join(OUT, R, 'splash.html'));
  await fsp.mkdir(path.join(OUT, R, 'js'), { recursive: true });
  await fsp.copyFile(path.join(ROOT, R, 'js/splash.js'), path.join(OUT, R, 'js/splash.js'));
  await copyDir(path.join(ROOT, R, 'css'), path.join(OUT, R, 'css'));
  await copyDir(path.join(ROOT, R, 'fonts'), path.join(OUT, R, 'fonts'));
  await copyDir(path.join(ROOT, R, 'assets'), path.join(OUT, R, 'assets'));
  await copyDir(path.join(ROOT, 'content'), path.join(OUT, 'content'));
  await copyDir(path.join(ROOT, 'game'), path.join(OUT, 'game'));

  // package.json без devDependencies и скриптов
  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  delete pkg.devDependencies;
  delete pkg.scripts;
  await fsp.writeFile(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2));

  console.log('▶ Обфускация');
  for (const f of ['src/main/main.js', 'src/preload/preload.js', 'src/renderer/js/app.js', 'src/renderer/js/splash.js']) {
    await obfuscateFile(path.join(OUT, f));
    process.stdout.write(`  ✔ ${f}\n`);
  }

  console.log('✔ Готово: dist-app/');
})().catch((e) => { console.error('✖', e); process.exit(1); });
