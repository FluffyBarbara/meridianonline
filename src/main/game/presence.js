'use strict';

/**
 * Движок активности для Discord: превращает снимок памяти игры в строки статуса.
 *
 *   details — что делает игрок: «За рулём ВАЗ 2101 · 90 км/ч», «Патрулирует на Машина полиции»…
 *   state   — где он: «📍 Арзамас · WHITE»
 *   small   — значок активности (content/discord/<ключ>.png)
 *
 * Названия машин взяты из GXT сборки (vehicles.json). Районы, свои тексты для районов и машин
 * задаются в content/launcher.json → discord.presence (меняются без выпуска лаунчера).
 */

const VEHICLES = require('./vehicles.json');

// Роли транспорта по ID моделей (функции машин SA в CR-MP сохраняются)
const ROLES = {
  police: [596, 597, 598, 599, 523, 427, 490, 528, 601, 497, 430],
  ambulance: [416],
  fire: [407, 544],
  taxi: [420, 438],
  bus: [431, 437],
  truck: [403, 514, 515, 443, 455, 456, 578, 499, 414, 498, 609, 524, 406, 573, 552, 433],
  tow: [525],
  trash: [408],
  tractor: [531, 532, 572],
};
const ROLE_OF = {};
for (const [role, ids] of Object.entries(ROLES)) for (const id of ids) ROLE_OF[id] = role;

const AFK_AFTER = 3 * 60 * 1000;
const MINIMIZED_AFTER = 60 * 1000;

const round10 = (n) => Math.round(n / 10) * 10;
const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));

class PresenceEngine {
  constructor() {
    this.reset();
  }

  reset() {
    this.lastPos = null;
    this.lastMoveAt = Date.now();
    this.unfocusedSince = null;
    this.lastOutdoorZone = null;
  }

  /** Самый маленький район, в который попадают координаты. */
  zoneFor(pos, zones) {
    if (!pos || !Array.isArray(zones)) return null;
    let best = null;
    let bestArea = Infinity;
    for (const z of zones) {
      if (!Array.isArray(z.min) || !Array.isArray(z.max)) continue;
      const [x1, y1] = [Math.min(z.min[0], z.max[0]), Math.min(z.min[1], z.max[1])];
      const [x2, y2] = [Math.max(z.min[0], z.max[0]), Math.max(z.min[1], z.max[1])];
      if (pos[0] < x1 || pos[0] > x2 || pos[1] < y1 || pos[1] > y2) continue;
      if (z.min.length > 2 && z.max.length > 2 && (pos[2] < Math.min(z.min[2], z.max[2]) || pos[2] > Math.max(z.min[2], z.max[2]))) continue;
      const area = (x2 - x1) * (y2 - y1);
      if (area < bestArea) { best = z; bestArea = area; }
    }
    return best;
  }

  vehicleInfo(model, cfg) {
    const custom = cfg.vehicles?.[model];
    const [name, type] = VEHICLES[model] || ['транспорт', 'car'];
    return {
      name: custom?.name || name,
      type: custom?.type || type,
      role: custom?.role || ROLE_OF[model] || null,
      text: custom?.text || null,
    };
  }

  /**
   * @param {object|null} snap  снимок из GameMemory.snapshot()
   * @param {{server:{id,name}, cfg:object}} ctx
   * @returns {{details:string, state:string, icon:string, iconText:string}}
   */
  build(snap, { server, cfg = {} }) {
    const serverName = server?.name || 'Meridian Online';
    const now = Date.now();

    // Где игрок
    let zone = null;
    if (snap?.pos) {
      if (!snap.interior) {
        zone = this.zoneFor(snap.pos, cfg.zones);
        this.lastOutdoorZone = zone;
      } else {
        zone = this.lastOutdoorZone;
      }
      if (this.lastPos && Math.hypot(snap.pos[0] - this.lastPos[0], snap.pos[1] - this.lastPos[1], snap.pos[2] - this.lastPos[2]) > 0.6) {
        this.lastMoveAt = now;
      }
      this.lastPos = snap.pos;
    }
    if (snap && !snap.foreground) this.unfocusedSince ??= now;
    else this.unfocusedSince = null;

    const place = zone?.name || cfg.defaultRegion || '';
    let state = place ? `📍 ${place} · ${serverName}` : `Сервер ${serverName}`;
    if (cfg.showCoords && snap?.pos) {
      state = `x ${snap.pos[0].toFixed(0)}  y ${snap.pos[1].toFixed(0)}  z ${snap.pos[2].toFixed(0)}${snap.interior ? `  int ${snap.interior}` : ''}`;
    }

    const out = (details, icon, iconText) => ({ details, state, icon, iconText: iconText || details });

    // Особые состояния
    if (!snap) return out('Играет на Meridian Online', 'pin', 'В игре');
    if (!snap.loaded || !snap.ped) return out('Заходит на сервер…', 'loading', 'Загрузка');
    if (snap.menu) return out('В меню паузы', 'pause', 'Пауза');
    if (this.unfocusedSince && now - this.unfocusedSince > MINIMIZED_AFTER) return out('Свернул игру', 'afk', 'Не в игре');
    if (now - this.lastMoveAt > AFK_AFTER && !snap.vehicle?.kmh) return out('Отошёл от компьютера (AFK)', 'afk', 'AFK');
    if (snap.health !== null && snap.health !== undefined && snap.health <= 0) return out('Без сознания', 'dead', 'Без сознания');

    // В транспорте
    if (snap.vehicle) {
      const v = this.vehicleInfo(snap.vehicle.model, cfg);
      const { driver, kmh } = snap.vehicle;
      const speed = driver && cfg.showSpeed !== false && kmh >= 5 ? ` · ${round10(kmh)} км/ч` : '';
      const vars = { vehicle: v.name, speed: round10(kmh), zone: place, server: serverName };

      if (zone?.vehicleText) return out(fill(zone.vehicleText, vars) + speed, zone.icon || 'drive');
      if (v.text && driver) return out(fill(v.text, vars) + speed, v.role || 'drive');

      switch (v.type) {
        case 'heli': return out(driver ? `Пилотирует ${v.name}` : `Летит на ${v.name}`, 'heli', 'Вертолёт');
        case 'plane': return out(driver ? `Пилотирует ${v.name}` : `Летит на ${v.name}`, 'plane', 'Самолёт');
        case 'boat': return out(`Плывёт на ${v.name}${speed}`, 'boat', 'На воде');
        case 'train': return out(driver ? `Ведёт поезд ${v.name}` : 'Едет на поезде', 'train', 'Поезд');
        case 'bmx': return out(driver ? `Катается на велосипеде${speed}` : 'Едет на велосипеде', 'bicycle', 'Велосипед');
        case 'bike':
        case 'quad':
          if (!driver) return out(`Пассажир на ${v.name}`, 'bike', 'Мотоцикл');
          return out(`${kmh >= 110 ? 'Гоняет' : 'Едет'} на ${v.name}${speed}`, 'bike', 'Мотоцикл');
        default:
          break;
      }

      if (!driver) return out(`Пассажир в ${v.name}`, 'passenger', 'Пассажир');
      const roleText = {
        police: kmh >= 70 ? `Преследует на ${v.name}` : `Патрулирует на ${v.name}`,
        ambulance: `Спешит на вызов · ${v.name}`,
        fire: `Едет на пожар · ${v.name}`,
        taxi: `Таксует на ${v.name}`,
        bus: `Везёт пассажиров · ${v.name}`,
        truck: `Дальнобойщик · ${v.name}`,
        tow: `Эвакуирует машины · ${v.name}`,
        trash: `Вывозит мусор · ${v.name}`,
        tractor: `Работает в поле · ${v.name}`,
      }[v.role];
      if (roleText) return out(roleText + speed, v.role === 'tow' ? 'truck' : v.role, roleText);
      if (kmh < 3) return out(`Сидит в ${v.name}`, 'drive', 'В машине');
      if (kmh >= 140) return out(`Гоняет на ${v.name}${speed}`, 'race', 'Гоняет');
      return out(`За рулём ${v.name}${speed}`, 'drive', 'За рулём');
    }

    // Пешком
    if (zone?.text) return out(fill(zone.text, { zone: place, server: serverName }), zone.icon || 'walk');
    if (snap.interior) return out('В помещении', 'home', 'В помещении');
    if (snap.health !== null && snap.health < 25) return out('Ранен, ищет помощь', 'dead', 'Ранен');
    if (snap.kmh >= 22) return out('Бежит', 'run', 'Бежит');
    if (snap.kmh >= 4) return out('Гуляет пешком', 'walk', 'Пешком');
    return out('Стоит на месте', 'stand', 'Пешком');
  }
}

module.exports = { PresenceEngine, ROLES };
