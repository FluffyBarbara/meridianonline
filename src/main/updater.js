'use strict';

const { app } = require('electron');
const { EventEmitter } = require('events');
const log = require('electron-log/main');
const config = require('./config');

/**
 * Автообновление лаунчера через GitHub Releases (electron-updater).
 *
 * Как выпустить новую версию: поднять "version" в package.json и залить в main —
 * GitHub Actions (.github/workflows/release.yml) соберёт установщик и опубликует релиз vX.Y.Z.
 * Лаунчер у игроков при старте увидит релиз, скачает его и перезапустится уже новым.
 */

class LauncherUpdater extends EventEmitter {
  constructor() {
    super();
    this.status = { state: 'idle' };
    this.updater = null;
    this.ready = false;
  }

  get enabled() {
    return app.isPackaged && !process.argv.includes('--no-update');
  }

  init() {
    if (!this.enabled || this.updater) return;
    const { autoUpdater } = require('electron-updater');
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false; // релизы игры помечаются как pre-release и не мешают
    autoUpdater.setFeedURL({ provider: 'github', owner: config.REPO_OWNER, repo: config.REPO_NAME });

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ state: 'latest' }));
    autoUpdater.on('update-available', (info) => this.set({ state: 'available', version: info.version, notes: info.releaseNotes }));
    autoUpdater.on('download-progress', (p) => this.set({
      state: 'downloading',
      version: this.status.version,
      percent: p.percent,
      speed: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    }));
    autoUpdater.on('update-downloaded', (info) => {
      this.ready = true;
      this.set({ state: 'downloaded', version: info.version });
    });
    autoUpdater.on('error', (err) => this.set({ state: 'error', message: String(err?.message || err) }));
    this.updater = autoUpdater;
  }

  set(status) {
    this.status = status;
    this.emit('status', status);
  }

  /**
   * Проверка при запуске. Резолвится:
   *  'none'       — обновлений нет / проверка не удалась / вышел таймаут;
   *  'installing' — обновление скачано, приложение перезапускается.
   */
  checkOnStartup() {
    if (!this.enabled) return Promise.resolve('none');
    this.init();
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        this.off('status', onStatus);
        clearTimeout(timer);
        resolve(r);
      };
      const onStatus = (s) => {
        if (s.state === 'latest' || s.state === 'error') done('none');
        if (s.state === 'available' || s.state === 'downloading') clearTimeout(timer); // ждём загрузку
        if (s.state === 'downloaded') {
          done('installing');
          setTimeout(() => this.install(), 900);
        }
      };
      const timer = setTimeout(() => done('none'), config.UPDATE_CHECK_TIMEOUT);
      this.on('status', onStatus);
      this.updater.checkForUpdates().catch(() => done('none'));
    });
  }

  /** Фоновая проверка во время работы лаунчера. */
  check() {
    if (!this.enabled) {
      this.set({ state: 'disabled' });
      return;
    }
    this.init();
    this.updater.checkForUpdates().catch(() => {});
  }

  install() {
    if (this.ready && this.updater) {
      // isSilent = true, isForceRunAfter = true — тихая установка и автозапуск
      this.updater.quitAndInstall(true, true);
    }
  }
}

module.exports = new LauncherUpdater();
