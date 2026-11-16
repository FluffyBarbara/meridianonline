'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel) {
  return (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('meridian', {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    minimize: () => ipcRenderer.send('window:minimize'),
    close: () => ipcRenderer.send('window:close'),
    open: (url) => ipcRenderer.invoke('shell:open', url),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  content: {
    get: (force) => ipcRenderer.invoke('content:get', force),
  },
  game: {
    status: (force) => ipcRenderer.invoke('game:status', force),
    install: () => ipcRenderer.invoke('game:install'),
    pause: () => ipcRenderer.invoke('game:pause'),
    cancel: () => ipcRenderer.invoke('game:cancel'),
    launch: (serverId, opts) => ipcRenderer.invoke('game:launch', serverId, opts),
    validateNick: (nick) => ipcRenderer.invoke('game:validate-nick', nick),
    chooseDir: () => ipcRenderer.invoke('game:choose-dir'),
    openDir: () => ipcRenderer.invoke('game:open-dir'),
    reinstall: () => ipcRenderer.invoke('game:reinstall'),
    onProgress: on('game:progress'),
    onRunning: on('game:running'),
  },
  prereqs: {
    check: () => ipcRenderer.invoke('prereqs:check'),
    install: () => ipcRenderer.invoke('prereqs:install'),
  },
  servers: {
    query: (ids) => ipcRenderer.invoke('server:query', ids),
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    status: () => ipcRenderer.invoke('updater:status'),
    onStatus: on('updater:status'),
  },
});
