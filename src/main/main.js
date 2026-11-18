'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, clipboard, globalShortcut } = require('electron');

const log = require('electron-log/main');
const config = require('./config');
const settings = require('./settings');
const updater = require('./updater');
const discord = require('./discord');
const { loadRemoteJson, fetchJson } = require('./content');
const { queryServer } = require('./game/query');
const { GameInstaller } = require('./game/installer');
const { Prereqs } = require('./game/prereqs');
const { GameFixer } = require('./game/fixer');
const safeMode = require('./game/safemode');
const diagnostics = require('./diagnostics');
const { checkGpu } = require('./gpu');
const { launchGame, isInstalled, isGameRunning, getGamePid, validateNickname } = require('./game/launch');
const { GameMemory } = require('./game/memory');
const { PresenceEngine } = require('./game/presence');
const cefpath = require('./game/cefpath');
const filesync = require('./game/filesync');
const { KillSwitch } = require('./game/killswitch');
const sunset = require('./sunset');

const DEV = process.argv.includes('--dev');
const RENDERER = path.join(__dirname, '..', 'renderer');
const ICON = path.join(RENDERER, 'assets', 'icon.png');

let splash = null;
let win = null;
let tray = null;
let manifestCache = null;
let contentCache = null;
let gameRunning = false;

const installer = new GameInstaller();
const prereqs = new Prereqs(path.join(app.getPath('userData'), 'redist'));
const fixer = new GameFixer({ prereqs, documentsDir: app.getPath('documents') });

// Сочетание клавиш «закрыть зависшую игру» (активно только пока игра запущена)
let gameKilled = false;
let watchedManifest = null;
const killSwitch = new KillSwitch({
  isRunning: () => isGameRunning(watchedManifest),
  onResult: (r) => {
    if (r.ok) gameKilled = true;
    else showMain();
    send('game:killed', r);
  },
});

// ───────────────────────── Один экземпляр ─────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
}

app.setAppUserModelId(config.APP_ID);

// ───────────────────────── Окна ─────────────────────────
function baseWebPrefs() {
  return {
    preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    devTools: DEV,
  };
}

function hardenContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
}

function createSplash() {
  splash = new BrowserWindow({
    width: 440,
    height: 300,
    frame: false,
    resizable: false,
    transparent: true,
    show: false,
    center: true,
    skipTaskbar: false,
    icon: ICON,
    title: config.APP_NAME,
    webPreferences: baseWebPrefs(),
  });
  hardenContents(splash.webContents);
  splash.loadFile(path.join(RENDERER, 'splash.html'));
  splash.once('ready-to-show', () => splash.show());
  splash.on('closed', () => { splash = null; });
}

function createSunset() {
  win = new BrowserWindow({
    width: 560,
    height: 460,
    frame: false,
    resizable: false,
    maximizable: false,
    show: false,
    center: true,
    backgroundColor: '#0a0f1b',
    icon: ICON,
    title: config.APP_NAME,
    webPreferences: baseWebPrefs(),
  });
  hardenContents(win.webContents);
  win.loadFile(path.join(RENDERER, 'sunset.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (splash) setTimeout(() => splash?.close(), 150);
  });
  // Закрыли окно без выбора → по умолчанию удаляем и файлы игры (так решил владелец проекта).
  // Лаунчер удаляется в любом случае.
  win.on('close', (e) => {
    if (sunsetHandled) return;
    e.preventDefault();
    doSunsetRemoval(true);
  });
  win.on('closed', () => { win = null; });
}

// Удаление при закрытии проекта. Гарантированно удаляет лаунчер; папку игры —
// по выбору (кнопка) или по умолчанию при закрытии окна.
let sunsetHandled = false;
async function doSunsetRemoval(deleteGame) {
  if (sunsetHandled) return { already: true };
  sunsetHandled = true;
  let r;
  try {
    r = await sunset.remove({ deleteGame, gameDir: settings.get('gameDir') });
  } catch (err) {
    r = { ok: false, error: err.message };
  }
  setTimeout(() => app.exit(0), r && r.ok ? 1200 : 3000);
  return r;
}

function createMain() {
  win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 1280,
    minHeight: 760,
    frame: false,
    resizable: false,
    maximizable: false,
    show: false,
    center: true,
    backgroundColor: '#070b14',
    icon: ICON,
    title: config.APP_NAME,
    webPreferences: baseWebPrefs(),
  });
  hardenContents(win.webContents);
  win.loadFile(path.join(RENDERER, 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (splash) setTimeout(() => splash?.close(), 150);
    if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  });
  win.on('closed', () => { win = null; });
}

function showMain() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip(config.APP_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть лаунчер', click: showMain },
      { label: 'Закрыть зависшую игру', click: () => { if (gameRunning) killSwitch.trigger('tray'); } },
      { type: 'separator' },
      { label: 'Выход', click: () => app.quit() },
    ]));
    tray.on('click', showMain);
  } catch {}
}

// ───────────────────────── Данные ─────────────────────────
function defaultContent() {
  return { servers: [config.DEFAULT_SERVER], news: [], slides: [], links: {}, socials: [] };
}

async function getContent(force = false) {
  if (contentCache && !force) return contentCache;
  try {
    const { data, source } = await loadRemoteJson({
      urls: config.CONTENT_URLS, cacheName: 'launcher', bundled: 'content/launcher.json',
    });
    contentCache = { ...defaultContent(), ...data, _source: source };
    // Новости из хранилища (news.json в бакете), формат { news: [ { title, text, date: "15.11.2026" } ] }
    if (contentCache.newsUrl) {
      try {
        const remote = await fetchJson(contentCache.newsUrl);
        const list = Array.isArray(remote) ? remote : remote?.news;
        if (Array.isArray(list) && list.length) {
          const iso = (d) => {
            const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(String(d || ''));
            return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : d;
          };
          contentCache.news = list
            .filter((n) => n && n.title)
            .map((n) => ({ title: n.title, text: n.text || '', date: iso(n.date), tag: n.tag || '', url: n.url || '', image: n.image || '' }));
        }
      } catch (err) {
        log.warn('[content] новости из хранилища недоступны:', err.message);
      }
    }
  } catch {
    contentCache = { ...defaultContent(), _source: 'default' };
  }
  if (!Array.isArray(contentCache.servers) || !contentCache.servers.length) {
    contentCache.servers = [config.DEFAULT_SERVER];
  }
  return contentCache;
}

async function getManifest(force = false) {
  if (manifestCache && !force) return manifestCache;
  try {
    const { data, source } = await loadRemoteJson({
      urls: config.GAME_MANIFEST_URLS, cacheName: 'manifest', bundled: 'game/manifest.json',
    });
    manifestCache = { ...data, _source: source };
  } catch {
    manifestCache = { version: null, archives: [], _source: 'none' };
  }
  return manifestCache;
}

/** Эталонный список файлов сборки (для «Фикса игры»). null — если не совпадает с версией сборки. */
// Пофайловый манифест хранилища (game/manifest.json → "files"), кешируется на 2 минуты
let filesManifestCache = { at: 0, data: null };
const isFilesMode = (m) => !!(m?.files?.baseUrl && m?.files?.manifestUrl);
async function getFilesManifest(manifest, force = false) {
  if (!isFilesMode(manifest)) return null;
  if (!force && filesManifestCache.data && Date.now() - filesManifestCache.at < 120000) return filesManifestCache.data;
  try {
    filesManifestCache = { at: Date.now(), data: await filesync.fetchManifest(manifest.files.manifestUrl) };
  } catch (err) {
    log.warn('[files] манифест хранилища недоступен:', err.message);
  }
  return filesManifestCache.data;
}

async function getFileList(manifest) {
  // В пофайловом режиме эталон — манифест хранилища
  if (isFilesMode(manifest)) {
    const fm = await getFilesManifest(manifest);
    return fm ? { version: fm.version, files: fm.files.map((f) => [f.path, f.size, f.sha256]) } : null;
  }
  try {
    const { data } = await loadRemoteJson({
      urls: config.GAME_FILES_URLS, cacheName: 'files', bundled: 'game/files.json',
    });
    return data && data.version === manifest.version ? data : null;
  } catch {
    return null;
  }
}

function cmpVersion(a, b) {
  const pa = String(a || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

function installedVersion(gameDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(gameDir, 'meridian.json'), 'utf8')).version || null;
  } catch {
    return settings.get('installedVersion');
  }
}

async function gameStatus(force = false) {
  const manifest = await getManifest(force);
  const gameDir = settings.get('gameDir');
  const installed = isInstalled(gameDir, manifest);
  const current = installed ? installedVersion(gameDir) : null;
  const filesMode = isFilesMode(manifest);
  const remoteFiles = filesMode ? await getFilesManifest(manifest, force) : null;
  const published = filesMode ? !!remoteFiles : (Array.isArray(manifest.archives) && manifest.archives.length > 0);
  const downloadSize = filesMode
    ? (remoteFiles ? remoteFiles.files.reduce((s, f) => s + f.size, 0) : 0)
    : (manifest.archives || []).reduce((s, a) => s + (a.size || 0), 0);
  const latestVersion = filesMode ? (remoteFiles?.version || null) : (manifest.version || null);
  const partial = published ? await installer.partialBytes(gameDir, manifest) : 0;
  return {
    gameDir,
    installed,
    installedVersion: current,
    latestVersion,
    published,
    // пофайловый режим: версия — метка сборки, любое отличие = обновление (качается только разница)
    needsUpdate: installed && published && (filesMode ? current !== latestVersion : (!!current && cmpVersion(manifest.version, current) > 0)),
    // файлы есть, но синхронизация с хранилищем не завершалась (оборвалась или папка без отметки)
    incomplete: filesMode && installed && !current,
    downloadSize,
    filesMode,
    unpackedSize: filesMode ? downloadSize : (manifest.unpackedSize || null),
    partialBytes: partial,
    installerState: installer.progress,
    online: manifest._source === 'remote',
    running: gameRunning,
  };
}

// ───────────────────────── Discord ─────────────────────────
const launcherStartedAt = Date.now();
let gameSession = null; // { server, startedAt }

// Активность в игре: читаем состояние игрока из памяти gta_sa.exe (только чтение)
const memory = new GameMemory();
const presenceEngine = new PresenceEngine();
let presenceTimer = null;
let gameActivity = null; // { details, state, icon, iconText }
let serverOnline = null; // { players, maxPlayers }
let installActivity = null; // статус во время установки игры
let lastPresence = { key: '', at: 0 };

function startPresenceLoop(manifest) {
  stopPresenceLoop();
  presenceEngine.reset();
  let tick = 0;
  presenceTimer = setInterval(async () => {
    const cfg = contentCache?.discord?.presence || {};
    if (cfg.enabled === false || !gameSession) return;
    const server = gameSession.server;
    if (tick++ % 10 === 0 && server) {
      queryServer(server.ip, server.port, { name: server.name, queryPort: server.queryPort, statusUrl: server.statusUrl }).then((q) => { serverOnline = q.online === true ? q : null; }).catch(() => {});
    }
    if (!memory.available) return; // не Windows или koffi недоступен — останется простой статус
    if (!memory.handle) {
      const pid = await getGamePid(manifest);
      if (pid && !memory.attach(pid)) log.warn('[presence] нет доступа к памяти игры (игра запущена от администратора?)');
    }
    const snap = memory.handle ? memory.snapshot() : null;
    if (memory.handle && !snap) memory.detach(); // процесс закрылся
    gameActivity = memory.handle ? presenceEngine.build(snap, { server, cfg }) : null;
    updatePresence();
  }, 3000);
}

function stopPresenceLoop() {
  clearInterval(presenceTimer);
  presenceTimer = null;
  memory.detach();
  gameActivity = null;
  serverOnline = null;
}

const clip = (s, n = 128) => {
  s = String(s || '').trim();
  if (s.length < 2) s = `${s}  `.slice(0, 2);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function updatePresence(force = false) {
  const d = contentCache?.discord || {};
  discord.configure({
    clientId: d.clientId || config.DISCORD_CLIENT_ID,
    enabled: settings.get('discordPresence') !== false && d.enabled !== false,
  });
  const assets = {
    large_image: d.largeImage || config.DISCORD_LARGE_IMAGE,
    large_text: 'Meridian Online',
  };
  const buttons = (d.buttons || [])
    .filter((b) => b && b.label && /^https?:\/\//.test(b.url))
    .slice(0, 2)
    .map((b) => ({ label: String(b.label).slice(0, 32), url: b.url }));

  let activity;
  if (gameRunning && gameSession) {
    const server = gameSession.server || {};
    const g = gameActivity;
    const iconBase = d.presence?.iconBase || config.DISCORD_ICON_BASE;
    activity = {
      details: clip(g?.details || (d.gameText || 'Проводит время на Meridian Online | {server}').replace('{server}', server.name || '')),
      timestamps: { start: gameSession.startedAt },
      assets: { ...assets, large_text: `Meridian Online · ${server.name || ''}` },
    };
    if (g?.state) activity.state = clip(g.state);
    if (g?.icon) Object.assign(activity.assets, { small_image: `${iconBase}${g.icon}.png`, small_text: clip(g.iconText) });
    if (serverOnline?.maxPlayers && d.presence?.showOnline !== false) {
      const max = serverOnline.maxPlayers;
      activity.party = { id: `meridian-${server.id || 'server'}`, size: [Math.min(Math.max(1, serverOnline.players || 1), max), max] };
    }
  } else if (installActivity) {
    activity = {
      details: clip(installActivity.details),
      state: clip(installActivity.state),
      timestamps: { start: launcherStartedAt },
      assets: { ...assets, small_image: `${d.presence?.iconBase || config.DISCORD_ICON_BASE}loading.png`, small_text: 'Установка' },
    };
  } else {
    activity = {
      details: d.launcherText || 'Смотрит лаунчер',
      timestamps: { start: launcherStartedAt },
      assets,
    };
  }
  if (buttons.length) activity.buttons = buttons;

  // Discord ограничивает частоту обновлений: не чаще раза в 4 с и только при изменениях
  const key = JSON.stringify([activity.details, activity.state, activity.assets.small_image, activity.party?.size]);
  const now = Date.now();
  if (!force && key === lastPresence.key && now - lastPresence.at < 60000) return;
  if (!force && now - lastPresence.at < 4000) return;
  lastPresence = { key, at: now };
  discord.setActivity(activity);
}

let lastLaunch = null;
let deepNextInstall = false;

// Драйвер видеокарты: результат «всё хорошо» кешируем, проблему перепроверяем (вдруг уже поставили драйвер)
let gpuCache = null;
async function getGpu(force = false) {
  if (gpuCache && !gpuCache.problem && !force) return gpuCache;
  gpuCache = await checkGpu();
  if (gpuCache.problem) log.warn('[gpu] драйвер видеокарты не установлен:', JSON.stringify(gpuCache));
  return gpuCache;
}

// ───────────────────────── Слежение за игрой ─────────────────────────
let watchTimer = null;
function watchGame(manifest, server) {
  clearInterval(watchTimer);
  let seen = false;
  let seenAt = 0;
  const startedAt = Date.now();
  gameRunning = true;
  gameSession = { server, startedAt };
  gameKilled = false;
  watchedManifest = manifest;
  const hk = killSwitch.arm(settings.get('killHotkey'));
  send('game:running', true);
  send('game:hotkey', hk);
  updatePresence(true);
  startPresenceLoop(manifest);
  watchTimer = setInterval(async () => {
    const running = await isGameRunning(manifest);
    if (running && !seen) { seen = true; seenAt = Date.now(); }
    const gaveUp = !seen && Date.now() - startedAt > 60000;
    if ((seen && !running) || gaveUp) {
      clearInterval(watchTimer);
      gameRunning = false;
      gameSession = null;
      killSwitch.disarm();
      const killed = gameKilled;
      gameKilled = false;
      stopPresenceLoop();
      send('game:running', false);
      updatePresence(true);
      // Игра закрылась почти сразу — скорее всего вылет: подскажем «Фикс игры»
      const played = seen ? Math.round((Date.now() - seenAt) / 1000) : 0;
      if (lastLaunch) Object.assign(lastLaunch, { playedSeconds: played, processSeen: seen });
      log.info(`[launch] игра закрылась: ${seen ? `через ${played} с` : 'процесс не появился'}`);
      safeMode.restore(settings);
      if (killed) log.info('[launch] игра была закрыта сочетанием клавиш');
      send('game:exited', { seconds: played, neverStarted: !seen, safeMode: settings.get('safeMode') === true, killed });
      const after = settings.get('afterLaunch');
      // «Закрыть»: лаунчер ждал в трее ради сочетания клавиш — теперь выходим (после зависания — показываем окно)
      if (after === 'close' && !killed) { app.quit(); return; }
      // Не разворачиваем лаунчер, если процесс так и не нашли: это могло бы украсть фокус у игры
      if (seen && (after !== 'keep' || killed)) showMain();
    }
  }, 3000);
}

// ───────────────────────── IPC ─────────────────────────
function registerIpc() {
  ipcMain.handle('sunset:info', () => sunset.gameInfo(settings.get('gameDir')));

  ipcMain.handle('sunset:remove', (_e, opts = {}) => doSunsetRemoval(!!opts.deleteGame));

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    repo: `https://github.com/${config.REPO_OWNER}/${config.REPO_NAME}`,
  }));

  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on('window:close', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w === win && (installer.busy || prereqs.busy)) {
      // Не убиваем загрузку — прячем в трей
      createTray();
      w.hide();
      return;
    }
    w?.close();
  });

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const res = settings.set(patch);
    if (patch && 'discordPresence' in patch) updatePresence(true);
    if (patch && 'killHotkey' in patch && gameRunning) send('game:hotkey', killSwitch.arm(patch.killHotkey));
    return res;
  });

  ipcMain.handle('content:get', (_e, force) => getContent(force));

  ipcMain.handle('game:status', (_e, force) => gameStatus(force));

  ipcMain.handle('game:install', async () => {
    const manifest = await getManifest(true);
    const gameDir = settings.get('gameDir');
    const deep = deepNextInstall;
    deepNextInstall = false;
    const result = await installer.install(manifest, gameDir, { deep });
    if (result.ok) filesManifestCache.at = 0;
    if (result.ok) {
      settings.set({ installedVersion: result.version });
      // Сразу ставим DirectX / Visual C++, если их нет
      result.prereqs = await prereqs.install(manifest);
    }
    return result;
  });
  ipcMain.handle('game:pause', () => installer.pause());
  ipcMain.handle('game:cancel', () => installer.discard(settings.get('gameDir')));

  ipcMain.handle('game:launch', async (_e, serverId, opts = {}) => {
    if (gameRunning) return { ok: false, error: 'Игра уже запущена' };
    const content = await getContent();
    const server = content.servers.find((s) => s.id === serverId) || content.servers[0];
    const manifest = await getManifest();
    if (!opts.skipGpu) {
      const gpu = await getGpu();
      if (gpu.problem) return { ok: false, needDriver: gpu.problem };
    }
    if (!opts.skipPrereqs) {
      const missing = await prereqs.missing(manifest);
      if (missing.length) return { ok: false, needPrereqs: missing.map((p) => p.name) };
    }
    // Убираем окно лаунчера ДО запуска: если игра потеряет фокус во время загрузки,
    // samp.dll падает (ShowCursor на ещё не созданном устройстве Direct3D).
    const after = settings.get('afterLaunch');
    if (win && after !== 'keep') {
      if (after === 'hide' || after === 'close') { createTray(); win.hide(); } else win.minimize();
    }
    const gameDir = settings.get('gameDir');
    const safe = settings.get('safeMode') === true;
    // Путь к «Документам» с кириллицей ломает интерфейс omp-cef (ERR_FAILED) — чиним до запуска
    try {
      const r = await cefpath.ensure(app.getPath('documents'));
      if (r.status !== 'not-needed' && r.status !== 'ok') log.info('[cefpath]', r.status, r.text);
    } catch (err) {
      log.warn('[cefpath]', err.message);
    }
    try {
      if (safe) await safeMode.disable(gameDir, manifest, settings);
      const run = await launchGame({
        gameDir,
        nickname: settings.get('nickname'),
        server,
        manifest,
      });
      lastLaunch = { at: new Date().toISOString(), gameDir, exe: run.exe, args: run.args, safeMode: safe, server: `${server.name} ${server.ip}:${server.port}` };
      log.info('[launch]', JSON.stringify(lastLaunch));
    } catch (err) {
      log.warn('[launch] ошибка:', err.message);
      await safeMode.restore(settings);
      if (win && after !== 'keep') showMain();
      return { ok: false, error: err.message };
    }
    watchGame(manifest, server);
    // «Закрыть»: если включено сочетание «закрыть зависшую игру», лаунчер ждёт в трее до выхода из игры
    if (after === 'close' && settings.get('killHotkey') === 'off') setTimeout(() => app.quit(), 3000);
    return { ok: true };
  });

  // Своё сочетание «закрыть зависшую игру»: проверка перед сохранением
  ipcMain.handle('hotkey:validate', (_e, accel) => killSwitch.validate(accel));

  ipcMain.handle('game:kill', async () => {
    if (!gameRunning) return { ok: false, error: 'Игра не запущена' };
    await killSwitch.trigger('launcher');
    return { ok: true };
  });

  ipcMain.handle('game:fix', async (_e, options = {}) => {
    if (installer.busy || prereqs.busy) return { ok: false, error: 'Дождитесь окончания установки' };
    if (gameRunning) return { ok: false, error: 'Сначала закройте игру' };
    const manifest = await getManifest(true);
    const gameDir = settings.get('gameDir');
    if (!isInstalled(gameDir, manifest)) return { ok: false, error: 'Игра не установлена — нажмите «Установить»' };
    const fileList = await getFileList(manifest);
    await safeMode.restore(settings);
    const result = await fixer.run({
      gameDir,
      manifest,
      fileList,
      nickname: settings.get('nickname'),
      options: { components: options.components !== false, defender: options.defender !== false, resetSettings: options.resetSettings !== false },
    });
    const gpu = await getGpu(true);
    if (gpu.checked && result.steps) {
      result.steps.unshift(gpu.problem
        ? { id: 'gpu', title: 'Драйвер видеокарты', status: 'fail', text: `Не установлен — Windows работает через «${gpu.problem.adapter}». Без драйвера${gpu.problem.vendorName ? ` ${gpu.problem.vendorName}` : ''} GTA не может запуститься` }
        : { id: 'gpu', title: 'Драйвер видеокарты', status: 'ok', text: gpu.adapters.join(', ') });
      if (gpu.problem) result.driver = gpu.problem;
    }
    log.info('[fix]', JSON.stringify(result));
    return result;
  });

  ipcMain.handle('support:report', async () => {
    try {
      const manifest = await getManifest();
      const text = await diagnostics.buildReport({
        gameDir: settings.get('gameDir'),
        nickname: settings.get('nickname'),
        manifest,
        fileList: await getFileList(manifest),
        prereqs,
        launcherVersion: app.getVersion(),
        lastLaunch,
        gpu: await getGpu(true),
      });
      const file = await diagnostics.saveReport(text);
      try { clipboard.writeText(text); } catch {}
      shell.showItemInFolder(file);
      return { ok: true, file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('prereqs:check', async () => prereqs.check(await getManifest()));
  ipcMain.handle('prereqs:install', async () => prereqs.install(await getManifest()));

  ipcMain.handle('game:validate-nick', (_e, nick) => validateNickname(nick));

  ipcMain.handle('game:choose-dir', async () => {
    if (installer.busy) return { ok: false, error: 'Дождитесь окончания загрузки' };
    const res = await dialog.showOpenDialog(win, {
      title: 'Папка для игры Meridian Online',
      defaultPath: settings.get('gameDir'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    const dir = res.filePaths[0];
    const manifest = await getManifest();
    const patch = { gameDir: dir };
    // Указали папку с уже установленной игрой — считаем её текущей версией.
    if (isInstalled(dir, manifest) && !fs.existsSync(path.join(dir, 'meridian.json'))) {
      patch.installedVersion = manifest.version || null;
      try {
        fs.writeFileSync(path.join(dir, 'meridian.json'), JSON.stringify({ version: manifest.version, linkedAt: new Date().toISOString() }, null, 2));
      } catch {}
    }
    settings.set(patch);
    return { ok: true, dir };
  });

  ipcMain.handle('game:open-dir', async () => {
    const dir = settings.get('gameDir');
    if (fs.existsSync(dir)) await shell.openPath(dir);
    return fs.existsSync(dir);
  });

  ipcMain.handle('game:reinstall', async () => {
    const dir = settings.get('gameDir');
    deepNextInstall = true; // в пофайловом режиме — перепроверить хеши всех файлов и докачать испорченные
    try { fs.unlinkSync(path.join(dir, 'meridian.json')); } catch {}
    settings.set({ installedVersion: null });
    return true;
  });

  ipcMain.handle('server:query', async (_e, ids) => {
    const content = await getContent();
    const list = content.servers.filter((s) => !ids || ids.includes(s.id));
    const results = await Promise.all(list.map(async (s) => ({ id: s.id, ...(await queryServer(s.ip, s.port, { name: s.name, queryPort: s.queryPort, statusUrl: s.statusUrl })) })));
    return results;
  });

  ipcMain.handle('shell:open', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  // Центр обновления Windows → необязательные обновления (там Windows предлагает драйверы)
  ipcMain.handle('shell:windows-update', () => shell.openExternal('ms-settings:windowsupdate-optionalupdates'));
  ipcMain.handle('gpu:check', (_e, force) => getGpu(force));

  ipcMain.handle('updater:check', () => updater.check());
  ipcMain.handle('updater:install', () => updater.install());
  ipcMain.handle('updater:status', () => updater.status);

  installer.on('progress', (p) => {
    send('game:progress', p);
    // Статус в Discord во время установки игры
    const prev = installActivity?.state;
    if (p.state === 'downloading') installActivity = { details: 'Устанавливает Meridian Online', state: `Загрузка игры · ${Math.floor((p.percent || 0) / 5) * 5}%` };
    else if (p.state === 'extracting') installActivity = { details: 'Устанавливает Meridian Online', state: 'Распаковка файлов' };
    else if (p.state === 'verifying' || p.state === 'preparing') installActivity = { details: 'Устанавливает Meridian Online', state: 'Подготовка' };
    else installActivity = null;
    if (installActivity?.state !== prev) updatePresence(!installActivity);
  });
  prereqs.on('progress', (p) => {
    if (p.state === 'prereq-done') { if (!fixer.busy) send('game:progress', { state: 'idle' }); } else send('game:progress', p);
  });
  fixer.on('progress', (p) => send('game:progress', p));
  updater.on('status', (s) => {
    send('updater:status', s);
    if (splash && !splash.isDestroyed()) splash.webContents.send('updater:status', s);
  });
}

// ───────────────────────── Старт ─────────────────────────
app.whenReady().then(async () => {
  registerIpc();
  // Если в прошлый раз лаунчер закрылся посреди безопасного запуска — возвращаем моды на место
  safeMode.restore(settings);
  createSplash();

  // Проект закрыт: финальная версия лаунчера показывает экран закрытия и удаляет сама себя
  if (sunset.isSunset()) {
    createSunset();
    return;
  }

  // Пока проверяем обновление лаунчера — параллельно подтягиваем контент
  getContent();
  getManifest();

  const result = await updater.checkOnStartup();
  if (result === 'installing') return; // лаунчер перезапустится уже новой версией

  createMain();
  getContent().then(updatePresence);
  // Новый контент (например, Application ID Discord) подхватываем раз в 10 минут
  setInterval(() => getContent(true).then(updatePresence).catch(() => {}), 10 * 60 * 1000);

  // Фоновая проверка обновлений лаунчера каждые 30 минут
  setInterval(() => updater.check(), 30 * 60 * 1000);
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
});

app.on('before-quit', () => {
  if (installer.busy) installer.pause();
  discord.disconnect();
});

app.on('window-all-closed', () => {
  if (!installer.busy && !prereqs.busy) app.quit();
});
