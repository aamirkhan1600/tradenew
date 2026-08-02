// newdoc/ema.md — the EMA Trend Confirmation Engine.
//
// A PURE function, held to the same standard as ./trend.js: no I/O, no clock, no
// instance state, no `Date.now()`. The same index buffer twice gives the same
// verdict twice, which is what lets the determinism gate hash a session's
// decisions and expect the same answer.
//
// ---------------------------------------------------------------------------
// What this engine is, and what it is not
// ---------------------------------------------------------------------------
//
// "The engine does not generate buy or sell signals. It only confirms whether
// trading is allowed." It sits BEFORE the 3-Candle Trend Engine in the pipeline
// and it can only ever REFUSE:
//
//     5s NIFTY candle sealed -> EMA9 / EMA20 -> EMA FILTER -> 3-candle trend
//       -> midpoint validation -> strike selection -> risk -> SELL
//
// Nothing here selects a strike, prices an order or opens a position. Its two
// jobs are to say "not now" before anything expensive runs, and — once a
// position is open — to notice the EMA9/EMA20 crossover that ends it.
//
// ---------------------------------------------------------------------------
// One EMA implementation, not two
// ---------------------------------------------------------------------------
//
// The averages come from `src/shared/indicators.js`, the same UMD module the
// chart draws with in the browser. Two implementations of an EMA is two answers
// to "what did the 9 cross", and the first time they disagree there is no way to
// tell which one the operator was looking at. That module seeds an EMA with the
// SMA of its first `period` values — the convention every charting package uses
// — and front-pads `null` for the warm-up, never 0.
//
// ---------------------------------------------------------------------------
// Warm-up is 21 candles, not 20
// ---------------------------------------------------------------------------
//
// EMA20 first exists on the 20th completed candle. Crossover detection needs the
// PREVIOUS candle's pair as well, so the first bar this engine can express an
// opinion about is the 21st. Answering on the 20th would mean the very first
// verdict of every session could not tell a fresh crossover from a settled
// trend, and the fresh-crossover rule is the one that keeps the engine out of
// the whipsaw. 21 candles at 5s is 105 seconds after the feed starts.
//
// Until then the verdict is WARMING_UP and no entry is evaluated. That is not a
// fault; it is the §3.8 fail-closed reading of an absent indicator.
//
// ---------------------------------------------------------------------------
// "EMA9 == EMA20" is a band, not an equality
// ---------------------------------------------------------------------------
//
// The specification's sideways rule is written `EMA9 == EMA20` and its summary
// table writes the same rule `EMA9 ~= EMA20`. Two floating-point averages of
// different periods are essentially never bit-identical, so the equality read
// literally would fire never and the rule would be decoration. The honest
// implementation is a SEPARATION BAND: below `flatP` the two averages are not
// distinguishable and the market is flat. `emaFlatPoints` is that band, in index
// points, and it is the single most consequential number in this file.
//
// Prices in: integer paise. An index level of 25135.40 is 2513540. EMA values
// are FRACTIONAL paise and are deliberately not rounded — rounding two averages
// independently before subtracting can flip the sign of the difference, which is
// the only quantity anything here compares.

const indicators = require('../shared/indicators');
const C = require('./constants');

const BULLISH = 'BULLISH';
const BEARISH = 'BEARISH';

// The verdict's own vocabulary. `state` answers "what is the tape doing";
// `trend` is the narrower BULLISH/BEARISH/null the rest of the engine consumes,
// and is non-null ONLY for a confirmed direction.
const STATE = {
  BULLISH,
  BEARISH,
  SIDEWAYS: 'SIDEWAYS',       // one of the three §"Sideways Market" rules fired
  NO_CONFIRM: 'NO_CONFIRM',   // the averages are separated, the close is not
  WARMING_UP: 'WARMING_UP',
};

// Why a verdict came out the way it did. Recorded on every decision row, because
// "the EMA filter refused" is not an answer — "the averages were 0.15 points
// apart" and "price crossed the 9 four times in six candles" are different
// markets and want different responses from an operator.
const VIA = {
  ALIGNED: 'EMA_ALIGNED',                 // a clean, confirmed direction
  FLAT: 'EMA_FLAT',                       // |EMA9 - EMA20| within the band
  CHOP: 'EMA_CHOP',                       // price crossing EMA9 repeatedly
  FRESH_CROSS: 'EMA_FRESH_CROSS',         // the crossover has only just happened
  CLOSE_AGAINST: 'EMA_CLOSE_AGAINST_9',   // separated, but the close is the wrong side
  WARMING_UP: 'EMA_WARMING_UP',
};

// The §"Reject Trade" outcomes, as the decision log's vocabulary. They are
// distinct on purpose: a sideways tape, a close on the wrong side of the 9 and a
// disagreement with the 3-candle engine are three different reasons not to
// trade, and collapsing them would destroy the only record of which one the
// session actually spent its day on.
const OUTCOME = {
  WARMING_UP: 'EMA_WARMING_UP',
  SIDEWAYS: 'EMA_SIDEWAYS',
  FILTER_FAIL: 'EMA_FILTER_FAIL',
  CONFLICT: 'EMA_TREND_CONFLICT',
};

// The same index-direction-to-option-side mapping ./trend.js makes, and it reads
// backwards to a directional trader for the same reason:
//
//     index BULLISH  ->  SELL PE
//     index BEARISH  ->  SELL CE
function sideFor(trend) {
  if (trend === BULLISH) return 'PE';
  if (trend === BEARISH) return 'CE';
  return null;
}

// The tunables, in the shape settings.derive() hands over. Defaults are the
// compiled-in constants so a caller with no configuration — a script, a test, a
// backtest — still gets the shipped behaviour rather than zeros.
function resolve(cfg = {}) {
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  return {
    fast: Math.max(1, Math.trunc(num(cfg.emaFast, C.EMA_FAST))),
    slow: Math.max(2, Math.trunc(num(cfg.emaSlow, C.EMA_SLOW))),
    flatP: Math.max(0, num(cfg.emaFlatP, C.EMA_FLAT_P)),
    chopLookback: Math.max(0, Math.trunc(num(cfg.emaChopLookback, C.EMA_CHOP_LOOKBACK))),
    chopFlips: Math.max(0, Math.trunc(num(cfg.emaChopFlips, C.EMA_CHOP_FLIPS))),
    crossCooldown: Math.max(0, Math.trunc(num(cfg.emaCrossCooldown, C.EMA_CROSS_COOLDOWN))),
  };
}

// The number of completed candles below which no verdict is possible.
function warmupCandles(cfg = {}) {
  const { slow } = resolve(cfg);
  return slow + 1;
}

/* ------------------------------------------------------------- the verdict -- */

// `candles` — completed index candles, OLDEST FIRST, exactly as ./trend.js takes
// them. The caller owns the buffer; only closes are read and nothing here
// mutates it.
//
// Returns:
//   state          STATE.*
//   trend          'BULLISH' | 'BEARISH' | null — null unless CONFIRMED
//   via            VIA.*
//   reason         one sentence, for the decision log and the page
//   ema9P/ema20P   fractional paise, or null while warming up
//   separationP    ema9P - ema20P; the sign is the crossover state
//   cross          'BULLISH' | 'BEARISH' | null — a crossover ON THIS CANDLE
//   crossAge       completed candles since the most recent crossover, or null
//   flips          close-vs-EMA9 sign changes inside the chop window
//   closeP         the candle the verdict was formed on
function evaluate(candles, cfg = {}) {
  const opts = resolve(cfg);
  const need = opts.slow + 1;

  const blank = {
    ema9P: null, ema20P: null, prevEma9P: null, prevEma20P: null,
    separationP: null, cross: null, crossAge: null, flips: 0, closeP: null,
  };

  if (!Array.isArray(candles) || candles.length < need) {
    return {
      state: STATE.WARMING_UP,
      trend: null,
      via: VIA.WARMING_UP,
      reason: `only ${Array.isArray(candles) ? candles.length : 0} completed index candles — `
        + `${need} are needed before EMA${opts.fast}/EMA${opts.slow} can say anything`,
      ...blank,
    };
  }

  const closes = candles.map(c => Number(c?.closeP));
  const fastLine = indicators.ema(closes, opts.fast);
  const slowLine = indicators.ema(closes, opts.slow);

  const i = closes.length - 1;
  const ema9P = fastLine[i];
  const ema20P = slowLine[i];
  const prevEma9P = fastLine[i - 1];
  const prevEma20P = slowLine[i - 1];
  const closeP = closes[i];

  // Defensive, and not merely defensive: `indicators.ema` SKIPS a non-finite
  // value rather than seeding from it, so a buffer carrying a malformed bar can
  // be long enough and still have an unwarmed tail. Treating that as WARMING_UP
  // is the only honest answer — the alternative is comparing a number against
  // `null`, which in JavaScript is a comparison that quietly succeeds.
  if (![ema9P, ema20P, prevEma9P, prevEma20P, closeP].every(Number.isFinite)) {
    return {
      state: STATE.WARMING_UP,
      trend: null,
      via: VIA.WARMING_UP,
      reason: 'the index series holds an unreadable close — the averages are not warm',
      ...blank,
    };
  }

  const separationP = ema9P - ema20P;
  const cross = crossAt(fastLine, slowLine, i);
  const crossAge = candlesSinceCross(fastLine, slowLine, i, opts.crossCooldown);
  const flips = countFlips(closes, fastLine, i, opts.chopLookback);

  const seen = {
    ema9P, ema20P, prevEma9P, prevEma20P, separationP, cross, crossAge, flips, closeP,
  };
  const verdict = (state, trend, via, reason) => ({ state, trend, via, reason, ...seen });

  /* --- §"Sideways Market" — three rules, any one of which is NO TRADE ------ */

  // 1. `EMA9 == EMA20`, read as the separation band. Checked first because when
  //    the averages are indistinguishable, nothing else in this file means
  //    anything: a "crossover" between two lines 0.05 points apart is noise
  //    wearing the name of a signal.
  if (Math.abs(separationP) <= opts.flatP) {
    return verdict(STATE.SIDEWAYS, null, VIA.FLAT,
      `EMA${opts.fast} ${fmt(ema9P)} and EMA${opts.slow} ${fmt(ema20P)} are `
      + `${fmt(Math.abs(separationP))} apart, inside the ${fmt(opts.flatP)}-point flat band`);
  }

  // 2. "EMA crossover has just occurred". The bar the averages crossed on, and
  //    the `crossCooldown - 1` bars after it, are the least reliable moment the
  //    indicator ever has — the separation is by definition near zero and the
  //    next candle decides whether it was a turn or a wobble.
  if (crossAge !== null && crossAge < opts.crossCooldown) {
    return verdict(STATE.SIDEWAYS, null, VIA.FRESH_CROSS,
      crossAge === 0
        ? `EMA${opts.fast} crossed EMA${opts.slow} on this candle — the first candle after a `
          + 'crossover is not confirmation of it'
        : `the EMA crossover was ${crossAge} candle${crossAge === 1 ? '' : 's'} ago; `
          + `${opts.crossCooldown} are required before it counts`);
  }

  // 3. "Price is moving repeatedly above and below EMA9." Counted rather than
  //    described: how many times the close changed sides across the last
  //    `chopLookback` candles.
  if (opts.chopFlips > 0 && flips >= opts.chopFlips) {
    return verdict(STATE.SIDEWAYS, null, VIA.CHOP,
      `the close crossed EMA${opts.fast} ${flips} times in the last ${opts.chopLookback} `
      + 'candles — that is chop, not a trend');
  }

  /* --- §"Bullish" / §"Bearish" — both halves, or nothing ------------------ */

  if (separationP > 0 && closeP > ema9P) {
    return verdict(BULLISH, BULLISH, VIA.ALIGNED,
      `EMA${opts.fast} ${fmt(ema9P)} is above EMA${opts.slow} ${fmt(ema20P)} and the close `
      + `${fmt(closeP)} is above both`);
  }

  if (separationP < 0 && closeP < ema9P) {
    return verdict(BEARISH, BEARISH, VIA.ALIGNED,
      `EMA${opts.fast} ${fmt(ema9P)} is below EMA${opts.slow} ${fmt(ema20P)} and the close `
      + `${fmt(closeP)} is below both`);
  }

  // The averages are separated but the close is on the wrong side of the fast
  // one: a pullback into the average inside a trend. §"Bullish EMA Condition"
  // requires BOTH halves, so this is a refusal and not a weaker yes.
  return verdict(STATE.NO_CONFIRM, null, VIA.CLOSE_AGAINST,
    `EMA${opts.fast} ${fmt(ema9P)} is ${separationP > 0 ? 'above' : 'below'} EMA${opts.slow} `
    + `${fmt(ema20P)}, but the close ${fmt(closeP)} is on the other side of EMA${opts.fast}`);
}

/* --------------------------------------------------------------- the gate -- */

// §"Trade Rules" and §"Reject Trade", as one decision.
//
//     SELL PE   EMA BULLISH  and  3-candle BULLISH   (midpoint is checked after)
//     SELL CE   EMA BEARISH  and  3-candle BEARISH
//
// Returns `{ allowed, outcome, reason }`. `outcome` is null when allowed and an
// OUTCOME.* code otherwise — the decision log's own vocabulary, so a refusal is
// machine-readable rather than a sentence somebody has to parse.
//
// `trend` is the ./trend.js verdict for the SAME cycle. An undetermined trend is
// not this engine's rejection to make — the caller has already handled it — but
// it is still a conflict here rather than a pass, because a filter that waves
// through an absent counterparty is not a filter.
function gate(verdict, trend) {
  if (!verdict || verdict.state === STATE.WARMING_UP) {
    return {
      allowed: false,
      outcome: OUTCOME.WARMING_UP,
      reason: verdict?.reason || 'the EMA filter has no verdict yet',
    };
  }

  if (verdict.state === STATE.SIDEWAYS) {
    return { allowed: false, outcome: OUTCOME.SIDEWAYS, reason: verdict.reason };
  }

  if (verdict.trend == null) {
    return { allowed: false, outcome: OUTCOME.FILTER_FAIL, reason: verdict.reason };
  }

  if (trend !== verdict.trend) {
    return {
      allowed: false,
      outcome: OUTCOME.CONFLICT,
      reason: `the EMA filter reads ${verdict.trend} (wants SELL ${sideFor(verdict.trend)}) but `
        + `the 3-candle trend engine reads ${trend ?? 'UNDETERMINED'} — both must agree`,
    };
  }

  return { allowed: true, outcome: null, reason: verdict.reason };
}

/* --------------------------------------------------------------- the exit -- */

// §"Position Exit Rule":
//
//     a bullish trade (short PE)  exits when EMA9 crosses BELOW EMA20
//     a bearish trade (short CE)  exits when EMA9 crosses ABOVE EMA20
//
// Implemented on the STATE, not on the edge, and that difference is deliberate.
//
// A crossover is visible on exactly one candle. The decision cycle drops a
// candle that seals while the previous cycle is still running (§4.2), so an
// edge-triggered exit can be missed outright — and the position it would have
// closed is a naked short whose whole justification has just inverted. Reading
// the RELATIONSHIP instead cannot be missed: once EMA9 is on the wrong side of
// EMA20 it stays there until it crosses back, so the exit fires on the first
// cycle that observes it and every cycle after.
//
// It cannot fire early either: an entry required the averages separated in the
// position's favour (with a flat band and a cooldown on top), so the only way to
// reach an adverse separation is through the crossover the specification names.
//
// The flat band is NOT applied here. Entry demands evidence and holding demands
// none — an average drifting to dead level under a live naked short is a reason
// to be out, not a reason to wait for confirmation. §3.8, fail closed.
//
// Returns `{ broken, fresh, reason }`.
function isBreak(verdict, optionType) {
  if (!verdict || verdict.state === STATE.WARMING_UP || !Number.isFinite(verdict.separationP)) {
    // No opinion. The trend engine treats its own silence as a break; this one
    // does not, because the EMA line is a SECOND opinion and the position
    // validity filter (§13.3) and the trend break are both still evaluating on
    // the same candle. Two independent filters that both exit on an absence
    // would close every position the moment the buffer was rebuilt after a
    // restart, which is a worse failure than a slow exit.
    return { broken: false, fresh: false, reason: null };
  }

  const wants = optionType === 'PE' ? BULLISH : BEARISH;
  const holds = wants === BULLISH ? verdict.separationP > 0 : verdict.separationP < 0;
  if (holds) return { broken: false, fresh: false, reason: null };

  const crossed = verdict.cross != null && verdict.cross !== wants;
  return {
    broken: true,
    fresh: crossed,
    reason: crossed
      ? `EMA9 crossed ${wants === BULLISH ? 'below' : 'above'} EMA20 on this candle — the `
        + `${wants} structure the short ${optionType} was sold into has ended`
      : `EMA9 ${fmt(verdict.ema9P)} is ${wants === BULLISH ? 'below' : 'above'} EMA20 `
        + `${fmt(verdict.ema20P)} — the ${wants} structure the short ${optionType} was sold `
        + 'into no longer holds',
  };
}

/* ------------------------------------------------------------- internals -- */

// A crossover ON bar `i`: the pair changed sides between `i-1` and `i`.
//
// The specification writes the bullish test as `prev EMA9 <= prev EMA20 AND
// current EMA9 > current EMA20`, so a bar where the averages were exactly level
// and then separated upward IS a bullish crossover. The `<=` is load-bearing and
// is reproduced exactly.
function crossAt(fastLine, slowLine, i) {
  if (i < 1) return null;
  const f0 = fastLine[i - 1];
  const s0 = slowLine[i - 1];
  const f1 = fastLine[i];
  const s1 = slowLine[i];
  if (![f0, s0, f1, s1].every(Number.isFinite)) return null;
  if (f0 <= s0 && f1 > s1) return BULLISH;
  if (f0 >= s0 && f1 < s1) return BEARISH;
  return null;
}

// How many completed candles ago the most recent crossover was, looking back at
// most `limit` bars. `0` means it happened on bar `i` itself; `null` means there
// was none inside the window.
//
// Bounded rather than exhaustive on purpose: the only question asked of this is
// "was it recent", the answer is compared against a cooldown of a few candles,
// and walking a 720-bar ring buffer once per cycle to answer it would be work
// the §23.1 latency budget does not need to spend.
function candlesSinceCross(fastLine, slowLine, i, limit) {
  const back = Math.max(0, Math.trunc(limit));
  for (let k = 0; k <= back; k += 1) {
    const at = i - k;
    if (at < 1) break;
    if (crossAt(fastLine, slowLine, at)) return k;
  }
  return null;
}

// How many times the close changed sides of EMA9 across the last `lookback`
// candles — the countable form of "price is moving repeatedly above and below
// EMA9".
//
// A close sitting EXACTLY on the average is not a side and is skipped rather
// than assigned one: counting it as a flip would make a flat tape read as chop,
// and counting it as a hold would let a genuine crossing hide behind it.
function countFlips(closes, fastLine, i, lookback) {
  const back = Math.max(0, Math.trunc(lookback));
  if (back < 2) return 0;

  let flips = 0;
  let previousSide = null;
  for (let at = Math.max(0, i - back + 1); at <= i; at += 1) {
    const ema = fastLine[at];
    const close = closes[at];
    if (!Number.isFinite(ema) || !Number.isFinite(close)) continue;
    if (close === ema) continue;
    const side = close > ema ? 1 : -1;
    if (previousSide !== null && side !== previousSide) flips += 1;
    previousSide = side;
  }
  return flips;
}

const fmt = (paise) => (paise === null || paise === undefined || !Number.isFinite(paise)
  ? '—' : (paise / 100).toFixed(2));

module.exports = {
  BULLISH, BEARISH, STATE, VIA, OUTCOME,
  sideFor, resolve, warmupCandles, evaluate, gate, isBreak,
  crossAt, candlesSinceCross, countFlips,
};
