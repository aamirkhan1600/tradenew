// Module 3 of doc/new.md — the trend direction filter.
//
// PURE, like everything else in this directory: bars in, a verdict out. No
// clock, no network, no quote object.
//
// ---------------------------------------------------------------------------
// This is NOT the same filter as src/strategy/trendFilter.js
// ---------------------------------------------------------------------------
//
// The scalper's filter classifies each bar by its SHAPE — body share of range,
// where the close sits in the range, a quality score out of five. doc/new.md
// asks for something different and simpler, and the difference is the whole
// reason this file exists rather than a config flag on the other one:
//
//     Bullish   Higher High    Higher Low    Bullish Close
//     Bearish   Lower High     Lower Low     Bearish Close
//
// That is a STRUCTURE rule (each bar's extremes against the previous bar's),
// not a shape rule. A bar with a tiny body and long wicks satisfies it if the
// structure holds; the scalper's filter would call the same bar NEUTRAL. Two
// different questions, two implementations, and no shared config that could
// make one silently answer the other.
//
// ---------------------------------------------------------------------------
// What the verdict means
// ---------------------------------------------------------------------------
//
// A pair of booleans and an explanation. No price crosses this boundary: the
// SELL price comes from the OPTION contract's own closed candle (Module 5), and
// nothing here can reach it.
//
// And the direction maps to the side the way an option seller needs, not the
// way a directional trader would read it:
//
//     index BULLISH  ->  SELL PE   (profits if the move continues)
//     index BEARISH  ->  SELL CE
//
// Prices in: integer paise. An index level of 25135.40 is 2513540.

const STATES = {
  BULLISH: 'BULLISH',
  BEARISH: 'BEARISH',
  NONE: 'NONE',                 // the structure holds in neither direction
  WARMING_UP: 'WARMING_UP',     // not enough completed bars yet
  NO_DATA: 'NO_DATA',           // a bar in the window measured nothing
};

// Which bars must close in the trend's direction.
//
//   LAST  the newest bar only — doc/new.md lists "Bullish Close" once, in the
//         singular, alongside two rules that are inherently pairwise
//   ALL    every bar in the window (stricter; roughly halves the signal rate)
//   OFF    structure alone
const CLOSE_RULES = ['LAST', 'ALL', 'OFF'];

const DEFAULTS = {
  bars: 3,                // "the latest three completed 5-second candles"
  closeRule: 'LAST',
  minTicks: 3,            // a bar built from fewer samples measured nothing
};

// A bar that measured nothing cannot support a structure claim. On the REST
// quote fallback a quiet five seconds can hold two samples, and "higher high"
// drawn from two samples describes the poller, not the market.
function blind(bar, minTicks) {
  if (!bar) return 'no bar';
  if (bar.synthetic || !bar.tickCount) return 'the index feed was silent for this bar';
  if ((bar.tickCount || 0) < minTicks) {
    return `the bar holds ${bar.tickCount} ticks, under the ${minTicks} needed to measure it`;
  }
  return null;
}

/* -------------------------------------------------------------- structure -- */

// Higher highs and higher lows across the whole window, oldest first.
//
// STRICTLY higher. An equal high is not a higher high — a market printing the
// same high three times in fifteen seconds is a market that has stopped, and
// selling premium into a stall is the case this rule is meant to skip.
function risingStructure(bars) {
  for (let i = 1; i < bars.length; i++) {
    if (!(bars[i].highP > bars[i - 1].highP)) {
      return `bar ${i + 1}'s high is not above bar ${i}'s`;
    }
    if (!(bars[i].lowP > bars[i - 1].lowP)) {
      return `bar ${i + 1}'s low is not above bar ${i}'s`;
    }
  }
  return null;
}

function fallingStructure(bars) {
  for (let i = 1; i < bars.length; i++) {
    if (!(bars[i].highP < bars[i - 1].highP)) {
      return `bar ${i + 1}'s high is not below bar ${i}'s`;
    }
    if (!(bars[i].lowP < bars[i - 1].lowP)) {
      return `bar ${i + 1}'s low is not below bar ${i}'s`;
    }
  }
  return null;
}

function closesAgree(bars, wantUp, rule) {
  if (rule === 'OFF') return null;
  const check = rule === 'ALL' ? bars : bars.slice(-1);
  for (const b of check) {
    const up = b.closeP > b.openP;
    const down = b.closeP < b.openP;
    if (wantUp ? !up : !down) {
      return rule === 'ALL'
        ? `not every bar closes ${wantUp ? 'up' : 'down'}`
        : `the newest bar does not close ${wantUp ? 'up' : 'down'}`;
    }
  }
  return null;
}

/* ---------------------------------------------------------------- verdict -- */

// `bars` — completed INDEX bars, oldest first. The caller owns the buffer; only
// its tail is read.
function verdict(bars, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const need = Math.max(2, Math.trunc(c.bars));
  const rule = CLOSE_RULES.includes(c.closeRule) ? c.closeRule : 'LAST';

  const nothing = (state, reason, extra = {}) => ({
    state, reason, bullish: false, bearish: false,
    allowCE: false, allowPE: false, window: [], atMs: null, ...extra,
  });

  if (!Array.isArray(bars) || bars.length < need) {
    return nothing(STATES.WARMING_UP,
      `only ${Array.isArray(bars) ? bars.length : 0} completed index bars — ${need} are needed`);
  }

  const window = bars.slice(-need);
  const detail = window.map(b => ({
    bucketStart: b.bucketStart,
    openP: b.openP, highP: b.highP, lowP: b.lowP, closeP: b.closeP,
    tickCount: b.tickCount,
  }));
  const seen = { window: detail, atMs: window[window.length - 1].bucketEnd ?? null };

  for (const b of window) {
    const why = blind(b, c.minTicks);
    if (why) return nothing(STATES.NO_DATA, why, seen);
  }

  const upBroken = risingStructure(window);
  if (!upBroken) {
    const closeBroken = closesAgree(window, true, rule);
    if (!closeBroken) {
      return {
        state: STATES.BULLISH,
        bullish: true, bearish: false,
        // A bullish index permits the PE side and blocks the CE side.
        allowCE: false, allowPE: true,
        reason: `${need} bars of higher highs and higher lows`,
        ...seen,
      };
    }
    return nothing(STATES.NONE, `higher highs and higher lows, but ${closeBroken}`, seen);
  }

  const downBroken = fallingStructure(window);
  if (!downBroken) {
    const closeBroken = closesAgree(window, false, rule);
    if (!closeBroken) {
      return {
        state: STATES.BEARISH,
        bullish: false, bearish: true,
        allowCE: true, allowPE: false,
        reason: `${need} bars of lower highs and lower lows`,
        ...seen,
      };
    }
    return nothing(STATES.NONE, `lower highs and lower lows, but ${closeBroken}`, seen);
  }

  // Neither structure holds. Report the RISING failure: it is the first test and
  // naming both would double the length of every log line for no extra meaning.
  return nothing(STATES.NONE, `no trend structure — ${upBroken}`, seen);
}

// A short label for logs and the dashboard.
function short(state) {
  return {
    BULLISH: 'bullish', BEARISH: 'bearish', NONE: 'no trend',
    WARMING_UP: 'warming up', NO_DATA: 'silent',
  }[state] || state;
}

// The document draws its tables in arrows; so does the audit log.
function arrow(state) {
  return { BULLISH: '↑', BEARISH: '↓', NONE: '•' }[state] || '?';
}

// Module 10, "Trend Break": the structure that justified an OPEN position no
// longer holds. Deliberately narrower than "the verdict changed" — WARMING_UP
// and NO_DATA mean the filter has nothing to say, and closing a live short on an
// absence of information hands the market a free exit every time a bar is quiet.
function isBreak(verdictNow, optionType) {
  if (!verdictNow) return false;
  if (verdictNow.state === STATES.WARMING_UP || verdictNow.state === STATES.NO_DATA) return false;
  return optionType === 'CE' ? !verdictNow.allowCE : !verdictNow.allowPE;
}

module.exports = { STATES, CLOSE_RULES, DEFAULTS, verdict, short, arrow, isBreak,
  risingStructure, fallingStructure };
