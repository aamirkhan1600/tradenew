// §8.4 — option chain validation.
//
// PURE. The fetching, caching and deduplication of §8.3 are I/O and live in the
// engine; this is the part that decides whether what came back is evidence.
//
// ---------------------------------------------------------------------------
// Absent is not zero, and absent is not invalid
// ---------------------------------------------------------------------------
//
// §8.4 lists `bid <= 0 || ask <= 0` as a discard. Taken at face value against a
// broker that sends no book at all, that discards every quote, trips
// CHAIN_CORRUPT on every cycle and the engine never trades.
//
// So this module distinguishes three states per field, not two:
//
//     PRESENT and valid     evidence
//     PRESENT and invalid   a discard, in every mode
//     ABSENT                the broker sent no such field
//
// and `liquidityMode` decides what ABSENT means. STRICT reads §8.4 literally and
// discards; LENIENT keeps the quote and records the field as unmeasurable so
// §9.2 can skip that check and say it skipped it. What neither mode does is
// coerce absence to zero — see the header of src/ose/constants.js.
//
// Prices in: integer paise. Quotes arrive from `neoClient.readQuoteFull` in
// RUPEES with anything the broker did not send as null, so normalisation happens
// here, once.

const C = require('./constants');

// Absent-aware read. The single most important line in this file.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const paise = (rupees) => (rupees == null ? null : Math.round(Number(rupees) * 100));

const DISCARD = {
  NO_LTP: 'no last traded price — the strike has not traded',
  BAD_LTP: 'the last traded price is zero or negative',
  NO_BOOK: 'the broker sends no bid or ask for this account',
  BAD_BOOK: 'the bid or ask is zero or negative',
  CROSSED: 'the ask is below the bid — a crossed book',
  BAD_COUNTS: 'open interest or volume is negative',
  NO_EXPIRY: 'the expiry is missing or unparseable',
  BAD_STRIKE: `the strike is not a multiple of ${C.STRIKE_MULTIPLE}`,
  STALE: 'the snapshot is older than the maximum quote age',
};

// One instrument-master row plus whatever the broker answered with, normalised
// into the §6.1 `OptionQuote` shape. `snapshotTs` is when the chain was fetched,
// not when the tick was printed — §8.4's staleness rule is about the snapshot.
//
// Returns `{ quote, discard }`. Exactly one of the two is null.
function normalise(row, rawQuote, { snapshotTs, nowMs, liquidityMode = 'STRICT' } = {}) {
  const strict = String(liquidityMode).toUpperCase() === 'STRICT';
  const q = rawQuote || {};

  const drop = (reason) => ({ quote: null, discard: reason });

  // Staleness first: nothing else about an old snapshot is worth checking.
  if (Number.isFinite(snapshotTs) && Number.isFinite(nowMs)
    && nowMs - snapshotTs > C.CHAIN_MAX_AGE_MS) {
    return drop(DISCARD.STALE);
  }

  const expiry = String(row.expiry_date ?? row.expiryDate ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return drop(DISCARD.NO_EXPIRY);

  const strike = Number(row.strike);
  if (!Number.isFinite(strike) || strike <= 0 || strike % C.STRIKE_MULTIPLE !== 0) {
    return drop(DISCARD.BAD_STRIKE);
  }

  const ltpP = paise(num(q.ltp));
  if (ltpP === null) return drop(DISCARD.NO_LTP);
  if (ltpP <= 0) return drop(DISCARD.BAD_LTP);

  const bidP = paise(num(q.bid));
  const askP = paise(num(q.ask));

  // Present-and-invalid is a discard in both modes: a quoted zero bid is a
  // statement about the book, and it is a statement that this contract cannot
  // be got out of.
  if ((bidP !== null && bidP <= 0) || (askP !== null && askP <= 0)) return drop(DISCARD.BAD_BOOK);
  if (bidP !== null && askP !== null && askP < bidP) return drop(DISCARD.CROSSED);
  if (strict && (bidP === null || askP === null)) return drop(DISCARD.NO_BOOK);

  const oi = num(q.oi);
  const volume = num(q.volume);
  if ((oi !== null && oi < 0) || (volume !== null && volume < 0)) return drop(DISCARD.BAD_COUNTS);

  const lotSize = num(row.lot_size ?? row.lotSize);
  const tickP = Math.round(Number(row.tick_size ?? row.tickSize ?? 0.05) * 100) || C.TICK;

  return {
    discard: null,
    quote: {
      token: String(row.token),
      segment: row.segment || 'nse_fo',
      symbol: row.symbol,
      strike,
      optionType: row.option_type ?? row.optionType,
      expiry,
      lotSize,
      tickP,
      ltpP,
      bidP,
      askP,
      // A spread needs BOTH sides. One-sided is not a narrow spread, it is an
      // unknown one, and §9.2 filters 7 and 8 must be able to tell them apart.
      spreadP: (bidP !== null && askP !== null) ? askP - bidP : null,
      midP: (bidP !== null && askP !== null) ? (bidP + askP) / 2 : null,
      bidQty: num(q.bidQty),
      askQty: num(q.askQty),
      oi,
      volume,
      snapshotTs: snapshotTs ?? null,
    },
  };
}

// §8.4 — "If more than 40% of quotes are discarded, the whole snapshot is
// rejected as CHAIN_CORRUPT."
//
// `rows` is `[{ row, quote }]` for the strikes the engine chose to quote.
// Returns the surviving quotes, every discard with its reason, and the corrupt
// verdict. The engine turns `corrupt` into `NO_ENTRY(CHAIN_CORRUPT)`.
function validateSnapshot(rows, { snapshotTs, nowMs, liquidityMode = 'STRICT' } = {}) {
  const quotes = [];
  const discarded = [];

  for (const item of rows || []) {
    if (!item || !item.row) continue;
    const { quote, discard } = normalise(item.row, item.quote,
      { snapshotTs, nowMs, liquidityMode });
    if (quote) quotes.push(quote);
    else {
      discarded.push({
        token: String(item.row.token),
        symbol: item.row.symbol,
        strike: Number(item.row.strike),
        reason: discard,
      });
    }
  }

  const considered = quotes.length + discarded.length;
  const discardRate = considered ? discarded.length / considered : 0;
  const corrupt = considered > 0 && discardRate > C.CHAIN_CORRUPT_PCT;

  // Which discard reason accounts for the corruption. On an `ltp`-only account
  // in STRICT mode this is NO_BOOK on every row, and saying so once is the
  // difference between "the market offered nothing" and "this account can never
  // pass the filter" — the most expensive ambiguity this platform can have.
  const tally = new Map();
  for (const d of discarded) tally.set(d.reason, (tally.get(d.reason) || 0) + 1);
  const dominant = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] || null;

  return {
    quotes,
    discarded,
    considered,
    discardRate,
    corrupt,
    dominantDiscard: dominant ? { reason: dominant[0], count: dominant[1] } : null,
    reason: corrupt
      ? `${discarded.length} of ${considered} quotes were discarded `
        + `(${Math.round(discardRate * 100)}%, over the ${Math.round(C.CHAIN_CORRUPT_PCT * 100)}% `
        + `limit) — mostly: ${dominant ? dominant[0] : 'mixed'}`
      : null,
  };
}

// §8.2 — nearest expiry with `expiryDate >= today`, and whether that expiry is
// today. `[MUST-CONFIRM #7]` governs whether an expiry-day session may trade at
// all; this only reports the fact so the caller can act on the setting.
function selectExpiry(expiries, todayIso) {
  const ahead = (expiries || [])
    .map(e => String(e).slice(0, 10))
    .filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e) && e >= todayIso)
    .sort();
  const expiry = ahead[0] || null;
  return { expiry, isExpiryDay: expiry != null && expiry === todayIso };
}

module.exports = { DISCARD, normalise, validateSnapshot, selectExpiry };
