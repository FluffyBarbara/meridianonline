import { icon } from './icons.js';
import { $, $$, esc, h, bytes, duration, date, toast, openModal, closeModal, confirmDialog } from './ui.js';
import { initSnow, initParallax } from './fx.js';
import { toAccel, formatAccel, readKeyEvent, PRESETS, DEFAULT_HOTKEY } from './hotkey.js';

// В браузере (предпросмотр дизайна) подключаем заглушку API.
const api = window.meridian ?? (await import('./mock.js')).default;

const state = {
  info: null,
  settings: null,
  content: null,
  game: null,
  progress: null,
  servers: {},
  running: false,
  updater: { state: 'idle' },
  launching: false,
};

const SOCIAL_BRAND = {
  telegram: '#229ED9', vk: '#0077FF', tiktok: '#111', instagram: '#E1306C', discord: '#5865F2', youtube: '#FF0000',
};

// ═════════════════ Иконки статических элементов ═════════════════
function paintStaticIcons() {
  $('#btnSettings').innerHTML = icon('settings');
  $('#btnMin').innerHTML = icon('minus');
  $('#btnClose').innerHTML = icon('x');
  $('#accountChev').innerHTML = icon('chevron-down');
  $('#heroPrev').innerHTML = icon('chevron-left');
  $('#heroNext').innerHTML = icon('chevron-right');
  $('#openFolderBtn').innerHTML = `${icon('folder-open')}Папка игры`;
  $('#fixBtn').innerHTML = `${icon('wrench')}Фикс игры`;
  const rows = {
    fix: ['shield-check', 'Фикс игры — если вылетает или не запускается'],
    report: ['newspaper', 'Отчёт для поддержки'],
    'open-folder': ['folder-open', 'Открыть папку игры'],
    verify: ['wrench', 'Переустановить игру'],
    settings: ['settings', 'Настройки лаунчера'],
  };
  $$('.row-btn').forEach((b) => {
    const [ic, label] = rows[b.dataset.action];
    b.innerHTML = `${icon(ic)}${label}`;
  });
}

// ═════════════════ Сервера ═════════════════
function selectedServer() {
  const list = state.content?.servers || [];
  return list.find((s) => s.id === state.settings.selectedServer) || list[0];
}

function renderServers() {
  const wrap = $('#servers');
  const sel = selectedServer();
  wrap.innerHTML = '';
  for (const s of state.content.servers) {
    const q = state.servers[s.id];
    const online = q?.online === true;
    const unknown = q?.online === 'unknown';
    const cls = !q ? '' : (online ? 'is-online' : (unknown ? 'is-unknown' : 'is-offline'));
    let meta;
    if (!q) meta = '<span>Подключение к серверу…</span>';
    else if (online) {
      meta = `<span><b>${q.players ?? 0}</b> / ${q.maxPlayers ?? '—'}</span>`
        + (q.ping != null ? `<span class="sep"></span><span class="server__ping">${icon('signal')}${q.ping} мс</span>` : '');
    } else if (unknown) meta = '<span>Онлайн неизвестен · можно играть</span>';
    else meta = '<span>Сервер недоступен</span>';
    const load = online && q.maxPlayers ? Math.min(100, (q.players / q.maxPlayers) * 100) : 0;
    const el = h(`
      <button class="server ${cls} ${sel?.id === s.id ? 'is-selected' : ''}" data-id="${esc(s.id)}">
        <span class="server__dot"></span>
        <span>
          <span class="server__top">
            <span class="server__name">${esc(s.name)}</span>
            ${s.tag ? `<span class="server__tag">${esc(s.tag)}</span>` : ''}
          </span>
          <span class="server__meta">${meta}</span>
          <span class="server__load" style="display:block"><i style="width:${load}%"></i></span>
        </span>
        <span class="server__check">${icon('check')}</span>
      </button>`);
    el.addEventListener('click', async () => {
      state.settings = await api.settings.set({ selectedServer: s.id });
      renderServers();
    });
    wrap.appendChild(el);
  }

  const results = Object.values(state.servers);
  const anyOnline = results.some((r) => r.online === true);
  const anyUnknown = results.some((r) => r.online === 'unknown');
  const total = results.reduce((sum, r) => sum + (r.online === true ? r.players || 0 : 0), 0);
  $('#onlineTotal').textContent = results.length ? (anyOnline ? total : (anyUnknown ? '—' : 'офлайн')) : '…';
  $('#onlineTotal').classList.toggle('is-off', results.length > 0 && !anyOnline);
  $('#onlineDot').classList.toggle('is-on', anyOnline || anyUnknown);
}

async function pollServers() {
  try {
    const res = await api.servers.query();
    for (const r of res) state.servers[r.id] = r;
    renderServers();
  } catch {}
}

// ═════════════════ Аккаунт ═════════════════
function renderAccount() {
  const nick = state.settings.nickname;
  $('#accountName').textContent = nick || 'Укажите ник';
  $('#accountName').classList.toggle('is-empty', !nick);
  $('#accountAvatar').innerHTML = nick ? esc(nick[0].toUpperCase()) : icon('user');
}

function toggleAccountPop(force) {
  const pop = $('#accountPop');
  const acc = $('#account');
  const open = force ?? pop.hidden;
  if (open) {
    const r = acc.getBoundingClientRect();
    pop.style.left = `${r.left}px`;
    pop.style.top = `${r.bottom + 10}px`;
    pop.hidden = false;
    acc.classList.add('is-open');
    const input = $('#nickInput');
    input.value = state.settings.nickname || '';
    setNickHint();
    setTimeout(() => input.focus(), 30);
  } else {
    pop.hidden = true;
    acc.classList.remove('is-open');
  }
}

function setNickHint(err) {
  const hint = $('#nickHint');
  hint.textContent = err || 'Формат: Имя_Фамилия, только латиница. Например: Ivan_Petrov';
  hint.classList.toggle('is-error', !!err);
  $('#nickInput').classList.toggle('is-error', !!err);
}

async function saveNick(input, hintSetter) {
  const nick = input.value.trim();
  const err = await api.game.validateNick(nick);
  if (err) { hintSetter(err); return false; }
  state.settings = await api.settings.set({ nickname: nick });
  renderAccount();
  toast({ title: 'Ник сохранён', text: `Вы войдёте в игру как ${nick}`, type: 'success', timeout: 3000 });
  return true;
}

function bindAccount() {
  $('#account').addEventListener('click', (e) => { e.stopPropagation(); toggleAccountPop(); });
  $('#account').addEventListener('keydown', (e) => { if (e.key === 'Enter') toggleAccountPop(); });
  $('#accountPop').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => !$('#accountPop').hidden && toggleAccountPop(false));
  const submit = async () => { if (await saveNick($('#nickInput'), setNickHint)) toggleAccountPop(false); };
  $('#nickSave').addEventListener('click', submit);
  $('#nickInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') toggleAccountPop(false);
  });
  $('#nickInput').addEventListener('input', () => setNickHint());
}

function showWelcome() {
  const dlg = openModal(`
    <div class="welcome">
      <img src="assets/logo.svg" alt="">
      <h2>Добро пожаловать в Meridian Online</h2>
      <p>Придумайте игровой ник — под ним вас будут знать на сервере.<br>Формат RP-ника: Имя_Фамилия.</p>
      <div class="field">
        <input class="input" id="welcomeNick" maxlength="20" spellcheck="false" placeholder="Ivan_Petrov">
        <button class="btn btn--primary" id="welcomeSave">Продолжить ${icon('arrow-right')}</button>
      </div>
      <div class="field__hint" id="welcomeHint">Только латиница, цифры и знак _ · от 3 до 20 символов</div>
    </div>`, { dismissable: false });
  const input = dlg.querySelector('#welcomeNick');
  const hint = dlg.querySelector('#welcomeHint');
  const setHint = (err) => {
    hint.textContent = err || 'Только латиница, цифры и знак _ · от 3 до 20 символов';
    hint.classList.toggle('is-error', !!err);
    input.classList.toggle('is-error', !!err);
  };
  const submit = async () => { if (await saveNick(input, setHint)) closeModal(); };
  dlg.querySelector('#welcomeSave').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  input.addEventListener('input', () => setHint());
  setTimeout(() => input.focus(), 50);
}

// ═════════════════ Статус и главная кнопка ═════════════════
/** «14.11.2026 21:53:57,47» → «14.11.2026»; «1.0.0» остаётся как есть */
const fmtVer = (v) => String(v ?? '').trim().split(/[\s,]+/)[0] || '—';

const BUSY = ['preparing', 'downloading', 'verifying', 'extracting', 'prereq-download', 'prereq-install', 'fixing'];

function computeView() {
  const g = state.game;
  const p = state.progress;
  const view = {
    title: '', pct: null, bar: 0, info: '', actions: [], mode: '',
    button: { label: '', icon: '', disabled: false, cls: '', action: null },
  };

  if (!g) {
    Object.assign(view, { title: 'Проверка файлов…', mode: 'indeterminate' });
    Object.assign(view.button, { label: 'Загрузка…', disabled: true });
    return view;
  }

  if (state.running) {
    const hk = state.hotkey?.ok && state.hotkey.label;
    Object.assign(view, {
      title: 'Игра запущена', pct: '', bar: 100,
      info: `Сервер ${esc(selectedServer()?.name || '')}${hk ? ` · зависла? <b class="kbd">${esc(hk)}</b>` : ''}`,
    });
    Object.assign(view.button, { label: 'Игра запущена', icon: 'gamepad-2', disabled: true, cls: 'is-running' });
    return view;
  }

  if (p && BUSY.includes(p.state)) {
    view.mode = 'active';
    view.button = { label: 'Установка…', icon: 'loader-circle', disabled: true, cls: '' };
    if (p.state === 'preparing') {
      view.title = 'Подготовка к загрузке…';
      view.mode = 'indeterminate';
    } else if (p.state === 'downloading') {
      view.title = p.mode === 'files'
        ? `Загрузка игры · файл ${Math.min(p.index, p.count)} из ${p.count}`
        : (p.count > 1 ? `Загрузка игры · часть ${p.index}/${p.count}` : 'Загрузка игры');
      view.pct = `${(p.percent || 0).toFixed(1).replace('.', ',')}%`;
      view.bar = p.percent || 0;
      const parts = [];
      if (p.retry) parts.push(p.message || 'Переподключение…');
      else if (p.speed) parts.push(`${bytes(p.speed)}/с`);
      parts.push(`${bytes(p.downloaded)} из ${bytes(p.total)}`);
      if (p.eta) parts.push(`≈ ${duration(p.eta)}`);
      view.info = parts.join(' · ');
      view.actions = [['x', 'Отменить загрузку', 'cancel']];
      view.button = { label: 'Пауза', icon: 'pause', disabled: false, cls: 'is-pause', action: 'pause' };
    } else if (p.state === 'verifying') {
      view.title = 'Проверка целостности';
      view.pct = `${Math.round(p.percent || 0)}%`;
      view.bar = p.percent || 0;
      view.info = p.file || '';
    } else if (p.state === 'fixing') {
      view.title = 'Фикс игры';
      view.info = esc(p.step || '');
      if (p.percent != null) {
        view.pct = `${Math.round(p.percent)}%`;
        view.bar = p.percent;
      } else view.mode = 'indeterminate';
      view.button.label = 'Фикс…';
      view.button.icon = 'wrench';
    } else if (p.state === 'prereq-download') {
      view.title = 'Загрузка компонентов Windows';
      view.pct = `${Math.round(p.percent || 0)}%`;
      view.bar = p.percent || 0;
      view.info = `${esc(p.name)}${p.count > 1 ? ` · ${p.index} из ${p.count}` : ''}`;
      view.button.label = 'Компоненты…';
    } else if (p.state === 'prereq-install') {
      view.title = 'Установка компонентов Windows';
      view.mode = 'indeterminate';
      view.info = 'Разрешите установку в окне Windows (запрос администратора)';
      view.button.label = 'Компоненты…';
    } else if (p.state === 'extracting') {
      view.title = 'Распаковка файлов игры';
      view.pct = `${Math.round(p.percent || 0)}%`;
      view.bar = p.percent || 0;
      view.info = 'Не закрывайте лаунчер';
      view.actions = [['x', 'Отмена', 'cancel']];
    }
    return view;
  }

  if (p?.state === 'error') {
    Object.assign(view, { title: 'Ошибка установки', mode: 'error', bar: 100, info: esc(p.message || '') });
    view.actions = [['folder-search', 'Папка', 'choose-dir']];
    Object.assign(view.button, { label: 'Повторить', icon: 'rotate-ccw', action: 'install' });
    return view;
  }

  const paused = p?.state === 'paused' || (!g.installed && g.partialBytes > 0) || (g.needsUpdate && g.partialBytes > 0);
  if (paused && g.published) {
    const done = p?.downloaded ?? g.partialBytes;
    const total = p?.total ?? g.downloadSize;
    const pct = total ? (done / total) * 100 : 0;
    Object.assign(view, {
      title: 'Загрузка на паузе', mode: 'paused', bar: pct,
      pct: `${pct.toFixed(1).replace('.', ',')}%`,
      info: `${bytes(done)} из ${bytes(total)}`,
      actions: [['x', 'Отмена', 'cancel']],
    });
    Object.assign(view.button, { label: 'Продолжить', icon: 'play', action: 'install' });
    return view;
  }

  if (!g.installed) {
    if (!g.published) {
      Object.assign(view, g.online === false
        ? { title: 'Нет связи с сервером обновлений', mode: 'error', bar: 100, info: 'Проверьте интернет или отключите VPN/прокси. Если игра уже установлена — укажите папку.' }
        : { title: 'Игра не найдена', info: 'Сборка скоро появится. Если игра уже установлена — укажите папку.' });
      view.actions = [['refresh-cw', 'Проверить снова', 'recheck'], ['folder-search', 'Указать папку', 'choose-dir']];
      Object.assign(view.button, { label: 'Скоро', icon: 'download', disabled: true });
    } else {
      Object.assign(view, { title: 'Игра не установлена', info: `Загрузка: ${bytes(g.downloadSize)}${g.unpackedSize ? ` · на диске ${bytes(g.unpackedSize)}` : ''}` });
      view.actions = [['folder-search', 'Уже есть игра', 'choose-dir']];
      Object.assign(view.button, { label: 'Установить', icon: 'download', action: 'install' });
    }
    return view;
  }

  if (g.needsUpdate && g.incomplete) {
    Object.assign(view, { title: 'Установка не завершена', bar: 0, pct: '', info: 'Докачаются только недостающие файлы' });
    Object.assign(view.button, { label: 'Продолжить установку', icon: 'download', action: 'install', cls: 'is-update' });
    return view;
  }

  if (g.needsUpdate) {
    Object.assign(view, {
      title: `Доступно обновление ${esc(fmtVer(g.latestVersion))}`,
      bar: 0, pct: '',
      info: g.filesMode ? `Текущая версия ${esc(fmtVer(g.installedVersion))} · скачаются только изменённые файлы` : `Текущая версия ${esc(fmtVer(g.installedVersion))} · ${bytes(g.downloadSize)}`,
    });
    Object.assign(view.button, { label: 'Обновить игру', icon: 'circle-arrow-up', action: 'install', cls: 'is-update' });
    return view;
  }

  if (state.gpu?.problem) {
    Object.assign(view, {
      title: 'Не установлен драйвер видеокарты', mode: 'paused', bar: 100, pct: '',
      info: `Без драйвера${state.gpu.problem.vendorName ? ` ${esc(state.gpu.problem.vendorName)}` : ''} GTA не сможет запуститься`,
      actions: [['download', 'Как установить', 'driver'], ['refresh-cw', 'Проверить', 'gpu-recheck']],
    });
    Object.assign(view.button, { label: 'Войти в игру', icon: 'play', action: 'launch', disabled: state.launching });
    return view;
  }

  Object.assign(view, {
    title: 'Игра готова к запуску', pct: '100%', bar: 100,
    info: state.settings.safeMode
      ? 'Безопасный запуск: графические моды отключены'
      : (g.installedVersion && g.installedVersion !== '0.0.0' ? `Версия сборки ${esc(fmtVer(g.installedVersion))}` : ''),
  });
  Object.assign(view.button, { label: 'Войти в игру', icon: 'play', action: 'launch', disabled: state.launching });
  if (state.launching) view.button.label = 'Запуск…';
  return view;
}

function renderStatus() {
  const v = computeView();
  const st = $('#status');
  st.className = 'status';
  if (v.mode) st.classList.add(`is-${v.mode}`);
  $('#statusTitle').innerHTML = v.title;
  $('#statusPct').textContent = v.pct ?? '';
  $('#statusBar').style.width = `${Math.max(0, Math.min(100, v.bar))}%`;
  $('#statusInfo').innerHTML = v.info;
  $('#statusActions').innerHTML = v.actions
    .map(([ic, label, act]) => `<button class="mini-btn" data-act="${act}" title="${label}">${icon(ic)}${label}</button>`)
    .join('');

  const btn = $('#playBtn');
  btn.className = `play ${v.button.cls}`;
  btn.disabled = v.button.disabled;
  btn.dataset.action = v.button.action || '';
  const spin = v.button.icon === 'loader-circle' ? 'spin' : '';
  $('#playLabel').innerHTML = `${v.button.icon ? icon(v.button.icon, spin) : ''}${esc(v.button.label)}`;
}

async function refreshGame(force = false) {
  state.game = await api.game.status(force);
  if (state.game.installerState && BUSY.includes(state.game.installerState.state)) state.progress = state.game.installerState;
  renderStatus();
}

async function runAction(action) {
  switch (action) {
    case 'install': {
      state.progress = { state: 'preparing' };
      renderStatus();
      const res = await api.game.install();
      if (res.ok) {
        if (res.downloadedFiles === 0) toast({ title: 'Все файлы игры в порядке', text: 'Скачивать ничего не пришлось.', type: 'success' });
        else if (res.downloadedFiles != null) toast({ title: 'Игра готова', text: `Скачано файлов: ${res.downloadedFiles} (${bytes(res.downloadedBytes)}). Можно заходить на сервер!`, type: 'success' });
        else toast({ title: 'Игра установлена', text: 'Можно заходить на сервер!', type: 'success' });
        state.progress = null;
        reportPrereqs(res.prereqs);
      } else if (res.cancelled) {
        state.progress = null;
      } else if (res.error) {
        toast({ title: 'Не удалось установить игру', text: res.error, type: 'error', timeout: 9000 });
      }
      await refreshGame();
      break;
    }
    case 'pause':
      await api.game.pause();
      break;
    case 'cancel': {
      const ok = await confirmDialog({
        title: 'Отменить загрузку?',
        text: 'Скачанные файлы будут удалены, загрузку придётся начать заново.',
        okLabel: 'Отменить загрузку', danger: true,
      });
      if (!ok) return;
      await api.game.cancel();
      state.progress = null;
      await refreshGame();
      break;
    }
    case 'choose-dir': {
      const res = await api.game.chooseDir();
      if (res?.ok) {
        state.progress = null;
        await refreshGame();
        toast({
          title: state.game.installed ? 'Игра найдена' : 'Папка выбрана',
          text: state.game.installed ? 'Лаунчер будет запускать игру из этой папки.' : `Игра будет установлена в ${res.dir}`,
          type: state.game.installed ? 'success' : 'info',
        });
      } else if (res?.error) toast({ title: res.error, type: 'warn' });
      break;
    }
    case 'launch':
      await launch();
      break;
    case 'driver':
      await showDriverHelp(state.gpu?.problem);
      break;
    case 'gpu-recheck':
      await recheckGpu(true);
      break;
    case 'recheck':
      state.game = null;
      renderStatus();
      await refreshGame(true);
      if (!state.game.published) toast({ title: state.game.online === false ? 'Сервер обновлений недоступен' : 'Сборка пока не опубликована', type: 'warn' });
      break;
  }
}

function reportPrereqs(r) {
  if (!r) return;
  if (r.declined) {
    toast({ title: 'Компоненты не установлены', text: 'Без DirectX, Visual C++ и DirectPlay игра может не запуститься. Установить их можно в настройках.', type: 'warn', timeout: 9000 });
  } else if (r.error || r.failed?.length) {
    toast({ title: 'Не удалось установить компоненты', text: r.error || r.failed.join(', '), type: 'error', timeout: 9000 });
  } else if (r.installed?.length) {
    toast({
      title: 'Компоненты установлены',
      text: r.reboot ? `${r.installed.join(', ')}. Рекомендуем перезагрузить компьютер.` : r.installed.join(', '),
      type: 'success',
    });
  }
}

async function installPrereqs() {
  const r = await api.prereqs.install();
  state.progress = null;
  renderStatus();
  reportPrereqs(r);
  return r;
}

function askPrereqs(names) {
  return new Promise((resolve) => {
    let choice = 'cancel';
    const dlg = openModal(`
      <div class="modal__head">
        <div class="modal__icon">${icon('wrench')}</div>
        <div>
          <div class="modal__title">Нужны компоненты Windows</div>
          <div class="modal__sub">Без них клиент CR-MP может не запуститься</div>
        </div>
      </div>
      <div class="modal__body">
        <div class="prereq-list">
          ${names.map((n) => `<div class="prereq">${icon('download')}<span>${esc(n)}</span><span class="chip">не установлен</span></div>`).join('')}
        </div>
        <p class="prereq-note">Лаунчер скачает официальные установщики Microsoft, включит нужные компоненты Windows и всё установит автоматически. Windows один раз попросит разрешение администратора.</p>
      </div>
      <div class="modal__foot">
        <button class="btn" data-choice="skip">Запустить без них</button>
        <button class="btn btn--primary" data-choice="install">${icon('download')}Установить</button>
      </div>`, { onClose: () => resolve(choice) });
    dlg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-choice]');
      if (b) { choice = b.dataset.choice; closeModal(); }
    });
  });
}

async function launch() {
  if (!state.settings.nickname) {
    toggleAccountPop(true);
    setNickHint('Сначала укажите игровой ник');
    return;
  }
  state.launching = true;
  renderStatus();
  const server = selectedServer();
  const opts = {};
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await api.game.launch(server.id, opts);
    if (res.needDriver) {
      state.gpu = { ...(state.gpu || {}), problem: res.needDriver };
      state.launching = false;
      renderStatus();
      const choice = await showDriverHelp(res.needDriver, { forLaunch: true });
      if (choice === 'skip') opts.skipGpu = true;
      else if (choice !== 'recheck') return;
      state.launching = true;
      renderStatus();
      continue;
    }
    if (res.needPrereqs) {
      state.launching = false;
      renderStatus();
      const choice = await askPrereqs(res.needPrereqs);
      if (choice === 'cancel') return;
      if (choice === 'install') {
        const r = await installPrereqs();
        if (!r.ok) return;
      }
      opts.skipPrereqs = true;
      state.launching = true;
      renderStatus();
      continue;
    }
    break;
  }
  if (res.needDriver || res.needPrereqs) { state.launching = false; renderStatus(); return; }
  if (opts.skipGpu === undefined && state.gpu?.problem) { state.gpu.problem = null; }
  state.launching = false;
  if (!res.ok) {
    toast({ title: 'Не удалось запустить игру', text: res.error, type: 'error', timeout: 8000 });
  } else {
    toast({ title: 'Запускаем игру…', text: `Подключение к ${server.name} (${server.ip}:${server.port})`, type: 'success', timeout: 4000 });
  }
  renderStatus();
}

function bindStatus() {
  $('#playBtn').addEventListener('click', () => {
    const a = $('#playBtn').dataset.action;
    if (a) runAction(a);
  });
  $('#statusActions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) runAction(b.dataset.act);
  });
  $('#openFolderBtn').addEventListener('click', openFolder);

  api.game.onProgress((p) => {
    state.progress = p;
    if (p.state === 'done' || p.state === 'idle') state.progress = null;
    renderStatus();
  });
  api.game.onRunning((running) => {
    state.running = running;
    renderStatus();
  });
  api.game.onHotkey((hk) => {
    state.hotkey = hk;
    renderStatus();
    if (hk && !hk.ok && !hk.off) {
      toast({ title: `Сочетание ${hk.label} занято`, text: 'Его использует другая программа. Выберите другое в настройках → «Закрыть зависшую игру».', type: 'warn' });
    }
  });
  api.game.onKilled((r) => {
    if (!r.ok) toast({ title: 'Игра не закрылась', text: r.error, type: 'error' });
  });
  api.game.onExited(({ seconds, neverStarted, killed }) => {
    if (killed) {
      toast({ title: 'Зависшая игра закрыта', text: 'Можно запускать заново. Если игра зависает часто — попробуйте «Фикс игры».', type: 'success' });
      return;
    }
    if (!(neverStarted || seconds < 120)) return;
    if (state.gpu?.problem) showDriverHelp(state.gpu.problem);
    else showCrashHelp(neverStarted ? null : seconds);
  });
  $('#fixBtn').addEventListener('click', openFix);
  $('#creditBtn').addEventListener('click', () => api.app.open('https://t.me/developerbyfluffybarbara'));
}

// ═════════════════ Драйвер видеокарты ═════════════════
async function recheckGpu(withToast) {
  state.gpu = await api.gpu.check(true);
  renderStatus();
  if (withToast) {
    toast(state.gpu.problem
      ? { title: 'Драйвер всё ещё не найден', text: 'После установки драйвера перезагрузите компьютер.', type: 'warn' }
      : { title: 'Драйвер видеокарты установлен', text: 'Можно заходить в игру!', type: 'success' });
  }
  return state.gpu;
}

function showDriverHelp(problem, { forLaunch = false } = {}) {
  if (!problem) return Promise.resolve('cancel');
  const vendor = problem.vendorName || 'вашей видеокарты';
  return new Promise((resolve) => {
    let choice = 'cancel';
    const dlg = openModal(`
      <div class="modal__head">
        <div class="modal__icon modal__icon--warn">${icon('triangle-alert')}</div>
        <div>
          <div class="modal__title">Не установлен драйвер видеокарты</div>
          <div class="modal__sub">Из-за этого игра вылетает при запуске</div>
        </div>
        <button class="icon-btn modal__x" data-close>${icon('x')}</button>
      </div>
      <div class="modal__body">
        <p class="driver-lead">Windows сейчас работает через <b>«${esc(problem.adapter)}»</b> — это временная заглушка без аппаратного Direct3D. GTA не может создать графику и закрывается. Нужно установить драйвер <b>${esc(vendor)}</b>.</p>
        <div class="crash-steps">
          <button class="card crash-step" data-do="site">
            <span class="crash-step__n">1</span>
            <span><span class="crash-step__t">Скачать драйвер ${esc(problem.vendorName || '')} с официального сайта</span><span class="crash-step__d">${esc(problem.url.replace(/^https?:\/\//, ''))}</span></span>
          </button>
          <button class="card crash-step" data-do="wu">
            <span class="crash-step__n">2</span>
            <span><span class="crash-step__t">Или через Центр обновления Windows</span><span class="crash-step__d">«Дополнительные параметры → Необязательные обновления → Обновления драйверов» — отметьте драйвер видеокарты. Подходит, если сайт производителя не открывается</span></span>
          </button>
          <div class="card crash-step crash-step--static">
            <span class="crash-step__n">3</span>
            <span><span class="crash-step__t">Перезагрузите компьютер</span><span class="crash-step__d">После перезагрузки нажмите «Проверить снова» — лаунчер убедится, что драйвер на месте</span></span>
          </div>
        </div>
      </div>
      <div class="modal__foot">
        ${forLaunch ? '<button class="btn" data-choice="skip">Запустить всё равно</button>' : ''}
        <button class="btn btn--primary" data-choice="recheck">${icon('refresh-cw')}Проверить снова</button>
      </div>`, { onClose: () => resolve(choice) });
    dlg.addEventListener('click', async (e) => {
      const d = e.target.closest('[data-do]');
      if (d?.dataset.do === 'site') api.app.open(problem.url);
      if (d?.dataset.do === 'wu') api.app.openWindowsUpdate();
      const c = e.target.closest('[data-choice]');
      if (!c) return;
      if (c.dataset.choice === 'recheck') {
        const g = await recheckGpu(true);
        if (g.problem) return; // остаёмся в окне
        choice = forLaunch ? 'recheck' : 'cancel';
      } else choice = c.dataset.choice;
      closeModal();
    });
  });
}

// ═════════════════ Помощь при вылете ═════════════════
function showCrashHelp(seconds) {
  const safe = state.settings.safeMode;
  const dlg = openModal(`
    <div class="modal__head">
      <div class="modal__icon">${icon('triangle-alert')}</div>
      <div>
        <div class="modal__title">${seconds == null ? 'Игра не запустилась' : `Игра закрылась через ${seconds} с`}</div>
        <div class="modal__sub">Если это был вылет — попробуйте по порядку</div>
      </div>
      <button class="icon-btn modal__x" data-close>${icon('x')}</button>
    </div>
    <div class="modal__body">
      <div class="crash-steps">
        <button class="card crash-step" data-do="fix">
          <span class="crash-step__n">1</span>
          <span><span class="crash-step__t">Фикс игры</span><span class="crash-step__d">Проверит файлы, сбросит настройки GTA, переустановит DirectX и Visual C++</span></span>
        </button>
        <button class="card crash-step" data-do="safe">
          <span class="crash-step__n">2</span>
          <span><span class="crash-step__t">${safe ? 'Безопасный запуск уже включён' : 'Безопасный запуск'}</span><span class="crash-step__d">${safe ? 'Графические моды и так отключены — переходите к шагу 3' : 'Запустить игру без графических модов (сглаживание, частота экрана, широкоформат)'}</span></span>
        </button>
        <button class="card crash-step" data-do="report">
          <span class="crash-step__n">3</span>
          <span><span class="crash-step__t">Отчёт для поддержки</span><span class="crash-step__d">Соберёт данные о компьютере и логи вылета в файл на рабочем столе — отправьте его администрации</span></span>
        </button>
      </div>
    </div>`);
  dlg.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-do]');
    if (!b) return;
    closeModal();
    if (b.dataset.do === 'fix') openFix();
    if (b.dataset.do === 'report') makeReport();
    if (b.dataset.do === 'safe') {
      if (!safe) {
        state.settings = await api.settings.set({ safeMode: true });
        renderStatus();
        toast({ title: 'Безопасный запуск включён', text: 'Отключить его можно в настройках.', type: 'success' });
      }
      runAction('launch');
    }
  });
}

async function makeReport() {
  toast({ title: 'Собираем отчёт…', text: 'Это займёт несколько секунд.', timeout: 3000 });
  const r = await api.support.report();
  if (r.ok) {
    toast({
      title: 'Отчёт сохранён на рабочем столе',
      text: `${r.file.split(/[\\/]/).pop()} — отправьте этот файл в поддержку. Текст отчёта также скопирован в буфер обмена.`,
      type: 'success',
      timeout: 12000,
    });
  } else {
    toast({ title: 'Не удалось создать отчёт', text: r.error, type: 'error' });
  }
}

// ═════════════════ Фикс игры ═════════════════
const FIX_STATUS_ICON = { ok: 'circle-check', warn: 'triangle-alert', fail: 'triangle-alert', skip: 'info' };

function openFix() {
  if (state.running) { toast({ title: 'Сначала закройте игру', type: 'warn' }); return; }
  if (state.progress && BUSY.includes(state.progress.state)) { toast({ title: 'Дождитесь окончания текущей операции', type: 'warn' }); return; }
  if (!state.game?.installed) { toast({ title: 'Игра ещё не установлена', text: 'Нажмите «Установить».', type: 'warn' }); return; }
  const opts = [
    ['resetSettings', 'Сбросить настройки графики GTA', 'Самая частая причина вылетов при запуске. Разрешение и графику придётся выставить заново'],
    ['components', 'Переустановить DirectX, Visual C++ и DirectPlay', 'Скачает официальные установщики Microsoft (~20 МБ)'],
    ['defender', 'Добавить папку игры в исключения Защитника Windows', 'Защитник иногда удаляет samp.dll и моды, считая их подозрительными'],
  ];
  const dlg = openModal(`
    <div class="modal__head">
      <div class="modal__icon">${icon('wrench')}</div>
      <div>
        <div class="modal__title">Фикс игры</div>
        <div class="modal__sub">Если игра вылетает, не запускается или зависает</div>
      </div>
      <button class="icon-btn modal__x" data-close>${icon('x')}</button>
    </div>
    <div class="modal__body">
      <div class="fix-always">
        ${['Закрыть зависшие процессы игры', 'Проверить все файлы игры и найти повреждённые', 'Отключить посторонние моды и читы, которых нет в сборке', 'Снять режимы совместимости Windows и оптимизацию во весь экран']
          .map((t) => `<div class="fix-always__item">${icon('check')}${t}</div>`).join('')}
      </div>
      <div class="fix-opts">
        ${opts.map(([k, t, d]) => `
          <label class="fix-opt">
            <span class="switch"><input type="checkbox" data-opt="${k}" checked><span></span></span>
            <span><span class="set-row__label" style="display:block">${t}</span><span class="set-row__desc" style="display:block">${d}</span></span>
          </label>`).join('')}
      </div>
      <p class="prereq-note">Для компонентов и Защитника Windows один раз попросит права администратора.</p>
    </div>
    <div class="modal__foot">
      <button class="btn" data-close>Отмена</button>
      <button class="btn btn--primary" data-run>${icon('wrench')}Починить игру</button>
    </div>`);
  dlg.querySelector('[data-run]').addEventListener('click', async () => {
    const options = {};
    dlg.querySelectorAll('[data-opt]').forEach((i) => { options[i.dataset.opt] = i.checked; });
    closeModal();
    await runFix(options);
  });
}

async function runFix(options) {
  state.progress = { state: 'fixing', step: 'Подготовка…' };
  renderStatus();
  const res = await api.game.fix(options);
  state.progress = null;
  await refreshGame(true);
  if (!res.steps) {
    toast({ title: 'Фикс не выполнен', text: res.error || '', type: 'error', timeout: 8000 });
    return;
  }
  const dlg = openModal(`
    <div class="modal__head">
      <div class="modal__icon">${icon(res.needReinstall ? 'triangle-alert' : 'circle-check')}</div>
      <div>
        <div class="modal__title">${res.needReinstall ? (state.game?.filesMode ? 'Нужно восстановить файлы' : 'Нужно перекачать игру') : 'Фикс завершён'}</div>
        <div class="modal__sub">${res.needReinstall ? `Найдены повреждённые или удалённые файлы: ${res.damaged}` : 'Запустите игру ещё раз'}</div>
      </div>
      <button class="icon-btn modal__x" data-close>${icon('x')}</button>
    </div>
    <div class="modal__body">
      <div class="fix-result">
        ${res.steps.map((s) => `
          <div class="fix-step fix-step--${s.status}">
            ${icon(FIX_STATUS_ICON[s.status] || 'info')}
            <div><div class="fix-step__title">${esc(s.title)}</div><div class="fix-step__text">${esc(s.text)}</div></div>
          </div>`).join('')}
      </div>
      ${res.needReinstall && state.game?.filesMode ? '<p class="prereq-note">Лаунчер скачает из хранилища только повреждённые и удалённые файлы — это быстро. Скорее всего, их удалил антивирус: после восстановления он больше не помешает, если вы добавили папку в исключения.</p>' : ''}${res.needReinstall && !state.game?.filesMode ? '<p class="prereq-note">Повреждённые файлы восстанавливаются перекачкой сборки (около 2 ГБ). Скорее всего, их удалил антивирус — после перекачки он больше не помешает, если вы добавили папку в исключения.</p>' : ''}
    </div>
    <div class="modal__foot">
      <button class="btn" data-report>${icon('newspaper')}Отчёт для поддержки</button>
      ${res.driver ? `<button class="btn btn--primary" data-driver>${icon('download')}Установить драйвер</button>` : ''}
      <button class="btn" data-close>Закрыть</button>
      ${res.needReinstall
        ? `<button class="btn btn--primary" data-reinstall>${icon('download')}${state.game?.filesMode ? 'Восстановить файлы' : 'Перекачать игру'}</button>`
        : `<button class="btn btn--primary" data-play>${icon('play')}Войти в игру</button>`}
    </div>`);
  dlg.querySelector('[data-reinstall]')?.addEventListener('click', async () => {
    closeModal();
    await api.game.reinstall();
    runAction('install');
  });
  dlg.querySelector('[data-play]')?.addEventListener('click', () => { closeModal(); runAction('launch'); });
  dlg.querySelector('[data-report]')?.addEventListener('click', () => { closeModal(); makeReport(); });
  dlg.querySelector('[data-driver]')?.addEventListener('click', () => { closeModal(); showDriverHelp(res.driver); });
}

async function openFolder() {
  const ok = await api.game.openDir();
  if (!ok) toast({ title: 'Папка игры ещё не создана', text: 'Сначала установите игру.', type: 'warn' });
}

// ═════════════════ Главная ═════════════════
let slideIdx = 0;

function renderHero() {
  const slides = state.content.slides?.length ? state.content.slides : [{ title: 'Meridian Online', text: '' }];
  const media = $('#heroMedia');
  const body = $('#heroBody');
  const dots = $('#heroDots');
  media.innerHTML = '<div class="hero__deco"></div>';
  body.innerHTML = '';
  dots.innerHTML = '';

  slides.forEach((s, i) => {
    if (s.image) media.insertAdjacentHTML('beforeend', `<div class="slide-bg" data-i="${i}" style="background-image:url('${encodeURI(s.image)}')"></div>`);
    const btn = s.button?.url ? `<button class="btn btn--primary slide__btn" data-url="${esc(s.button.url)}">${esc(s.button.label || 'Подробнее')} ${icon('arrow-right')}</button>` : '';
    body.insertAdjacentHTML('beforeend', `
      <div class="slide" data-i="${i}">
        ${s.kicker ? `<span class="slide__kicker">${icon('sparkles')}${esc(s.kicker)}</span>` : ''}
        <div class="slide__title">${esc(s.title)}</div>
        ${s.text ? `<div class="slide__text">${esc(s.text)}</div>` : ''}
        ${btn}
      </div>`);
    const dot = h(`<button class="hero__dot" data-i="${i}"><i></i></button>`);
    dot.addEventListener('click', () => showSlide(i));
    dot.querySelector('i').addEventListener('animationend', () => showSlide(slideIdx + 1));
    dots.appendChild(dot);
  });

  // Высота блока = самый высокий слайд
  requestAnimationFrame(() => {
    const max = Math.max(...$$('.slide', body).map((s) => s.offsetHeight), 120);
    body.style.minHeight = `${max + 18}px`;
  });

  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-url]');
    if (b) api.app.open(b.dataset.url);
  });
  $('.hero__nav').style.display = slides.length > 1 ? '' : 'none';
  showSlide(0);
}

function showSlide(i) {
  const n = $$('.slide').length;
  if (!n) return;
  slideIdx = ((i % n) + n) % n;
  $$('.slide').forEach((el) => el.classList.toggle('is-active', +el.dataset.i === slideIdx));
  $$('.slide-bg').forEach((el) => el.classList.toggle('is-active', +el.dataset.i === slideIdx));
  $$('.hero__dot').forEach((el) => {
    const active = +el.dataset.i === slideIdx;
    el.classList.toggle('is-active', active);
    // Перезапуск анимации прогресса
    const bar = el.querySelector('i');
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = '';
  });
}

function renderFeatures() {
  const wrap = $('#features');
  wrap.innerHTML = '';
  for (const f of (state.content.features || []).slice(0, 2)) {
    const el = h(`
      <button class="card feature">
        <span class="feature__icon">${icon(f.icon || 'sparkles')}</span>
        <span>
          <span class="feature__title" style="display:block">${esc(f.title)}</span>
          <span class="feature__text" style="display:block">${esc(f.text)}</span>
        </span>
      </button>`);
    if (f.url) el.addEventListener('click', () => api.app.open(f.url));
    else el.style.cursor = 'default';
    wrap.appendChild(el);
  }
}

function sortedNews() {
  return [...(state.content.news || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function renderNews() {
  const list = $('#newsList');
  const grid = $('#newsGrid');
  list.innerHTML = '';
  grid.innerHTML = '';
  const news = sortedNews();
  if (!news.length) {
    list.innerHTML = '<div class="news-item__text" style="padding:10px 4px">Новостей пока нет</div>';
  }
  for (const n of news) {
    const meta = `${n.tag ? `<span class="chip chip--accent">${esc(n.tag)}</span>` : ''}<span class="chip">${esc(date(n.date))}</span>`;
    const item = h(`
      <button class="news-item">
        <div class="news-item__title">${esc(n.title)}</div>
        <div class="news-item__text">${esc(n.text)}</div>
        <div class="news-item__meta">${meta}</div>
      </button>`);
    const tile = h(`
      <button class="card news-tile">
        ${n.image ? `<div class="news-tile__img" style="background-image:url('${encodeURI(n.image)}')"></div>` : ''}
        <div class="news-tile__title">${esc(n.title)}</div>
        <div class="news-tile__text">${esc(n.text)}</div>
        <div class="news-tile__meta">${meta}</div>
      </button>`);
    const open = () => (n.url ? api.app.open(n.url) : switchView('news'));
    item.addEventListener('click', open);
    if (n.url) tile.addEventListener('click', () => api.app.open(n.url));
    else tile.style.cursor = 'default';
    list.appendChild(item);
    grid.appendChild(tile);
  }
}

function renderSocials() {
  const wrap = $('#socials');
  wrap.innerHTML = '';
  for (const s of state.content.socials || []) {
    const el = h(`
      <button class="social" style="--brand:${SOCIAL_BRAND[s.id] || 'var(--accent)'}">
        <span class="social__icon">${icon(s.id) || icon('globe')}</span>
        <span>
          <span class="social__title" style="display:block">${esc(s.title)}</span>
          <span class="social__sub" style="display:block">${esc(s.subtitle || '')}</span>
        </span>
        <span class="social__go">${icon('external-link')}</span>
      </button>`);
    el.addEventListener('click', () => s.url && api.app.open(s.url));
    wrap.appendChild(el);
  }
}

function renderSupport() {
  const sup = state.content.support || {};
  $('#supportText').textContent = sup.text || '';
  const faq = $('#faq');
  faq.innerHTML = '';
  for (const item of sup.faq || []) {
    const el = h(`
      <div class="card faq__item">
        <button class="faq__q"><span class="faq__qi">${icon('message-circle-question')}</span>${esc(item.q)}${icon('chevron-down')}</button>
        <div class="faq__a"><div>${esc(item.a)}</div></div>
      </div>`);
    el.querySelector('.faq__q').addEventListener('click', () => el.classList.toggle('is-open'));
    faq.appendChild(el);
  }
  const contacts = $('#contacts');
  contacts.innerHTML = '';
  for (const c of sup.contacts || []) {
    const el = h(`
      <button class="card contact" style="--brand:${SOCIAL_BRAND[c.icon] || 'var(--accent)'}">
        <span class="social__icon">${icon(c.icon) || icon('life-buoy')}</span>${esc(c.title)}${icon('external-link')}
      </button>`);
    el.addEventListener('click', () => c.url && api.app.open(c.url));
    contacts.appendChild(el);
  }
}

// ═════════════════ Вкладки ═════════════════
const LINK_TITLES = { forum: 'Форум', site: 'Сайт', shop: 'Магазин' };

/** Внешние ссылки во вкладках: со стрелкой ↗ или с пометкой «скоро», если ссылки пока нет. */
function renderLinkTabs() {
  $$('.tab[data-link]').forEach((t) => {
    t.querySelectorAll('.ico, .tab__soon').forEach((x) => x.remove());
    const url = state.content.links?.[t.dataset.link];
    t.classList.toggle('is-soon', !url);
    t.insertAdjacentHTML('beforeend', url ? icon('external-link') : '<span class="tab__soon">скоро</span>');
    t.title = url ? url.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'Скоро добавится';
  });
}

function switchView(name) {
  $$('.tab[data-view]').forEach((t) => t.classList.toggle('is-active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
}

function bindTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    if (t.dataset.view) switchView(t.dataset.view);
    else if (t.dataset.link) {
      const url = state.content.links?.[t.dataset.link];
      if (url) api.app.open(url);
      else toast({ title: `${LINK_TITLES[t.dataset.link] || 'Раздел'} скоро добавится`, text: 'Следите за новостями проекта.' });
    }
  });
  $$('.row-btn').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.action === 'open-folder') openFolder();
    if (b.dataset.action === 'settings') openSettings();
    if (b.dataset.action === 'verify') reinstallGame();
    if (b.dataset.action === 'fix') openFix();
    if (b.dataset.action === 'report') makeReport();
  }));
}

// ═════════════════ Настройки ═════════════════
async function reinstallGame() {
  if (!state.game?.published) {
    toast({ title: 'Сборка игры ещё не опубликована', type: 'warn' });
    return;
  }
  const ok = await confirmDialog({
    title: 'Переустановить игру?',
    text: 'Лаунчер заново скачает сборку и перезапишет файлы игры. Ваши настройки GTA не пострадают.',
    okLabel: 'Переустановить', iconName: 'wrench',
  });
  if (!ok) return;
  await api.game.reinstall();
  runAction('install');
}

function openSettings() {
  const s = state.settings;
  const g = state.game || {};
  const after = [['minimize', 'Свернуть'], ['hide', 'В трей'], ['close', 'Закрыть'], ['keep', 'Ничего']];
  const dlg = openModal(`
    <div class="modal__head">
      <div class="modal__icon">${icon('settings')}</div>
      <div>
        <div class="modal__title">Настройки</div>
        <div class="modal__sub">Параметры игры и лаунчера</div>
      </div>
      <button class="icon-btn modal__x" data-close>${icon('x')}</button>
    </div>
    <div class="modal__body">
      <div class="set-group">
        <div class="set-group__title">Игра</div>
        <div class="path-box">
          ${icon('hard-drive')}
          <div class="path-box__text" title="${esc(s.gameDir)}">${esc(s.gameDir)}</div>
          <button class="btn btn--sm" data-set="open">${icon('folder-open')}Открыть</button>
          <button class="btn btn--sm" data-set="choose">${icon('pencil')}Изменить</button>
        </div>
        <div class="set-row">
          <div class="set-row__text">
            <div class="set-row__label">Версия сборки</div>
            <div class="set-row__desc">${g.installed ? `Установлена ${esc(fmtVer(g.installedVersion))}` : 'Не установлена'}${g.latestVersion && g.published ? ` · последняя ${esc(fmtVer(g.latestVersion))}` : ''}</div>
          </div>
          <button class="btn btn--sm" data-set="reinstall">${icon('rotate-ccw')}Переустановить</button>
        </div>
        <div class="set-row">
          <div class="set-row__text">
            <div class="set-row__label">Фикс игры</div>
            <div class="set-row__desc">Если игра вылетает или не запускается: проверка файлов, сброс настроек, компоненты Windows</div>
          </div>
          <button class="btn btn--sm" data-set="fix">${icon('wrench')}Починить</button>
        </div>
        <div class="set-row">
          <div class="set-row__text">
            <div class="set-row__label">DirectX, Visual C++ и DirectPlay</div>
            <div class="set-row__desc" id="prereqStatus">Проверка…</div>
          </div>
          <button class="btn btn--sm" data-set="prereqs">${icon('download')}Установить</button>
        </div>
        <div class="set-row">
          <div class="set-row__text">
            <div class="set-row__label">Обновлять игру автоматически</div>
            <div class="set-row__desc">Скачивать новую версию сборки при запуске лаунчера</div>
          </div>
          <label class="switch"><input type="checkbox" data-set="autoUpdateGame" ${s.autoUpdateGame ? 'checked' : ''}><span></span></label>
        </div>
      </div>

      <div class="set-group">
        <div class="set-group__title">Запуск</div>
        <div class="set-row">
          <div class="set-row__text">
            <div class="set-row__label">После запуска игры</div>
            <div class="set-row__desc">Что делать с окном лаунчера</div>
          </div>
          <div class="segmented" data-seg="afterLaunch">
            ${after.map(([v, l]) => `<button data-v="${v}" class="${s.afterLaunch === v ? 'is-active' : ''}">${l}</button>`).join('')}
          </div>
        </div>
        <div class="set-row">
          <div class="set-row__text">
            <div class="set-row__label">Закрыть зависшую игру</div>
            <div class="set-row__desc">Нажмите это сочетание прямо в игре — она закроется мгновенно, без диспетчера задач. Работает, пока лаунчер открыт или свёрнут в трей. Нажмите на клавиши, чтобы назначить свои</div>
            <div class="hotkey-hint" id="hkHint" hidden></div>
          </div>
          <div class="hotkey-ctl" id="hkCtl"></div>
        </div>
        <div class="set-row">
          <div class="set-row__text">
            <div class="set-row__label">Безопасный запуск</div>
            <div class="set-row__desc">Запускать игру без графических модов (сглаживание, частота экрана, широкоформат, небо). Включите, если игра вылетает при запуске</div>
          </div>
          <label class="switch"><input type="checkbox" data-set="safeMode" ${s.safeMode ? 'checked' : ''}><span></span></label>
        </div>
        <div class="set-row">
          <div class="set-row__text">
            <div class="set-row__label">Отчёт для поддержки</div>
            <div class="set-row__desc">Данные о компьютере и логи вылета — в файл на рабочем столе</div>
          </div>
          <button class="btn btn--sm" data-set="report">${icon('newspaper')}Создать</button>
        </div>
      </div>

      <div class="set-group">
        <div class="set-group__title">Интерфейс</div>
        <div class="set-row">
          <div class="set-row__text">
            <div class="set-row__label">Анимированный фон</div>
            <div class="set-row__desc">Снег, туман и параллакс. Отключите на слабых ПК</div>
          </div>
          <label class="switch"><input type="checkbox" data-set="animatedBackground" ${s.animatedBackground ? 'checked' : ''}><span></span></label>
        </div>
        <div class="set-row">
          <div class="set-row__text">
            <div class="set-row__label">Статус в Discord</div>
            <div class="set-row__desc">Показывать друзьям «Смотрит лаунчер» или «Проводит время на Meridian Online»</div>
          </div>
          <label class="switch"><input type="checkbox" data-set="discordPresence" ${s.discordPresence !== false ? 'checked' : ''}><span></span></label>
        </div>
      </div>

      <div class="set-group">
        <div class="set-group__title">О лаунчере</div>
        <div class="set-row">
          <div class="about set-row__text">
            <img src="assets/logo.svg" alt="">
            <div>
              <div class="about__name">Meridian Online Launcher</div>
              <div class="about__ver" id="aboutVer">Версия ${esc(state.info?.version || '')} · ${updaterText()}</div>
            </div>
          </div>
          <button class="btn btn--sm" data-set="check-update">${icon('refresh-cw')}Проверить</button>
        </div>
      </div>
    </div>`);

  dlg.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-set]');
    if (b && b.tagName === 'BUTTON') {
      const act = b.dataset.set;
      if (act === 'open') openFolder();
      if (act === 'choose') { closeModal(); await runAction('choose-dir'); openSettings(); }
      if (act === 'reinstall') { closeModal(); reinstallGame(); }
      if (act === 'fix') { closeModal(); openFix(); }
      if (act === 'report') { closeModal(); makeReport(); }
      if (act === 'prereqs') { closeModal(); await installPrereqs(); }
      if (act === 'check-update') { api.updater.check(); b.querySelector('.ico')?.classList.add('spin'); }
    }
    const seg = e.target.closest('[data-seg] button');
    if (seg) {
      const key = seg.parentElement.dataset.seg;
      state.settings = await api.settings.set({ [key]: seg.dataset.v });
      seg.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('is-active', x === seg));
    }
  });
  initHotkeySetting(dlg);
  api.prereqs.check().then((list) => {
    const el = dlg.querySelector('#prereqStatus');
    if (!el) return;
    const missing = list.filter((p) => !p.installed);
    el.innerHTML = missing.length
      ? `<span style="color:var(--amber)">Не хватает: ${missing.map((p) => esc(p.name)).join(', ')}</span>`
      : `<span style="color:var(--green)">Всё установлено</span> · ${list.map((p) => esc(p.name)).join(', ')}`;
    const btn = dlg.querySelector('[data-set="prereqs"]');
    if (!missing.length) btn.disabled = true;
  });
  dlg.addEventListener('change', async (e) => {
    const inp = e.target.closest('input[data-set]');
    if (!inp) return;
    state.settings = await api.settings.set({ [inp.dataset.set]: inp.checked });
    if (inp.dataset.set === 'animatedBackground') applyAnimation();
    if (inp.dataset.set === 'safeMode') renderStatus();
  });
}

// ═════════════════ Своё сочетание «закрыть зависшую игру» ═════════════════
const keyChips = (accel) => formatAccel(accel).split(' + ').map((k) => `<kbd class="key">${esc(k)}</kbd>`).join('<i class="key-plus">+</i>');

function initHotkeySetting(dlg) {
  const ctl = dlg.querySelector('#hkCtl');
  const hint = dlg.querySelector('#hkHint');
  let recording = false;

  const current = () => {
    const s = state.settings;
    const on = s.killHotkey !== 'off';
    const value = on ? (s.killHotkey || DEFAULT_HOTKEY) : (s.killHotkeyLast || DEFAULT_HOTKEY);
    return { on, value, accel: toAccel(value) };
  };
  const say = (text, type = 'info') => {
    hint.hidden = !text;
    hint.className = `hotkey-hint hotkey-hint--${type}`;
    hint.innerHTML = text || '';
  };

  const render = () => {
    const c = current();
    const isDefault = c.accel === PRESETS[DEFAULT_HOTKEY];
    ctl.innerHTML = `
      ${!isDefault && c.on ? `<button class="hotkey-reset" data-hk="reset" title="Вернуть Ctrl + Alt + End">${icon('rotate-ccw')}</button>` : ''}
      <button class="hotkey ${c.on ? '' : 'is-off'}" data-hk="record" title="Назначить свои клавиши" ${c.on ? '' : 'disabled'}>
        <span class="hotkey__keys">${keyChips(c.accel)}</span>${icon('pencil')}
      </button>
      <label class="switch" title="Включить или выключить"><input type="checkbox" data-hk="toggle" ${c.on ? 'checked' : ''}><span></span></label>`;
  };

  const save = async (patch, message) => {
    state.settings = await api.settings.set(patch);
    render();
    if (message) say(message, 'ok');
  };

  const stop = () => {
    recording = false;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKeyUp, true);
    ctl.querySelector('.hotkey')?.classList.remove('is-recording');
  };

  const showLive = (mods) => {
    const keys = ctl.querySelector('.hotkey__keys');
    if (!keys) return;
    keys.innerHTML = mods.length
      ? `${mods.map((m) => `<kbd class="key">${esc(formatAccel(m))}</kbd>`).join('<i class="key-plus">+</i>')}<i class="key-plus">+</i><span class="hotkey__wait">…</span>`
      : '<span class="hotkey__wait">Нажмите клавиши…</span>';
  };

  async function onKey(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const k = readKeyEvent(e);
    if (e.code === 'Escape' && !k.mods.length) { stop(); render(); say(''); return; }
    if (!k.key) {
      if (k.unsupported) say('Эту клавишу нельзя назначить — выберите другую', 'error');
      else showLive(k.mods);
      return;
    }
    if (!k.mods.some((m) => m !== 'Shift')) {
      showLive(k.mods);
      say('Добавьте <b>Ctrl</b>, <b>Alt</b> или <b>Win</b> — одиночная клавиша мешала бы в игре и чате', 'error');
      return;
    }
    stop();
    const res = await api.game.validateHotkey(k.accel);
    if (!res.ok) {
      render();
      say(esc(res.error), 'error');
      return;
    }
    await save({ killHotkey: res.accel, killHotkeyLast: res.accel }, `Назначено: <b>${esc(res.label)}</b>`);
  }
  function onKeyUp(e) {
    if (!recording) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    showLive(readKeyEvent(e).mods);
  }

  ctl.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-hk]');
    if (!b) return;
    if (b.dataset.hk === 'record') {
      if (recording) { stop(); render(); say(''); return; }
      recording = true;
      b.classList.add('is-recording');
      showLive([]);
      say('Зажмите <b>Ctrl</b>, <b>Alt</b> или <b>Win</b> и нажмите клавишу. <b>Esc</b> — отмена', 'info');
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('keyup', onKeyUp, true);
    }
    if (b.dataset.hk === 'reset') {
      stop();
      await save({ killHotkey: DEFAULT_HOTKEY, killHotkeyLast: null }, 'Возвращено: <b>Ctrl + Alt + End</b>');
    }
  });
  ctl.addEventListener('change', async (e) => {
    if (e.target.dataset.hk !== 'toggle') return;
    stop();
    const c = current();
    if (e.target.checked) await save({ killHotkey: c.value }, '');
    else await save({ killHotkey: 'off', killHotkeyLast: c.value }, '');
    say('');
  });
  // Закрыли окно настроек во время записи — снимаем перехват клавиш
  new MutationObserver((_m, obs) => { if (!dlg.isConnected || $('#modal').hidden) { stop(); obs.disconnect(); } })
    .observe($('#modal'), { attributes: true, childList: true, subtree: true });

  render();
}

// ═════════════════ Обновление лаунчера ═════════════════
function updaterText() {
  const u = state.updater;
  switch (u.state) {
    case 'checking': return 'проверка обновлений…';
    case 'latest': return 'последняя версия';
    case 'available': return `найдена версия ${u.version}`;
    case 'downloading': return `загрузка обновления ${Math.round(u.percent || 0)}%`;
    case 'downloaded': return `версия ${u.version} готова к установке`;
    case 'error': return 'не удалось проверить обновления';
    case 'disabled': return 'режим разработки';
    default: return 'автообновление включено';
  }
}

function renderUpdater() {
  const u = state.updater;
  const pill = $('#updatePill');
  const about = $('#aboutVer');
  if (about) about.textContent = `Версия ${state.info?.version || ''} · ${updaterText()}`;
  if (about) $$('[data-set="check-update"] .ico').forEach((i) => u.state !== 'checking' && i.classList.remove('spin'));

  if (u.state === 'downloading') {
    pill.hidden = false;
    pill.innerHTML = `${icon('download')}Обновление лаунчера · ${Math.round(u.percent || 0)}%`;
    pill.onclick = null;
  } else if (u.state === 'downloaded') {
    pill.hidden = false;
    pill.innerHTML = `${icon('circle-arrow-up')}Обновить лаунчер до v${esc(u.version)}`;
    pill.onclick = () => api.updater.install();
  } else {
    pill.hidden = true;
  }
}

// ═════════════════ Фон ═════════════════
let snow = null;
function applyAnimation() {
  const on = state.settings.animatedBackground;
  document.body.classList.toggle('no-anim', !on);
  if (on) snow.start(); else snow.stop();
}

function loadBackgroundArt() {
  const url = state.content.background || 'assets/background.jpg';
  const img = new Image();
  img.onload = () => {
    const art = $('#sceneArt');
    art.style.backgroundImage = `url('${encodeURI(url)}')`;
    art.classList.add('is-loaded');
    document.body.classList.add('has-art');
  };
  img.src = url;
}

// ═════════════════ Старт ═════════════════
async function boot() {
  paintStaticIcons();
  snow = initSnow($('#snow'));
  initParallax([[$('.scene__skyline'), 14], [$('#sceneArt'), 8]]);

  [state.info, state.settings, state.content] = await Promise.all([api.app.info(), api.settings.get(), api.content.get()]);
  $('#versionLabel').textContent = `Лаунчер v${state.info.version}`;

  $('#btnMin').addEventListener('click', () => api.app.minimize());
  $('#btnClose').addEventListener('click', () => api.app.close());
  $('#btnSettings').addEventListener('click', openSettings);

  applyAnimation();
  loadBackgroundArt();
  bindAccount();
  bindTabs();
  bindStatus();
  renderAccount();
  renderServers();
  renderHero();
  renderFeatures();
  renderNews();
  renderSocials();
  renderSupport();
  renderLinkTabs();
  renderStatus();

  $('#heroPrev').addEventListener('click', () => showSlide(slideIdx - 1));
  $('#heroNext').addEventListener('click', () => showSlide(slideIdx + 1));

  api.updater.onStatus((s) => { state.updater = s; renderUpdater(); });
  state.updater = await api.updater.status();
  renderUpdater();

  pollServers();
  setInterval(pollServers, 15000);

  await refreshGame(true);
  api.gpu.check().then((g) => { state.gpu = g; renderStatus(); }).catch(() => {});
  if (!state.settings.nickname) showWelcome();

  if (state.settings.autoUpdateGame && state.game.needsUpdate && !state.running) {
    toast({ title: `Обновление игры ${fmtVer(state.game.latestVersion)}`, text: 'Загрузка началась автоматически.' });
    runAction('install');
  }

  // Пока сборки нет — проверяем каждую минуту
  setInterval(() => {
    if (state.game && !state.game.published && !state.game.installed) refreshGame(true);
  }, 60 * 1000);

  // Подтягиваем свежий контент раз в 10 минут
  setInterval(async () => {
    try {
      state.content = await api.content.get(true);
      renderNews();
      renderSocials();
      renderLinkTabs();
    } catch {}
    if (!state.progress || !BUSY.includes(state.progress.state)) refreshGame(true);
  }, 10 * 60 * 1000);
}

boot();
