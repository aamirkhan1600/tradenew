// §10 — the Trend Engine.
//
// A PURE function. No I/O, no clock, no instance state, no `Date.now()`. §10.4
// calls this "the single largest contributor to reproducibility" and it is the
// reason the determinism gate (§25.4) can hash a whole session's decisions and
// expect the same answer twice.
//
// ---------------------------------------------------------------------------
// Binary, with two tie-breaks and no sideways state
// ---------------------------------------------------------------------------
//
// The specification mandates a Bullish/Bearish output with no NEUTRAL. The
// deterministic rule over the latest three completed index candles C1 (oldest),
// C2, C3 (latest):
//
//     d1 = C3.close − C1.close          ->  sign decides
//     d2 = mid(C3)  − mid(C1)           ->  tie-break 1, midpoint drift
//     d3 = C3.close − C2.close          ->  tie-break 2, newest candle direction
//     otherwise                         ->  null
//
// `null` is NOT "sideways". §10.3 is explicit: it means the trend is UNDETERMINED
// for this cycle. The engine takes no action on it, and it does not carry a
// previous verdict forward — carry-forward would make the output depend on
// history beyond the three-candle window and break §3.6.
//
// For an OPEN position, `null` counts as a trend break and exits (§16.2 #6).
// Fail closed: an absence of information is not a reason to keep a naked short.
//
// ---------------------------------------------------------------------------
// Why the midpoint tie-break never divides
// ---------------------------------------------------------------------------
//
// §10.2 writes tie-break 1 as `m(c) = (c.high + c.low) / 2`. Halving integer
// paise can land on half a paise, and rounding two mids independently before
// subtracting can flip the sign of a difference of one paise — which on a
// TIE-BREAK is the only case that ever runs. Comparing the undivided sums is
// exactly equivalent in sign and cannot round at all:
//
//     sign(mid(C3) − mid(C1)) === sign((C3.high + C3.low) − (C1.high + C1.low))
//
// This matters nowhere else in the codebase and matters absolutely here.
//
// Prices in: integer paise. An index level of 25135.40 is 2513540.

const { TREND_LOOKBACK } = require('./constants');

const BULLISH = 'BULLISH';
const BEARISH = 'BEARISH';

// The reason a verdict came out the way it did. Recorded on every decision row
// so a post-mortem can tell a clean trend from one that survived on tie-break 2.
const VIA = {
  CLOSE: 'CLOSE_DRIFT',           // d1 decided
  MIDPOINT: 'MIDPOINT_DRIFT',     // d1 == 0, d2 decided
  RECENT: 'RECENT_CANDLE',        // d1 == 0, d2 == 0, d3 decided
  TIE: 'PERFECT_TIE',             // all three zero
  WARMING_UP: 'WARMING_UP',       // fewer than TREND_LOOKBACK candles
};

// The index side an option seller takes. This mapping is the one place the
// direction of the market is turned into the side of the trade, and it reads
// backwards to a directional trader on purpose:
//
//     index BULLISH  ->  SELL PE   (the put decays as the market rises)
//     index BEARISH  ->  SELL CE
function sideFor(trend) {
  if (trend === BULLISH) return 'PE';
  if (trend === BEARISH) return 'CE';
  return null;
}

// `candles` — completed index candles, OLDEST FIRST. The caller owns the buffer;
// only its tail is read and nothing here mutates it.
//
// Returns `{ trend, via, reason, window }`. `trend` is the §6.2 `ITrendEngine`
// contract — `'BULLISH' | 'BEARISH' | null`; the rest is for the audit trail and
// costs nothing to carry.
function evaluate(candles, lookback = TREND_LOOKBACK) {
  const need = Math.max(2, Math.trunc(lookback));

  if (!Array.isArray(candles) || candles.length < need) {
    return {
      trend: null,
      via: VIA.WARMING_UP,
      reason: `only ${Array.isArray(candles) ? candles.length : 0} completed index candles — `
        + `${need} are needed`,
      window: [],
    };
  }

  const window = candles.slice(-need);
  const first = window[0];                      // C1, oldest
  const previous = window[window.length - 2];   // C2
  const last = window[window.length - 1];       // C3, latest

  const seen = {
    window: window.map(c => ({
      bucketStart: c.bucketStart,
      openP: c.openP, highP: c.highP, lowP: c.lowP, closeP: c.closeP,
      tickCount: c.tickCount, synthetic: Boolean(c.synthetic),
    })),
  };

  const verdict = (trend, via, reason) => ({ trend, via, reason, ...seen });

  // d1 — the drift across the whole window.
  const d1 = last.closeP - first.closeP;
  if (d1 > 0) return verdict(BULLISH, VIA.CLOSE, `close rose ${fmt(d1)} across ${need} candles`);
  if (d1 < 0) return verdict(BEARISH, VIA.CLOSE, `close fell ${fmt(-d1)} across ${need} candles`);

  // d2 — tie-break 1. Undivided midpoint sums; see the header.
  const d2 = (last.highP + last.lowP) - (first.highP + first.lowP);
  if (d2 > 0) return verdict(BULLISH, VIA.MIDPOINT, 'closes are level; the midpoint drifted up');
  if (d2 < 0) return verdict(BEARISH, VIA.MIDPOINT, 'closes are level; the midpoint drifted down');

  // d3 — tie-break 2. The newest candle's own direction.
  const d3 = last.closeP - previous.closeP;
  if (d3 > 0) return verdict(BULLISH, VIA.RECENT, 'the newest candle closed above the one before it');
  if (d3 < 0) return verdict(BEARISH, VIA.RECENT, 'the newest candle closed below the one before it');

  return verdict(null, VIA.TIE,
    'closes and midpoints are identical across the window — the trend is undetermined');
}

// §16.2 #6 — the structure that justified an OPEN position no longer holds.
//
// Both a FLIP and an undetermined verdict are breaks. That is stricter than the
// Price-Filter Engine, which holds through an absent verdict, and the difference
// is deliberate: §10.3 names `null` as a trend break in terms, and §3.8 says fail
// closed. A trend engine that has nothing to say is not permission to stay short.
function isBreak(trend, optionType) {
  if (trend == null) return true;
  return sideFor(trend) !== optionType;
}

const fmt = (paise) => (paise / 100).toFixed(2);

module.exports = { BULLISH, BEARISH, VIA, evaluate, sideFor, isBreak };
