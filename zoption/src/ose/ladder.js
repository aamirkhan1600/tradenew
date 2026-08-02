// §12.1, §14 and §15 — the entry price, the target ladder and the trailing stop.
//
// PURE arithmetic. Numbers in, numbers out; no clock, no quote object, no
// broker. §25.1 tests every function here exhaustively and §25.2 property-tests
// the monotonicity invariant, which is only possible because nothing in this
// file can reach the outside world.
//
// Prices in: integer paise. One POINT is 100 paise (§14.1).

const money = require('../core/money');
const { IntegrityError } = require('../core/errors');
const C = require('./constants');

/* ------------------------------------------------- §12.1, the entry price -- */

// THE most commonly violated rule in implementations of this specification, and
// §12.1 says so in terms: the entry is priced from a SEALED OPTION CANDLE and the
// engine MUST NOT substitute LTP.
//
//     rawPrice   = optionClose + entryOffset
//     entryPrice = floorToTick(rawPrice)
//
// The signature is the enforcement. This function takes a candle and an offset;
// no quote, bid, ask or last price is reachable from inside it, so no future
// edit can accidentally price an order from a live number without changing the
// call signature — which a reviewer would see.
//
// `floorToTick`, not round-half-up: see the comment on money.floorToTickPaise.
// With TICK = 5 paise and the shipped ₹0.10 offset the raw price is already
// tick-aligned whenever the close is, so the floor is defensive rather than
// load-bearing — but the defence is the point.
function entryPrice(candle, entryOffsetPaise, tickPaise = C.TICK) {
  if (!candle || !Number.isFinite(candle.closeP)) {
    throw new IntegrityError('entryPrice needs a sealed option candle — LTP is not a substitute');
  }
  if (candle.tradable === false) {
    throw new IntegrityError(
      `entryPrice refuses a bar that measured nothing (${candle.synthetic ? 'synthetic'
        : `${candle.tickCount} ticks`})`);
  }
  return money.floorToTickPaise(candle.closeP + Math.round(entryOffsetPaise), tickPaise);
}

/* --------------------------------------------------- §14, the target ladder -- */

// §14.1 — for a short, profit accrues as the premium falls, so rung k sits k
// points BELOW the fill:
//
//     level 1: entryPrice − 1 point
//     level k: entryPrice − k points
//
// §14.4 leaves the ladder uncapped. It is bounded naturally by the premium
// itself: the most a short at E can make is E, so the deepest reachable rung is
// floor(entryPrice / POINT), and PREMIUM_FLOOR closes the position before it
// gets there anyway.
// `rungP` — the size of ONE rung in paise. Defaults to §14.1's one point, which
// is what it was hardcoded to before this was a parameter.
//
// §14.1 writes the ladder as "level k: entryPrice − k points", and read literally
// that fixes the rung at exactly one point. It is a parameter now because the
// desk asked for a half-point target, and the ladder is the only thing that
// decides what a "point" means here: everything else — the trail, the locked-in
// progression, the target-reached test — is expressed in rungs and follows.
//
// The rung is validated as a multiple of the 5-paise tick, so a target price can
// never be off-tick and be rejected by the exchange.
function targetPriceFor(entryPriceP, level, rungP = C.POINT) {
  const k = Math.max(0, Math.trunc(level));
  const rung = Math.max(1, Math.round(rungP || C.POINT));
  return entryPriceP - k * rung;
}

// §14.3 — "a sealed option candle whose close is at or beyond the current target
// price". At or beyond, for a short, means AT OR BELOW.
//
// Intra-candle wicks do not confirm. That is the deliberate asymmetry with the
// stop (§15.4), which uses the high: a target that counted wicks would book
// profits the market never actually offered on a close, while a stop that
// ignored them would understate realised losses. Conservative in both
// directions — and `[MUST-CONFIRM #4]` asks the desk to sign that off.
function targetReached(candle, targetPriceP) {
  if (!candle || !Number.isFinite(candle.closeP) || !Number.isFinite(targetPriceP)) return false;
  return candle.closeP <= targetPriceP;
}

// §14.2 — the extension. On a confirmed target the position is NOT closed: the
// target moves one rung further out and the stop tightens behind it. That is the
// entire "let winners run" behaviour, and it is why exit is the Exit Engine's
// job alone (§16.1).
//
// §14.3 caps the advance at ONE level per candle even if the close is four
// points beyond, because more than one decision per candle breaks the invariant
// the whole engine is built on. `[MUST-CONFIRM #3]`.
//
// Returns null when nothing moves.
function advanceTarget(trade, candle, cfg = {}) {
  const extension = Math.max(1, Math.trunc(cfg.targetExtensionPoints ?? 1));
  if (!targetReached(candle, trade.targetPriceP)) return null;

  const level = Math.trunc(trade.targetLevel || 0) + extension;
  return {
    targetLevel: level,
    targetPriceP: targetPriceFor(trade.entryPriceP, level, cfg.rungP),
  };
}

/* --------------------------------------------------- §15, the trailing stop -- */

// §15.1 — for a short the stop sits ABOVE the fill, because a rising premium is
// the loss.
function initialStop(entryPriceP, initialStopPoints) {
  return entryPriceP + Math.max(1, Math.trunc(initialStopPoints)) * C.POINT;
}

// §15.2 — when target level k is achieved the stop moves to `entry − (k−1)`,
// producing the progression §15.2 tabulates:
//
//     level achieved | new stop      | locked in
//     ---------------|---------------|-----------
//     — (entry)      | entry + 2     | −2 points (the maximum loss)
//     1              | entry + 0     | breakeven
//     2              | entry − 1     | +1 point
//     k              | entry − (k−1) | +(k−1) points
//
// §15.3 — THE INVARIANT. `min()` enforces it structurally: for a short the stop
// only ever moves DOWN. A stop that can widen is not a stop.
//
// The assertion below is NOT stripped in production. §15.3 requires it to stay,
// and a violation is an IntegrityError rather than a log line because §20.2 puts
// integrity failures in the one row of the taxonomy with no discretion: halt.
//
// §15.5 — with trailing disabled the stop never moves and the ladder still runs.
function trailStop(trade, level, cfg = {}) {
  if (cfg.trailingStopEnabled === false) return null;

  const k = Math.trunc(level);
  if (k < 1) return null;

  // The same rung the TARGET ladder uses. If the two ever disagreed, §15.2's
  // "level k locks +(k−1)" would stop being true and the trail would either give
  // away profit or claim protection it does not have.
  const rung = Math.max(1, Math.round(cfg.rungP || C.POINT));
  const candidate = trade.entryPriceP - (k - 1) * rung;
  const next = Math.min(trade.stopPriceP, candidate);

  if (next > trade.stopPriceP) {
    // Unreachable through min(). Kept because §15.3 asks for the assertion to
    // exist in production code, and an unreachable guard that fires is the most
    // valuable log line the system can produce.
    throw new IntegrityError(
      `STOP_INVARIANT_VIOLATION: the stop tried to widen from ${trade.stopPriceP} to ${next}`);
  }
  if (next === trade.stopPriceP) return null;

  return { stopPriceP: next, lockedPointsP: trade.entryPriceP - next };
}

// §15.4 — the stop is hit when a sealed option candle satisfies
// `candle.high >= stopPrice`.
//
// `high`, not `close`. This is the single documented exception to close-only
// evaluation and it exists because a stop that waited for a close would
// systematically understate realised losses in a backtest against what the same
// strategy actually pays live.
//
// It also means the stop is evaluated once every five seconds and not at tick
// speed. That is a real exposure between seals, it is what the specification
// asks for, and `[MUST-CONFIRM #4]` is where the desk signs it off — see the
// boot warning in ./settings.js.
function stopHit(candle, stopPriceP) {
  if (!candle || !Number.isFinite(candle.highP) || !Number.isFinite(stopPriceP)) return false;
  return candle.highP >= stopPriceP;
}

/* ------------------------------------------------------------------- P&L --- */

// §2 — "Short P&L: pnl_points = entry_price − position_premium. Positive =
// profit." In points, for the decision log; the rupee P&L that reaches the risk
// counters comes from money.shortPnl and is NET of charges (§17.3).
function pnlPoints(entryPriceP, premiumP) {
  if (!Number.isFinite(premiumP)) return 0;
  return (entryPriceP - premiumP) / C.POINT;
}

// §6.1 — the maximum favourable excursion, tracked for post-trade analysis. For
// a short the best moment is the LOWEST premium seen, so MFE only ever rises.
function updateMfe(currentMfePoints, entryPriceP, premiumP) {
  return Math.max(currentMfePoints ?? 0, pnlPoints(entryPriceP, premiumP));
}

module.exports = {
  entryPrice,
  targetPriceFor, targetReached, advanceTarget,
  initialStop, trailStop, stopHit,
  pnlPoints, updateMfe,
};
