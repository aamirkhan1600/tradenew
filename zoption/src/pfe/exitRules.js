// Modules 5, 6, 8, 9 and 10 of doc/new.md — pricing, the target ladder, the
// trailing stop and every reason to be flat.
//
// PURE arithmetic and predicates. Nothing here reads a clock, a socket or a
// database; the engine passes in the numbers and executes what comes back.
//
// Prices in: integer paise.

/* --------------------------------------------------------------- pricing -- */

// Module 5. THE entry price: a completed candle OF THE OPTION CONTRACT plus a
// configured offset.
//
//     "Never use live ask price, live LTP, partial candle values."
//
// Two arguments, and no quote object is reachable from this function. That is
// the same structural guarantee `src/strategy/legMachine.calculateSellPrice`
// makes for the scalper, and test/pfeExitRules.test.js asserts it here too.
function calculateSellPrice(candle, sellOffsetPaise) {
  if (!candle || !Number.isFinite(candle.closeP)) {
    throw new Error('calculateSellPrice needs a completed option candle');
  }
  if (candle.tradable === false) {
    throw new Error('calculateSellPrice refuses a bar that measured nothing');
  }
  return candle.closeP + Math.round(sellOffsetPaise);
}

// Module 6. Priced off what actually FILLED, not off what was asked for: a limit
// that filled better should keep the improvement, and one that filled worse
// should not have its target quietly moved to compensate.
//
//     SELL 20.00  ->  target 19.00 (1 point)  stop 22.00 (2 points)
function calculateTargetPrice(filledPriceP, targetPaise) {
  return Math.max(5, filledPriceP - Math.round(targetPaise));
}

function calculateStopPrice(filledPriceP, stopLossPaise) {
  return filledPriceP + Math.round(stopLossPaise);
}

/* -------------------------------------------------- Module 8, the ladder -- */

// | Confirmation | Target |
// |--------------|--------|
// | Entry        | 1 point|
// | First        | 2      |
// | Second       | 3      |
// | Third        | 4      |
// | Fourth+      | Trail until exit |
//
// A "confirmation" is a completed index candle whose price position filter still
// permits the side the position is on — see priceFilter.isConfirmation. It is
// NOT a profit threshold: the target extends because the move is still running,
// which is the whole idea.
//
// Returns null past the top of the ladder, meaning "withdraw the resting target
// and run on the trail alone".
function ladderTarget(filledPriceP, confirmations, targetPaise, stepPaise, maxSteps) {
  const n = Math.max(0, Math.trunc(confirmations || 0));
  if (n >= Math.trunc(maxSteps)) return null;              // trail-only
  return Math.max(5, filledPriceP - Math.round(targetPaise) - n * Math.round(stepPaise));
}

/* ---------------------------------------------- Module 9, the trail ------- */

// The position is SHORT, so "better" means LOWER. `bestPaise` is the cheapest
// the premium has been since the fill, and the stop sits a gap above it:
//
//     stop = best + gap
//
// The document's worked example tightens that gap as the trade runs:
//
//     entry 20.00, initial stop 22.00
//     best 19.20  ->  20.20     (gap 1.00)
//     best 18.50  ->  19.30     (gap 0.80)
//     best 17.80  ->  18.40     (gap 0.60)
//
// so `gap` starts at `trailGapPaise` and shrinks by `tightenPaise` on every
// trail that actually moves the stop, down to a floor of `minGapPaise`. With
// the shipped defaults (1.00 / 0.20 / 0.40) this reproduces those three numbers
// exactly; `tightenPaise: 0` gives a plain fixed-gap trail instead.
//
// Two guards, and both are load-bearing:
//
//   * the trail does not engage until the position is `trailStartPaise` in
//     profit. Without it the first tick clamps the stop to a hair above the
//     entry and ordinary noise takes the trade out.
//   * IT NEVER MOVES AWAY FROM PROFIT. "Stop Loss Never Moves Backward" — a
//     stop that can widen is not a stop, and the refusal is here rather than in
//     the caller so no call site can forget it.
//
// Returns null when nothing should move.
function trailStop({
  filledPriceP, bestPaise, currentStopP,
  trailStartPaise = 0, trailGapPaise = 0, tightenPaise = 0, minGapPaise = 0, trails = 0,
}) {
  if (!trailGapPaise) return null;                          // trailing disabled
  if (!Number.isFinite(bestPaise) || !Number.isFinite(currentStopP)) return null;

  const profit = filledPriceP - bestPaise;
  if (profit < Math.round(trailStartPaise)) return null;    // not far enough yet

  const shrunk = Math.round(trailGapPaise) - Math.trunc(trails) * Math.round(tightenPaise);
  const gap = Math.max(Math.round(minGapPaise), shrunk);

  const candidate = bestPaise + gap;
  if (candidate >= currentStopP) return null;               // would widen — refuse
  return Math.max(5, candidate);
}

/* ------------------------------------------- Module 10, the exit reasons -- */

const EXIT_REASONS = {
  TARGET: 'TARGET',
  STOPLOSS: 'STOPLOSS',            // the trailing stop was hit
  FILTER_FAIL: 'FILTER_FAIL',      // the live price position filter turned
  TREND_BREAK: 'TREND_BREAK',      // the 3-candle structure no longer holds
  PREMIUM_SAFETY: 'PREMIUM_SAFETY', // premium ran against us by the safety margin
  LIQUIDITY: 'LIQUIDITY',          // the book went away underneath us
  MAX_HOLD: 'MAX_HOLD',            // 60–90 seconds
  SQUAREOFF: 'SQUAREOFF',          // 15:20
  HALT: 'HALT',                    // a risk limit stopped the day
  NO_ENTRY: 'NO_ENTRY',            // never opened — the arm expired
};

// "Exit if option premium increases against the position by 2 points, even if
// the trend filter has not yet failed."
//
// Measured from the FILL, not from the best price — it is a hard ceiling on how
// far a single trade may go wrong, and measuring it from the running best would
// make it a second, looser trailing stop instead.
function premiumSafetyBreached(filledPriceP, ltpPaise, marginPaise) {
  if (!marginPaise) return false;
  if (!Number.isFinite(ltpPaise) || !Number.isFinite(filledPriceP)) return false;
  return ltpPaise - filledPriceP >= Math.round(marginPaise);
}

// "Exit immediately if the bid disappears, the spread exceeds ₹0.50, or volume
// collapses."
//
// Same three-outcome discipline as the scanner: a field the broker never sends
// cannot be evidence that liquidity has gone. On an `ltp`-only account this
// returns `{ broken: false, blind: true }` on every call, and the caller says so
// once rather than pretending the check ran.
//
// `entryVolume` is the traded volume observed when the position opened; a
// collapse is measured against that rather than against an absolute floor,
// because "volume collapsed" is a statement about this contract's own day.
function liquidityBroken(quote, {
  exitSpreadPaise = 0, minBidQty = 0, volumeCollapsePct = 0, entryVolume = null,
} = {}) {
  const q = quote || {};
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const bid = num(q.bid);
  const ask = num(q.ask);
  const bidQty = num(q.bidQty);
  const volume = num(q.volume);

  const measured = [];

  // "Bid disappears" needs care, because `neoClient.readQuoteFull` normalises a
  // zero or negative price to NULL — a bid of 0 and a broker that sends no bid
  // column arrive here identically. They are told apart by the ASK: if the
  // broker is sending a book at all, a missing bid inside it means the bid side
  // is empty. On an `ltp`-only account neither side arrives, nothing is
  // inferred, and the check reports itself blind instead of firing.
  if (bid !== null) {
    measured.push('bid');
    if (bid <= 0) return { broken: true, reason: 'the bid has disappeared', blind: false };
  } else if (ask !== null) {
    measured.push('bid');
    return { broken: true, reason: 'there is no bid — the book has emptied on the buy side', blind: false };
  }
  if (bidQty !== null) {
    measured.push('bidQty');
    if (minBidQty > 0 && bidQty <= 0) {
      return { broken: true, reason: 'there is nothing left on the bid', blind: false };
    }
  }
  if (bid !== null && ask !== null && exitSpreadPaise > 0) {
    measured.push('spread');
    const spreadP = Math.round((ask - bid) * 100);
    if (spreadP > exitSpreadPaise) {
      return {
        broken: true, blind: false,
        reason: `the spread has widened to ${(spreadP / 100).toFixed(2)}, over `
          + `${(exitSpreadPaise / 100).toFixed(2)}`,
      };
    }
  }
  if (volume !== null && entryVolume !== null && volumeCollapsePct > 0) {
    measured.push('volume');
    // Volume is cumulative through the day, so it cannot fall. A "collapse" is
    // therefore the absence of NEW volume: the contract has stopped trading.
    // Expressed as a share of what it had already done by the time we entered.
    if (entryVolume > 0 && volume - entryVolume <= 0
      && volumeCollapsePct >= 100) {
      return { broken: true, reason: 'the contract has stopped trading', blind: false };
    }
  }

  return { broken: false, reason: null, blind: measured.length === 0 };
}

// Module 10's maximum holding time, and Module 1's force exit.
function heldTooLong(openedAtMs, nowMs, maxHoldMs) {
  if (!maxHoldMs) return false;
  if (!openedAtMs) return false;
  return nowMs - openedAtMs >= maxHoldMs;
}

// Module 11 — "wait for a minimum of 2 completed candles" after an exit.
// Counted in CANDLES, not seconds, so the wait means the same thing whatever
// the timeframe is set to.
function reentryAllowed(candlesSinceExit, requiredCandles) {
  return Math.trunc(candlesSinceExit || 0) >= Math.trunc(requiredCandles || 0);
}

module.exports = {
  EXIT_REASONS,
  calculateSellPrice, calculateTargetPrice, calculateStopPrice,
  ladderTarget, trailStop,
  premiumSafetyBreached, liquidityBroken, heldTooLong, reentryAllowed,
};
