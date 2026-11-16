'use strict';

/**
 * Чтение состояния игрока из памяти gta_sa.exe (GTA San Andreas 1.0 US / HOODLUM).
 *
 * Только чтение (PROCESS_VM_READ), ничего в игру не пишется и не внедряется.
 * Используется для статуса в Discord: где игрок, пешком он или за рулём, на чём едет и т.п.
 * Работает через koffi (вызов WinAPI из Node без компиляции).
 */

const ADDR = {
  GAME_STATE: 0xC8D4C0, // 9 — идёт игра
  MENU_ACTIVE: 0xBA67A4, // CMenuManager::m_bMenuActive
  CUR_AREA: 0xB72914, // номер интерьера, 0 — улица
  PLAYER_PED: 0xB6F5F0, // CPed* игрока
  MONEY: 0xB7CE50,
};
const PED = { MATRIX: 0x14, POS_FALLBACK: 0x04, SPEED: 0x44, IN_VEHICLE: 0x46C, HEALTH: 0x540, ARMOR: 0x548, VEHICLE: 0x58C };
const VEH = { MODEL: 0x22, SPEED: 0x44, HEALTH: 0x4C0, DRIVER: 0x460 };

const PROCESS_VM_READ = 0x0010;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

let api = null;
function winapi() {
  if (api !== null) return api;
  api = false;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const k32 = koffi.load('kernel32.dll');
    const u32 = koffi.load('user32.dll');
    api = {
      OpenProcess: k32.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'bool', 'uint32']),
      ReadProcessMemory: k32.func('__stdcall', 'ReadProcessMemory', 'bool', ['void *', 'uintptr_t', 'void *', 'uintptr_t', 'void *']),
      CloseHandle: k32.func('__stdcall', 'CloseHandle', 'bool', ['void *']),
      GetForegroundWindow: u32.func('__stdcall', 'GetForegroundWindow', 'void *', []),
      GetWindowThreadProcessId: u32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['void *', 'void *']),
    };
  } catch (err) {
    api = false;
  }
  return api;
}

const finite = (n, lim = 1e6) => (Number.isFinite(n) && Math.abs(n) < lim ? n : null);
const validPtr = (p) => p > 0x10000 && p < 0x7FFF0000;

class GameMemory {
  constructor() {
    this.handle = null;
    this.pid = null;
  }

  get available() {
    return !!winapi();
  }

  attach(pid) {
    const w = winapi();
    if (!w) return false;
    if (this.handle && this.pid === pid) return true;
    this.detach();
    const h = w.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!h) return false;
    this.handle = h;
    this.pid = pid;
    return true;
  }

  detach() {
    if (this.handle && api) {
      try { api.CloseHandle(this.handle); } catch {}
    }
    this.handle = null;
    this.pid = null;
  }

  read(addr, size) {
    if (!this.handle || !validPtr(addr)) return null;
    const buf = Buffer.alloc(size);
    try {
      return api.ReadProcessMemory(this.handle, addr, buf, size, null) ? buf : null;
    } catch {
      return null;
    }
  }

  u8(a) { const b = this.read(a, 1); return b ? b.readUInt8(0) : null; }
  u16(a) { const b = this.read(a, 2); return b ? b.readUInt16LE(0) : null; }
  u32(a) { const b = this.read(a, 4); return b ? b.readUInt32LE(0) : null; }
  i32(a) { const b = this.read(a, 4); return b ? b.readInt32LE(0) : null; }
  f32(a) { const b = this.read(a, 4); return b ? b.readFloatLE(0) : null; }
  vec3(a) {
    const b = this.read(a, 12);
    if (!b) return null;
    const v = [b.readFloatLE(0), b.readFloatLE(4), b.readFloatLE(8)].map((n) => finite(n));
    return v.includes(null) ? null : v;
  }

  isForeground() {
    try {
      const hwnd = api.GetForegroundWindow();
      if (!hwnd) return false;
      const out = Buffer.alloc(4);
      api.GetWindowThreadProcessId(hwnd, out);
      return out.readUInt32LE(0) === this.pid;
    } catch {
      return true;
    }
  }

  /** Снимок состояния игрока или null, если процесс недоступен. */
  snapshot() {
    if (!this.handle) return null;
    const gameState = this.u32(ADDR.GAME_STATE);
    if (gameState === null) return null; // процесс закрылся или нет доступа

    const snap = {
      ts: Date.now(),
      loaded: gameState === 9,
      menu: this.u8(ADDR.MENU_ACTIVE) === 1,
      foreground: this.isForeground(),
      interior: this.i32(ADDR.CUR_AREA) || 0,
      ped: false,
    };

    const ped = this.u32(ADDR.PLAYER_PED);
    if (!snap.loaded || !validPtr(ped)) return snap;
    snap.ped = true;

    const matrix = this.u32(ped + PED.MATRIX);
    snap.pos = validPtr(matrix) ? this.vec3(matrix + 0x30) : this.vec3(ped + PED.POS_FALLBACK);
    snap.health = finite(this.f32(ped + PED.HEALTH), 10000);
    snap.armor = finite(this.f32(ped + PED.ARMOR), 10000);

    const inVehicle = this.u8(ped + PED.IN_VEHICLE) === 1;
    const veh = inVehicle ? this.u32(ped + PED.VEHICLE) : 0;
    if (inVehicle && validPtr(veh)) {
      const model = this.u16(veh + VEH.MODEL);
      const speed = this.vec3(veh + VEH.SPEED);
      snap.vehicle = {
        model: model >= 400 && model <= 20000 ? model : null,
        driver: this.u32(veh + VEH.DRIVER) === ped,
        kmh: speed ? Math.round(Math.hypot(...speed) * 180) : 0,
        health: finite(this.f32(veh + VEH.HEALTH), 100000),
      };
    } else {
      const speed = this.vec3(ped + PED.SPEED);
      snap.kmh = speed ? Math.round(Math.hypot(speed[0], speed[1]) * 180) : 0;
    }
    return snap;
  }
}

module.exports = { GameMemory };

// Для тестов: подмена WinAPI
module.exports._setApi = (fake) => { api = fake; };
