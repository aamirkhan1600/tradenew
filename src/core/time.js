// IST time. Every trading window in this app is expressed in Indian Standard
// Time, while servers usually run UTC — so all comparisons go through here
// rather than through the host's local zone.
//
// IST is UTC+05:30 with no daylight saving, which makes a fixed offset exact.
// The trick used throughout: shift the instant by +5:30 and then read the UTC
// fields, which gives IST wall-clock values without any locale dependency.
//
// Every function takes an explicit `now` (default Date.now()) so tests can
// drive the clock instead of monkey-patching Date.

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const MARKET = {
  openMin: 9 * 60 + 15,     // 09:15 IST
  closeMin: 15 * 60 + 30,   // 15:30 IST
};

function istDate(now = Date.now()) {
  return new Date(now + IST_OFFSET_MS);
}

// Minutes since IST midnight — the unit all window comparisons use.
function istMinutes(now = Date.now()) {
  const d = istDate(now);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// 'YYYY-MM-DD' in IST. This is the trading-day key for daily counters, so it
// must roll at IST midnight, not UTC midnight.
function istDateString(now = Date.now()) {
  const d = istDate(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function istTimeString(now = Date.now()) {
  const d = istDate(now);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

// 'HH:MM' -> minutes since midnight. Returns null for anything malformed so a
// bad config value fails a validation check instead of silently becoming 0
// (which would read as 00:00 and open the entry window all day).
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function formatHHMM(minutes) {
  const m = Math.max(0, Math.trunc(minutes));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Weekday check only. Exchange holidays are configured per strategy
// (`holidays: ['YYYY-MM-DD']`) because there is no reliable free API for the
// NSE calendar and a stale hardcoded list is worse than an explicit one.
function isWeekday(now = Date.now()) {
  const day = istDate(now).getUTCDay();
  return day >= 1 && day <= 5;
}

function isTradingDay(now = Date.now(), holidays = []) {
  if (!isWeekday(now)) return false;
  return !holidays.includes(istDateString(now));
}

// Inside the exchange's own hours. A strategy's entry window is checked
// separately; this is the outer bound that nothing may trade beyond.
function isMarketOpen(now = Date.now(), holidays = []) {
  if (!isTradingDay(now, holidays)) return false;
  const m = istMinutes(now);
  return m >= MARKET.openMin && m < MARKET.closeMin;
}

module.exports = {
  IST_OFFSET_MS, MARKET,
  istDate, istMinutes, istDateString, istTimeString,
  parseHHMM, formatHHMM,
  isWeekday, isTradingDay, isMarketOpen,
};
