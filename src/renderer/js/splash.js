(function () {
  const text = document.getElementById('text');
  const bar = document.getElementById('bar');
  const fill = document.getElementById('fill');
  if (!window.meridian) return;
  window.meridian.updater.onStatus((s) => {
    if (s.state === 'available') text.textContent = `Найдена новая версия ${s.version}`;
    if (s.state === 'downloading') {
      bar.classList.add('det');
      fill.style.left = '0';
      fill.style.width = `${Math.round(s.percent || 0)}%`;
      text.textContent = `Обновление лаунчера · ${Math.round(s.percent || 0)}%`;
    }
    if (s.state === 'downloaded') text.textContent = 'Установка обновления…';
    if (s.state === 'latest' || s.state === 'error') text.textContent = 'Запуск…';
  });
})();
