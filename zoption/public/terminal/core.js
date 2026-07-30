// Terminal shared helpers: the IST clock, formatting, and the small amount of
// state every module needs.
//
// Plain scripts on a `window.Z` namespace rather than modules. The page loads
// six files from one origin under a `script-src 'self'` CSP; a bundler would
// add a build step to a project that deliberately has none.

window.Z = window.Z || {};

(function (Z) {
  'use strict';

  const IST_OFFSET_S = 5.5 * 3600;
  const DAY_S = 24 * 3600;

  // Lightweight Charts formats axis labels in UTC and offers no timezone option.
  // The standard fix is to hand it IST-shifted timestamps so its "UTC" labels
  // read as IST wall clock. Every conversion goes through this pair, so the
  // shift exists in exactly two places and a crosshair reading is never a day
  // out.
  //
  // `utcSeconds` is what the API returns. `chartSeconds` is what the library is
  // fed. They must never be mixed, which is why they are named differently
  // everywhere below.
  Z.toChart = (utcSeconds) => utcSeconds + IST_OFFSET_S;
  Z.fromChart = (chartSeconds) => chartSeconds - IST_OFFSET_S;

  Z.IST_OFFSET_S = IST_OFFSET_S;

  // Absolute, IST-midnight-aligned buckets — the same rule the server's candle
  // builder follows. It has to be the same: the client extends the last bar
  // live while the server stores it, and a boundary disagreement would show up
  // as a bar that jumps when the page is reloaded.
  Z.bucketStart = function (utcSeconds, timeframeSeconds) {
    const ist = utcSeconds + IST_OFFSET_S;
    const dayStart = Math.floor(ist / DAY_S) * DAY_S;
    const into = ist - dayStart;
    return dayStart + Math.floor(into / timeframeSeconds) * timeframeSeconds - IST_OFFSET_S;
  };

  Z.TIMEFRAME_SECONDS = {
    '5s': 5, '15s': 15, '30s': 30, '1m': 60, '3m': 180,
    '5m': 300, '15m': 900, '1h': 3600, '1d': 86400,
  };

  // The IST calendar day a timestamp belongs to. VWAP and the opening range
  // reset on it.
  Z.dayKey = function (utcSeconds) {
    if (utcSeconds == null) return 'x';
    return Math.floor((utcSeconds + IST_OFFSET_S) / DAY_S);
  };

  // Minutes since the 09:15 IST open. Negative before it — the opening-range
  // window must not include a pre-open print.
  Z.minutesIntoSession = function (utcSeconds) {
    if (utcSeconds == null) return -1;
    const ist = utcSeconds + IST_OFFSET_S;
    const into = ist - Math.floor(ist / DAY_S) * DAY_S;
    return (into - (9 * 60 + 15) * 60) / 60;
  };

  Z.istClock = function (utcSeconds, withSeconds) {
    if (utcSeconds == null) return '—';
    const ist = new Date((utcSeconds + IST_OFFSET_S) * 1000);
    const p = (n) => String(n).padStart(2, '0');
    const base = p(ist.getUTCHours()) + ':' + p(ist.getUTCMinutes());
    return withSeconds ? base + ':' + p(ist.getUTCSeconds()) : base;
  };

  Z.istDate = function (utcSeconds) {
    if (utcSeconds == null) return '—';
    const ist = new Date((utcSeconds + IST_OFFSET_S) * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return ist.getUTCFullYear() + '-' + p(ist.getUTCMonth() + 1) + '-' + p(ist.getUTCDate());
  };

  /* ------------------------------------------------------------ formatting */

  // A null is a fact — "the broker did not send this" — and it renders as an
  // em-dash everywhere. Nothing in this terminal prints 0 for missing data.
  Z.fmt = function (v, decimals) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return Number(v).toFixed(decimals === undefined ? 2 : decimals);
  };

  Z.fmtInt = function (v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return Math.round(Number(v)).toLocaleString('en-IN');
  };

  // Indian market convention: OI and volume in lakhs once they get large,
  // because a nine-digit number in a table cell is unreadable at a glance.
  Z.fmtCompact = function (v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    const n = Number(v);
    const abs = Math.abs(n);
    if (abs >= 1e7) return (n / 1e7).toFixed(2) + 'Cr';
    if (abs >= 1e5) return (n / 1e5).toFixed(2) + 'L';
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  };

  Z.fmtSigned = function (v, decimals) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    const s = Z.fmt(Math.abs(v), decimals);
    return (v > 0 ? '+' : v < 0 ? '-' : '') + s;
  };

  Z.signClass = function (v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '';
    return v > 0 ? 'up' : v < 0 ? 'down' : '';
  };

  Z.el = function (id) { return document.getElementById(id); };

  Z.setText = function (id, text, className) {
    const node = Z.el(id);
    if (!node) return;
    node.textContent = text;
    if (className !== undefined) node.className = className;
  };

  Z.escapeHtml = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  /* ----------------------------------------------------------------- theme */

  // Two palettes, one shape. The chart library needs explicit colours rather
  // than CSS variables, so the source of truth is here and the stylesheet
  // mirrors it via a `data-theme` attribute.
  Z.THEMES = {
    dark: {
      bg: '#0f1115', panel: '#171a21', panel2: '#1d212a', line: '#262b36',
      text: '#e6e9ef', muted: '#8b93a3',
      up: '#35c07f', down: '#ef5b5b', warn: '#e0a437', accent: '#5b9dff',
      grid: '#1c212b', crosshair: '#5a6478',
      ema9: '#7fd1ff', ema20: '#e0a437', ema50: '#b98cff', ema200: '#e6e9ef',
      vwap: '#5b9dff', st: '#35c07f', bb: '#4c5670',
    },
    light: {
      bg: '#f7f8fa', panel: '#ffffff', panel2: '#eef1f6', line: '#d8dde7',
      text: '#161a22', muted: '#5c6675',
      up: '#0f9d58', down: '#d93025', warn: '#b26a00', accent: '#1a73e8',
      grid: '#e6eaf1', crosshair: '#8d97a8',
      ema9: '#0a7ea4', ema20: '#b26a00', ema50: '#7c3aed', ema200: '#161a22',
      vwap: '#1a73e8', st: '#0f9d58', bb: '#9aa5b8',
    },
  };

  Z.theme = function () {
    return Z.THEMES[document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'];
  };

  Z.onThemeChange = function (fn) {
    (Z._themeListeners = Z._themeListeners || []).push(fn);
  };

  Z.setTheme = function (name) {
    const next = name === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('zoption.theme', next); } catch (_) { /* private mode */ }
    for (const fn of (Z._themeListeners || [])) {
      try { fn(Z.theme()); } catch (_) { /* one bad listener must not stop the rest */ }
    }
  };

  Z.initTheme = function () {
    let stored = null;
    try { stored = localStorage.getItem('zoption.theme'); } catch (_) { /* ignore */ }
    document.documentElement.setAttribute('data-theme', stored === 'light' ? 'light' : 'dark');
  };

  /* ------------------------------------------------------------ preferences */

  // Toggles, drawings and layout choices survive a reload. Wrapped because
  // localStorage throws in a private window and a chart that will not open
  // because a preference could not be read is a bad trade for a saved toggle.
  Z.store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem('zoption.' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (_) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('zoption.' + key, JSON.stringify(value)); } catch (_) { /* ignore */ }
    },
  };

  /* ---------------------------------------------------------------- fetch  */

  Z.api = async function (path, params) {
    const url = new URL(path, window.location.origin);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
    }
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
    if (!res.ok || body.ok === false) throw new Error(body.error || ('HTTP ' + res.status));
    return body;
  };

  /* ------------------------------------------------------------- toasting  */

  Z.notify = function (message, kind) {
    const host = Z.el('toasts');
    if (!host) return;
    const node = document.createElement('div');
    node.className = 'toast ' + (kind || '');
    node.textContent = message;
    host.appendChild(node);
    setTimeout(() => node.remove(), kind === 'bad' ? 9000 : 5000);
  };
}(window.Z));
