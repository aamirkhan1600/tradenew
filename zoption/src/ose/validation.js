// newdoc/paralle.md — the merge step, and the single Validation Output Object.
//
// PURE. Three verdicts in, one decision out. No I/O, no clock, no state.
//
// ---------------------------------------------------------------------------
// What this is for
// ---------------------------------------------------------------------------
//
// The three validations already ran off one snapshot in one cycle — that part of
// paralle.md was satisfied before this file existed. What was missing was the
// MERGE being a thing you could point at: the decision was assembled out of two
// early returns and a third check scattered down `_evaluateEntry`, so the
// document's Final Decision Matrix was implemented but not stated, and nothing
// could be tested against the matrix as written.
//
// This is that matrix, as one function, returning the document's object.
//
// ---------------------------------------------------------------------------
// ONE gate, not a gate and a report
// ---------------------------------------------------------------------------
//
// The engine ACTS on what this returns. It would have been easier to leave the
// existing checks alone and build the object alongside them for display, and
// that is exactly the mistake worth avoiding: two code paths deciding the same
// thing drift, and the one on the page would eventually say VALID_ENTRY about a
// cycle the engine refused. There is one decision here and the engine takes it.
//
// ---------------------------------------------------------------------------
// Precedence, and why it is not the matrix's row order
// ---------------------------------------------------------------------------
//
// paralle.md's table is a truth table, not an order of evaluation — several of
// its rows match the same cycle. The order below is the one the engine already
// had, and it is chosen so the REASON names the earliest thing that was wrong:
//
//   1. the 3-candle engine has too few candles      WARMING_UP
//   2. the EMA filter refuses                       EMA_*
//   3. the midpoint / trend confluence refuses      NO_MIDPOINT_BREAK, ...
//   4. everything agrees                            SELL_PE | SELL_CE
//
// Reporting "no midpoint break" on a cycle whose averages were still warming up
// would be true and useless. The earliest cause is the actionable one.
//
// ---------------------------------------------------------------------------
// The document's four reason codes are not enough
// ---------------------------------------------------------------------------
//
// paralle.md names VALID_ENTRY, EMA_TREND_CONFLICT, NO_ENTRY and EMA_SIDEWAYS.
// The engine already distinguishes nine cases, and the /ose "why it is not
// trading" panel is built on that granularity — collapsing EMA_WARMING_UP,
// EMA_SIDEWAYS and EMA_FILTER_FAIL into one code would make a warming engine
// indistinguishable from a chopping market on the one screen that exists to tell
// them apart. So `reason` carries the precise code, and `result` carries the
// document's coarse one for anything reading to its vocabulary.

const trendEngine = require('./trend');
const emaEngine = require('./ema');
const entry = require('./entry');

// paralle.md's own vocabulary, on `result`.
const RESULT = {
  VALID_ENTRY: 'VALID_ENTRY',
  NO_ENTRY: 'NO_ENTRY',
  EMA_SIDEWAYS: 'EMA_SIDEWAYS',
  EMA_TREND_CONFLICT: 'EMA_TREND_CONFLICT',
  WARMING_UP: 'WARMING_UP',
};

// The engine's own, on `reason` — these are what the decision log stores and
// what the page tallies.
const REASON = {
  WARMING_UP: 'WARMING_UP',
  SELL_PE: 'SELL_PE',
  SELL_CE: 'SELL_CE',
};

const SIDE = { PE: 'SELL_PE', CE: 'SELL_CE' };

// `input`:
//   trend       the §10 verdict from ./trend.js       — required
//   ema         the ema.md verdict from ./ema.js      — may be null
//   midpoint    the §11 decision from ./entry.js      — required
//   emaEnabled  whether the EMA filter is a GATE this cycle
//
// Returns paralle.md's Validation Output Object, plus the fields the decision
// log needs:
//
//   { emaTrend, threeCandleTrend, midpoint, entryAllowed, side, result,
//     reason, detail }
function merge({ trend, ema = null, midpoint, emaEnabled = true } = {}) {
  const threeCandleTrend = trend?.trend ?? null;
  const emaTrend = ema?.trend ?? null;
  const midpointPass = Boolean(midpoint?.allowed);

  const base = {
    emaTrend,
    emaState: ema?.state ?? null,
    threeCandleTrend,
    midpoint: midpointPass,
  };
  const reject = (result, reason, detail) => ({
    ...base, entryAllowed: false, side: null, result, reason, detail,
  });

  /* 1 — the 3-candle engine has not seen enough candles. */
  if (threeCandleTrend === null && trend?.via === trendEngine.VIA.WARMING_UP) {
    return reject(RESULT.WARMING_UP, REASON.WARMING_UP, trend.reason);
  }

  /* 2 — the EMA filter. Evaluated even when it is not a gate, so the object
        always reports what the averages said; only the REFUSAL is conditional. */
  if (emaEnabled) {
    const gate = emaEngine.gate(ema, threeCandleTrend);
    if (!gate.allowed) {
      // `gate.outcome` is already the decision log's code — EMA_WARMING_UP,
      // EMA_SIDEWAYS, EMA_FILTER_FAIL, EMA_TREND_CONFLICT.
      const result = gate.outcome === emaEngine.OUTCOME.CONFLICT
        ? RESULT.EMA_TREND_CONFLICT
        : (gate.outcome === emaEngine.OUTCOME.SIDEWAYS
          ? RESULT.EMA_SIDEWAYS
          : (gate.outcome === emaEngine.OUTCOME.WARMING_UP ? RESULT.WARMING_UP : RESULT.NO_ENTRY));
      return reject(result, gate.outcome, gate.reason);
    }
  }

  /* 3 — §11's confluence: an undetermined trend, no midpoint break, or a break
        on the wrong side of the one the trend wants. */
  if (!midpointPass) {
    return reject(RESULT.NO_ENTRY,
      midpoint?.reason ?? entry.REASONS.NO_CANDLE,
      midpoint?.detail ?? 'the entry validator returned no decision');
  }

  /* 4 — all three agree. */
  const optionType = midpoint.optionType;
  return {
    ...base,
    entryAllowed: true,
    side: optionType === 'PE' ? SIDE.PE : SIDE.CE,
    result: RESULT.VALID_ENTRY,
    reason: optionType === 'PE' ? REASON.SELL_PE : REASON.SELL_CE,
    detail: midpoint.detail,
  };
}

module.exports = { RESULT, REASON, SIDE, merge };
