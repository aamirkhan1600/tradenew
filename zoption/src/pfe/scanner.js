// Module 2 of doc/new.md — automatic option selection.
//
//     download the chain -> filter by premium -> drop the illiquid
//                        -> rank what is left -> take the best
//
// PURE: a list of contracts with their quotes goes in, a ranked selection comes
// out. No network, no clock, no broker. The engine does the quoting.
//
// ---------------------------------------------------------------------------
// THE ONE THING TO UNDERSTAND BEFORE READING THE THRESHOLDS
// ---------------------------------------------------------------------------
//
// The document asks for open interest above 100,000, volume above 10,000, more
// than 100 lots on each side of the book and a spread inside 20 paise. Kotak's
// Trade API sends NONE of those on a retail entitlement — `src/market/
// quoteSource.js` probes for a richer quote filter at boot and, on most
// accounts, settles on `ltp` and says so.
//
// So every check here has three outcomes, not two:
//
//     PASS      the broker sent the field and it clears the threshold
//     FAIL      the broker sent the field and it does not
//     UNKNOWN   the broker sent no such field
//
// and `liquidityMode` decides what UNKNOWN means:
//
//     STRICT    UNKNOWN counts as FAIL. Correct, and on an `ltp`-only account
//               it means the engine never trades. That is an honest answer to
//               "I require a liquidity filter" — but it is a silent one unless
//               somebody says so, which is what `unavailable` on the result and
//               the warning in settings.js are for.
//     LENIENT   UNKNOWN skips that one check and is RECORDED. The contract is
//               selected on the checks that could actually be made.
//
// What is never done is coercing a missing field to zero. `Number(null)` is 0,
// and a chain where every strike reports zero open interest does not read as
// "the broker sent nothing", it reads as "nobody holds these" — a lie a trader
// can act on. Absence is checked before coercion, everywhere.
//
// Premiums in: integer paise. Open interest and volume are contract counts.

const MODES = ['LENIENT', 'STRICT'];

const DEFAULTS = {
  liquidityMode: 'LENIENT',
  premiumMinP: 1200,          // ₹12 — below this the reward is poor and gamma bites
  premiumMaxP: 3000,          // ₹30 — above it the stop has to be wide
  premiumIdealMinP: 1500,     // ₹15 ─┐ the band the score treats as perfect
  premiumIdealMaxP: 2500,     // ₹25 ─┘
  minOpenInterest: 100000,
  minVolume: 10000,
  minBidQty: 100,
  minAskQty: 100,
  maxSpreadP: 20,             // ₹0.20
  weights: { premium: 1, spread: 1, oi: 1, volume: 1, depth: 1 },
};

// Absent-aware read. The single most important line in this file, for the same
// reason it is in src/market/chainAnalytics.js.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const paise = (rupees) => (rupees == null ? null : Math.round(Number(rupees) * 100));

/* ------------------------------------------------------------- one check -- */

const PASS = 'PASS';
const FAIL = 'FAIL';
const UNKNOWN = 'UNKNOWN';

function check(value, ok, describe) {
  if (value === null) return { result: UNKNOWN, value: null, reason: null };
  return ok(value)
    ? { result: PASS, value, reason: null }
    : { result: FAIL, value, reason: describe(value) };
}

/* --------------------------------------------------------- the candidate -- */

// One contract's measurable facts, normalised. `row` is an instrument-master
// row; `quote` is whatever the broker actually answered with.
function measure(row, quote) {
  const q = quote || {};
  const ltpP = paise(num(q.ltp));
  const bidP = paise(num(q.bid));
  const askP = paise(num(q.ask));
  return {
    token: String(row.token),
    symbol: row.symbol,
    segment: row.segment,
    strike: Number(row.strike),
    optionType: row.option_type || row.optionType,
    lotSize: num(row.lot_size ?? row.lotSize),
    tickP: Math.round(Number(row.tick_size ?? row.tickSize ?? 0.05) * 100) || 5,
    ltpP,
    bidP,
    askP,
    // A spread needs BOTH sides. One-sided is not a narrow spread, it is an
    // unknown one.
    spreadP: (bidP != null && askP != null) ? askP - bidP : null,
    bidQty: num(q.bidQty),
    askQty: num(q.askQty),
    oi: num(q.oi),
    volume: num(q.volume),
  };
}

// Every gate doc/new.md lists, in the order it lists them. Returns the per-check
// results plus a verdict that already accounts for `liquidityMode`.
function gate(m, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const strict = String(c.liquidityMode).toUpperCase() === 'STRICT';

  const checks = {
    // The premium band is NOT subject to liquidityMode. It is priced off the
    // last traded price, which every account gets, so an absent premium means
    // the strike has not traded at all today — and an untraded strike is
    // exactly what the liquidity filter exists to refuse.
    premium: check(m.ltpP,
      (v) => v >= c.premiumMinP && v <= c.premiumMaxP,
      (v) => `the premium ${(v / 100).toFixed(2)} is outside `
        + `${(c.premiumMinP / 100).toFixed(2)}–${(c.premiumMaxP / 100).toFixed(2)}`),

    openInterest: check(m.oi,
      (v) => v >= c.minOpenInterest,
      (v) => `open interest ${v.toLocaleString('en-IN')} is under ${c.minOpenInterest.toLocaleString('en-IN')}`),

    volume: check(m.volume,
      (v) => v >= c.minVolume,
      (v) => `volume ${v.toLocaleString('en-IN')} is under ${c.minVolume.toLocaleString('en-IN')}`),

    bidQty: check(m.bidQty,
      (v) => v > c.minBidQty,
      (v) => `only ${v} on the bid, ${c.minBidQty} required`),

    askQty: check(m.askQty,
      (v) => v > c.minAskQty,
      (v) => `only ${v} on the ask, ${c.minAskQty} required`),

    spread: check(m.spreadP,
      (v) => v >= 0 && v <= c.maxSpreadP,
      (v) => `the bid-ask spread ${(v / 100).toFixed(2)} is over ${(c.maxSpreadP / 100).toFixed(2)}`),
  };

  // A quote with no last price at all is a frozen contract, whatever mode is
  // set. "Reject contracts with frozen quotes" — doc/new.md.
  if (checks.premium.result === UNKNOWN) {
    return {
      checks, ok: false, unavailable: [],
      reason: 'the broker sends no last traded price for this strike — it has not traded',
    };
  }

  const failed = Object.entries(checks).filter(([, r]) => r.result === FAIL);
  const unavailable = Object.entries(checks)
    .filter(([, r]) => r.result === UNKNOWN).map(([name]) => name);

  if (failed.length) {
    return { checks, ok: false, unavailable, reason: failed[0][1].reason };
  }
  if (strict && unavailable.length) {
    return {
      checks, ok: false, unavailable,
      reason: `liquidityMode is STRICT and the broker sends no ${unavailable.join(', ')} `
        + 'for this account — no contract can clear the filter',
    };
  }
  return { checks, ok: true, unavailable, reason: null };
}

/* ------------------------------------------------------------------ rank -- */

// The document's ranking score:
//
//     Score = Liquidity + OI + Volume + Spread + Premium
//
// Each term is worth 20, for 100. Four of the five are RELATIVE to the rest of
// this scan rather than absolute — "rank the remaining contracts" is a
// comparison, and an absolute scale would need a ceiling for open interest that
// is different on every expiry and every index.
//
// The premium term is the exception: it is absolute, because the document names
// an ideal band (₹15–₹25) and that band is the point. A strike inside it scores
// full marks; outside it the score falls off linearly to the edge of the
// accepted band.
//
// A term nobody in the scan has data for is DROPPED and the total is rescaled
// over the terms that survive, so a `ltp`-only account still gets a meaningful
// ranking out of the premium term alone rather than every contract scoring 20.
// `componentsUsed` says which ones counted.
function premiumScore(ltpP, c) {
  if (ltpP == null) return null;
  if (ltpP >= c.premiumIdealMinP && ltpP <= c.premiumIdealMaxP) return 1;
  if (ltpP < c.premiumIdealMinP) {
    const span = c.premiumIdealMinP - c.premiumMinP;
    if (span <= 0) return 0;
    return Math.max(0, (ltpP - c.premiumMinP) / span);
  }
  const span = c.premiumMaxP - c.premiumIdealMaxP;
  if (span <= 0) return 0;
  return Math.max(0, (c.premiumMaxP - ltpP) / span);
}

// Bigger is better, scaled against the best in the scan.
function relativeHigh(value, best) {
  if (value == null || best == null || best <= 0) return null;
  return Math.max(0, Math.min(1, value / best));
}

// Smaller is better. A zero spread scores 1; the configured maximum scores 0.
function spreadScore(spreadP, c) {
  if (spreadP == null) return null;
  if (c.maxSpreadP <= 0) return spreadP <= 0 ? 1 : 0;
  return Math.max(0, Math.min(1, 1 - spreadP / c.maxSpreadP));
}

function rank(passing, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const w = { ...DEFAULTS.weights, ...(cfg.weights || {}) };

  const bestOi = passing.reduce((b, m) => (m.oi == null ? b : Math.max(b ?? 0, m.oi)), null);
  const bestVol = passing.reduce((b, m) => (m.volume == null ? b : Math.max(b ?? 0, m.volume)), null);
  const bestDepth = passing.reduce((b, m) => {
    const d = (m.bidQty == null || m.askQty == null) ? null : Math.min(m.bidQty, m.askQty);
    return d == null ? b : Math.max(b ?? 0, d);
  }, null);

  return passing.map((m) => {
    const depth = (m.bidQty == null || m.askQty == null) ? null : Math.min(m.bidQty, m.askQty);
    const parts = {
      // "Liquidity" in the document's list is the tradable size at the touch —
      // the thing that decides whether an order gets filled at all. The thinner
      // side is what matters, so the two quantities are combined with min()
      // rather than added: 500 on the bid and 5 on the ask is not liquid.
      liquidity: relativeHigh(depth, bestDepth),
      oi: relativeHigh(m.oi, bestOi),
      volume: relativeHigh(m.volume, bestVol),
      spread: spreadScore(m.spreadP, c),
      premium: premiumScore(m.ltpP, c),
    };

    const weights = {
      liquidity: w.depth, oi: w.oi, volume: w.volume, spread: w.spread, premium: w.premium,
    };
    let earned = 0;
    let available = 0;
    const used = [];
    for (const [name, value] of Object.entries(parts)) {
      const weight = Number(weights[name]) || 0;
      if (value === null || weight <= 0) continue;
      earned += value * weight;
      available += weight;
      used.push(name);
    }

    return {
      ...m,
      score: available > 0 ? Math.round((earned / available) * 10000) / 100 : 0,
      parts,
      componentsUsed: used,
    };
  }).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // A tie breaks toward the FURTHER strike: further out of the money is the
    // safer of two contracts the score likes equally. Same rule the scalper's
    // selector uses, for the same reason.
    return a.optionType === 'CE' ? b.strike - a.strike : a.strike - b.strike;
  });
}

/* ---------------------------------------------------------------- select -- */

// The whole of Module 2 in one call.
//
//   `contracts` — [{ row, quote }] for ONE option type, already restricted to
//                 the ladder the engine chose to quote.
//
// Returns the winner, the full ranked list (for the audit trail — "why this
// strike" is the question a post-mortem always asks first), and every rejection
// with its reason.
function select(contracts, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };

  const measured = (contracts || [])
    .filter(x => x && x.row)
    .map(x => ({ m: measure(x.row, x.quote), g: null }));

  for (const item of measured) item.g = gate(item.m, c);

  const passing = measured.filter(x => x.g.ok).map(x => ({ ...x.m, unavailable: x.g.unavailable }));
  const rejected = measured.filter(x => !x.g.ok).map(x => ({
    token: x.m.token, symbol: x.m.symbol, strike: x.m.strike,
    ltpP: x.m.ltpP, reason: x.g.reason,
  }));

  // What the broker never sent for ANY strike in this scan. Reported once,
  // here, rather than as a rejection reason repeated forty times.
  const fields = ['openInterest', 'volume', 'bidQty', 'askQty', 'spread'];
  const unavailable = fields.filter(f =>
    measured.length > 0 && measured.every(x => x.g.checks[f]?.result === UNKNOWN));

  if (!passing.length) {
    return {
      chosen: null,
      ranked: [],
      rejected,
      unavailable,
      reason: measured.length
        ? `no strike cleared the filters (${rejected.length} rejected; `
          + `first: ${rejected[0]?.reason})`
        : 'no contracts were quoted',
    };
  }

  const ranked = rank(passing, c);
  return {
    chosen: ranked[0],
    ranked,
    rejected,
    unavailable,
    reason: null,
  };
}

module.exports = {
  MODES, DEFAULTS, PASS, FAIL, UNKNOWN,
  measure, gate, rank, select, premiumScore, spreadScore,
};
