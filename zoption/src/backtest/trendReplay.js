// Replay the index trend filter over stored history.
//
// The trend filter (`src/strategy/trendFilter.js`) is a pure function of index
// bars, so it is the one part of this strategy that a downloaded index series
// can genuinely backtest. It decides WHICH SIDE may sell — never at what price —
// and this replay answers the two questions that matter about it:
//
//   1. How often does it permit anything at all? A filter that blocks 99% of
//      bars has not made the strategy selective, it has turned it off. The
//      verdict histogram says which rule is doing the blocking.
//
//   2. When it permits a side, does the index then move that way? The filter
//      allows the side that profits from the move CONTINUING, so for each
//      signal the replay measures the index over the following N bars and
//      reports how often it went the permitted way.
//
// WHAT THIS IS NOT. It is not a P&L backtest and it must not be read as one.
// Point 2 measures the index, and this strategy sells option premium — the
// relationship between "the index kept rising" and "the call premium I sold
// decayed" runs through delta, theta and the spread, none of which are in this
// data. A high hit rate here means the filter's directional read is sound; it
// says nothing about whether the trades made money.
//
// TWO CAVEATS ABOUT THE DATA, both structural:
//
//   * The filter is configured at 5 SECONDS. Yahoo's finest interval is one
//     minute, so a replay on downloaded bars tests the LOGIC at 1m and above,
//     not the filter as it actually runs. Only live recordings can do that, and
//     the replay says which kind of bar it used.
//
//   * `minTicks` exists to reject bars the REST quote poller sampled too
//     thinly. An exchange-aggregated bar has no sample count at all, so the
//     guard is meaningless on downloaded data and is disabled for it — with a
//     note on the result, because silently changing a threshold and then
//     reporting a pass rate would be the most misleading thing this file could
//     do.

const time = require('../core/time');
const repo = require('../repositories');
const trendFilter = require('../strategy/trendFilter');
const settingsService = require('../strategy/settings');

// Stored row -> the bar shape trendFilter.verdict() reads.
function toTrendBar(row, seconds) {
  const startMs = time.fromMysql(row.bucket_start);
  return {
    bucketStart: startMs,
    bucketEnd: startMs + seconds * 1000,
    openP: row.open_p,
    highP: row.high_p,
    lowP: row.low_p,
    closeP: row.close_p,
    tickCount: row.tick_count,
    synthetic: Boolean(row.synthetic),
    source: row.source || 'LIVE',
  };
}

// The follow-through measurement. Returns the signed index move, in paise, over
// the `bars` bars after `index` — measured close to close, because that is what
// a position opened at this bar's close would have experienced.
function forwardMove(bars, index, ahead) {
  const from = bars[index];
  const to = bars[Math.min(bars.length - 1, index + ahead)];
  if (!from || !to || to === from) return null;
  return to.closeP - from.closeP;
}

/**
 * Replay the filter over a series.
 *
 * `bars` — ascending, in the shape toTrendBar() produces.
 * `cfg`  — the trend config, as settings.derive() builds it (`_trend`).
 */
function replay(bars, cfg, { lookaheadBars = 3 } = {}) {
  const need = Math.max(1, Math.trunc(cfg.confirmBars || 3));

  const states = {};
  const signals = [];
  let evaluated = 0;

  for (let i = need - 1; i < bars.length; i++) {
    const window = bars.slice(i - need + 1, i + 1);
    const v = trendFilter.verdict(window, cfg);
    evaluated += 1;
    states[v.state] = (states[v.state] || 0) + 1;

    if (!v.allowCE && !v.allowPE) continue;

    const move = forwardMove(bars, i, lookaheadBars);
    // A bullish index permits the PE. "Correct" therefore means the index kept
    // rising after a PE permission, and kept falling after a CE one — the side
    // that profits from the move continuing.
    const bullish = v.allowPE;
    signals.push({
      index: i,
      atMs: bars[i].bucketEnd,
      state: v.state,
      side: bullish ? 'PE' : 'CE',
      closeP: bars[i].closeP,
      forwardP: move,
      correct: move === null ? null : (bullish ? move > 0 : move < 0),
    });
  }

  const scored = signals.filter(s => s.correct !== null);
  const right = scored.filter(s => s.correct);
  const moves = scored.map(s => (s.side === 'PE' ? s.forwardP : -s.forwardP));

  return {
    bars: bars.length,
    evaluated,
    states,
    signals: signals.length,
    // Signals as a share of bars evaluated. The number to look at first: if this
    // is under a percent the filter is not selective, it is off.
    signalRate: evaluated ? signals.length / evaluated : 0,
    ce: signals.filter(s => s.side === 'CE').length,
    pe: signals.filter(s => s.side === 'PE').length,
    scored: scored.length,
    hitRate: scored.length ? right.length / scored.length : null,
    // In index POINTS, favourable-signed: positive means the index moved the way
    // the permitted side wanted.
    avgMovePoints: moves.length ? (moves.reduce((a, b) => a + b, 0) / moves.length) / 100 : null,
    medianMovePoints: moves.length
      ? moves.slice().sort((a, b) => a - b)[Math.floor(moves.length / 2)] / 100
      : null,
    lookaheadBars,
    detail: signals,
  };
}

/**
 * Load a stored series and replay the configured filter over it.
 *
 * Returns the replay plus everything needed to judge whether the answer means
 * anything: which timeframe it really ran on, and whether the bars were
 * recorded here or downloaded.
 */
async function run({ token, timeframe = '1m', from = null, to = null,
  limit = 5000, cfg = null, lookaheadBars = 3 } = {}) {
  const seconds = time.chartTimeframeSeconds(timeframe);
  const toMs = to ?? Date.now();
  const fromMs = from ?? (toMs - 30 * 24 * 60 * 60 * 1000);

  const rows = await repo.candles.range(token, timeframe, fromMs, toMs, limit);
  const bars = rows.map(r => toTrendBar(r, seconds));

  const backfilled = bars.filter(b => b.source === 'BACKFILL').length;
  const mixed = backfilled > 0 && backfilled < bars.length;

  let config = cfg;
  let configuredTimeframe = '5s';
  if (!config) {
    const settings = settingsService.derive(
      settingsService.withDefaults(await repo.settings.get('default')));
    config = settings._trend;
    configuredTimeframe = settings.trendTimeframe || '5s';
  }

  // See the header: the sample-count guard is meaningless on exchange-aggregated
  // bars, so it is dropped for them — loudly, on the result.
  const notes = [];
  const effective = { ...config };
  if (backfilled) {
    effective.minTicks = 0;
    notes.push(`minTicks was disabled: ${backfilled} of ${bars.length} bars were downloaded, `
      + 'and an exchange-aggregated bar carries no sample count for the guard to test');
  }
  if (mixed) {
    notes.push('the series MIXES recorded and downloaded bars — they are different measurements '
      + 'of the same market, so treat any boundary effect in the result with suspicion');
  }
  // THE VOLATILITY CEILING DOES NOT SURVIVE A TIMEFRAME CHANGE, and this is the
  // trap that makes a replay at the wrong timeframe look like a broken filter.
  //
  // `trendMaxRangePoints` is a span across the WHOLE confirmation window. At the
  // configured 5-second bars, three bars is fifteen seconds and ten points is a
  // sensible ceiling on "the move is already made". Replayed on one-minute bars
  // the same three bars are three MINUTES, and NIFTY covers ten points in three
  // minutes routinely — so the ceiling rejects almost everything and the
  // histogram fills with HIGH_VOLATILITY. Measured on live data: it blocks 59%
  // of 1m windows and 100% of 5m ones.
  //
  // The equivalent ceiling is offered, NOT applied. Volatility scales with the
  // square root of time for a random walk, so a 12× wider bar wants a ~3.5×
  // wider ceiling — but that is a modelling assumption about the market, and
  // silently substituting one config for another is how a backtest ends up
  // measuring something the operator never asked about.
  const scale = Math.sqrt(seconds / time.chartTimeframeSeconds(configuredTimeframe));
  const suggestedMaxRangePoints = (config.maxRangeP / 100) * scale;
  if (timeframe !== configuredTimeframe) {
    notes.push(`this ran at ${timeframe}; the filter is configured for ${configuredTimeframe} `
      + 'bars, so it tests the logic rather than the live setup');
    if (scale > 1.5) {
      notes.push('the volatility ceiling does not carry across timeframes: '
        + `${(config.maxRangeP / 100).toFixed(1)} points across ${config.confirmBars} bars is `
        + `${config.confirmBars * time.chartTimeframeSeconds(configuredTimeframe)}s at `
        + `${configuredTimeframe} but ${config.confirmBars * seconds}s at ${timeframe}. `
        + `A √time-equivalent ceiling here would be about `
        + `${suggestedMaxRangePoints.toFixed(0)} points — pass it with --max-range to compare, `
        + 'but do not read the result as a verdict on the live 5s setting.');
    }
  }

  const result = replay(bars, effective, { lookaheadBars });

  // A histogram dominated by one blocking rule is the finding, not a footnote.
  const dominant = Object.entries(result.states).sort((a, b) => b[1] - a[1])[0];
  if (dominant && result.evaluated && dominant[1] / result.evaluated > 0.8 && !result.signals) {
    notes.push(`${dominant[0]} rejected ${((dominant[1] / result.evaluated) * 100).toFixed(0)}% of `
      + 'windows on its own — this replay is measuring that one threshold and nothing else');
  }

  return {
    token,
    timeframe,
    configuredTimeframe,
    from: bars.length ? bars[0].bucketStart : null,
    to: bars.length ? bars[bars.length - 1].bucketEnd : null,
    source: !bars.length ? 'none' : backfilled === bars.length ? 'BACKFILL' : mixed ? 'MIXED' : 'LIVE',
    backfilledBars: backfilled,
    config: effective,
    suggestedMaxRangePoints,
    notes,
    ...result,
  };
}

/**
 * The same replay across a grid of settings, so "would a stricter score have
 * helped" is answered by measurement rather than by opinion.
 *
 * Deliberately re-runs the pure filter over bars already in memory rather than
 * re-reading the database per combination — a 5×4 grid over 5,000 bars is a
 * hundred thousand verdicts, which is milliseconds.
 */
function sweep(bars, baseCfg, grid, { lookaheadBars = 3 } = {}) {
  const keys = Object.keys(grid);
  const combos = keys.reduce(
    (acc, key) => acc.flatMap(base => grid[key].map(value => ({ ...base, [key]: value }))),
    [{}]);

  return combos.map((override) => {
    const cfg = { ...baseCfg, ...override };
    const r = replay(bars, cfg, { lookaheadBars });
    return {
      override,
      signals: r.signals,
      signalRate: r.signalRate,
      hitRate: r.hitRate,
      avgMovePoints: r.avgMovePoints,
    };
  }).sort((a, b) => (b.hitRate ?? -1) - (a.hitRate ?? -1));
}

module.exports = { toTrendBar, forwardMove, replay, run, sweep };
