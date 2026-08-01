// §9 — the Strike Selection Module.
//
// PURE. Validated quotes and a requested option type go in; the single
// highest-ranked candidate comes out, or null.
//
// §9.1 notes that selection is computed independently for CE and PE and that the
// Trend Engine decides which side is requested. This module only ever sees one
// side, which is the structural version of that sentence: there is no code path
// here that can act on the side the trend did not ask for.
//
// ---------------------------------------------------------------------------
// Determinism is the product
// ---------------------------------------------------------------------------
//
// §3.1 requires byte-identical decisions from identical inputs, and a strike
// selector is where that is easiest to lose: object iteration order, an unstable
// sort, a float comparison that goes either way. Three things defend it —
//
//   * the score is rounded to six decimal places (§9.3) before it is compared,
//     so two candidates either tie exactly or do not tie at all;
//   * the comparator is TOTAL (§9.4). Six keys, ending in the trading symbol,
//     which is unique — so there is always exactly one winner;
//   * nothing here reads a clock or a random source.
//
// §25.2 asserts the consequence directly: the same quote set shuffled a thousand
// times must select the same symbol every time.
//
// Prices in: integer paise.

const C = require('./constants');

const CHECKS = ['premium', 'openInterest', 'volume', 'bidQty', 'askQty', 'spreadAbs', 'spreadPct'];

const PASS = 'PASS';
const FAIL = 'FAIL';
const UNKNOWN = 'UNKNOWN';

function check(value, ok, describe) {
  if (value === null || value === undefined) return { result: UNKNOWN, value: null, reason: null };
  return ok(value)
    ? { result: PASS, value, reason: null }
    : { result: FAIL, value, reason: describe(value) };
}

/* -------------------------------------------------- §9.2, the hard filters -- */

// Applied in the order §9.2 lists them; ALL must pass. The result carries every
// check individually rather than only the first failure, because "why was this
// strike rejected" is a question a post-mortem asks of a specific strike.
//
// `cfg` supplies only the premium band — §5.1 makes that tunable and §5.2 makes
// everything else a constant.
function gate(quote, cfg = {}) {
  const strict = String(cfg.liquidityMode || 'STRICT').toUpperCase() === 'STRICT';
  const premiumMinP = cfg.premiumMinP ?? 1500;
  const premiumMaxP = cfg.premiumMaxP ?? 2500;

  // §9.2 writes the depth thresholds as `5 * LOT`, so they are per-contract.
  const lot = Number(quote.lotSize) || 0;
  const minBidQty = C.MIN_BID_LOTS * lot;
  const minAskQty = C.MIN_ASK_LOTS * lot;

  const checks = {
    // The premium band is never subject to liquidityMode: it is priced off the
    // last traded price, which every entitlement sends, and §8.4 has already
    // discarded a quote without one.
    premium: check(quote.ltpP,
      (v) => v >= premiumMinP && v <= premiumMaxP,
      (v) => `the premium ${fmt(v)} is outside ${fmt(premiumMinP)}–${fmt(premiumMaxP)}`),

    openInterest: check(quote.oi,
      (v) => v >= C.MIN_OI,
      (v) => `open interest ${inr(v)} is under ${inr(C.MIN_OI)}`),

    volume: check(quote.volume,
      (v) => v >= C.MIN_VOLUME,
      (v) => `volume ${inr(v)} is under ${inr(C.MIN_VOLUME)}`),

    bidQty: check(quote.bidQty,
      (v) => lot > 0 && v >= minBidQty,
      (v) => `only ${v} on the bid, ${minBidQty} required (${C.MIN_BID_LOTS} lots)`),

    askQty: check(quote.askQty,
      (v) => lot > 0 && v >= minAskQty,
      (v) => `only ${v} on the ask, ${minAskQty} required (${C.MIN_ASK_LOTS} lots)`),

    spreadAbs: check(quote.spreadP,
      (v) => v <= C.MAX_SPREAD_ABS,
      (v) => `the spread ${fmt(v)} is over ${fmt(C.MAX_SPREAD_ABS)}`),

    // §9.2 filter 8 — relative to the mid, so a wide spread on a cheap contract
    // fails where the same absolute spread on an expensive one passes.
    spreadPct: check(
      (quote.spreadP === null || quote.midP === null || quote.midP <= 0)
        ? null : quote.spreadP / quote.midP,
      (v) => v <= C.MAX_SPREAD_PCT,
      (v) => `the spread is ${(v * 100).toFixed(2)}% of the mid, over `
        + `${(C.MAX_SPREAD_PCT * 100).toFixed(0)}%`),
  };

  const failed = CHECKS.filter(name => checks[name].result === FAIL);
  const unavailable = CHECKS.filter(name => checks[name].result === UNKNOWN);

  // A §9.2 filter that actually FAILED rejects the strike, and it is checked
  // first — a premium outside the band, or open interest under the floor, is a
  // fact about the contract that no later rule can excuse.
  if (failed.length) {
    return { checks, ok: false, unavailable, reason: checks[failed[0]].reason };
  }

  // NEVER SELL AN IN-THE-MONEY OPTION.
  //
  // Deliberately kept OUT of the CHECKS array. Those seven are §9.2's, they are
  // liquidity, and `liquidityBroken` re-runs them on an open position — a short
  // that has gone in the money is the trade going wrong, which the stop owns,
  // not a reason to call it a liquidity exit. Moneyness is a rule about what may
  // be OPENED, and it belongs only here.
  //
  // ATM is the strike nearest spot on the 50-point grid, and it is allowed on
  // both sides: with spot at 24383 the 24400 strike is the at-the-money one, and
  // refusing it would push every trade a further 50 points out for no reason.
  const money = moneyness(quote, cfg);
  if (money.itm) {
    return { checks, ok: false, unavailable, moneyness: money, reason: money.reason };
  }
  if (strict && unavailable.length) {
    return {
      checks,
      ok: false,
      unavailable,
      moneyness: money,
      reason: `liquidityMode is STRICT and this account sends no ${unavailable.join(', ')} — `
        + 'no strike can clear the filter',
    };
  }
  return { checks, ok: true, unavailable, moneyness: money, reason: null };
}

/* ------------------------------------------------- ATM or OTM, never ITM -- */

// A short option is sold for premium it hopes to keep. An in-the-money strike
// already has intrinsic value in it: the delta is high, it moves nearly
// one-for-one with the index, and the "premium" being collected is largely not
// time value at all. Selling one is a different trade from the one this engine
// is specified to make.
//
// Without a spot price nothing can be decided, so the strike is ALLOWED and the
// verdict says why — refusing every strike because the caller omitted a
// parameter would look exactly like a market with nothing in it.
function moneyness(quote, cfg = {}) {
  const spotP = Number(cfg.spotP);
  if (!Number.isFinite(spotP) || spotP <= 0) {
    return { itm: false, atm: false, known: false, atmStrike: null, reason: null };
  }

  const spot = spotP / 100;
  const atmStrike = Math.round(spot / C.STRIKE_MULTIPLE) * C.STRIKE_MULTIPLE;
  const strike = Number(quote.strike);
  const isCall = quote.optionType === 'CE';

  // A call is in the money below the money, a put above it. The at-the-money
  // strike itself is neither, and is permitted on both sides.
  const itm = isCall ? strike < atmStrike : strike > atmStrike;

  return {
    itm,
    atm: strike === atmStrike,
    known: true,
    atmStrike,
    reason: itm
      ? `the ${strike} ${quote.optionType} is in the money with the index at `
        + `${spot.toFixed(2)} (at-the-money strike ${atmStrike}) — only ATM or OTM may be sold`
      : null,
  };
}

/* ------------------------------------------------------- §9.3, the ranking -- */

// Min-max across the SURVIVING set. Returns null when the field cannot be
// normalised — either nobody in the set has it, or the caller has a single
// member and the special case below applies.
function minMax(values) {
  const present = values.filter(v => v !== null && v !== undefined && Number.isFinite(v));
  if (!present.length) return null;
  return { min: Math.min(...present), max: Math.max(...present) };
}

function normalise(value, bounds) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (!bounds) return null;
  // §9.3 — "0 if maxOI == minOI". A field every survivor agrees on carries no
  // information for ranking, so it contributes nothing rather than everything.
  if (bounds.max === bounds.min) return 0;
  return (value - bounds.min) / (bounds.max - bounds.min);
}

// `score = 0.40*oiNorm + 0.30*volNorm + 0.20*depthNorm + 0.10*(1 − spreadNorm)`
//
// A term the broker never sent is DROPPED and the total is rescaled over the
// terms that survive. That generalisation is forced: coercing a missing field to
// 0 would rank an unmeasurable strike below a measurably bad one, and coercing
// it to 1 would rank it above a measurably good one. Neither is true, so the
// weight is redistributed among the terms that are actually evidence, and
// `componentsUsed` records which those were.
//
// In STRICT mode this never fires — an unmeasurable strike was already rejected
// by gate() — so the rescaling is LENIENT's concern alone.
function scoreOne(candidate, bounds, single) {
  const depth = (candidate.bidQty === null || candidate.askQty === null)
    ? null : Math.min(candidate.bidQty, candidate.askQty);

  // §9.3 — "If the set has a single member, all norms are 1.0 (except spread,
  // 0.0)." Stated before the formula and therefore taking precedence over the
  // max == min rule, which would otherwise zero everything.
  const norm = (value, key) => {
    if (value === null || value === undefined) return null;
    if (single) return key === 'spread' ? 0 : 1;
    return normalise(value, bounds[key]);
  };

  const components = {
    oi: norm(candidate.oi, 'oi'),
    volume: norm(candidate.volume, 'volume'),
    depth: norm(depth, 'depth'),
    spread: norm(candidate.spreadP, 'spread'),
  };

  const terms = {
    oi: components.oi,
    volume: components.volume,
    depth: components.depth,
    // The one inverted term: a narrow spread is good, so the normalised spread
    // is subtracted from one before it is weighted.
    spread: components.spread === null ? null : 1 - components.spread,
  };

  let earned = 0;
  let available = 0;
  const used = [];
  for (const [key, value] of Object.entries(terms)) {
    if (value === null) continue;
    const weight = C.SCORE_WEIGHTS[key];
    earned += value * weight;
    available += weight;
    used.push(key);
  }

  const raw = available > 0 ? earned / available : 0;
  const factor = 10 ** C.SCORE_DP;

  return {
    ...candidate,
    depth,
    score: Math.round(raw * factor) / factor,
    components,
    componentsUsed: used,
  };
}

/* ---------------------------------------------------- §9.4, the tie-break -- */

// Total and stable. Applied in order until non-zero:
//
//   1. score      descending
//   2. oi         descending
//   3. volume     descending
//   4. spread     ascending
//   5. strike     ascending
//   6. symbol     ascending (localeCompare, 'en', numeric: false)
//
// Step 6 guarantees a unique winner, because the trading symbol is unique within
// an expiry. §9.4 is explicit that `Array.prototype.sort` stability must never
// be relied on instead — a stable sort preserves INPUT order, and input order
// here is whatever the broker's JSON happened to enumerate.
//
// A field the broker did not send sorts LAST in its own key rather than first:
// an unmeasurable strike must not win a tie-break it could not participate in.
const desc = (a, b) => (b === null ? -1 : 0) - (a === null ? -1 : 0) || (b ?? 0) - (a ?? 0);
const asc = (a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0) || (a ?? 0) - (b ?? 0);

// §9.4, plus one step the specification did not need and this broker does.
//
// The published comparator ends `... spread asc, strike asc, symbol asc`, and
// `strike asc` was only ever meant to guarantee a UNIQUE winner once score had
// already discriminated. On an `ltp`-only account nothing above it can
// discriminate — every candidate scores 0 — so `strike asc` silently becomes the
// PRIMARY selector, and it is directionally wrong:
//
//   short PE : the lowest strike is furthest OUT of the money — the safest
//   short CE : the lowest strike is deepest IN the money — the riskiest
//
// So it would systematically sell the safest put and the most dangerous call.
//
// `premiumDistanceP` runs first: the candidate whose premium sits nearest the
// middle of the configured band. It is decided PURELY on premium — the one field
// this entitlement actually sends — and it is symmetric, because for a call a
// higher premium means deeper in the money and for a put it means the opposite.
// Picking the richest premium in the band would reproduce exactly the bias above.
//
// It sits BELOW score/oi/volume/spread, so on an entitlement that does send
// those, §9.4 is unchanged and this never runs.
function compare(a, b) {
  return (b.score - a.score)
    || desc(a.oi, b.oi)
    || desc(a.volume, b.volume)
    || asc(a.spreadP, b.spreadP)
    || desc(a.ltpP, b.ltpP)
    || (a.strike - b.strike)
    || String(a.symbol).localeCompare(String(b.symbol), 'en', { numeric: false });
}

/* ------------------------------------------------------------- §9.1, select -- */

// `quotes` — validated `OptionQuote[]` (§8.4 has already run).
// `optionType` — the side the Trend Engine asked for.
//
// Returns the winner, the full ranked list for the audit trail, every rejection
// with its reason, and the fields nobody in the scan had data for.
function select(quotes, optionType, cfg = {}) {
  const ofType = (quotes || []).filter(q => q && q.optionType === optionType);

  const gated = ofType.map(q => ({ q, g: gate(q, cfg) }));
  const passing = gated.filter(x => x.g.ok).map(x => x.q);
  const rejected = gated.filter(x => !x.g.ok).map(x => ({
    token: x.q.token, symbol: x.q.symbol, strike: x.q.strike, ltpP: x.q.ltpP,
    reason: x.g.reason,
  }));

  // What the broker never sent for ANY strike on this side. Reported once here
  // rather than repeated as a rejection reason forty times.
  const unavailable = CHECKS.filter(name =>
    gated.length > 0 && gated.every(x => x.g.checks[name].result === UNKNOWN));

  if (!passing.length) {
    return {
      chosen: null,
      ranked: [],
      rejected,
      unavailable,
      considered: ofType.length,
      reason: ofType.length
        ? `no ${optionType} strike cleared the filters (${rejected.length} rejected; `
          + `first: ${rejected[0]?.reason})`
        : `no ${optionType} contracts were quoted`,
    };
  }

  const single = passing.length === 1;
  const bounds = {
    oi: minMax(passing.map(q => q.oi)),
    volume: minMax(passing.map(q => q.volume)),
    depth: minMax(passing.map(q =>
      (q.bidQty === null || q.askQty === null) ? null : Math.min(q.bidQty, q.askQty))),
    spread: minMax(passing.map(q => q.spreadP)),
  };

  const ranked = passing
    .map(q => ({
      ...scoreOne(q, bounds, single),
      // Highest premium wins — the most credit available. Safe to maximise only
      // because every survivor is already ATM or OTM: without that filter the
      // richest premium on the call side is always the deepest in-the-money one.
      premiumRankP: q.ltpP,
    }))
    .sort(compare);

  return {
    chosen: ranked[0],
    ranked,
    rejected,
    unavailable,
    considered: ofType.length,
    reason: null,
  };
}

const fmt = (paise) => (paise / 100).toFixed(2);
const inr = (n) => Number(n).toLocaleString('en-IN');

module.exports = {
  CHECKS, PASS, FAIL, UNKNOWN,
  gate, normalise, minMax, scoreOne, compare, select,
};
