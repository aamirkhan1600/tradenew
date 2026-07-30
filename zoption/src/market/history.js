// Chart history: stored bars, widened on demand.
//
// The terminal offers nine timeframes and the store holds two. Persisting all
// nine would multiply the write rate by nine for series that are exact
// arithmetic on each other, so the base bars are stored and everything above
// them is rebuilt on read.
//
// One rule makes that safe, and it is the same rule the builder follows:
// BUCKETS ARE ABSOLUTE. A 15-minute bar covers 10:15:00–10:29:59.999 IST
// whichever base it was assembled from, so a bar rebuilt from 5-second rows and
// the same bar rebuilt from 1-minute rows are the same bar. `baseTimeframeFor`
// only ever offers a base that divides the target exactly, so no rebuilt bar can
// straddle a boundary.
//
// What this file will NOT do is invent history. Kotak's Trade API has no
// historical-candles endpoint, so a fresh install has an empty chart that fills
// in as the terminal runs. Drawing a chart from a second source would eventually
// disagree with the bars the engine traded on, and then neither can be trusted.

const time = require('../core/time');
const repo = require('../repositories');

// The two series the terminal persists. 5s exists so the sub-minute timeframes
// have something to rebuild from; everything from 1m up comes off the 1m rows.
const BASE_TIMEFRAMES = ['1m', '5s'];

// Row -> the shape a chart reads. Prices stay in paise here; the HTTP layer
// converts once, at the edge.
function toBar(row) {
  return {
    time: time.fromMysql(row.bucket_start),
    openP: row.open_p,
    highP: row.high_p,
    lowP: row.low_p,
    closeP: row.close_p,
    tickCount: row.tick_count,
    synthetic: Boolean(row.synthetic),
  };
}

// Fold base bars into wider ones. Input must be ascending; output is ascending.
//
// A wide bar is synthetic only when EVERY base bar inside it was — one real
// print in an hour makes the hour real. Volume is the tick count summed, which
// is the only volume this platform has: Kotak's quote feed on this account class
// carries no traded quantity, and a fabricated volume series is worse than an
// honest proxy that says what it is.
function aggregate(bars, targetSeconds) {
  const out = [];
  let current = null;

  for (const bar of bars) {
    const bucket = time.bucketStart(bar.time, targetSeconds);
    if (!current || current.time !== bucket) {
      if (current) out.push(current);
      current = {
        time: bucket,
        openP: bar.openP,
        highP: bar.highP,
        lowP: bar.lowP,
        closeP: bar.closeP,
        tickCount: bar.tickCount,
        synthetic: bar.synthetic,
      };
      continue;
    }
    if (bar.highP > current.highP) current.highP = bar.highP;
    if (bar.lowP < current.lowP) current.lowP = bar.lowP;
    current.closeP = bar.closeP;
    current.tickCount += bar.tickCount;
    current.synthetic = current.synthetic && bar.synthetic;
  }
  if (current) out.push(current);
  return out;
}

// How far back to read to satisfy `limit` bars of `timeframe`, capped so a
// request for 500 daily bars does not scan a year of 1-minute rows that a
// fourteen-day retention never kept anyway.
function windowMs(seconds, limit) {
  const span = seconds * 1000 * Math.max(1, limit);
  // Bars only exist during market hours, so calendar time runs about 6.4× faster
  // than bar time. Over-read rather than return a short chart.
  return Math.min(span * 8, 400 * 24 * 60 * 60 * 1000);
}

// The whole of "give me a chart series". `from`/`to` are optional; without them
// the window is derived from `limit`.
async function series(token, timeframe, { from = null, to = null, limit = 500 } = {}) {
  const seconds = time.chartTimeframeSeconds(timeframe);
  const toMs = to == null ? Date.now() + seconds * 1000 : Number(to);
  const fromMs = from == null ? toMs - windowMs(seconds, limit) : Number(from);
  const want = Math.max(1, Math.trunc(limit));

  // AN EXACTLY-STORED SERIES WINS.
  //
  // Two things write candles: the live builders, which store only the base
  // timeframes, and the Yahoo backfill, which stores 1m/5m/15m/1h/1d directly
  // because no base this platform keeps could reconstruct a year of daily bars
  // out of a week of minutes. So the exact series is tried first, and rebuilding
  // from a base is the fallback rather than the rule.
  const exact = await repo.candles.range(token, timeframe, fromMs, toMs, want);
  if (exact.length) {
    const bars = exact.map(toBar);
    // A base rebuild can still beat it — a live session has this hour's minutes
    // while the backfill stops at yesterday. Whichever covers more bars wins,
    // which keeps the answer deterministic instead of depending on which write
    // happened last.
    const rebuilt = await rebuildFromBase(token, timeframe, seconds, fromMs, toMs, want);
    return (rebuilt.length > bars.length ? rebuilt : bars).slice(-want);
  }

  const rebuilt = await rebuildFromBase(token, timeframe, seconds, fromMs, toMs, want);
  return rebuilt.slice(-want);
}

async function rebuildFromBase(token, timeframe, seconds, fromMs, toMs, limit) {
  const base = BASE_TIMEFRAMES.includes(timeframe)
    ? null
    : time.baseTimeframeFor(timeframe, BASE_TIMEFRAMES);
  if (!base) return [];

  // A wide bar needs `seconds / baseSeconds` base rows, so the row cap scales
  // with the ratio rather than with the bar count.
  const ratio = Math.ceil(seconds / time.chartTimeframeSeconds(base));
  const rows = await repo.candles.range(token, base, fromMs, toMs,
    Math.min(20000, limit * ratio + ratio));
  if (!rows.length) return [];
  return aggregate(rows.map(toBar), seconds);
}

module.exports = { BASE_TIMEFRAMES, toBar, aggregate, windowMs, series, rebuildFromBase };
