// The NIFTY 5-second 3-candle trend confirmation — doc/update-point.md.
//
// A PURE module, like legMachine.js: bars in, a verdict out. No clock, no
// network, no quote object. That is what lets the whole decision table be tested
// exhaustively without a market.
//
// ---------------------------------------------------------------------------
// What it is for, and what it is NOT for
// ---------------------------------------------------------------------------
//
// This filter decides WHETHER a trade is allowed, and which side may take it.
// It never decides at what price. The entry price is still
// `optionCandle.close + sellOffset` and comes from the option contract's own
// candle — doc/update-point.md says it in one line:
//
//   "The Option Candle is still used only for calculating the SELL price."
//
// So the verdict this module returns is a pair of BOOLEANS (allowCE, allowPE)
// plus an explanation. No price crosses the boundary, and a test asserts that
// the verdict object carries no price field at all.
//
// ---------------------------------------------------------------------------
// The rules, in the order they are applied
// ---------------------------------------------------------------------------
//
//   1. Every bar in the window must have measured something. A synthetic bar,
//      or one built from fewer than `minTicks` samples, is NO_DATA and blocks —
//      "body >= 60% of range" off three samples is noise, not a measurement.
//   2. COMBINED volatility: highest high minus lowest low across the three bars.
//      Over `maxRangeP` and the move is already made; a one-point premium sold
//      into it is late, and large moves pull back.
//   3. All three bars must point the same way. Cases 3-6 of the document's
//      table — bullish-bullish-bearish, choppy, and the rest — all skip.
//   4. Momentum: three ranges that shrink monotonically are a trend running out
//      of breath. Skip.
//   5. Strength: every bar must clear the quality score. The document offers
//      this as a recommended addition, so `minScore: 0` turns it off and leaves
//      the plain direction rule.
//
// And a bullish index means PE selling, not CE selling: the filter allows the
// side that profits from the move continuing, and blocks the side standing in
// front of it.
//
// Prices in: integer paise (an index level of 25135.40 is 2513540). Point
// thresholds are converted to paise by the caller.

const BAR_STATES = {
  STRONG_BULLISH: 'STRONG_BULLISH',
  STRONG_BEARISH: 'STRONG_BEARISH',
  NEUTRAL: 'NEUTRAL',
};

// The verdict can also be one of these, which no single bar ever is.
const VERDICT_STATES = {
  ...BAR_STATES,
  WARMING_UP: 'WARMING_UP',           // not enough completed bars yet
  CHOPPY: 'CHOPPY',                   // the window disagrees with itself
  HIGH_VOLATILITY: 'HIGH_VOLATILITY', // the window spans too many points
  WEAKENING: 'WEAKENING',             // ranges shrinking bar over bar
  NO_DATA: 'NO_DATA',                 // a bar in the window measured nothing
};

const DEFAULTS = {
  confirmBars: 3,       // consecutive bars that must agree
  bodyPct: 60,          // classification: body must exceed this share of range
  closeNearPct: 25,     // classification: close must land this near the extreme
  strongBodyPct: 70,    // score: the +2 body term
  wickPct: 15,          // score: the opposing-wick and at-the-extreme terms
  maxRangeP: 1000,      // 10 NIFTY points across the WHOLE window, in paise
  minScore: 5,          // out of 5, required of every bar; 0 disables
  minTicks: 4,          // a bar built from fewer samples measured nothing
  momentum: true,       // apply the shrinking-range rule
};

// The quality score's ceiling. The document's table has a fourth term, "volume
// higher than previous candle" (+1) — this feed carries no volume at all (the
// tick stream is LTP-only and the candle builder has no volume field), so the
// term is dropped rather than faked from a proxy. 2 + 1 + 2 = 5, and the
// document's threshold of 5 still means "a textbook candle".
const MAX_SCORE = 5;

/* ------------------------------------------------------------- geometry -- */

// Everything the classifier needs, as percentages of the bar's own range. Using
// ratios rather than absolute points is what makes one threshold work at 25000
// and at 26000.
function shape(bar) {
  const rangeP = bar.highP - bar.lowP;
  const bodyP = Math.abs(bar.closeP - bar.openP);
  const up = bar.closeP > bar.openP;
  const down = bar.closeP < bar.openP;

  // A bar with no range at all is a flat print, not a trend. Reporting 0% for
  // every ratio makes it fail every threshold, which is the right answer.
  const pct = (n) => (rangeP > 0 ? (n / rangeP) * 100 : 0);

  return {
    rangeP,
    bodyP,
    bodyPct: pct(bodyP),
    upperWickPct: pct(bar.highP - Math.max(bar.openP, bar.closeP)),
    lowerWickPct: pct(Math.min(bar.openP, bar.closeP) - bar.lowP),
    // How far up the range the close landed. 100 = on the high, 0 = on the low.
    closePosPct: rangeP > 0 ? ((bar.closeP - bar.lowP) / rangeP) * 100 : 0,
    direction: up ? 'UP' : down ? 'DOWN' : 'FLAT',
  };
}

/* ----------------------------------------------------------- classifier -- */

// One bar -> one state. Volatility is deliberately NOT tested here: the document
// measures it across the whole window, and a per-bar test would reject a
// three-bar trend that never moved much in any single five seconds.
function classify(bar, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };

  if (!bar) return { state: VERDICT_STATES.NO_DATA, reason: 'no bar', metrics: null };

  // A bar has to have measured something before its shape means anything. On
  // the REST quote fallback a quiet five seconds can hold two samples, and a
  // "60% body" drawn from two samples describes the poller, not the market.
  if (bar.synthetic || bar.tradable === false || (bar.tickCount || 0) < c.minTicks) {
    return {
      state: VERDICT_STATES.NO_DATA,
      reason: bar.synthetic || !bar.tickCount
        ? 'the index feed was silent for this bar'
        : `the bar holds ${bar.tickCount} ticks, under the ${c.minTicks} needed to measure it`,
      metrics: null,
    };
  }

  const m = shape(bar);

  if (m.direction === 'FLAT' || m.bodyPct < c.bodyPct) {
    return {
      state: BAR_STATES.NEUTRAL,
      reason: `the body is ${m.bodyPct.toFixed(0)}% of the range, under ${c.bodyPct}%`,
      metrics: m,
    };
  }

  if (m.direction === 'UP') {
    if (m.closePosPct < 100 - c.closeNearPct) {
      return {
        state: BAR_STATES.NEUTRAL,
        reason: `the close is ${(100 - m.closePosPct).toFixed(0)}% below the high, `
          + `over the ${c.closeNearPct}% allowed`,
        metrics: m,
      };
    }
    return { state: BAR_STATES.STRONG_BULLISH, reason: null, metrics: m };
  }

  if (m.closePosPct > c.closeNearPct) {
    return {
      state: BAR_STATES.NEUTRAL,
      reason: `the close is ${m.closePosPct.toFixed(0)}% above the low, `
        + `over the ${c.closeNearPct}% allowed`,
      metrics: m,
    };
  }
  return { state: BAR_STATES.STRONG_BEARISH, reason: null, metrics: m };
}

/* ---------------------------------------------------------------- score -- */

// The quality table from doc/update-point.md, out of 5 (see MAX_SCORE above for
// why the volume term is absent). Direction-aware: the "opposing" wick is the
// upper one on a bullish bar and the lower one on a bearish bar, and "at the
// extreme" means the high or the low accordingly.
function strength(bar, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const m = shape(bar);
  const bullish = m.direction === 'UP';

  const parts = {
    body: m.bodyPct >= c.strongBodyPct ? 2 : 0,
    smallOpposingWick: (bullish ? m.upperWickPct : m.lowerWickPct) < c.wickPct ? 1 : 0,
    closeAtExtreme: bullish
      ? (m.closePosPct >= 100 - c.wickPct ? 2 : 0)
      : (m.closePosPct <= c.wickPct ? 2 : 0),
  };

  return {
    total: Object.values(parts).reduce((a, b) => a + b, 0),
    max: MAX_SCORE,
    parts,
  };
}

/* -------------------------------------------------------------- verdict -- */

// `bars` — completed index bars, oldest first. The caller keeps the buffer; this
// function only reads the tail of it.
//
// Returns the pair of booleans the engine gates on, plus everything an operator
// needs to understand the answer without re-deriving it.
function verdict(bars, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const need = Math.max(1, Math.trunc(c.confirmBars));

  const block = (state, reason, extra = {}) => ({
    state, reason, allowCE: false, allowPE: false, scores: null,
    window: [], atMs: null, ...extra,
  });

  if (!Array.isArray(bars) || bars.length < need) {
    return block(VERDICT_STATES.WARMING_UP,
      `only ${Array.isArray(bars) ? bars.length : 0} completed index bars — `
      + `${need} are needed`);
  }

  const window = bars.slice(-need);
  const latest = window[window.length - 1];
  const classified = window.map(b => ({ bar: b, ...classify(b, c) }));
  const atMs = latest.bucketEnd ?? null;

  const detail = classified.map(x => ({
    bucketStart: x.bar.bucketStart,
    state: x.state,
    closeP: x.bar.closeP,
    rangeP: x.bar.highP - x.bar.lowP,
  }));
  const seen = { window: detail, atMs };

  /* 1. did every bar measure anything */
  const silent = classified.find(x => x.state === VERDICT_STATES.NO_DATA);
  if (silent) return block(VERDICT_STATES.NO_DATA, silent.reason, seen);

  /* 2. combined volatility across the whole window */
  const highest = Math.max(...window.map(b => b.highP));
  const lowest = Math.min(...window.map(b => b.lowP));
  const spanP = highest - lowest;
  if (spanP > c.maxRangeP) {
    return block(VERDICT_STATES.HIGH_VOLATILITY,
      `the ${need} bars span ${(spanP / 100).toFixed(1)} points, over the `
      + `${(c.maxRangeP / 100).toFixed(1)} allowed — large moves pull back`,
      seen);
  }

  /* 3. all three the same direction */
  const first = classified[0].state;
  if (!classified.every(x => x.state === first)) {
    return block(VERDICT_STATES.CHOPPY,
      `the last ${need} bars disagree (${classified.map(x => arrow(x.state)).join(' ')})`,
      seen);
  }
  if (first === BAR_STATES.NEUTRAL) {
    return block(BAR_STATES.NEUTRAL, classified[classified.length - 1].reason, seen);
  }

  /* 4. momentum — a trend whose bars keep shrinking is running out of breath */
  if (c.momentum && need > 1) {
    const ranges = window.map(b => b.highP - b.lowP);
    const shrinking = ranges.every((r, i) => i === 0 || r < ranges[i - 1]);
    if (shrinking) {
      return block(VERDICT_STATES.WEAKENING,
        `the ranges shrink bar over bar (${ranges.map(r => (r / 100).toFixed(1)).join(' → ')} `
        + 'points) — momentum is fading',
        seen);
    }
  }

  /* 5. strength — every bar, not just the newest */
  const scores = window.map(b => strength(b, c));
  if (c.minScore > 0) {
    const weak = scores.findIndex(s => s.total < c.minScore);
    if (weak >= 0) {
      return block(VERDICT_STATES.CHOPPY,
        `the trend is ${short(first)} but bar ${weak + 1} of ${need} scores `
        + `${scores[weak].total}/${MAX_SCORE}, under the ${c.minScore} required`,
        { ...seen, scores });
    }
  }

  const bullish = first === BAR_STATES.STRONG_BULLISH;
  return {
    state: first,
    // Bullish index -> sell PE, block CE. The filter permits the side that
    // profits from the move continuing.
    allowCE: !bullish,
    allowPE: bullish,
    reason: `${need} consecutive ${short(first)} bars, all scoring `
      + `${Math.min(...scores.map(s => s.total))}/${MAX_SCORE} or better`,
    scores,
    window: detail,
    atMs,
  };
}

function short(state) {
  return {
    STRONG_BULLISH: 'bullish',
    STRONG_BEARISH: 'bearish',
    NEUTRAL: 'neutral',
    HIGH_VOLATILITY: 'volatile',
    CHOPPY: 'choppy',
    WEAKENING: 'weakening',
    NO_DATA: 'silent',
    WARMING_UP: 'warming up',
  }[state] || state;
}

// The document draws its decision table in arrows. So does the audit log.
function arrow(state) {
  return { STRONG_BULLISH: '↑', STRONG_BEARISH: '↓', NEUTRAL: '•' }[state] || '?';
}

module.exports = {
  BAR_STATES, VERDICT_STATES, DEFAULTS, MAX_SCORE,
  shape, classify, strength, verdict, short, arrow,
};
