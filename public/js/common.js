// Shared browser helpers. Small on purpose — the pages carry their own logic,
// and a trading console is easier to trust when there is no framework between
// the data and the screen.

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Everything rendered into innerHTML goes through this. Strategy names, broker
// messages and audit text are all operator-supplied or broker-supplied.
function esc(value) {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function inr(v, { blank = '—' } = {}) {
  if (v == null || v === '' || Number.isNaN(Number(v))) return blank;
  const n = Number(v);
  return (n < 0 ? '-₹' : '₹') + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function num(v, digits = 2, blank = '—') {
  if (v == null || v === '' || Number.isNaN(Number(v))) return blank;
  return Number(v).toFixed(digits).replace(/\.00$/, '');
}

function signClass(v) {
  if (v == null || Number.isNaN(Number(v))) return '';
  return Number(v) > 0 ? 'pos' : (Number(v) < 0 ? 'neg' : '');
}

function timeOf(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
}

function dateOf(ts) {
  if (!ts) return '—';
  return String(ts).slice(0, 10);
}

// fetch + JSON + error handling in one place, so no page has to repeat it.
async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('unauthorised'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `request failed (${res.status})`);
  return data;
}

function toast(el, message, kind = 'ok') {
  if (!el) return;
  el.className = 'notice ' + kind;
  el.textContent = message;
  el.classList.remove('hidden');
  if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 4000);
}

// Poll while the tab is visible. A backgrounded dashboard hammering the API for
// hours is pure waste, and the engine does not depend on anyone watching.
function poll(fn, intervalMs) {
  let timer = null;
  const run = async () => {
    if (document.visibilityState === 'visible') {
      try { await fn(); } catch (_) { /* transient; the next tick retries */ }
    }
    timer = setTimeout(run, intervalMs);
  };
  run();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { clearTimeout(timer); run(); }
  });
  return () => clearTimeout(timer);
}
