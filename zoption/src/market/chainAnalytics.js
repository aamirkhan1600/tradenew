// Option-chain analytics: max pain, PCR, OI build-up, and the day's totals.
//
// Pure functions over a chain array, no I/O and no clock, so the answers to
// "where is max pain" and "is this call writing or short covering" are testable
// without a broker session.
//
// ONE CAVEAT THAT GOVERNS THIS WHOLE FILE. Every function here reads open
// interest, and open interest is the field Kotak's quote endpoint is least
// likely to return on a retail Trade API entitlement. When OI is absent these
// functions return null rather than a plausible-looking zero: a max-pain strike
// computed from an all-zero OI ladder is not "max pain at the ATM", it is
// nothing at all, and printing it as a number is how a screen lies quietly.
// `chainSummary` therefore carries an `available` block saying which of these
// numbers are real.

// The single most important line in this file.
//
// `Number(null)` is 0 and `Number('')` is 0, so a plain `Number.isFinite`
// coercion turns "the broker sent no open interest" into "this strike has zero
// open interest" — and every function below then happily computes a max pain, a
// PCR and an OI build-up out of a column that does not exist. Absence is
// checked BEFORE coercion, and only then is the value converted.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const sumOf = (rows, pick) => {
  let total = 0;
  let seen = 0;
  for (const r of rows) {
    const v = num(pick(r));
    if (v === null) continue;
    total += v;
    seen += 1;
  }
  return seen ? total : null;
};

/* --------------------------------------------------------------- max pain - */

// The strike at which option WRITERS pay out the least, which is the strike the
// market as a whole loses the least by expiring at.
//
// Computed as stated rather than by the "sum of ITM OI" shortcut: for each
// candidate settlement strike, add up what every call and put in the chain would
// be worth intrinsically, weighted by its open interest. The minimum wins.
//
// O(n²) over the strike ladder. With a ±20 window that is 1,600 multiplications
// once a second, which is not worth optimising and is worth being able to read.
function maxPain(rows) {
  const strikes = [...new Set(rows.map(r => num(r.strike)).filter(v => v !== null))]
    .sort((a, b) => a - b);
  if (strikes.length < 2) return null;

  let hasOi = false;
  let best = null;
  let bestPain = Infinity;

  for (const settle of strikes) {
    let pain = 0;
    for (const r of rows) {
      const strike = num(r.strike);
      if (strike === null) continue;
      const callOi = num(r.call && r.call.oi);
      const putOi = num(r.put && r.put.oi);
      if (callOi !== null) { hasOi = true; pain += callOi * Math.max(0, settle - strike); }
      if (putOi !== null) { hasOi = true; pain += putOi * Math.max(0, strike - settle); }
    }
    if (pain < bestPain) { bestPain = pain; best = settle; }
  }
  // Without OI every candidate scores 0 and the "winner" is just the lowest
  // strike in the ladder. Say null.
  if (!hasOi) return null;
  return { strike: best, pain: bestPain };
}

/* -------------------------------------------------------------------- PCR - */

// Put-call ratio. Above 1 means more puts are open than calls, which is read as
// support (put writers are the ones with capital at risk below the market).
//
// Both the OI and the volume ratio are returned because they answer different
// questions: OI is positioning that has accumulated, volume is what changed
// hands today.
function pcr(rows) {
  const callOi = sumOf(rows, r => r.call && r.call.oi);
  const putOi = sumOf(rows, r => r.put && r.put.oi);
  const callVol = sumOf(rows, r => r.call && r.call.volume);
  const putVol = sumOf(rows, r => r.put && r.put.volume);
  return {
    oi: (callOi && putOi !== null && callOi > 0) ? putOi / callOi : null,
    volume: (callVol && putVol !== null && callVol > 0) ? putVol / callVol : null,
    callOi, putOi, callVol, putVol,
  };
}

/* -------------------------------------------------------------- build-up -- */

// The four-quadrant reading every Indian options desk uses. Price and open
// interest moving together means new money is taking the position; moving apart
// means an existing position is being closed.
//
//                     OI up                    OI down
//   price up     LONG_BUILDUP            SHORT_COVERING
//   price down   SHORT_BUILDUP           LONG_UNWINDING
//
// On the OPTION's own premium, not the underlying's — a rising call premium with
// rising call OI is longs being built in that call, which for this platform's
// short-selling strategy is the thing to be on the other side of carefully.
//
// `null` when either input is missing, and 'FLAT' when neither moved enough to
// mean anything: a 0.1% wobble in premium against a 12-contract OI change is
// noise, and labelling it SHORT_BUILDUP puts a story on a rounding error.
function buildup({ priceChange, oiChange, priceThreshold = 0, oiThreshold = 0 }) {
  const p = num(priceChange);
  const o = num(oiChange);
  if (p === null || o === null) return null;
  if (Math.abs(p) <= priceThreshold && Math.abs(o) <= oiThreshold) return 'FLAT';
  if (Math.abs(o) <= oiThreshold) return 'FLAT';
  if (p > 0 && o > 0) return 'LONG_BUILDUP';
  if (p < 0 && o > 0) return 'SHORT_BUILDUP';
  if (p > 0 && o < 0) return 'SHORT_COVERING';
  if (p < 0 && o < 0) return 'LONG_UNWINDING';
  return 'FLAT';
}

const BUILDUP_LABEL = {
  LONG_BUILDUP: 'Long build-up',
  SHORT_BUILDUP: 'Short build-up',
  SHORT_COVERING: 'Short covering',
  LONG_UNWINDING: 'Long unwinding',
  FLAT: 'Flat',
};

// Which side is writing. Call writing is bearish (the writer wants the market
// below the strike); put writing is bullish. Reported per strike so the heat map
// can colour the wall the market is defending.
function writingBias(row) {
  const call = row.call || {};
  const put = row.put || {};
  const callUp = num(call.oiChange);
  const putUp = num(put.oiChange);
  if (callUp === null && putUp === null) return null;
  const c = callUp || 0;
  const p = putUp || 0;
  if (c <= 0 && p <= 0) return null;
  if (c > p) return 'CALL_WRITING';
  if (p > c) return 'PUT_WRITING';
  return null;
}

/* -------------------------------------------------------------- moneyness - */

function moneyness(strike, spot, type, step) {
  const s = num(strike);
  const sp = num(spot);
  if (s === null || sp === null) return null;
  // "ATM" is the one strike nearest the spot, not a band. A band would paint
  // three rows yellow and the eye needs exactly one anchor.
  if (Math.abs(s - sp) <= (Number(step) || 50) / 2) return 'ATM';
  if (type === 'CE') return s < sp ? 'ITM' : 'OTM';
  return s > sp ? 'ITM' : 'OTM';
}

function atmStrike(rows, spot) {
  const sp = num(spot);
  if (sp === null) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const r of rows) {
    const s = num(r.strike);
    if (s === null) continue;
    const d = Math.abs(s - sp);
    if (d < bestDistance) { best = s; bestDistance = d; }
  }
  return best;
}

/* ----------------------------------------------------------- extremes ----- */

// The single-strike superlatives the spec asks to highlight. Returned as a map
// of `field -> strike` so the renderer can ask "is this cell the highest OI"
// with one lookup instead of a scan per cell.
function extremes(rows) {
  const out = {
    callOi: null, putOi: null,
    callOiChange: null, putOiChange: null,
    callVolume: null, putVolume: null,
    callIv: null, putIv: null,
    callTheta: null, putTheta: null,
    callGamma: null, putGamma: null,
  };
  const best = {};

  const consider = (key, strike, value, compare) => {
    const v = num(value);
    if (v === null) return;
    if (best[key] === undefined || compare(v, best[key])) { best[key] = v; out[key] = strike; }
  };
  const bigger = (a, b) => a > b;
  // Theta is negative for a long option, so "highest theta" means the most decay
  // — the most negative number. Comparing it with > would highlight the strike
  // that is decaying least, which is the opposite of what a seller is looking
  // for.
  const smaller = (a, b) => a < b;

  for (const r of rows) {
    const strike = Number(r.strike);
    const c = r.call || {};
    const p = r.put || {};
    consider('callOi', strike, c.oi, bigger);
    consider('putOi', strike, p.oi, bigger);
    consider('callOiChange', strike, c.oiChange, bigger);
    consider('putOiChange', strike, p.oiChange, bigger);
    consider('callVolume', strike, c.volume, bigger);
    consider('putVolume', strike, p.volume, bigger);
    consider('callIv', strike, c.iv, bigger);
    consider('putIv', strike, p.iv, bigger);
    consider('callTheta', strike, c.theta, smaller);
    consider('putTheta', strike, p.theta, smaller);
    consider('callGamma', strike, c.gamma, bigger);
    consider('putGamma', strike, p.gamma, bigger);
  }
  return out;
}

/* ------------------------------------------------------------- summary ---- */

// The panel at the top of the chain. `available` is the important half: it tells
// the UI which of these numbers came from the broker and which could not be
// computed, so a missing feed shows an em-dash instead of a zero that reads as
// "no open interest today".
function chainSummary(rows, { spot = null, expiry = null, lotSize = null, vix = null } = {}) {
  const ratio = pcr(rows);
  const pain = maxPain(rows);
  const atm = spot == null ? null : atmStrike(rows, spot);

  return {
    spot,
    expiry,
    lotSize,
    vix,
    atmStrike: atm,
    pcr: ratio.oi,
    pcrVolume: ratio.volume,
    maxPain: pain ? pain.strike : null,
    totalCallOi: ratio.callOi,
    totalPutOi: ratio.putOi,
    netOi: (ratio.putOi === null || ratio.callOi === null) ? null : ratio.putOi - ratio.callOi,
    totalCallVolume: ratio.callVol,
    totalPutVolume: ratio.putVol,
    extremes: extremes(rows),
    available: {
      oi: ratio.callOi !== null || ratio.putOi !== null,
      volume: ratio.callVol !== null || ratio.putVol !== null,
      maxPain: pain !== null,
      pcr: ratio.oi !== null,
      vix: vix !== null,
    },
  };
}

module.exports = {
  BUILDUP_LABEL,
  maxPain, pcr, buildup, writingBias, moneyness, atmStrike, extremes, chainSummary,
};
