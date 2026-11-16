'use strict';

const { execFile } = require('child_process');

/**
 * Проверка драйвера видеокарты.
 *
 * Если драйвер не установлен, Windows работает через «Базовый видеоадаптер (Майкрософт)»
 * (Microsoft Basic Display Adapter) без аппаратного Direct3D. GTA не может создать устройство
 * Direct3D 9, и samp.dll падает при запуске (EXCEPTION_ACCESS_VIOLATION, адрес 0x0).
 * У базового адаптера в PNPDeviceID остаётся код производителя настоящей видеокарты (VEN_xxxx) —
 * по нему подсказываем, чей драйвер скачать.
 */

const VENDORS = {
  '10DE': { id: 'nvidia', name: 'NVIDIA', url: 'https://www.nvidia.com/ru-ru/drivers/' },
  '1002': { id: 'amd', name: 'AMD Radeon', url: 'https://www.amd.com/ru/support/download/drivers.html' },
  '1022': { id: 'amd', name: 'AMD Radeon', url: 'https://www.amd.com/ru/support/download/drivers.html' },
  '8086': { id: 'intel', name: 'Intel', url: 'https://www.intel.com/content/www/us/en/support/detect.html' },
};

const BASIC = /(Microsoft Basic (Display|Render)|Базовый видеоадаптер|Базовый адаптер отрисовки|Standard VGA|Стандартный VGA)/i;
const VIRTUAL = /(Remote Display|Virtual|Parsec|Meta Virtual|IddSample|Hyper-V|VMware|VirtualBox|DisplayLink|Mirage|Citrix|Spacedesk|Duet|Splashtop|Sunshine|Indirect)/i;

function query() {
  const cmd = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
    + 'Get-CimInstance Win32_VideoController | Select-Object Name, PNPDeviceID, DriverVersion, InfFilename, Status | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true, timeout: 20000 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const data = JSON.parse(String(out).trim() || '[]');
        resolve(Array.isArray(data) ? data : [data]);
      } catch {
        resolve(null);
      }
    });
  });
}

function isBasic(c) {
  return BASIC.test(c.Name || '') || /^display\.inf$/i.test(c.InfFilename || '');
}

/**
 * @returns {{checked:boolean, adapters:string[], problem:null|{vendor:string, vendorName:string, url:string, adapter:string}}}
 */
async function checkGpu() {
  if (process.platform !== 'win32') return { checked: false, adapters: [], problem: null };
  const list = await query();
  if (!list) return { checked: false, adapters: [], problem: null };

  const adapters = list.map((c) => `${c.Name}${c.DriverVersion ? ` (драйвер ${c.DriverVersion})` : ''}`);
  const real = list.filter((c) => !isBasic(c) && !VIRTUAL.test(c.Name || ''));
  const basic = list.filter(isBasic);
  if (real.length || !basic.length) return { checked: true, adapters, problem: null };

  const ven = (basic.map((c) => /VEN_([0-9A-F]{4})/i.exec(c.PNPDeviceID || '')?.[1]?.toUpperCase()).find(Boolean)) || '';
  const v = VENDORS[ven];
  return {
    checked: true,
    adapters,
    problem: {
      vendor: v?.id || 'unknown',
      vendorName: v?.name || '',
      url: v?.url || 'https://www.nvidia.com/ru-ru/drivers/',
      adapter: basic[0].Name,
    },
  };
}

module.exports = { checkGpu };
