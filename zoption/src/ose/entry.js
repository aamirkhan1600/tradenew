// §11 — the Entry Validation Engine.
//
// PURE. One completed index candle and a trend go in, an `EntryDecision` comes
// out. No price it returns can reach an order: the SELL price is derived from
// the OPTION contract's own sealed candle in §12.1, and nothing here can see one.
//
// ---------------------------------------------------------------------------
// The midpoints, and the one place this differs from the Price-Filter Engine
// ---------------------------------------------------------------------------
//
//     bullishMid = floor((C.open + C.high) / 2)
//     bearishMid = floor((C.open + C.low)  / 2)
//
//     SELL PE  requires  C.close >  bullishMid
//     SELL CE  requires  C.close <  bearishMid
//
// Both midpoints and the price being compared come from the SAME candle. That
// is the whole difference from `src/pfe/priceFilter.js`, which compares the LIVE
// index price against the mids of the last completed bar. Two consequences
// follow and both are intended:
//
//   * this engine re-answers once per sealed candle, not once per tick, so it is
//     a §3.2 "completed data only" decision end to end;
//   * a candle can only ever break its own midpoint by CLOSING away from its
//     open, which makes the condition a statement about that candle's shape
//     rather than about where the market happens to be standing.
//
// ---------------------------------------------------------------------------
// Strict inequality, and why no conflict rule is needed
// ---------------------------------------------------------------------------
//
// `>` and `<`, never `>=`. A close sitting exactly ON a midpoint is not evidence
// for the trade, and §3.8 resolves an absence of evidence toward not trading.
//
// The two conditions are mutually exclusive by construction. `close > (O+H)/2`
// forces `close > open` because `high >= close`; `close < (O+L)/2` forces
// `close < open` because `low <= close`. They cannot both hold, so there is no
// conflict-resolution rule to get wrong — and §25.2 asserts the property over
// generated candles rather than trusting this paragraph.
//
// Prices in: integer paise.

const trendEngine = require('./trend');

// Machine-readable, because §11.5 forbids a silent rejection: every non-trade is
// logged with the full decision object and the audit trail must be able to
// explain each one without parsing English.
const REASONS = {
  SELL_PE: 'SELL_PE',
  SELL_CE: 'SELL_CE',
  TREND_UNDETERMINED: 'TREND_UNDETERMINED',
  NO_MIDPOINT_BREAK: 'NO_MIDPOINT_BREAK',
  TREND_SIGNAL_CONFLICT: 'TREND_SIGNAL_CONFLICT',
  NO_CANDLE: 'NO_CANDLE',
};

// §11.2 — `Math.floor` on integer paise, stated once so no call site can round
// differently. A midpoint that lands on half a paise is not a price.
function midpoints(candle) {
  if (!candle || !Number.isFinite(candle.openP)) {
    throw new Error('the entry validator needs a completed index candle');
  }
  return {
    bullishMidP: Math.floor((candle.openP + candle.highP) / 2),
    bearishMidP: Math.floor((candle.openP + candle.lowP) / 2),
  };
}

// The §11.4 confluence table, implemented as the table:
//
//   | trend    | midpoint condition | action                          |
//   |----------|--------------------|---------------------------------|
//   | BULLISH  | close > bullishMid | SELL PE                         |
//   | BEARISH  | close < bearishMid | SELL CE                         |
//   | BULLISH  | close < bearishMid | reject TREND_SIGNAL_CONFLICT    |
//   | BEARISH  | close > bullishMid | reject TREND_SIGNAL_CONFLICT    |
//   | any      | neither            | reject NO_MIDPOINT_BREAK        |
//   | null     | any                | reject TREND_UNDETERMINED       |
//
// Returns the §11.5 `EntryDecision`.
function validate(candle, trend) {
  if (!candle || !Number.isFinite(candle.openP)) {
    return {
      allowed: false,
      optionType: null,
      reason: REASONS.NO_CANDLE,
      detail: 'no completed index candle to validate against',
      bullishMidP: null,
      bearishMidP: null,
      referencePriceP: null,
      trend: trend ?? null,
    };
  }

  const { bullishMidP, bearishMidP } = midpoints(candle);
  const referencePriceP = candle.closeP;

  const base = { bullishMidP, bearishMidP, referencePriceP, trend: trend ?? null };
  const reject = (reason, detail) =>
    ({ allowed: false, optionType: null, reason, detail, ...base });

  // Checked first. An undetermined trend is not a conflict and not a missing
  // break — it is the filter having nothing to say, and naming it precisely is
  // what lets a post-mortem separate a quiet tape from a contradictory one.
  if (trend == null) {
    return reject(REASONS.TREND_UNDETERMINED,
      'the trend engine returned no verdict for this cycle');
  }

  const breaksBullish = referencePriceP > bullishMidP;
  const breaksBearish = referencePriceP < bearishMidP;

  if (!breaksBullish && !breaksBearish) {
    return reject(REASONS.NO_MIDPOINT_BREAK,
      `the close ${fmt(referencePriceP)} sits between the bearish mid ${fmt(bearishMidP)} `
      + `and the bullish mid ${fmt(bullishMidP)}`);
  }

  // The two rows where the candle broke a midpoint but the wrong one for the
  // trend. Both filters have to agree; a candle closing up inside a falling
  // market is the case this rejection exists for.
  const wanted = trendEngine.sideFor(trend);
  const offered = breaksBullish ? 'PE' : 'CE';

  if (wanted !== offered) {
    return reject(REASONS.TREND_SIGNAL_CONFLICT,
      `the trend is ${trend} (wants ${wanted}) but the candle broke the `
      + `${breaksBullish ? 'bullish' : 'bearish'} mid, which offers ${offered}`);
  }

  return {
    allowed: true,
    optionType: offered,
    reason: offered === 'PE' ? REASONS.SELL_PE : REASONS.SELL_CE,
    detail: offered === 'PE'
      ? `the close ${fmt(referencePriceP)} is above the bullish mid ${fmt(bullishMidP)} `
        + 'in a bullish trend'
      : `the close ${fmt(referencePriceP)} is below the bearish mid ${fmt(bearishMidP)} `
        + 'in a bearish trend',
    ...base,
  };
}

// §13.3 — the Position Validity Filter. The original directional thesis, re-asked
// against a NEW candle's own midpoints:
//
//     short PE (entered BULLISH)  valid while  trend BULLISH and close > bullishMid
//     short CE (entered BEARISH)  valid while  trend BEARISH and close < bearishMid
//
// This is a strict, unforgiving filter and §13.3 says so in terms: because each
// candle is measured against its OWN midpoints, an ordinary consolidation candle
// invalidates the position. That is the dominant driver of the short holding
// period, it is intentional, and it is flagged for desk awareness rather than
// softened here.
//
// Returns `{ ok, reason, detail }` — `reason` is an §16.2 exit reason when not ok.
function stillValid(candle, trend, optionType) {
  if (!candle || !Number.isFinite(candle.openP)) {
    // §3.8. An unreadable candle cannot confirm the thesis, and this engine does
    // not hold a naked short on an absence of information.
    return { ok: false, reason: 'EXIT_FILTER_FAIL', detail: 'no completed index candle' };
  }

  if (trendEngine.isBreak(trend, optionType)) {
    return {
      ok: false,
      reason: 'EXIT_TREND_BREAK',
      detail: trend == null
        ? 'the trend is undetermined'
        : `the trend turned ${trend}, which no longer supports a short ${optionType}`,
    };
  }

  const { bullishMidP, bearishMidP } = midpoints(candle);
  const closeP = candle.closeP;

  const holds = optionType === 'PE' ? closeP > bullishMidP : closeP < bearishMidP;
  if (holds) return { ok: true, reason: null, detail: null, bullishMidP, bearishMidP };

  return {
    ok: false,
    reason: 'EXIT_FILTER_FAIL',
    detail: optionType === 'PE'
      ? `the close ${fmt(closeP)} fell to or below the bullish mid ${fmt(bullishMidP)}`
      : `the close ${fmt(closeP)} rose to or above the bearish mid ${fmt(bearishMidP)}`,
    bullishMidP,
    bearishMidP,
  };
}

const fmt = (paise) => (paise / 100).toFixed(2);

module.exports = { REASONS, midpoints, validate, stillValid };
