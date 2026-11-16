'use strict';

const net = require('net');
const path = require('path');
const crypto = require('crypto');
const log = require('electron-log/main');

/**
 * Discord Rich Presence — статус «Играет в Meridian Online» в профиле Discord.
 *
 * Работает через локальный IPC-канал клиента Discord (\\?\pipe\discord-ipc-N),
 * без сторонних библиотек. Если Discord не запущен — тихо переподключается раз в 20 секунд.
 *
 * Нужен Application ID приложения из https://discord.com/developers/applications —
 * задаётся в content/launcher.json → "discord.clientId" (можно менять без выпуска лаунчера).
 */

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const RECONNECT_MS = 20000;

function pipePath(i) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  return path.join(dir, `discord-ipc-${i}`);
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

class DiscordPresence {
  constructor() {
    this.clientId = null;
    this.socket = null;
    this.ready = false;
    this.activity = null;
    this.enabled = true;
    this.timer = null;
    this.buffer = Buffer.alloc(0);
  }

  /** Задать Application ID и включить/выключить статус. */
  configure({ clientId, enabled = true }) {
    const changed = clientId !== this.clientId;
    this.clientId = clientId || null;
    this.enabled = enabled && !!this.clientId;
    if (!this.enabled) {
      this.disconnect();
      return;
    }
    if (changed) this.disconnect();
    if (!this.socket) this.connect();
  }

  setActivity(activity) {
    this.activity = activity;
    this.flush();
  }

  flush() {
    if (!this.ready || !this.socket) return;
    this.send(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: this.activity },
      nonce: crypto.randomUUID(),
    });
  }

  send(op, data) {
    try { this.socket?.write(encode(op, data)); } catch {}
  }

  connect(index = 0) {
    if (!this.enabled || this.socket) return;
    if (index > 9) return this.scheduleReconnect();

    const sock = net.createConnection(pipePath(index));
    let opened = false;

    sock.once('connect', () => {
      opened = true;
      this.socket = sock;
      this.buffer = Buffer.alloc(0);
      this.send(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
    });
    sock.on('data', (chunk) => this.onData(chunk));
    sock.on('error', () => {
      if (!opened) {
        sock.destroy();
        this.connect(index + 1); // пробуем следующий номер канала
      }
    });
    sock.on('close', () => {
      if (!opened) return;
      if (this.socket === sock) {
        this.socket = null;
        this.ready = false;
        this.scheduleReconnect();
      }
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const len = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + len) break;
      let msg = null;
      try { msg = JSON.parse(this.buffer.subarray(8, 8 + len).toString('utf8')); } catch {}
      this.buffer = this.buffer.subarray(8 + len);

      if (op === OP.PING) this.send(OP.PONG, msg);
      else if (op === OP.CLOSE) {
        log.warn(`[discord] соединение закрыто: ${msg?.message || ''}`);
        this.socket?.destroy();
      } else if (op === OP.FRAME && msg?.evt === 'READY') {
        this.ready = true;
        log.info(`[discord] подключено к ${msg.data?.user?.username || 'Discord'}`);
        this.flush();
      } else if (op === OP.FRAME && msg?.evt === 'ERROR') {
        log.warn(`[discord] ошибка: ${msg.data?.message || JSON.stringify(msg.data)}`);
      }
    }
  }

  scheduleReconnect() {
    clearTimeout(this.timer);
    if (!this.enabled) return;
    this.timer = setTimeout(() => this.connect(), RECONNECT_MS);
  }

  disconnect() {
    clearTimeout(this.timer);
    this.ready = false;
    const s = this.socket;
    this.socket = null;
    if (s) {
      try {
        s.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: crypto.randomUUID() }));
      } catch {}
      s.destroy();
    }
  }
}

module.exports = new DiscordPresence();
