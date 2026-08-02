// §17 — the Risk Engine.
//
// PURE. Counters and a clock reading go in, a verdict comes out. The counters
// themselves are durable (§19.2 makes their write synchronous) and the engine
// owns that; this file owns the rules.
//
// §3.3 is worth restating because it shapes the whole module: "The engine MUST
// reject any entry attempt while activeTrade !== null. Enforced by a SINGLE
// GUARD in the Risk Engine, not by scattered checks." So there is exactly one
// function that answers "may a trade be opened", every caller goes through it,
// and it returns the FIRST failing verdict rather than a list — an operator
// needs the reason, not the audit.
//
// A risk limit stops ENTRIES. Nothing in this file can stop a stop-loss, a
// target extension or the square-off; walking away from a live naked short is
// not a risk control.

const time = require('../core/time');
const C = require('./constants');

// §17.2's verdicts, in the order they are evaluated.
const VERDICTS = {
  ALLOW: 'ALLOW',
  HALTED: 'HALTED',
  SESSION_CLOSED: 'SESSION_CLOSED',
  ENTRY_WINDOW_CLOSED: 'ENTRY_WINDOW_CLOSED',
  MAX_OPEN_TRADES: 'MAX_OPEN_TRADES',
  MAX_TRADES_PER_DAY: 'MAX_TRADES_PER_DAY',
  MAX_CONSECUTIVE_LOSSES: 'MAX_CONSECUTIVE_LOSSES',
  COOLDOWN: 'COOLDOWN',
  // Not in §17.2's list. §8.2 and `[MUST-CONFIRM #7]` make expiry-day trading a
  // decision, and it is a reason to refuse an entry, so it belongs here rather
  // than as a special case inside the scan.
  EXPIRY_DAY: 'EXPIRY_DAY',
  HOLIDAY: 'HOLIDAY',
  KILL_SWITCH: 'KILL_SWITCH',
};

// §17.1 — the durable counters. Reset at the first cycle whose IST date differs
// from `tradingDate`, never on a timer: a restart mid-day must not hand the
// session a fresh set of limits.
function blankCounters(tradingDate) {
  return {
    tradingDate,
    tradesToday: 0,
    consecutiveLosses: 0,
    openPositions: 0,
    realisedPnlPaise: 0,
    halted: false,
    haltReason: null,
  };
}

function needsDayReset(counters, nowMs) {
  return !counters || counters.tradingDate !== time.tradeDate(nowMs);
}

/* ------------------------------------------------------ §17.4, the windows -- */

// The engine's own session test. Deliberately not `time.isWithinSession` with
// settings — §5.2 makes these constants, so there is nothing to pass in and
// nothing an operator can move.
function isSessionOpen(nowMs) {
  return time.isWithinSession(nowMs, C.SESSION.FIRST_ENTRY_TIME, C.SESSION.MARKET_CLOSE);
}

function isEntryWindowClosed(nowMs) {
  return time.isAfter(nowMs, C.SESSION.NO_NEW_ENTRY_TIME);
}

function isPastSquareOff(nowMs) {
  return time.isAfter(nowMs, C.SESSION.SQUARE_OFF_TIME);
}

/* ---------------------------------------------------- §17.7, the calendar -- */

// A holiday list is a safety device, so an ABSENT one is not treated as "no
// holidays". §17.7 refuses to start in production on a missing or stale list,
// and this returns the facts that decision is made from.
//
// "Stale" means the list does not reach the end of the current year — a calendar
// that ran out in December is a calendar nobody maintained.
// The one place the holiday FILE is turned into a list.
//
// It exists because the file and the code disagreed about the key. Both readers
// took `raw.holidays`; the shipped file declared `dates` and its own note told
// the operator to fill `dates`. A calendar written exactly as instructed would
// therefore have read as EMPTY — which in production is a refusal to start, and
// in development is a silent "no holidays this year". That is precisely the
// failure the file exists to prevent, hiding inside the file itself.
//
// Both spellings are accepted, and a bare array still works. Anything that reads
// the calendar goes through here so a third reader cannot invent a fourth
// convention.
function readCalendar(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw.holidays)) return raw.holidays;
  if (Array.isArray(raw.dates)) return raw.dates;
  return [];
}

function validateCalendar(holidays, todayIso) {
  const dates = Array.isArray(holidays)
    ? holidays.map(h => String(typeof h === 'string' ? h : h?.date ?? '').slice(0, 10))
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    : [];

  if (!dates.length) {
    return { ok: false, count: 0, reason: 'the holiday calendar is empty or unreadable' };
  }

  const year = String(todayIso).slice(0, 4);
  const covers = dates.some(d => d >= todayIso && d.slice(0, 4) === year)
    || dates.some(d => d.slice(0, 4) > year);

  if (!covers) {
    return {
      ok: false,
      count: dates.length,
      reason: `the holiday calendar has no dates on or after ${todayIso} — it is stale`,
    };
  }
  return { ok: true, count: dates.length, reason: null };
}

function isHoliday(holidays, dateIso) {
  if (!Array.isArray(holidays)) return false;
  return holidays.some(h =>
    String(typeof h === 'string' ? h : h?.date ?? '').slice(0, 10) === dateIso);
}

function isWeekend(nowMs) {
  const day = time.istParts(nowMs).weekday;
  return day === 0 || day === 6;
}

/* -------------------------------------------------- §17.2, the pre-trade gate -- */

// THE single guard of §3.3. Returns the FIRST failing verdict.
//
// `counters`  the §17.1 block, as loaded from `ose_stats`
// `cfg`       derived settings (maxOpenTrades, maxTradesPerDay, maxConsecutiveLosses)
// `ctx`       nowMs, cooldownCandlesRemaining, isExpiryDay, holidays, killSwitch,
//             activeTrade
//
// `haltAfter` on the result means the caller must halt once it has recorded the
// verdict — §17.2 step 6 halts as well as rejecting, and returning the intent
// rather than performing it keeps this function pure.
function canOpenTrade(counters, cfg = {}, ctx = {}) {
  const nowMs = ctx.nowMs ?? 0;
  const reject = (verdict, reason, extra = {}) =>
    ({ allowed: false, verdict, reason, ...extra });

  /* 1 */
  if (counters.halted) {
    return reject(VERDICTS.HALTED, counters.haltReason || 'the engine is halted');
  }

  // Not numbered in §17.2 because §26.5 gives the kill switch its own path, but
  // it belongs before every market condition: it is the operator's guaranteed
  // intervention and nothing may outrank it.
  if (ctx.killSwitch) {
    return reject(VERDICTS.KILL_SWITCH, 'the kill-switch file is present');
  }

  /* 2 */
  if (isWeekend(nowMs)) {
    return reject(VERDICTS.SESSION_CLOSED, 'the exchange is closed at the weekend');
  }
  if (isHoliday(ctx.holidays, time.tradeDate(nowMs))) {
    return reject(VERDICTS.HOLIDAY, 'the exchange is closed for a holiday');
  }
  if (!isSessionOpen(nowMs)) {
    return reject(VERDICTS.SESSION_CLOSED,
      `outside the session ${C.SESSION.FIRST_ENTRY_TIME}–${C.SESSION.MARKET_CLOSE} IST`);
  }

  /* 3 */
  if (isEntryWindowClosed(nowMs)) {
    return reject(VERDICTS.ENTRY_WINDOW_CLOSED,
      `no new entries after ${C.SESSION.NO_NEW_ENTRY_TIME} IST`);
  }

  // §8.2 / `[MUST-CONFIRM #7]`. Premium behaviour on expiry day differs
  // materially and the shipped answer is "not permitted".
  if (ctx.isExpiryDay && cfg.tradeOnExpiryDay !== true) {
    return reject(VERDICTS.EXPIRY_DAY,
      'today is the expiry of the contract being traded and tradeOnExpiryDay is off');
  }

  /* 4 — §3.3. `activeTrade !== null` and the persisted count both answer here so
        there is one guard rather than two half-guards. */
  const open = Math.max(Number(counters.openPositions) || 0, ctx.activeTrade ? 1 : 0);
  if (open >= (cfg.maxOpenTrades ?? 1)) {
    return reject(VERDICTS.MAX_OPEN_TRADES, 'a position is already open');
  }

  /* 5 */
  if (cfg.maxTradesPerDay > 0 && counters.tradesToday >= cfg.maxTradesPerDay) {
    return reject(VERDICTS.MAX_TRADES_PER_DAY,
      `the daily cap of ${cfg.maxTradesPerDay} trades is reached`);
  }

  /* 6 — the circuit breaker. Rejects AND halts: §17.2 step 6. */
  if (cfg.maxConsecutiveLosses > 0 && counters.consecutiveLosses >= cfg.maxConsecutiveLosses) {
    return reject(VERDICTS.MAX_CONSECUTIVE_LOSSES,
      `${counters.consecutiveLosses} consecutive losses`,
      { haltAfter: true });
  }

  /* 7 — §17.5. Counted in sealed index candles, not seconds, so a feed pause
        extends the wait rather than skipping it. */
  const remaining = Math.max(0, Math.trunc(ctx.cooldownCandlesRemaining ?? 0));
  if (remaining > 0) {
    return reject(VERDICTS.COOLDOWN,
      `waiting ${remaining} more candle${remaining === 1 ? '' : 's'} after the last trade`);
  }

  return { allowed: true, verdict: VERDICTS.ALLOW, reason: null };
}

/* ---------------------------------------------------------- §17.3, the books -- */

// A closed trade is a LOSS when its NET P&L is negative. `[MUST-CONFIRM #6]`
// recommends net over gross and the reasoning is not stylistic: brokerage is a
// flat fee per order, so a gross-scratch round trip is a real net loss, and a
// circuit breaker that counted it as a scratch would keep trading a strategy
// that is bleeding.
//
// Exactly zero is a SCRATCH. It resets nothing and increments nothing except
// `tradesToday` — §17.3 is explicit, and it matters because treating a flat
// trade as a loss trips the breaker on a flat day.
function foldClosedTrade(counters, netPnlPaise) {
  const isLoss = netPnlPaise < 0;
  return {
    ...counters,
    tradesToday: counters.tradesToday + 1,
    realisedPnlPaise: counters.realisedPnlPaise + netPnlPaise,
    consecutiveLosses: isLoss ? counters.consecutiveLosses + 1 : 0,
    openPositions: 0,
  };
}

module.exports = {
  VERDICTS,
  blankCounters, needsDayReset,
  isSessionOpen, isEntryWindowClosed, isPastSquareOff, isWeekend,
  readCalendar,
  validateCalendar, isHoliday,
  canOpenTrade, foldClosedTrade,
};
