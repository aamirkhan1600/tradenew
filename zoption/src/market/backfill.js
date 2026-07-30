// Yahoo bars -> zoption's `candles` table.
//
// The point of this file is that a downloaded bar has to land in exactly the
// same coordinate system as a bar this platform assembled itself, or the chart
// will show a seam where the two meet and no one will be able to say which side
// is wrong. Three things have to line up:
//
//   1. THE TOKEN. The terminal reads its chart by instrument token, not by
//      symbol, so a downloaded NIFTY bar must be stored under whatever
//      `instrumentMaster.indexInstrument('NIFTY')` currently resolves to. Get
//      this wrong and the import "succeeds" while the chart stays empty.
//
//   2. THE BUCKET. Yahoo timestamps a bar at its START, in UTC, and NSE bars
//      start at 09:15 IST — which lands on the same absolute IST-aligned
//      boundaries `core/time.js` uses. That is checked here rather than assumed:
//      a bar whose timestamp does not fall exactly on a bucket boundary for its
//      timeframe is REJECTED, because a half-aligned series is worse than none.
//
//   3. THE UNIT. Everything in this schema is integer paise.
//
// And one thing that deliberately does NOT line up: `source` is written as
// BACKFILL. These bars were measured by somebody else, with a different clock
// and a different definition of a print. `repo.candles.insertMany` will not
// overwrite a bar this platform already recorded, so a backfill only ever fills
// gaps — it cannot revise history the engine traded on.

const logger = require('../core/logger');
const time = require('../core/time');
const repo = require('../repositories');
const history = require('./history');
const instrumentMaster = require('./instrumentMaster');
const { service } = require('./yahoo');
const { ValidationError } = require('../core/errors');

// How each stored timeframe is sourced. This table is not the obvious
// interval-name mapping, and the reason is the single most important fact in
// this file:
//
//     NSE SESSIONS START AT 09:15 IST, WHICH IS NOT ON AN HOUR BOUNDARY.
//
// Yahoo bars follow the exchange's session, so its hourly bars run 09:15–10:15,
// 10:15–11:15 and so on. This platform's buckets are absolute — aligned to IST
// midnight, so 09:00–10:00, 10:00–11:00 (`core/time.js`, and the candle builder
// depends on it so that two builders started a second apart produce identical
// bars). Those are DIFFERENT BARS, not the same bar labelled differently.
// Measured against the live API: 1m, 5m and 15m align perfectly; 60m is 100%
// misaligned; and a daily bar is stamped 09:15 rather than at midnight.
//
// So:
//
//   * 1m / 5m / 15m are taken at their own interval — they already land on the
//     boundaries this platform uses.
//   * 1h is built from Yahoo's FIVE-MINUTE bars and folded locally into
//     absolute buckets, using the very same `aggregate()` the charts use. A
//     downloaded hour and a locally rebuilt hour are then the same object by
//     construction, rather than by hope.
//   * 1d is taken daily and its timestamp SNAPPED to IST midnight. Here the
//     content genuinely is the same — one bar covering one trading session —
//     and only the label differs, so snapping is lossless.
//
// Nothing below a minute is listed because Yahoo has nothing below a minute,
// and Yahoo's 30m and 90m are absent because this platform has no such stored
// timeframe to put them in.
const SOURCE_PLAN = {
  '1m': { interval: '1m', fold: false, maxDays: 7 },
  '5m': { interval: '5m', fold: false, maxDays: 60 },
  '15m': { interval: '15m', fold: false, maxDays: 60 },
  '1h': { interval: '5m', fold: true, maxDays: 60 },
  '1d': { interval: '1d', fold: false, snapToDay: true, maxDays: 3650 },
};

const TIMEFRAME_OF = { '1m': '1m', '5m': '5m', '15m': '15m', '1d': '1d' };

// What to pull by default, finest first so a chart becomes useful before the
// long history has finished downloading.
const DEFAULT_PLAN = [
  { timeframe: '1m', days: 7 },
  { timeframe: '5m', days: 60 },
  { timeframe: '15m', days: 60 },
  { timeframe: '1h', days: 60 },
  { timeframe: '1d', days: 3650 },
];

function sourceFor(timeframe) {
  const tf = String(timeframe || '').toLowerCase();
  const plan = SOURCE_PLAN[tf];
  if (!plan) {
    throw new ValidationError(
      `timeframe "${timeframe}" cannot be backfilled from Yahoo `
      + `(available: ${Object.keys(SOURCE_PLAN).join(', ')}). `
      + 'Anything finer than a minute exists only as live recordings.');
  }
  return { timeframe: tf, ...plan };
}

function yahooInterval(timeframe) { return sourceFor(timeframe).interval; }

// The instrument a symbol's bars belong to. Deliberately the SAME resolution the
// terminal feed uses, so the two cannot disagree about where NIFTY's chart
// lives.
async function resolveTarget(underlying) {
  const key = String(underlying || 'NIFTY').toUpperCase();
  const instrument = await instrumentMaster.indexInstrument(key);
  if (!instrument?.token) {
    throw new ValidationError(
      `no ${key} index instrument — sync instruments on the Broker page first, `
      + 'otherwise the downloaded bars would be stored under a token nothing reads');
  }
  return {
    underlying: key,
    token: String(instrument.token),
    quoteBy: instrument.quoteBy || 'token',
  };
}

// Yahoo bar -> candle row. Returns a `reject` reason rather than null for
// anything that cannot be trusted, so the caller can count the rejections and a
// silent 90%-dropped import is impossible.
function toCandleRow(bar, { token, timeframe, seconds, snapToDay = false }) {
  let ms = Number(bar.time);
  if (!Number.isFinite(ms)) return { reject: 'timestamp' };

  // A daily bar is stamped at the session open (09:15 IST). The bar covers the
  // whole session either way, so moving the label to IST midnight is lossless —
  // unlike the hourly case, which is handled by folding rather than snapping.
  if (snapToDay) ms = time.bucketStart(ms, 86400);

  // The alignment check, applied after any normalisation. Yahoo stamps a bar at
  // its start; if that instant is not a bucket boundary for this timeframe, the
  // two systems disagree about what a bar IS and merging them would be
  // meaningless. This is what catches a timezone change at the source.
  if (time.bucketStart(ms, seconds) !== ms) return { reject: 'unaligned' };

  const closeP = Math.round(Number(bar.close) * 100);
  const openP = Math.round(Number(bar.open) * 100);
  const highP = Math.round(Number(bar.high) * 100);
  const lowP = Math.round(Number(bar.low) * 100);
  if (![openP, highP, lowP, closeP].every(v => Number.isFinite(v) && v > 0)) {
    return { reject: 'price' };
  }
  // A bar whose high is below its low, or whose close sits outside its range, is
  // corrupt whatever produced it.
  if (highP < lowP || closeP > highP || closeP < lowP || openP > highP || openP < lowP) {
    return { reject: 'inconsistent' };
  }

  return {
    row: {
      token,
      timeframe,
      bucketStart: ms,
      openP,
      highP,
      lowP,
      closeP,
      // Not a sample count — an exchange-aggregated bar has none. Readers must
      // gate on `source`, which is why the column exists.
      tickCount: 0,
      synthetic: false,
      source: 'BACKFILL',
    },
  };
}

/* ------------------------------------------------------------------ run --- */

// Import one timeframe. Returns what was fetched, what was stored and — the
// important half — what was thrown away and why.
async function importTimeframe({ underlying = 'NIFTY', timeframe = '1m', days = null,
  from = null, to = null, target = null } = {}) {
  const plan = sourceFor(timeframe);
  const tf = plan.timeframe;
  const seconds = time.chartTimeframeSeconds(tf);
  const where = target || await resolveTarget(underlying);

  const end = to ?? Date.now();
  const start = from ?? (end - Math.min(days ?? 30, plan.maxDays) * 24 * 60 * 60 * 1000);

  const history = await service.getHistoricalData(where.underlying, plan.interval, start, end);

  // The source interval's own bucket width — the one the downloaded bars are
  // aligned to, which is not the target's when folding.
  const sourceSeconds = plan.fold
    ? time.chartTimeframeSeconds(plan.interval === '60m' ? '1h' : plan.interval)
    : seconds;

  const rows = [];
  const rejected = { timestamp: 0, unaligned: 0, price: 0, inconsistent: 0 };
  for (const bar of history.bars) {
    const mapped = toCandleRow(bar, {
      token: where.token,
      timeframe: plan.fold ? plan.interval : tf,
      seconds: sourceSeconds,
      snapToDay: Boolean(plan.snapToDay),
    });
    if (mapped.reject) { rejected[mapped.reject] += 1; continue; }
    rows.push(mapped.row);
  }

  // Fold the aligned source bars up into the target's absolute buckets, using
  // the SAME aggregator the charts use — so a stored hour and a rebuilt hour
  // are identical by construction rather than by coincidence.
  const finalRows = plan.fold ? foldRows(rows, where.token, tf, seconds) : rows;

  // An import that drops most of what it downloaded has hit a format change or
  // a timezone shift, and storing the survivors would leave a chart with holes
  // nobody can explain. Say so loudly rather than reporting a cheerful count.
  //
  // This check is why the alignment test above rejects rather than snaps: a
  // silent snap would turn "the source moved to a different session grid" into
  // a chart that is quietly wrong, and this line would never fire.
  if (history.bars.length && rows.length < history.bars.length * 0.5) {
    logger.error('backfill: most bars were rejected — the source format may have changed', {
      underlying: where.underlying, timeframe: tf, sourceInterval: plan.interval,
      downloaded: history.bars.length, kept: rows.length, rejected,
      timezone: history.timezone,
    });
  }

  const stored = await repo.candles.insertMany(finalRows);

  logger.info('backfill: imported', {
    underlying: where.underlying, token: where.token, timeframe: tf,
    sourceInterval: plan.interval, folded: Boolean(plan.fold),
    downloaded: history.bars.length, mapped: finalRows.length,
    // `stored` counts rows actually inserted. The difference is bars that were
    // already there — usually ones this platform recorded itself, which always
    // win.
    stored, alreadyHeld: finalRows.length - stored,
    truncated: history.truncated,
  });

  return {
    underlying: where.underlying,
    token: where.token,
    timeframe: tf,
    interval: plan.interval,
    folded: Boolean(plan.fold),
    downloaded: history.bars.length,
    mapped: finalRows.length,
    stored,
    alreadyHeld: finalRows.length - stored,
    rejected,
    truncated: history.truncated,
    timezone: history.timezone,
    from: finalRows.length ? finalRows[0].bucketStart : null,
    to: finalRows.length ? finalRows[finalRows.length - 1].bucketStart : null,
  };
}

// Candle rows -> the shape `history.aggregate` reads -> candle rows again.
// Going through the chart's own aggregator rather than a second implementation
// is the point: there is exactly one definition of "fold these bars into wider
// ones" in this codebase.
function foldRows(rows, token, timeframe, seconds) {
  const bars = rows.map(r => ({
    time: r.bucketStart,
    openP: r.openP, highP: r.highP, lowP: r.lowP, closeP: r.closeP,
    tickCount: r.tickCount, synthetic: r.synthetic,
  }));
  return history.aggregate(bars, seconds).map(b => ({
    token,
    timeframe,
    bucketStart: b.time,
    openP: b.openP, highP: b.highP, lowP: b.lowP, closeP: b.closeP,
    tickCount: 0,
    synthetic: false,
    source: 'BACKFILL',
  }));
}

// The whole default plan, newest-and-finest first so a chart becomes useful
// before the long history finishes downloading.
async function importAll({ underlying = 'NIFTY', plan = DEFAULT_PLAN } = {}) {
  const target = await resolveTarget(underlying);
  const results = [];
  for (const step of plan) {
    try {
      results.push(await importTimeframe({ ...step, underlying, target }));
    } catch (err) {
      logger.warn('backfill: a timeframe failed', { timeframe: step.timeframe, err: err.message });
      results.push({ timeframe: step.timeframe, error: err.message, stored: 0 });
    }
  }
  return { target, results, stored: results.reduce((n, r) => n + (r.stored || 0), 0) };
}

module.exports = {
  TIMEFRAME_OF, SOURCE_PLAN, DEFAULT_PLAN,
  sourceFor, yahooInterval, resolveTarget, toCandleRow, foldRows,
  importTimeframe, importAll,
};
