// §16 — the Exit Engine's decision half, and §13.4's evaluation order.
//
// PURE predicates. The Exit Engine is the sole owner of position closure (§16.1)
// and this file is the part of it that decides; sending the MARKET order is the
// engine's job. Keeping the two apart is what lets all twelve exit reasons be
// fired in a unit test without a broker (§25.3).
//
// ---------------------------------------------------------------------------
// Two clocks, and why
// ---------------------------------------------------------------------------
//
// §16.2 gives every condition a priority, and priority 0 is not "most urgent" —
// it is "evaluated on a 1000 ms timer INDEPENDENT of the candle cycle". Those
// four conditions (feed gap, session end, kill switch, risk halt) must fire even
// when the candle feed has stopped, and a condition that lives on the candle
// cycle cannot fire when there are no candles. That is the entire distinction,
// and it is the reason this module exposes two evaluators rather than one.
//
//     onCandle()  runs inside a decision cycle, in the §13.4 order
//     onTimer()   runs on the safety timer, and outranks everything
//
// ---------------------------------------------------------------------------
// Stops before targets
// ---------------------------------------------------------------------------
//
// §13.4 fixes the order and the first match wins. Stops are evaluated BEFORE
// targets so a candle that spans both levels resolves conservatively — the loss
// is booked. §25.1 asserts that with a candle built to touch both.
//
// Prices in: integer paise.

const C = require('./constants');
const ladder = require('./ladder');
const entry = require('./entry');
const strikes = require('./strikes');

const EXIT_REASONS = {
  STOP_HIT: 'EXIT_STOP_HIT',
  PREMIUM_SAFETY: 'EXIT_PREMIUM_SAFETY',
  LIQUIDITY: 'EXIT_LIQUIDITY',
  MAX_HOLD: 'EXIT_MAX_HOLD',
  FILTER_FAIL: 'EXIT_FILTER_FAIL',
  TREND_BREAK: 'EXIT_TREND_BREAK',
  PREMIUM_FLOOR: 'EXIT_PREMIUM_FLOOR',
  FEED_GAP: 'EXIT_FEED_GAP',
  OPTION_FEED_GAP: 'EXIT_OPTION_FEED_GAP',
  SESSION_END: 'EXIT_SESSION_END',
  KILL_SWITCH: 'EXIT_KILL_SWITCH',
  RISK_HALT: 'EXIT_RISK_HALT',
  // The operator pressed Stop. A SOFT stop, and deliberately not the same thing
  // as the kill switch: this flattens and stops entering, and Start resumes it.
  // The kill switch flattens, cancels, and HALTS — which needs a script and a
  // restart to undo. Collapsing the two would mean an operator who wanted to
  // pause for ten minutes had to run a reset script to come back.
  OPERATOR_STOP: 'EXIT_OPERATOR_STOP',
  // §16.4. Recorded DISTINCTLY from STOP_HIT on purpose: the count of these is
  // the empirical answer to "how often did the sampled candle miss a stop the
  // live sample caught", which is the evidence §15.4's residual risk needs and
  // which a shared reason code would destroy.
  STOP_GUARD: 'EXIT_STOP_GUARD',
  // §20.5 — the fail-safe handler closes an open position on an unhandled
  // exception. Not in the §16.2 table because it is not a strategy decision;
  // it is the engine admitting it does not know what is going on.
  ENGINE_ERROR: 'EXIT_ENGINE_ERROR',
};

// §16.2's priority column. Lower is more urgent; 0 means "runs on the safety
// timer, independent of the candle feed".
const PRIORITY = Object.freeze({
  [EXIT_REASONS.FEED_GAP]: 0,
  [EXIT_REASONS.OPTION_FEED_GAP]: 0,
  [EXIT_REASONS.SESSION_END]: 0,
  [EXIT_REASONS.KILL_SWITCH]: 0,
  [EXIT_REASONS.RISK_HALT]: 0,
  [EXIT_REASONS.ENGINE_ERROR]: 0,
  [EXIT_REASONS.STOP_GUARD]: 0,
  [EXIT_REASONS.OPERATOR_STOP]: 0,
  [EXIT_REASONS.STOP_HIT]: 1,
  [EXIT_REASONS.PREMIUM_FLOOR]: 1,
  [EXIT_REASONS.PREMIUM_SAFETY]: 2,
  [EXIT_REASONS.LIQUIDITY]: 3,
  [EXIT_REASONS.MAX_HOLD]: 4,
  [EXIT_REASONS.FILTER_FAIL]: 5,
  [EXIT_REASONS.TREND_BREAK]: 5,
});

// The `orders.stage` an exit is recorded under. The trades page and the broker's
// order book both read it, so a reason with no mapping would show up as a
// mystery order.
function stageFor(reason) {
  switch (reason) {
    case EXIT_REASONS.STOP_HIT:
    case EXIT_REASONS.STOP_GUARD:
    case EXIT_REASONS.PREMIUM_SAFETY:
    case EXIT_REASONS.PREMIUM_FLOOR:
      return 'SL';
    case EXIT_REASONS.MAX_HOLD:
      return 'TIMEOUT';
    case EXIT_REASONS.SESSION_END:
    case EXIT_REASONS.OPERATOR_STOP:
      return 'SQUAREOFF';
    default:
      return 'EXIT';
  }
}

/* ------------------------------------------------- §16.2 #2, premium safety -- */

// §16.2.4 — a 2-point adverse move from ENTRY, regardless of trailing state.
//
// Measured from the fill and never from the running best. That is what makes it
// a backstop rather than a second, looser trailing stop: it is a hard ceiling on
// how far one trade may go wrong.
//
// Because trailing only ever tightens (§15.3), this can only fire before the
// first target is achieved — at which point it coincides with the stop. §16.2.4
// therefore expects it never to be the SOLE trigger in production, and any
// occurrence where it fires without the stop also firing indicates a
// stop-evaluation bug. The caller raises a warn on `soleTrigger`.
function premiumSafetyBreached(trade, premiumP, safetyPoints) {
  if (!safetyPoints) return false;
  if (!Number.isFinite(premiumP) || !Number.isFinite(trade.entryPriceP)) return false;
  return premiumP >= trade.entryPriceP + Math.trunc(safetyPoints) * C.POINT;
}

/* --------------------------------------------------- §16.2 #3, the liquidity -- */

// "the held contract fails §9.2 filters 3–8 on the current chain snapshot".
//
// Filters 3–8 are everything except type and premium: open interest, volume,
// both depths and both spread rules. The premium band is deliberately excluded —
// a position whose premium has left the entry band is a position that has MOVED,
// which is the trade working, not the book going away.
//
// Reuses the selection gate rather than restating the thresholds, so a contract
// can never be exited for a rule it was not selected under. A field the broker
// does not send cannot be evidence that liquidity has gone: with nothing
// measurable this returns `blind`, and the caller says so once per session
// rather than pretending the check ran.
function liquidityBroken(quote, cfg = {}) {
  if (!quote) return { broken: false, blind: true, reason: null };

  // LENIENT for this call whatever the selection mode is. In STRICT the absence
  // of a field is a selection refusal; here it would be an EXIT, and closing a
  // live short because the broker stopped sending a column nobody was reading is
  // not a liquidity event.
  const g = strikes.gate(quote, { ...cfg, liquidityMode: 'LENIENT' });

  const failed = strikes.CHECKS
    .filter(name => name !== 'premium')
    .filter(name => g.checks[name].result === strikes.FAIL);

  const measured = strikes.CHECKS
    .filter(name => name !== 'premium')
    .filter(name => g.checks[name].result !== strikes.UNKNOWN);

  if (!measured.length) return { broken: false, blind: true, reason: null };
  if (!failed.length) return { broken: false, blind: false, reason: null };

  return { broken: true, blind: false, reason: g.checks[failed[0]].reason };
}

/* ------------------------------------------------ §13.4, the candle evaluator -- */

// The six checks of §13.4, in the fixed order, first match wins:
//
//   1. hard stop / trailing stop        §15
//   2. premium safety exit              §16.2.4
//   3. liquidity deterioration          §16.2 #3
//   4. maximum holding time             §16.2 #4
//   5. position validity filter         §13.3
//   6. target reached -> extend         §14
//
// Returns `{ exit, extend, checks }`. `exit` is an exit reason with its detail,
// or null. `extend` is the ladder patch from §14.2, or null. They are never both
// set — a target that is reached on the same candle as a stop loses, which is
// the fail-closed reading of §13.4.
//
// `input`:
//   trade        the §6.1 ActiveTrade
//   optionCandle the sealed option candle for the held symbol (may be null)
//   indexCandle  the sealed index candle driving this cycle
//   trend        the §10 verdict, 'BULLISH' | 'BEARISH' | null
//   quote        the current chain snapshot row for the held contract, or null
//   cfg          derived settings
function onCandle({ trade, optionCandle, indexCandle, trend, quote, cfg = {} }) {
  const checks = [];
  const note = (name, hit, detail) => { checks.push({ name, hit, detail }); return hit; };

  const premiumP = optionCandle && Number.isFinite(optionCandle.closeP)
    ? optionCandle.closeP : null;

  const fire = (reason, detail, extra = {}) => ({
    exit: { reason, detail, priority: PRIORITY[reason] ?? 9, ...extra },
    extend: null,
    checks,
  });

  /* 1 — the stop. Evaluated first so a candle spanning both levels books the
        loss rather than the profit. */
  const stopWasHit = ladder.stopHit(optionCandle, trade.stopPriceP);

  /* 7 — the premium floor shares priority 1 with the stop and is checked
        alongside it: below ₹1 the spread makes holding uneconomic and the ladder
        has nowhere left to go (§14.4). */
  if (note('premiumFloor', premiumP !== null && premiumP <= C.PREMIUM_FLOOR)) {
    return fire(EXIT_REASONS.PREMIUM_FLOOR,
      `the premium has fallen to ${fmt(premiumP)} — below ₹1 there is nothing left to take`);
  }

  if (note('stop', stopWasHit,
    optionCandle ? `high ${fmt(optionCandle.highP)} vs stop ${fmt(trade.stopPriceP)}` : null)) {
    return fire(EXIT_REASONS.STOP_HIT,
      `the option candle's high ${fmt(optionCandle.highP)} reached the stop at `
      + `${fmt(trade.stopPriceP)}`);
  }

  /* 2 — the premium safety backstop. */
  const safety = premiumSafetyBreached(trade, premiumP, cfg.premiumSafetyExitPoints);
  if (note('premiumSafety', safety)) {
    return fire(EXIT_REASONS.PREMIUM_SAFETY,
      `the premium ${fmt(premiumP)} is ${cfg.premiumSafetyExitPoints} points above the entry `
      + `${fmt(trade.entryPriceP)}`,
      // §16.2.4 — firing without the stop also firing means the stop did not
      // evaluate. The caller turns this into a warn-level alert.
      { soleTrigger: !stopWasHit });
  }

  /* 3 — the book going away underneath us. */
  const liquidity = liquidityBroken(quote, cfg);
  if (note('liquidity', liquidity.broken, liquidity.reason)) {
    return fire(EXIT_REASONS.LIQUIDITY, liquidity.reason);
  }

  /* 4 — the clock. `[MUST-CONFIRM #9]`. */
  const maxHold = Math.trunc(cfg.maxHoldCandles ?? C.MAX_HOLD_CANDLES);
  if (note('maxHold', (trade.candlesHeld || 0) >= maxHold)) {
    return fire(EXIT_REASONS.MAX_HOLD,
      `held for ${trade.candlesHeld} candles, the maximum is ${maxHold}`);
  }

  /* 5 and 6 — the position validity filter. A trend break and a midpoint failure
     share priority 5 and are distinguished only by which one is reported; the
     filter itself names the more specific of the two. */
  const valid = entry.stillValid(indexCandle, trend, trade.optionType);
  if (note('validity', !valid.ok, valid.detail)) {
    return fire(valid.reason, valid.detail);
  }

  /* 6 — nothing is wrong, so the only remaining question is whether the target
     was reached. The position is NOT closed on it (§14.2): the rung moves out
     and the stop tightens behind it. */
  const extend = ladder.advanceTarget(trade, optionCandle, cfg);
  note('target', Boolean(extend), extend ? `to level ${extend.targetLevel}` : null);

  return { exit: null, extend, checks };
}

/* --------------------------------------- §13.1, the option-candle evaluator -- */

// "Also runs on every sealed OPTION candle for the held symbol, FOR STOP/TARGET
// EVALUATION ONLY."
//
// A narrower door than onCandle() on purpose. An option candle says nothing
// about the index, so the position validity filter, the trend break and the
// holding-time count are not evaluated here — only the three things that are
// facts about the contract itself: the premium floor, the stop, and whether the
// target rung was reached.
//
// The same §13.4 ordering applies within that subset: stops before targets.
function onOptionCandle({ trade, optionCandle, cfg = {} }) {
  const premiumP = optionCandle && Number.isFinite(optionCandle.closeP)
    ? optionCandle.closeP : null;

  const fire = (reason, detail, extra = {}) => ({
    exit: { reason, detail, priority: PRIORITY[reason] ?? 9, ...extra },
    extend: null,
  });

  if (premiumP !== null && premiumP <= C.PREMIUM_FLOOR) {
    return fire(EXIT_REASONS.PREMIUM_FLOOR,
      `the premium has fallen to ${fmt(premiumP)} — below ₹1 there is nothing left to take`);
  }

  const stopWasHit = ladder.stopHit(optionCandle, trade.stopPriceP);
  if (stopWasHit) {
    return fire(EXIT_REASONS.STOP_HIT,
      `the option candle's high ${fmt(optionCandle.highP)} reached the stop at `
      + `${fmt(trade.stopPriceP)}`);
  }

  if (premiumSafetyBreached(trade, premiumP, cfg.premiumSafetyExitPoints)) {
    return fire(EXIT_REASONS.PREMIUM_SAFETY,
      `the premium ${fmt(premiumP)} is ${cfg.premiumSafetyExitPoints} points above the entry `
      + `${fmt(trade.entryPriceP)}`,
      { soleTrigger: !stopWasHit });
  }

  return { exit: null, extend: ladder.advanceTarget(trade, optionCandle, cfg) };
}

/* ------------------------------------------- §16.2 priority 0, the safety timer -- */

// The four conditions that must fire with the candle feed stopped, plus the
// engine-error exit. Evaluated on SAFETY_TIMER_MS and outranking everything the
// candle cycle can produce.
//
// `input`:
//   indexGapCandles / optionGapCandles  consecutive silent buckets (§7.5)
//   pastSquareOff                       now >= SQUARE_OFF_TIME (§17.4)
//   killSwitch                          the file exists (§26.5)
//   halted                              the Risk Engine halted mid-position
//   trade / livePremiumP / sampleAgeMs  the §16.4 stop guard, below
//
// ---------------------------------------------------------------------------
// §16.4, the sampled-stop guard — `[MUST-CONFIRM #12]`
// ---------------------------------------------------------------------------
//
// §15.4 evaluates the stop once per sealed 5s candle, on `candle.high`. On this
// broker that high is the maximum of at most five REST samples, not the true
// intra-bucket high — so a spike that crosses the stop and retraces between two
// polls leaves NO TRACE IN THE CANDLE AT ALL and the stop does not fire. That is
// not a bug that can be fixed inside §15.4: the data does not contain the event.
//
// This guard re-checks the latest live sample every second, which is the
// difference between a 5-second stop and a 1-second one.
//
// It is the ONLY place in the engine where a live quote drives a decision, and
// it is permitted under §3.2(c) for one reason: it can only ever CLOSE a
// position. It cannot open a trade that would not otherwise have been possible,
// cannot loosen a stop, and cannot change any price. Every other consumer of a
// live quote would be a §3.2 violation.
//
// A STALE sample expresses no opinion. If the last sample is older than two poll
// intervals the guard is silent rather than firing on a price that may be from
// before the stop was last trailed — a guard that acts on stale data is worse
// than one that does not act, because it exits a position for a reason that was
// no longer true.
function onTimer({
  indexGapCandles = 0, optionGapCandles = 0,
  pastSquareOff = false, killSwitch = false, halted = false, operatorStop = false,
  trade = null, livePremiumP = null, sampleAgeMs = null, maxSampleAgeMs = 0,
  stopGuardEnabled = false,
} = {}) {
  const fire = (reason, detail) => ({ reason, detail, priority: 0 });

  // The kill switch is the operator's guaranteed intervention path (§26.5) and
  // is checked first for exactly that reason: nothing the engine believes about
  // the market may outrank a human deciding to be flat.
  if (killSwitch) return fire(EXIT_REASONS.KILL_SWITCH, 'the kill-switch file is present');
  if (halted) return fire(EXIT_REASONS.RISK_HALT, 'the risk engine halted while a position was open');
  // Below the kill switch and the halt, above everything the market can say: an
  // operator asking to be flat outranks the strategy's own opinion of the trade.
  if (operatorStop) return fire(EXIT_REASONS.OPERATOR_STOP, 'the operator pressed Stop');
  if (pastSquareOff) return fire(EXIT_REASONS.SESSION_END, 'the session square-off time has passed');

  // §7.5 — one silent bucket is synthesised and traded through. Two or more is a
  // feed gap, and a naked short with no price feed is the position this engine
  // least wants to be holding.
  if (optionGapCandles > C.MAX_SYNTHETIC_RUN) {
    return fire(EXIT_REASONS.OPTION_FEED_GAP,
      `${optionGapCandles} consecutive silent option buckets`);
  }
  if (indexGapCandles > C.MAX_SYNTHETIC_RUN) {
    return fire(EXIT_REASONS.FEED_GAP, `${indexGapCandles} consecutive silent index buckets`);
  }

  // §16.4. Last, because every condition above is a fact about the SYSTEM and
  // this one is a fact about the market — and when the feed has stopped or the
  // operator has intervened, what the price is doing no longer decides anything.
  if (stopGuardEnabled && trade && trade.stopPriceP != null
      && livePremiumP != null && Number.isFinite(livePremiumP) && livePremiumP > 0) {
    const fresh = sampleAgeMs != null && maxSampleAgeMs > 0 && sampleAgeMs <= maxSampleAgeMs;
    if (fresh && livePremiumP >= trade.stopPriceP) {
      return fire(EXIT_REASONS.STOP_GUARD,
        `the live sample ${fmt(livePremiumP)} is at or past the stop ${fmt(trade.stopPriceP)} `
        + `${sampleAgeMs}ms ago — the sealed candle had not shown it`);
    }
  }

  return null;
}

const fmt = (paise) => (paise === null || paise === undefined ? '—' : (paise / 100).toFixed(2));

module.exports = {
  EXIT_REASONS, PRIORITY,
  stageFor, premiumSafetyBreached, liquidityBroken,
  onCandle, onOptionCandle, onTimer,
};
