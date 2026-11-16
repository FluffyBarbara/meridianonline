'use strict';

const dgram = require('dgram');
const dns = require('dns').promises;
const net = require('net');

/**
 * Онлайн и пинг сервера SA-MP / CR-MP.
 *
 * Порядок получения онлайна:
 *   1. UDP-запрос SA-MP query (opcode 'i') на основной порт, с повторами;
 *   2. если не ответил — на запасной query-порт (server.queryPort), если задан;
 *   3. если и это не помогло — HTTP-источник (server.statusUrl), если задан,
 *      он возвращает JSON с онлайном (подходит для серверов с выключенным query).
 *
 * Если ничего не ответило, но HTTP-источник не задан, возвращаем online:'unknown' —
 * лаунчер пишет «Онлайн неизвестен», а не «Сервер недоступен».
 */

const decoder = (() => {
  try { return new TextDecoder('windows-1251'); } catch { return new TextDecoder('latin1'); }
})();

async function resolveIp(host) {
  if (net.isIPv4(host)) return host;
  const { address } = await dns.lookup(host, { family: 4 });
  return address;
}

function buildPacket(ip, port, opcode) {
  const parts = ip.split('.').map(Number);
  const buf = Buffer.alloc(11);
  buf.write('SAMP', 0, 'ascii');
  parts.forEach((p, i) => buf.writeUInt8(p, 4 + i));
  buf.writeUInt16LE(port, 8);
  buf.write(opcode, 10, 'ascii');
  return buf;
}

function readString(buf, offset, lenBytes = 4) {
  const len = lenBytes === 4 ? buf.readUInt32LE(offset) : buf.readUInt8(offset);
  const str = decoder.decode(buf.subarray(offset + lenBytes, offset + lenBytes + len));
  return [str, offset + lenBytes + len];
}

function parseInfo(buf) {
  let o = 11;
  const password = buf.readUInt8(o) === 1; o += 1;
  const players = buf.readUInt16LE(o); o += 2;
  const maxPlayers = buf.readUInt16LE(o); o += 2;
  let hostname, gamemode, language;
  [hostname, o] = readString(buf, o);
  [gamemode, o] = readString(buf, o);
  [language, o] = readString(buf, o);
  return { password, players, maxPlayers, hostname, gamemode, language };
}

/** Один UDP-запрос SA-MP query. */
function queryOnce(ip, port, timeout) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const packet = buildPacket(ip, port, 'i');
    let done = false;
    const started = process.hrtime.bigint();
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeout);
    socket.on('error', () => finish(null));
    socket.on('message', (msg) => {
      if (msg.length < 11 || msg.toString('ascii', 0, 4) !== 'SAMP' || msg[10] !== 0x69) return;
      const ping = Number((process.hrtime.bigint() - started) / 1000000n);
      try { finish({ online: true, source: 'udp', ping, ...parseInfo(msg) }); }
      catch { finish({ online: true, source: 'udp', ping }); }
    });
    socket.send(packet, port, ip, (err) => { if (err) finish(null); });
  });
}

/** UDP-запрос с повторами. */
async function queryUdp(ip, port, { timeout = 1800, retries = 2 } = {}) {
  for (let i = 0; i <= retries; i++) {
    const r = await queryOnce(ip, port, timeout);
    if (r) return r;
  }
  return null;
}

/** HTTP-источник онлайна: JSON в разных форматах. */
async function queryHttp(url, timeout = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'MeridianLauncher', Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const pick = (obj, keys) => {
      for (const k of keys) {
        if (obj == null) break;
        const v = obj[k];
        if (typeof v === 'number') return v;
        if (typeof v === 'string' && v.trim() !== '' && !isNaN(+v)) return +v;
      }
      return null;
    };
    const node = data.server || data.data || data;
    const players = pick(node, ['players', 'online', 'playersOnline', 'current', 'count']);
    const maxPlayers = pick(node, ['maxPlayers', 'maxplayers', 'max', 'slots', 'maxPlayersOnline']);
    if (players === null && maxPlayers === null && node.online !== true) return null;
    return { online: true, source: 'http', players: players ?? 0, maxPlayers: maxPlayers ?? null, ping: null };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * @returns {object} один из:
 *   { online: true, players, maxPlayers, ping, source }
 *   { online: false }                 — точно офлайн (ICMP/недоступность доказана HTTP-источником)
 *   { online: 'unknown' }             — не удалось узнать (query не отвечает, HTTP-источника нет)
 */
async function queryServer(host, port, opts = {}) {
  let ip;
  try { ip = await resolveIp(host); } catch { return { online: 'unknown', error: 'dns' }; }

  const udp = await queryUdp(ip, port, opts);
  if (udp) return udp;

  if (opts.queryPort && opts.queryPort !== port) {
    const alt = await queryUdp(ip, opts.queryPort, opts);
    if (alt) return alt;
  }

  if (opts.statusUrl) {
    const http = await queryHttp(opts.statusUrl);
    if (http) return http;
    return { online: false, error: 'status-url' };
  }

  // Сервер не ответил на query, но доказательств, что он офлайн, нет
  return { online: 'unknown', error: 'timeout' };
}

module.exports = { queryServer };
