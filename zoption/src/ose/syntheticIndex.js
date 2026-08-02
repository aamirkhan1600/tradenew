// The index, derived from the option chain instead of quoted directly.
//
// PURE. Legs, samples and a clock reading go in; an index level comes out.
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
//
// On 2026-08-02 this account's Kotak gateway served `nse_cm|Nifty 50` at
// 25117.55 against a true 24383.60 — a value consistent with an intraday tick on
// 2024-10-04, roughly 22 months stale. Every index on the cash segment was
// wrong, by different amounts and in OPPOSITE directions (NIFTY +3.01%,
// BANKNIFTY −8.79%, FINNIFTY −10.21%), while F&O quotes on the same UCC were
// current to within ten points. The fault is confined to `nse_cm` index quotes.
//
// The engine builds its whole index candle series from that number, so when it
// is wrong the trend, both midpoints, the EMA filter and the at-the-money strike
// are all wrong with it. `./spotGuard.js` detects that and refuses to trade.
// This module is the other half: it lets the engine KEEP trading by taking the
// index from the instruments that are still telling the truth.
//
// ---------------------------------------------------------------------------
// One formula, not two
// ---------------------------------------------------------------------------
//
// The level comes from `spotGuard.impliedSpot` — the same put-call parity, the
// same discount, the same near-the-money median. That is not tidiness: the guard
// is what decides the feed is wrong, and if the guard and the substitute
// computed the index differently, the engine could switch to a synthetic source
// the guard then rejected. Same function, no possible disagreement.
//
// ---------------------------------------------------------------------------
// Why this needs a FAST leg subscription, not the chain snapshot
// ---------------------------------------------------------------------------
//
// The obvious implementation — recompute from `chain.snapshot` on its 5-second
// refresh — produces exactly one index sample per 5-second bucket. A bar built
// from one sample has `open == high == low == close`, so §11.2's midpoints
// collapse onto the close, `close > bullishMid` is never true, and the engine
// would never take an entry again. It would look like it was running.
//
// So the legs are subscribed into the TICKER's one-second poll, in the same
// batched request the index and the held option already ride in. Twelve legs on
// a `NEO_QUOTE_BATCH` of 25 costs no extra HTTP request at all.
//
// ---------------------------------------------------------------------------
// A stale leg is dropped, not averaged
// ---------------------------------------------------------------------------
//
// `C − P` is only meaningful when both legs were observed at about the same
// moment. If a call ticks and its put does not, the difference moves for a
// reason that has nothing to do with the index. Any strike whose two legs are
// not BOTH fresh is discarded outright rather than smoothed — with a median over
// several strikes, dropping one costs nothing and keeping a bad one costs a
// wrong index level.
//
// Prices in: integer paise. `strike` is in POINTS, as everywhere else in the
// chain.

const spotGuard = require('./spotGuard');

// How many strikes to derive from, and the floor below which the level is not
// computed at all. Six is comfortably inside the quote batch and gives the
// median something to work with; three surviving strikes is the least that can
// carry a median worth the name.
const DEFAULT_STRIKES = 6;
const DEFAULT_MIN_STRIKES = 3;

// A leg older than this is not evidence. Two poll intervals, matching the
// staleness rule §16.4's stop guard already uses — a sample that has survived
// two polls without an update is one the gateway is not refreshing.
const DEFAULT_MAX_SAMPLE_AGE_MS = 2000;

/* ------------------------------------------------------------ leg selection -- */

// The strikes to subscribe: the `count` nearest `spotP` that quote BOTH legs.
//
// `quotes` is a chain snapshot's rows. Selection is deliberately tolerant of a
// WRONG `spotP` — parity is an identity and holds at every strike, so a window
// centred on a bad spot still returns the right level. That was verified against
// the live chain on the day of the fault: centred on 25100, it read 24382
// against a true 24383.60. It matters because the only spot available when this
// first runs is the one under suspicion.
function pickLegs(quotes, { spotP, count = DEFAULT_STRIKES } = {}) {
  const byStrike = new Map();
  for (const q of quotes || []) {
    if (!q || (q.optionType !== 'CE' && q.optionType !== 'PE')) continue;
    const strike = Number(q.strike);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    if (!q.token) continue;
    const e = byStrike.get(strike) || { strike, expiry: q.expiry ?? null };
    e[q.optionType] = { token: String(q.token), segment: q.segment || 'nse_fo' };
    byStrike.set(strike, e);
  }

  const centre = Number.isFinite(Number(spotP)) ? Number(spotP) / 100 : null;
  const complete = [...byStrike.values()].filter(e => e.CE && e.PE);
  if (centre == null) return complete.slice(0, Math.max(1, count));

  return complete
    .sort((a, b) => Math.abs(a.strike - centre) - Math.abs(b.strike - centre))
    .slice(0, Math.max(1, count))
    .sort((a, b) => a.strike - b.strike);
}

// Every token a leg set needs subscribed, in the shape `ticker.subscribe` takes.
function tokensFor(legs) {
  const out = [];
  for (const leg of legs || []) {
    if (leg.CE) out.push({ token: leg.CE.token, segment: leg.CE.segment });
    if (leg.PE) out.push({ token: leg.PE.token, segment: leg.PE.segment });
  }
  return out;
}

/* ------------------------------------------------------------- the level -- */

// `legs`     from pickLegs()
// `samples`  Map token -> { ltpPaise, ts }, the ticker's latest per instrument
//
// Returns `{ levelP, used, dropped, reason }`. `levelP` is integer paise, or
// null when too few strikes survived — and null is a REFUSAL to guess, not a
// zero. The caller feeds nothing to the candle builder on null, which shows up
// as a thin or absent bar rather than as a fabricated price.
function compute(legs, samples, {
  nowMs = Date.now(),
  maxSampleAgeMs = DEFAULT_MAX_SAMPLE_AGE_MS,
  minStrikes = DEFAULT_MIN_STRIKES,
  riskFreeRate,
} = {}) {
  const quotes = [];
  let dropped = 0;

  for (const leg of legs || []) {
    const ce = samples?.get(leg.CE?.token);
    const pe = samples?.get(leg.PE?.token);
    // BOTH legs, BOTH fresh. See the header — a half-updated pair moves `C − P`
    // for a reason that is not the index.
    if (!ce || !pe
      || !Number.isFinite(ce.ltpPaise) || ce.ltpPaise <= 0
      || !Number.isFinite(pe.ltpPaise) || pe.ltpPaise <= 0
      || (nowMs - ce.ts) > maxSampleAgeMs
      || (nowMs - pe.ts) > maxSampleAgeMs) {
      dropped += 1;
      continue;
    }
    quotes.push({ strike: leg.strike, optionType: 'CE', ltpP: ce.ltpPaise, expiry: leg.expiry });
    quotes.push({ strike: leg.strike, optionType: 'PE', ltpP: pe.ltpPaise, expiry: leg.expiry });
  }

  const used = quotes.length / 2;
  if (used < Math.max(1, Math.trunc(minStrikes))) {
    return {
      levelP: null,
      used,
      dropped,
      reason: `only ${used} strike(s) had both legs fresh within ${maxSampleAgeMs}ms — `
        + `${minStrikes} are needed`,
    };
  }

  // THE SAME function the guard judges the feed with. See the header.
  const implied = spotGuard.impliedSpot(quotes, { minPairs: minStrikes, nowMs, riskFreeRate });
  if (implied.spotP == null) {
    return { levelP: null, used, dropped, reason: 'the parity estimate did not resolve' };
  }

  // Rounded to whole paise HERE, at the boundary where it becomes a price the
  // candle builder will treat as one. Everything upstream ran full precision.
  return { levelP: Math.round(implied.spotP), used, dropped, reason: null };
}

module.exports = {
  DEFAULT_STRIKES, DEFAULT_MIN_STRIKES, DEFAULT_MAX_SAMPLE_AGE_MS,
  pickLegs, tokensFor, compute,
};
