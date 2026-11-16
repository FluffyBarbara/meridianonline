import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ───────── Форматирование ─────────
export function bytes(n, digits = 1) {
  if (n == null || !isFinite(n)) return '—';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i < 2 ? 0 : digits).replace('.', ',')} ${u[i]}`;
}

export function duration(sec) {
  if (sec == null || !isFinite(sec)) return '';
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} мин ${sec % 60} с`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

export function date(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ───────── Тосты ─────────
const TOAST_ICON = { info: 'info', success: 'circle-check', error: 'triangle-alert', warn: 'triangle-alert' };

export function toast({ title, text = '', type = 'info', timeout = 5000, action }) {
  const el = h(`
    <div class="toast toast--${type}">
      <div class="toast__icon">${icon(TOAST_ICON[type] || 'info')}</div>
      <div>
        <div class="toast__title">${esc(title)}</div>
        ${text ? `<div class="toast__text">${esc(text)}</div>` : ''}
        ${action ? `<div class="toast__action"><button class="btn btn--sm btn--primary">${esc(action.label)}</button></div>` : ''}
      </div>
    </div>`);
  const close = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 300);
  };
  if (action) el.querySelector('button').addEventListener('click', () => { action.onClick(); close(); });
  $('#toasts').appendChild(el);
  if (timeout) setTimeout(close, timeout);
  return close;
}

// ───────── Модальное окно ─────────
let onModalClose = null;

export function openModal(html, { onClose, dismissable = true } = {}) {
  const modal = $('#modal');
  const old = $('#modalDialog');
  const dialog = old.cloneNode(false); // новый элемент без старых обработчиков
  old.replaceWith(dialog);
  dialog.innerHTML = html;
  modal.hidden = false;
  modal.dataset.dismissable = dismissable ? '1' : '';
  onModalClose = onClose || null;
  return dialog;
}

export function closeModal() {
  const modal = $('#modal');
  if (modal.hidden) return;
  modal.hidden = true;
  $('#modalDialog').innerHTML = '';
  const cb = onModalClose;
  onModalClose = null;
  cb?.();
}

document.addEventListener('click', (e) => {
  const modal = $('#modal');
  if (modal.hidden) return;
  if (e.target.closest('[data-close]') && (modal.dataset.dismissable || e.target.closest('.modal__dialog'))) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden && $('#modal').dataset.dismissable) closeModal();
});

export function confirmDialog({ title, text, okLabel = 'Подтвердить', danger = false, iconName = 'triangle-alert' }) {
  return new Promise((resolve) => {
    let result = false;
    const dlg = openModal(`
      <div class="modal__head">
        <div class="modal__icon">${icon(iconName)}</div>
        <div><div class="modal__title">${esc(title)}</div></div>
      </div>
      <div class="modal__body"><p style="color:var(--text-2);line-height:1.6">${esc(text)}</p></div>
      <div class="modal__foot">
        <button class="btn" data-close>Отмена</button>
        <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-ok>${esc(okLabel)}</button>
      </div>`, { onClose: () => resolve(result) });
    dlg.querySelector('[data-ok]').addEventListener('click', () => { result = true; closeModal(); });
  });
}
