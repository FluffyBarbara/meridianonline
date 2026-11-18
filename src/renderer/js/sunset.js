'use strict';

// Экран «проект закрыт»: сообщает в main-процесс, что пора удалить лаунчер.
(() => {
  const statusEl = document.getElementById('status');
  const spinner = document.getElementById('spinner');
  const api = window.meridian && window.meridian.sunset;

  const stop = (text) => {
    if (statusEl) statusEl.textContent = text;
    if (spinner) spinner.style.display = 'none';
  };

  async function run() {
    if (!api) return stop('Проект закрыт.');
    try {
      const r = await api.remove();
      if (r && r.ok) {
        if (statusEl) statusEl.textContent = 'Лаунчер удаляется…';
      } else if (r && r.skipped) {
        stop('Проект закрыт.');
      } else {
        stop('Удалите лаунчер через «Программы и компоненты» Windows.');
      }
    } catch {
      stop('Удалите лаунчер через «Программы и компоненты» Windows.');
    }
  }

  // Пауза, чтобы человек успел прочитать экран, потом запускаем удаление
  setTimeout(run, 3500);
})();
