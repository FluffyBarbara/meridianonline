// Заглушка API для просмотра интерфейса в обычном браузере (не попадает в сборку).
const params = new URLSearchParams(location.search);
const scenario = params.get('s') || 'ready';

let settings = {
  nickname: scenario === 'welcome' ? '' : 'Yuma_Takimura',
  gameDir: 'C:\\Games\\Meridian Online',
  selectedServer: 'white',
  afterLaunch: 'minimize',
  autoUpdateGame: true,
  animatedBackground: true,
};

const noop = () => () => {};
let progressCb = null;

const api = {
  app: {
    info: async () => ({ version: '1.0.0', packaged: false }),
    minimize() {}, close() {}, open: async (u) => console.log('open', u),
  },
  settings: {
    get: async () => ({ ...settings }),
    set: async (p) => (settings = { ...settings, ...p }),
  },
  content: { get: async () => (await fetch('../../content/launcher.json')).json() },
  game: {
    status: async () => ({
      gameDir: settings.gameDir,
      installed: scenario !== 'install' && scenario !== 'download',
      installedVersion: '1.0.0',
      latestVersion: scenario === 'update' ? '1.1.0' : '1.0.0',
      published: true,
      needsUpdate: scenario === 'update',
      downloadSize: 1712000000,
      unpackedSize: 2400000000,
      partialBytes: 0,
      installerState: scenario === 'download'
        ? { state: 'downloading', index: 1, count: 1, downloaded: 712000000, total: 1712000000, percent: 41.6, speed: 12400000, eta: 81 }
        : null,
    }),
    install: () => new Promise(() => {}),
    pause: async () => {}, cancel: async () => {},
    launch: async (id, o) => (o?.skipPrereqs ? { ok: true } : { ok: false, needPrereqs: ['DirectX 9.0c', 'Visual C++ 2015–2022 (x86)'] }),
    validateNick: async (n) => (/^[A-Za-z0-9_]{3,20}$/.test(n) ? null : 'Ник: 3–20 символов, латиница, цифры и _'),
    chooseDir: async () => ({ ok: false }),
    openDir: async () => true,
    reinstall: async () => true,
    onProgress: (cb) => { progressCb = cb; return () => {}; },
    onRunning: noop,
  },
  prereqs: {
    check: async () => [{ id: 'directx', name: 'DirectX 9.0c', installed: false }, { id: 'vc2015', name: 'Visual C++ 2015–2022 (x86)', installed: true }],
    install: async () => ({ ok: true, installed: ['DirectX 9.0c'], failed: [] }),
  },
  servers: {
    query: async () => [{ id: 'white', online: true, players: 187, maxPlayers: 500, ping: 38 }],
  },
  updater: {
    check() {}, install() {},
    status: async () => (scenario === 'update' ? { state: 'downloaded', version: '1.0.1' } : { state: 'latest' }),
    onStatus: noop,
  },
};

export default api;
