// Small DOM and formatting helpers shared by the player, merchant and admin apps.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Tagged template that escapes interpolations. Use raw() to insert trusted HTML. */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      if (Array.isArray(v)) out += v.map((x) => (x?.__html ?? esc(x))).join('');
      else out += v?.__html ?? (v === false || v === null || v === undefined ? '' : esc(v));
    }
  });
  return { __html: out, toString: () => out };
}
export const raw = (s) => ({ __html: s, toString: () => s });

export function render(el, content) {
  el.innerHTML = String(content);
}

let toastTimer;
export function toast(message, kind = 'info') {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.append(el);
  }
  el.className = `toast toast-${kind} show`;
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

export const fmt = {
  points: (n) => `${Number(n ?? 0).toLocaleString('en-GB')}`,
  signed: (n) => (n > 0 ? `+${n.toLocaleString('en-GB')}` : n < 0 ? `−${Math.abs(n).toLocaleString('en-GB')}` : '0'),
  pounds: (pence) => (pence === null || pence === undefined ? '—' : `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`),
  pct: (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`),
  time: (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }),
  date: (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' }),
  dateTime: (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }),
  dayName: (dateStr) => new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
  duration: (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
};

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "Today 2–5 pm", "Tonight", "Until 3 Dec", "Available now", "Thu–Sat". */
export function availabilityLabel(o) {
  const parts = [];
  if (o.days?.length && o.days.length < 7) {
    const d = o.days;
    const run = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
    parts.push(run && d.length > 2 ? `${DAY_NAMES[d[0]]}–${DAY_NAMES[d.at(-1)]}` : d.map((x) => DAY_NAMES[x]).join(', '));
  }
  if (o.window_start && o.window_end) parts.push(`${clock(o.window_start)}–${clock(o.window_end)}`);
  if (o.valid_until) {
    const end = new Date(o.valid_until);
    const hoursLeft = (end - Date.now()) / 3600000;
    if (hoursLeft < 24 && new Date().toDateString() === end.toDateString()) parts.push(new Date().getHours() >= 17 || hoursLeft < 8 ? 'Tonight' : 'Today');
    else if (hoursLeft < 48) parts.push('Until tomorrow');
    else parts.push(`Until ${fmt.date(o.valid_until)}`);
  }
  return parts.length ? parts.join(' · ') : 'Any time';
}

function clock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return m ? `${h12}.${String(m).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`;
}

export const REASON_TEXT = {
  offer_not_active: 'Not available right now',
  merchant_unavailable: 'Venue unavailable',
  not_started: 'Coming soon',
  ended: 'Ended',
  outside_window: 'Outside its hours',
  sold_out: 'Sold out',
  limit_reached: 'You’ve claimed this'
};

export const CATEGORY_LABELS = {
  coffee: 'Coffee', food: 'Food', drinks: 'Drinks', music: 'Live music', theatre: 'Theatre',
  comedy: 'Comedy', experience: 'Experiences', other: 'Other'
};

export function uuid() {
  return crypto.randomUUID();
}

/** Load the vendored QR generator from the main site once. */
let qrLib;
export function loadQr() {
  qrLib ??= new Promise((res, rej) => {
    if (window.qrcode) return res(window.qrcode);
    const s = document.createElement('script');
    s.src = '/words/vendor/qrcode.js';
    s.onload = () => res(window.qrcode);
    s.onerror = rej;
    document.head.append(s);
  });
  return qrLib;
}

export async function qrSvg(text, cell = 6) {
  const qrcode = await loadQr();
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
}

export function confirmDialog({ title, body, confirm = 'Confirm', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'sheet';
    d.innerHTML = String(html`<form method="dialog"><h2>${title}</h2><div class="sheet-body">${body ?? ''}</div>
      <div class="row gap"><button class="btn ghost" value="cancel">${cancel}</button><button class="btn ${danger ? 'danger' : 'primary'}" value="ok" autofocus>${confirm}</button></div></form>`);
    document.body.append(d);
    d.addEventListener('close', () => {
      resolve(d.returnValue === 'ok');
      d.remove();
    });
    d.showModal();
  });
}

/** Prompt for text in a dialog. Resolves to the string or null. */
export function promptDialog({ title, label, placeholder = '', confirm = 'Save', type = 'text', value = '' }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'sheet';
    d.innerHTML = String(html`<form method="dialog"><h2>${title}</h2><label class="field"><span>${label}</span><input name="v" type="${type}" placeholder="${placeholder}" value="${value}" required></label>
      <div class="row gap"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">${confirm}</button></div></form>`);
    document.body.append(d);
    d.addEventListener('close', () => {
      resolve(d.returnValue === 'ok' ? d.querySelector('input').value : null);
      d.remove();
    });
    d.showModal();
  });
}
