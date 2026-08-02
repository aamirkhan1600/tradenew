// The index-feed sanity check.
//
// PURE, like every other decision module here. Chain quotes and a spot go in, a
// verdict comes out. No I/O, no clock, no state.
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
//
// On 2026-08-02 this account's Kotak gateway answered `nse_cm|Nifty 50` with
// `"ltp":"25117.5500"` while the index was actually at 24383.60 — a 734-point
// lie, served with a 200 and no error anywhere. The engine builds its ENTIRE
// index candle series from that number, so the 3-candle trend, both midpoints,
// the EMA9/EMA20 filter and `strikes.moneyness()` all inherited it. At a spot
// 734 points too high the at-the-money strike computes as 25100 instead of
// 24400, which marks every CE in the sellable band as in-the-money and
// unsellable.
//
// Nothing in the system noticed. That is the part worth fixing: a feed that
// fails LOUDLY is an operational annoyance, and one that fails silently with a
// plausible-looking number is how an engine sells the wrong strike all morning.
//
// ---------------------------------------------------------------------------
// Why NOT `ltp` against `ohlc.close`
// ---------------------------------------------------------------------------
//
// The obvious check — compare the two fields the same gateway serves for the
// same instrument — is wrong, and it is worth writing down why so nobody
// "simplifies" this back to it:
//
//   * during live hours `ohlc.close` is the PREVIOUS session's close, so `ltp`
//     legitimately differs from it by the whole of today's move. The check would
//     fire on every trending day and be switched off within a week.
//   * on the account that produced this bug the OHLC block is itself unreliable:
//     it reported open 24615.40 / high 25429.15 / low 24262.55 on a session
//     whose real values were 24361.45 / 24429.40 / 24299.70. Only `close`
//     happened to be right, and a guard resting on one accidentally-correct
//     field is not a guard.
//
// ---------------------------------------------------------------------------
// Put-call parity, and why it is the right instrument
// ---------------------------------------------------------------------------
//
// For European options on the same underlying and expiry, parity recovers the
// FORWARD, not the spot:
//
//     C - P = (F - K)*e^(-rT)      =>      F = K + (C - P)*e^(rT)
//
// and over the front expiry this engine trades, e^(rT) is 1.0003, so:
//
//     F ~= K + (C - P)              and      S = F*e^(-(r-q)T) ~= F
//
// THE STRIKE IS NOT DISCOUNTED, and an earlier revision of this file got that
// wrong. It computed `S = (C - P) + K*e^(-rT)`, which is parity for a
// NON-dividend-paying underlying and is not what an index does. Measured against
// 25 both-legged strikes on 2026-08-02:
//
//     K + (C - P)                 24381.90    err  -1.70
//     (C - P) + K*e^(-rT)         24373.75    err  -9.85     <- the "correction"
//
// Every strike agreed to within +/-0.5 points, so that 8-point gap was a
// systematic modelling bias, not noise. Discounting the strike without also
// discounting the spot by the dividend yield q moves the answer away from the
// index by K*(1 - e^(-rT)); the two effects very nearly cancel, and the cheapest
// correct thing is to let them.
//
// What is given up is the forward BASIS, F - S = S*(e^((r-q)T) - 1). Over the
// front weekly that is under two points and is inside the noise. It grows with
// T, so `check()` widens its tolerance by the basis allowance for the expiry in
// hand rather than pretending it is zero.
//
// Every strike that quotes BOTH legs is therefore an independent estimate of the
// spot, derived from the very instruments the engine trades. That is what makes
// this the right check rather than merely a second one:
//
//   * it MOVES WITH THE MARKET, so a real 3% day does not trip it;
//   * it is denominated in the same prices the strike selector ranks on, so if
//     the chain and the index disagree, the engine is by definition about to
//     select against a market it cannot see;
//   * it needs only `ltp` on options, which is all this entitlement serves.
//
// Measured against the live chain on the day of the bug, with the scan window
// deliberately centred on the WRONG spot, the median estimate came back at
// 24382.10 against a true 24383.60 — 1.5 points, while the feed was out by 735.
//
// ---------------------------------------------------------------------------
// The median, not the mean
// ---------------------------------------------------------------------------
//
// Near the money the estimates are extremely tight (24381–24384 across a dozen
// strikes). Far out of the money, where a leg may not have traded for hours, a
// stale `ltp` produces estimates hundreds of points wide — 23854 and 24050 both
// appeared in the same snapshot. A mean would be dragged by those; the median
// ignores them, and needs no threshold of its own to do it.
//
// ---------------------------------------------------------------------------
// Two functions, one identity — and why they are not yet one function
// ---------------------------------------------------------------------------
//
// `src/market/terminalFeed.js` computes a synthetic spot from the same identity,
// for a different reason (some accounts can quote F&O but not the cash segment
// the index lives in). It is a PRIVATE METHOD on a stateful class, reading
// `this.chainInstruments` and `this.quotes`; this is a pure function over a flat
// quote array. Neither can call the other without dragging its subsystem along.
//
// They are kept in step by using the same rate, the same `yearsToExpiry` and the
// same median-of-near-the-money selection. That is a convention, not a
// guarantee, and the honest thing to record is that extracting one shared
// implementation is the correct end state and has not been done.
//
// Prices in: integer paise. Index levels and strikes are the awkward pair here —
// `quote.strike` is in POINTS (24500 means 24500.00) while every price is in
// paise, so the conversion is done once, explicitly, and never inline.

const greeks = require('../market/greeks');

// The same default `terminalFeed` runs on (TERMINAL_RISK_FREE_RATE, 6.5%). Taken
// as a number rather than read from config so this module stays pure and a test
// can vary it.
const DEFAULT_RISK_FREE_RATE = 0.065;

// A nominal NIFTY dividend yield. Only ever used to size the forward-basis
// ALLOWANCE, never to price anything — the basis is what the tolerance absorbs,
// so being approximately right is the whole requirement.
const DEFAULT_DIVIDEND_YIELD = 0.012;

const VERDICT = {
  OK: 'OK',
  DIVERGED: 'SPOT_DIVERGENCE',
  UNKNOWN: 'SPOT_UNKNOWN',
  DISABLED: 'SPOT_CHECK_DISABLED',
};

// Defaults, used when a caller passes no configuration — a script, a test, or a
// backtest still gets the shipped behaviour rather than zeros.
const DEFAULT_MAX_DIVERGENCE_P = 10000;   // 100 index points, in paise
const DEFAULT_MIN_PAIRS = 5;

// How many near-the-money strikes the median is taken over. Five is
// `terminalFeed._syntheticSpotPaise()`'s sample size, matched on purpose.
const NEAR_MONEY_SAMPLE = 5;

// One estimate of the spot per strike that quotes both legs.
//
// `quotes` are §6.1 OptionQuotes — the shape `chain.normalise()` emits. A leg
// with no positive `ltpP` is skipped rather than read as zero: `Number(null)` is
// 0, and a zero premium would produce an estimate that looks like a number and
// means nothing.
// The discount factor e^(−rT) for the expiry these quotes belong to.
//
// Every quote in one OSE chain snapshot carries the SAME expiry (§8.2 selects
// one), so the first one that has it decides. A chain with no expiry on it
// yields 1 — the undiscounted identity — which is the old, slightly wrong
// behaviour, and it is confined to a case that should not occur rather than
// being the default for all of them.
function discountFor(quotes, { riskFreeRate = DEFAULT_RISK_FREE_RATE, nowMs } = {}) {
  const expiry = (quotes || []).find(q => q && q.expiry)?.expiry ?? null;
  if (!expiry) return 1;
  // `snapshotTs` is preferred over the wall clock so the verdict is a pure
  // function of its inputs — the same snapshot judged twice gives the same
  // answer, which is what the determinism gate needs.
  const at = Number.isFinite(Number(nowMs))
    ? Number(nowMs)
    : Number((quotes || []).find(q => q && Number.isFinite(q.snapshotTs))?.snapshotTs) || Date.now();
  const T = greeks.yearsToExpiry(expiry, at);
  if (!T) return 1;
  return Math.exp(-riskFreeRate * T);
}

// How far the FORWARD may legitimately sit above the spot, in paise.
//
// S·(e^((r−q)T) − 1), with (r−q) taken as the risk-free rate less a nominal
// index dividend yield. Both are approximations; the point is not to be exact
// but to stop a long-dated expiry reading as a broken feed. Zero when the expiry
// is unknown, which keeps the old behaviour for a caller that passes bare quotes.
function basisAllowanceP(levelP, quotes, { riskFreeRate = DEFAULT_RISK_FREE_RATE,
  dividendYield = DEFAULT_DIVIDEND_YIELD, nowMs } = {}) {
  if (!Number.isFinite(levelP) || levelP <= 0) return 0;
  const expiry = (quotes || []).find(q => q && q.expiry)?.expiry ?? null;
  if (!expiry) return 0;
  const at = Number.isFinite(Number(nowMs))
    ? Number(nowMs)
    : Number((quotes || []).find(q => q && Number.isFinite(q.snapshotTs))?.snapshotTs) || Date.now();
  const T = greeks.yearsToExpiry(expiry, at);
  if (!T) return 0;
  return Math.abs(levelP * (Math.exp(Math.max(0, riskFreeRate - dividendYield) * T) - 1));
}

function estimates(quotes, opts = {}) {
  const byStrike = new Map();
  for (const q of quotes || []) {
    if (!q || !Number.isFinite(q.ltpP) || q.ltpP <= 0) continue;
    if (q.optionType !== 'CE' && q.optionType !== 'PE') continue;
    const strike = Number(q.strike);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    const entry = byStrike.get(strike) || { strike };
    entry[q.optionType] = q.ltpP;
    byStrike.set(strike, entry);
  }

  const out = [];
  for (const e of byStrike.values()) {
    if (e.CE == null || e.PE == null) continue;
    // S = (C − P) + K·e^(−rT). The strike is in points and the premiums in
    // paise, so the strike is converted UP rather than the premiums down —
    // dividing paise would reintroduce the rounding this codebase keeps out of
    // price maths.
    out.push({
      strike: e.strike,
      ceP: e.CE,
      peP: e.PE,
      spreadP: Math.abs(e.CE - e.PE),
      // F ~= K + (C - P). The strike is in points and the premiums in paise, so
      // the strike is converted UP rather than the premiums down.
      spotP: (e.CE - e.PE) + (e.strike * 100),
    });
  }
  out.sort((a, b) => a.strike - b.strike);
  return out;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The chain's own opinion of where the index is. `null` when too few strikes
// quote both legs to form one — which is a different answer from "the index is
// wrong" and is reported as such.
function impliedSpot(quotes, opts = {}) {
  const minPairs = Number.isFinite(Number(opts.minPairs)) ? Number(opts.minPairs) : DEFAULT_MIN_PAIRS;
  const rows = estimates(quotes, opts);
  if (rows.length < Math.max(1, Math.trunc(minPairs))) {
    return { spotP: null, pairs: rows.length, rows };
  }
  // Parity is exact at EVERY strike but only trustworthy where both legs
  // actually trade, and |C − P| is smallest nearest the money — which is where
  // they do. Taking the near-the-money sample rather than the whole chain is
  // what `terminalFeed._syntheticSpotPaise()` does, and the two must agree.
  //
  // The median on top of that is what makes one stale leg cost nothing: on the
  // live chain of 2026-08-02, estimates of 23854, 24050 and 23922 sat alongside
  // a dozen at 24381–24384, and a mean would have followed them.
  const sample = [...rows].sort((a, b) => a.spreadP - b.spreadP).slice(0, NEAR_MONEY_SAMPLE);
  return { spotP: median(sample.map(r => r.spotP)), pairs: rows.length, rows };
}

// The verdict the engine acts on.
//
// `feedSpotP`  the sealed index candle's close — what the engine believes
// `quotes`     the current chain snapshot's quotes
//
// Returns `{ ok, verdict, impliedSpotP, divergenceP, pairs, reason }`. `ok` is
// false ONLY for a measured divergence: an unmeasurable chain returns ok with
// the UNKNOWN verdict, because a thin chain is already the business of
// CHAIN_CORRUPT and NO_LIQUID_STRIKE, and stopping the engine twice for one
// fault helps nobody.
function check(feedSpotP, quotes, cfg = {}) {
  const enabled = cfg.enabled !== false;
  if (!enabled) {
    return { ok: true, verdict: VERDICT.DISABLED, feedSpotP, impliedSpotP: null,
      divergenceP: null, pairs: 0, reason: null };
  }

  const maxDivergenceP = Number.isFinite(Number(cfg.maxDivergenceP))
    ? Number(cfg.maxDivergenceP) : DEFAULT_MAX_DIVERGENCE_P;
  const minPairs = Number.isFinite(Number(cfg.minPairs))
    ? Number(cfg.minPairs) : DEFAULT_MIN_PAIRS;

  const implied = impliedSpot(quotes, { minPairs });

  if (!Number.isFinite(feedSpotP) || feedSpotP <= 0 || implied.spotP == null) {
    return {
      ok: true,
      verdict: VERDICT.UNKNOWN,
      feedSpotP,
      impliedSpotP: implied.spotP,
      divergenceP: null,
      pairs: implied.pairs,
      reason: implied.spotP == null
        ? `only ${implied.pairs} strike(s) quote both legs — the chain cannot express an `
          + 'opinion about where the index is'
        : 'no sealed index close to check',
    };
  }

  // The estimate is a FORWARD, and the forward sits above the spot by the basis
  // S·(e^((r−q)T) − 1). Over the front weekly this engine trades that is under
  // two points; at a month it is tens. Rather than model q — which is not
  // knowable to the precision that would need — the tolerance simply absorbs it,
  // so a far expiry widens the band instead of tripping it.
  //
  // This replaces discounting the strike, which was an attempt to remove the
  // basis from the ESTIMATE and instead introduced a larger bias of its own. See
  // the header.
  const basisP = basisAllowanceP(implied.spotP, quotes, cfg);
  const toleranceP = maxDivergenceP + basisP;

  const divergenceP = feedSpotP - implied.spotP;
  if (Math.abs(divergenceP) <= toleranceP) {
    return { ok: true, verdict: VERDICT.OK, feedSpotP, impliedSpotP: implied.spotP,
      divergenceP, pairs: implied.pairs, reason: null };
  }

  return {
    ok: false,
    verdict: VERDICT.DIVERGED,
    feedSpotP,
    impliedSpotP: implied.spotP,
    divergenceP,
    pairs: implied.pairs,
    reason: `the index feed says ${fmt(feedSpotP)} but ${implied.pairs} option strikes price it at `
      + `${fmt(implied.spotP)} — a ${fmt(Math.abs(divergenceP))}-point disagreement `
      + `(tolerance ${fmt(toleranceP)}). The chain is `
      + 'the market the engine actually trades, so the FEED is what is wrong. Selecting a strike '
      + 'against this spot would pick from the wrong part of the chain.',
  };
}

const fmt = (paise) => (paise === null || paise === undefined || !Number.isFinite(paise)
  ? '—' : (paise / 100).toFixed(2));

module.exports = {
  VERDICT, DEFAULT_MAX_DIVERGENCE_P, DEFAULT_MIN_PAIRS, DEFAULT_RISK_FREE_RATE,
  DEFAULT_DIVIDEND_YIELD, basisAllowanceP,
  NEAR_MONEY_SAMPLE,
  discountFor, estimates, median, impliedSpot, check,
};
