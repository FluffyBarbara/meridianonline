'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage } = require('electron');

const config = require('./config');
const settings = require('./settings');
const updater = require('./updater');
const { loadRemoteJson } = require('./content');
const { queryServer } = require('./game/query');
const { GameInstaller } = require('./game/installer');
const { Prereqs } = require('./game/prereqs');
const { launchGame, isInstalled, isGameRunning, validateNickname } = require('./game/launch');

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
  const published = Array.isArray(manifest.archives) && manifest.archives.length > 0;
  const downloadSize = (manifest.archives || []).reduce((s, a) => s + (a.size || 0), 0);
  const partial = published ? await installer.partialBytes(gameDir, manifest) : 0;
  return {
    gameDir,
    installed,
    installedVersion: current,
    latestVersion: manifest.version || null,
    published,
    needsUpdate: installed && published && !!current && cmpVersion(manifest.version, current) > 0,
    downloadSize,
    unpackedSize: manifest.unpackedSize || null,
    partialBytes: partial,
    installerState: installer.progress,
    online: manifest._source === 'remote',
    running: gameRunning,
  };
}

// ───────────────────────── Слежение за игрой ─────────────────────────
let watchTimer = null;
function watchGame(manifest) {
  clearInterval(watchTimer);
  let seen = false;
  const startedAt = Date.now();
  gameRunning = true;
  send('game:running', true);
  watchTimer = setInterval(async () => {
    const running = await isGameRunning(manifest);
    if (running) seen = true;
    const gaveUp = !seen && Date.now() - startedAt > 45000;
    if ((seen && !running) || gaveUp) {
      clearInterval(watchTimer);
      gameRunning = false;
      send('game:running', false);
      if (settings.get('afterLaunch') !== 'keep') showMain();
    }
  }, 3000);
}

// ───────────────────────── IPC ─────────────────────────
function registerIpc() {
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
  ipcMain.handle('settings:set', (_e, patch) => settings.set(patch));

  ipcMain.handle('content:get', (_e, force) => getContent(force));

  ipcMain.handle('game:status', (_e, force) => gameStatus(force));

  ipcMain.handle('game:install', async () => {
    const manifest = await getManifest(true);
    const gameDir = settings.get('gameDir');
    const result = await installer.install(manifest, gameDir);
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
    if (!opts.skipPrereqs) {
      const missing = await prereqs.missing(manifest);
      if (missing.length) return { ok: false, needPrereqs: missing.map((p) => p.name) };
    }
    try {
      await launchGame({
        gameDir: settings.get('gameDir'),
        nickname: settings.get('nickname'),
        server,
        manifest,
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    watchGame(manifest);
    const after = settings.get('afterLaunch');
    setTimeout(() => {
      if (!win) return;
      if (after === 'minimize') win.minimize();
      else if (after === 'hide') { createTray(); win.hide(); }
      else if (after === 'close') app.quit();
    }, 1200);
    return { ok: true };
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
    try { fs.unlinkSync(path.join(dir, 'meridian.json')); } catch {}
    settings.set({ installedVersion: null });
    return true;
  });

  ipcMain.handle('server:query', async (_e, ids) => {
    const content = await getContent();
    const list = content.servers.filter((s) => !ids || ids.includes(s.id));
    const results = await Promise.all(list.map(async (s) => ({ id: s.id, ...(await queryServer(s.ip, s.port)) })));
    return results;
  });

  ipcMain.handle('shell:open', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('updater:check', () => updater.check());
  ipcMain.handle('updater:install', () => updater.install());
  ipcMain.handle('updater:status', () => updater.status);

  installer.on('progress', (p) => send('game:progress', p));
  prereqs.on('progress', (p) => send('game:progress', p.state === 'prereq-done' ? { state: 'idle' } : p));
  updater.on('status', (s) => {
    send('updater:status', s);
    if (splash && !splash.isDestroyed()) splash.webContents.send('updater:status', s);
  });
}

// ───────────────────────── Старт ─────────────────────────
app.whenReady().then(async () => {
  registerIpc();
  createSplash();

  // Пока проверяем обновление лаунчера — параллельно подтягиваем контент
  getContent();
  getManifest();

  const result = await updater.checkOnStartup();
  if (result === 'installing') return; // лаунчер перезапустится уже новой версией

  createMain();

  // Фоновая проверка обновлений лаунчера каждые 30 минут
  setInterval(() => updater.check(), 30 * 60 * 1000);
});

app.on('before-quit', () => installer.cancel && installer.busy && installer.pause());

app.on('window-all-closed', () => {
  if (!installer.busy && !prereqs.busy) app.quit();
});
