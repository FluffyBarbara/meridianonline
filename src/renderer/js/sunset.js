'use strict';

// Экран «проект закрыт»: спрашивает про папку игры и запускает удаление лаунчера.
(() => {
  const $ = (id) => document.getElementById(id);
  const ask = $('ask');
  const askSimple = $('askSimple');
  const spinner = $('spinner');
  const status = $('status');
  const api = window.meridian && window.meridian.sunset;

  const fmtSize = (b) => {
    if (!b) return '';
    const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    let i = 0, n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
  };

  const setStatus = (text, spin) => {
    status.textContent = text || '';
    spinner.hidden = !spin;
  };

  async function remove(deleteGame) {
    ask.hidden = true;
    askSimple.hidden = true;
    setStatus(deleteGame ? 'Удаляю лаунчер, затем файлы игры…' : 'Удаляю лаунчер…', true);
    try {
      const r = await api.remove({ deleteGame });
      if (r && r.ok) {
        setStatus(deleteGame
          ? 'Лаунчер удаляется, затем будут удалены файлы игры…'
          : 'Лаунчер удаляется…', true);
      } else if (r && r.skipped) {
        setStatus('Проект закрыт.', false);
      } else {
        setStatus('Удалите лаунчер через «Программы и компоненты» Windows.', false);
      }
    } catch {
      setStatus('Удалите лаунчер через «Программы и компоненты» Windows.', false);
    }
  }

  async function init() {
    let info = { hasGame: false };
    try { info = (await api.info()) || info; } catch {}

    if (info.hasGame) {
      $('gamePath').innerHTML = `Папка: <b>${escapeHtml(info.gameDir)}</b>${info.size ? ` · ${fmtSize(info.size)}` : ''}`;
      ask.hidden = false;
      $('btnDel').addEventListener('click', () => remove(true));
      $('btnKeep').addEventListener('click', () => remove(false));
    } else {
      askSimple.hidden = false;
      $('btnOnly').addEventListener('click', () => remove(false));
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  if (!api) {
    setStatus('Проект закрыт.', false);
  } else {
    init();
  }
})();
