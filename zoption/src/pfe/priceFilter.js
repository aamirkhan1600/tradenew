// Modules 4, 7 and 10 of doc/new.md — the Live Price Position Filter.
//
// The single decision framework the document builds everything else on:
//
//     Bullish Mid = (Open + High) / 2
//     Bearish Mid = (Open + Low)  / 2
//
// of the LATEST COMPLETED index candle, against the CURRENT index price.
//
//     SELL PE   allowed while   price >  bullish mid
//     SELL CE   allowed while   price <  bearish mid
//
// The same two lines answer four questions: may a trade be entered (Module 4),
// does an open trade remain valid (Module 7), should the target be extended
// (Module 8, via a confirmation) and should the position be closed immediately
// (Module 10). One rule, four uses — which is why it is one file with one
// implementation and no per-caller variants.
//
// ---------------------------------------------------------------------------
// PURE, and it returns a VERDICT, never a price
// ---------------------------------------------------------------------------
//
// The mids are computed from an INDEX candle. The SELL price comes from the
// OPTION contract's own closed candle plus an offset (Module 5) and nothing
// here can reach it. The state machine is handed booleans.
//
// ---------------------------------------------------------------------------
// Why entry is strict and the exit is not
// ---------------------------------------------------------------------------
//
// Module 4 permits an entry when `price > mid`. Module 10 exits when
// `price <= mid`. They are exact complements on purpose: a price sitting
// EXACTLY on the mid is not evidence for the trade, so it does not open one —
// and it is not evidence against one either, but the document names `≤` as an
// exit and an ambiguity resolved toward flat is the cheap direction to be wrong
// in on a naked short.
//
// Prices in: integer paise, index and option alike.

// A candle with no range at all — a flat print across the whole bucket — makes
// both mids equal the close, so `price > mid` and `price < mid` are both false
// and no side may trade. That is the right answer and it needs no special case.
function mids(candle) {
  if (!candle || !Number.isFinite(candle.openP)) {
    throw new Error('the price position filter needs a completed candle');
  }
  return {
    // Halved in paise, then rounded: a mid that lands on half a paise is not a
    // price, and rounding once here beats every caller rounding differently.
    bullishMidP: Math.round((candle.openP + candle.highP) / 2),
    bearishMidP: Math.round((candle.openP + candle.lowP) / 2),
    bucketStart: candle.bucketStart ?? null,
    bucketEnd: candle.bucketEnd ?? null,
  };
}

const fmt = (paise) => (paise / 100).toFixed(2);

// Module 4 — may either side be sold right now?
//
// `spotP` is the CURRENT index price in paise, not the candle's close. The
// distinction matters: the filter compares live price against a level derived
// from a completed bar, so it re-answers on every tick even though the level
// only moves once a bar.
function entryVerdict({ candle, spotP }) {
  const m = mids(candle);

  if (!Number.isFinite(spotP)) {
    return {
      ...m, allowCE: false, allowPE: false,
      reason: 'no index price to compare against the mid',
    };
  }

  const allowPE = spotP > m.bullishMidP;
  const allowCE = spotP < m.bearishMidP;

  return {
    ...m,
    spotP,
    allowCE,
    allowPE,
    reason: allowPE || allowCE
      ? null
      : `the index at ${fmt(spotP)} sits between the bearish mid ${fmt(m.bearishMidP)} `
        + `and the bullish mid ${fmt(m.bullishMidP)} — neither side is permitted`,
  };
}

// Module 7 — may an OPEN position stay open?
//
// Returns `{ ok, reason }`. `ok: false` is Module 10's "Position Filter Fails",
// which is an immediate exit and not a stop-loss: it usually fires in profit.
function holdVerdict({ candle, spotP, optionType }) {
  const m = mids(candle);

  if (!Number.isFinite(spotP)) {
    // No price is not evidence of a failed filter. An absence of information
    // must never close a live short — the trailing stop and the maximum hold
    // are what protect the position while the feed is quiet.
    return { ...m, ok: true, undecided: true, reason: 'no index price — holding' };
  }

  if (optionType === 'PE') {
    const ok = spotP > m.bullishMidP;
    return {
      ...m, spotP, ok, undecided: false,
      reason: ok ? null
        : `the index at ${fmt(spotP)} has fallen to or below the bullish mid ${fmt(m.bullishMidP)}`,
    };
  }

  const ok = spotP < m.bearishMidP;
  return {
    ...m, spotP, ok, undecided: false,
    reason: ok ? null
      : `the index at ${fmt(spotP)} has risen to or above the bearish mid ${fmt(m.bearishMidP)}`,
  };
}

// Module 8's confirmation. A completed candle whose filter still permits the
// side the position is on is a confirmation — and that, not a profit threshold,
// is what pushes the target one rung further out.
function isConfirmation({ candle, spotP, optionType }) {
  const v = holdVerdict({ candle, spotP, optionType });
  return v.ok && !v.undecided;
}

module.exports = { mids, entryVerdict, holdVerdict, isConfirmation };
