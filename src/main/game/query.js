'use strict';

const dgram = require('dgram');
const dns = require('dns').promises;
const net = require('net');

/**
 * Запрос к серверу SA-MP / CR-MP по UDP (query-протокол SA-MP).
 * Возвращает онлайн, максимум слотов, название, мод, язык и пинг.
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

function readString(buf, offset) {
  const len = buf.readUInt32LE(offset);
  const str = decoder.decode(buf.subarray(offset + 4, offset + 4 + len));
  return [str, offset + 4 + len];
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

function queryServer(host, port, timeout = 3000) {
  return new Promise(async (resolve) => {
    let ip;
    try { ip = await resolveIp(host); } catch {
      return resolve({ online: false, error: 'dns' });
    }

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

    const timer = setTimeout(() => finish({ online: false, error: 'timeout' }), timeout);

    socket.on('error', () => finish({ online: false, error: 'socket' }));
    socket.on('message', (msg) => {
      if (msg.length < 11 || msg.toString('ascii', 0, 4) !== 'SAMP' || msg[10] !== 0x69) return;
      const ping = Number((process.hrtime.bigint() - started) / 1000000n);
      try {
        finish({ online: true, ping, ...parseInfo(msg) });
      } catch {
        finish({ online: true, ping });
      }
    });

    socket.send(packet, port, ip, (err) => {
      if (err) finish({ online: false, error: 'send' });
    });
  });
}

module.exports = { queryServer };
