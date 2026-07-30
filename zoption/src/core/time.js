// The IST market clock and candle-boundary arithmetic.
//
// Two rules the rest of the engine depends on:
//
// 1. Candle buckets are aligned to IST MIDNIGHT, not to the Unix epoch and not
//    to whenever the process happened to subscribe. Two builders started a
//    second apart must produce byte-identical bars, and a bar labelled 10:15
//    must cover 10:15:00.000–10:15:59.999 IST.
//
//    Epoch alignment happens to give the same answer for 5s/15s/30s/1m/3m/5m,
//    because IST's 19800-second offset divides evenly by each of them. It does
//    NOT for a 4-minute bar (19800/240 = 82.5). Aligning explicitly costs one
//    subtraction and removes a trap from any future timeframe.
//
// 2. Everything stored is UTC. IST exists at the boundaries — the session
//    window, the trade date, the bucket label — and nowhere else. India has no
//    daylight saving, so a fixed offset is correct rather than merely
//    convenient.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const TIMEFRAMES = {
  '5s': 5,
  '15s': 15,
  '30s': 30,
  '1m': 60,
  '3m': 180,
  '5m': 300,
};

// The CHART timeframes are a strict superset, and deliberately a SEPARATE map.
//
// `TIMEFRAMES` is the set the strategy may be configured with, and it stops at
// 5m for a reason: an entry priced off an hourly close is a different strategy.
// The terminal reads the market rather than trading it, so it wants the long end
// too — but adding 1h to `TIMEFRAMES` would silently make `candleTimeframe: 1h`
// a legal engine configuration. Two maps, two questions.
const CHART_TIMEFRAMES = {
  ...TIMEFRAMES,
  '15m': 900,
  '1h': 3600,
  '1d': 86400,
};

function timeframeSeconds(tf) {
  const s = TIMEFRAMES[String(tf || '').toLowerCase()];
  if (!s) throw new Error(`unsupported candle timeframe "${tf}" — one of ${Object.keys(TIMEFRAMES).join(', ')}`);
  return s;
}

function isTimeframe(tf) {
  return Object.prototype.hasOwnProperty.call(TIMEFRAMES, String(tf || '').toLowerCase());
}

function chartTimeframeSeconds(tf) {
  const s = CHART_TIMEFRAMES[String(tf || '').toLowerCase()];
  if (!s) {
    throw new Error(`unsupported chart timeframe "${tf}" — one of ${Object.keys(CHART_TIMEFRAMES).join(', ')}`);
  }
  return s;
}

function isChartTimeframe(tf) {
  return Object.prototype.hasOwnProperty.call(CHART_TIMEFRAMES, String(tf || '').toLowerCase());
}

// The widest STORED timeframe that divides `tf` exactly, so a chart bar can be
// rebuilt from stored bars without straddling a boundary. Returns null when the
// requested timeframe is itself a base, or when no base divides it.
function baseTimeframeFor(tf, bases = ['1m', '5s']) {
  const want = chartTimeframeSeconds(tf);
  let best = null;
  for (const b of bases) {
    const sec = chartTimeframeSeconds(b);
    if (sec >= want) continue;
    if (want % sec !== 0) continue;
    if (!best || sec > chartTimeframeSeconds(best)) best = b;
  }
  return best;
}

/* ------------------------------------------------------------ IST pieces -- */

// Calendar parts of an instant, as seen in IST.
function istParts(tsMs = Date.now()) {
  const d = new Date(Number(tsMs) + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
    ms: d.getUTCMilliseconds(),
    weekday: d.getUTCDay(),                 // 0 = Sunday
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

// The trading day an instant belongs to, as YYYY-MM-DD in IST. Every daily
// aggregate keys on this — using a UTC date would roll the day over at 05:30
// IST, in the middle of pre-open.
function tradeDate(tsMs = Date.now()) {
  const p = istParts(tsMs);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function istClock(tsMs = Date.now()) {
  const p = istParts(tsMs);
  return `${pad(p.hours)}:${pad(p.minutes)}:${pad(p.seconds)}`;
}

// "09:20" or "09:20:30" -> seconds since IST midnight.
function parseHhMm(text) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(text || '').trim());
  if (!m) throw new Error(`invalid time "${text}" — expected HH:MM`);
  const h = Number(m[1]); const mi = Number(m[2]); const s = Number(m[3] || 0);
  if (h > 23 || mi > 59 || s > 59) throw new Error(`invalid time "${text}"`);
  return h * 3600 + mi * 60 + s;
}

// Seconds elapsed since IST midnight for an instant.
function secondsIntoIstDay(tsMs = Date.now()) {
  const ist = Number(tsMs) + IST_OFFSET_MS;
  return Math.floor((ist - Math.floor(ist / DAY_MS) * DAY_MS) / 1000);
}

// The instant of an IST wall-clock time on the same IST day as `tsMs`.
function atIstTime(tsMs, hhmm) {
  const ist = Number(tsMs) + IST_OFFSET_MS;
  const dayStart = Math.floor(ist / DAY_MS) * DAY_MS;
  return dayStart + parseHhMm(hhmm) * 1000 - IST_OFFSET_MS;
}

/* --------------------------------------------------------- candle buckets */

// The start instant of the bucket containing `tsMs`, aligned to IST midnight.
function bucketStart(tsMs, timeframeSec) {
  const width = Math.max(1, Math.trunc(timeframeSec)) * 1000;
  const ist = Number(tsMs) + IST_OFFSET_MS;
  const dayStart = Math.floor(ist / DAY_MS) * DAY_MS;
  const into = ist - dayStart;
  return dayStart + Math.floor(into / width) * width - IST_OFFSET_MS;
}

function bucketEnd(bucketStartMs, timeframeSec) {
  return bucketStartMs + Math.max(1, Math.trunc(timeframeSec)) * 1000;
}

// The bucket label an operator reads on a chart: HH:MM:SS in IST.
function bucketLabel(bucketStartMs) {
  return istClock(bucketStartMs);
}

/* ------------------------------------------------------------- sessions --- */

// Is `tsMs` inside [start, end) of the IST trading window, on a weekday?
//
// Exchange holidays are NOT known here. The engine additionally requires a live
// price before it will trade, so a holiday presents as a silent feed rather than
// as a wrong-day trade — but a holiday calendar is still the honest fix and is
// on the backlog.
function isWithinSession(tsMs, startHhMm, endHhMm) {
  const p = istParts(tsMs);
  if (p.weekday === 0 || p.weekday === 6) return false;
  const now = secondsIntoIstDay(tsMs);
  return now >= parseHhMm(startHhMm) && now < parseHhMm(endHhMm);
}

function isAfter(tsMs, hhmm) {
  return secondsIntoIstDay(tsMs) >= parseHhMm(hhmm);
}

/* --------------------------------------------------------------- MySQL ---- */

// DATETIME columns are UTC (the pool pins the session to +00:00).
function toMysql(tsMs) {
  return new Date(Number(tsMs)).toISOString().slice(0, 19).replace('T', ' ');
}

function fromMysql(value) {
  if (value == null) return null;
  return value instanceof Date ? value.getTime() : new Date(`${value}Z`).getTime();
}

module.exports = {
  IST_OFFSET_MS, TIMEFRAMES, CHART_TIMEFRAMES,
  timeframeSeconds, isTimeframe, chartTimeframeSeconds, isChartTimeframe, baseTimeframeFor,
  istParts, tradeDate, istClock, parseHhMm, secondsIntoIstDay, atIstTime,
  bucketStart, bucketEnd, bucketLabel,
  isWithinSession, isAfter,
  toMysql, fromMysql,
};
