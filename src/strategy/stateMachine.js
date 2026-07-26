// The strategy state machine.
//
// `decide(context)` is a PURE function: given everything that is currently
// true, it returns the next state, the single action to perform, and the reason
// — and nothing else. It never places an order, reads a database, or looks at
// the clock. The runner supplies the facts and carries out the action.
//
// That split is the point. Every rule in the doc — the premium range, the arm
// price, the offset reversal, the target, the stop, the time exit, and above
// all the hedge ordering — is expressible as a transition over facts, so the
// entire trading logic is unit-testable without a broker or a market.
//
//   IDLE ─▶ SCANNING ─▶ STRIKE_SELECTED ─▶ HEDGE_PENDING ─▶ HEDGE_OPEN
//        ─▶ ARM_WAIT ─▶ OFFSET_WAIT ─▶ SHORT_PENDING ─▶ POSITION_OPEN
//        ─▶ EXIT_SHORT ─▶ EXIT_HEDGE ─▶ COMPLETE ─▶ IDLE
//
// TWO INVARIANTS. Everything below protects them:
//   1. The hedge is bought and CONFIRMED before the short is sent. If the short
//      then fails, the hedge is unwound rather than left stranded.
//   2. On exit the short is bought back FIRST; the hedge is sold only after
//      that confirms. A failed buy-back keeps the hedge — it is the only thing
//      capping the loss — and retries.

const { parseHHMM } = require('../core/time');
const { round } = require('../core/money');

const S = {
  IDLE: 'IDLE',
  SCANNING: 'SCANNING',
  STRIKE_SELECTED: 'STRIKE_SELECTED',
  HEDGE_PENDING: 'HEDGE_PENDING',
  HEDGE_OPEN: 'HEDGE_OPEN',
  ARM_WAIT: 'ARM_WAIT',
  OFFSET_WAIT: 'OFFSET_WAIT',
  SHORT_PENDING: 'SHORT_PENDING',
  POSITION_OPEN: 'POSITION_OPEN',
  EXIT_SHORT: 'EXIT_SHORT',
  EXIT_HEDGE: 'EXIT_HEDGE',
  COMPLETE: 'COMPLETE',
  HALTED: 'HALTED',
};

const A = {
  NONE: 'NONE',
  SCAN: 'SCAN',                     // look for a strike + hedge this tick
  PLACE_HEDGE: 'PLACE_HEDGE',
  PLACE_SHORT: 'PLACE_SHORT',
  EXIT_SHORT: 'EXIT_SHORT',         // buy back the short
  EXIT_HEDGE: 'EXIT_HEDGE',         // sell the hedge (also the lone-hedge unwind)
  RECONCILE: 'RECONCILE',           // an order was in flight when we stopped
  FINALISE: 'FINALISE',             // close the books on the trade
};

// States where real exposure exists (or is about to). Only one strategy per
// user may occupy these at a time — that is the doc's "strategy queue".
const EXPOSED_STATES = new Set([
  S.STRIKE_SELECTED, S.HEDGE_PENDING, S.HEDGE_OPEN, S.ARM_WAIT, S.OFFSET_WAIT,
  S.SHORT_PENDING, S.POSITION_OPEN, S.EXIT_SHORT, S.EXIT_HEDGE,
]);

// States entered immediately before an order leaves. Finding one of these on
// boot means the process died mid-order and the broker must be asked what
// actually happened.
const IN_FLIGHT_STATES = new Set([S.HEDGE_PENDING, S.SHORT_PENDING, S.EXIT_SHORT, S.EXIT_HEDGE]);

// States that require a trade record to exist.
const TRADE_STATES = new Set([
  S.HEDGE_OPEN, S.ARM_WAIT, S.OFFSET_WAIT, S.SHORT_PENDING,
  S.POSITION_OPEN, S.EXIT_SHORT, S.EXIT_HEDGE,
]);

function result(next, action, reason, patch = null) {
  return { next, action, reason, patch };
}

/**
 * @param {object} ctx
 * @param {string} ctx.state       current state
 * @param {object} ctx.config      normalised strategy config
 * @param {object} ctx.session     { minutes, isTradingDay, marketOpen }
 * @param {object} ctx.market      { spot, shortLtp, shortAgeMs, hedgeLtp, feedHealthy }
 * @param {object|null} ctx.candidate  scanner.findCandidate() result, SCANNING only
 * @param {object|null} ctx.trade  live trade snapshot
 * @param {object} ctx.runtime     { armed, armedLow, stageEnteredAt, cooldownUntil }
 * @param {object} ctx.risk        { blockedReason }
 * @param {boolean} ctx.halted     global kill switch
 * @param {number} ctx.now         epoch ms
 */
function decide(ctx) {
  const { state, trade } = ctx;

  // An order was in flight when this process last stopped. Nothing may be
  // decided until the broker tells us whether it exists.
  if (IN_FLIGHT_STATES.has(state)) {
    return result(state, A.RECONCILE, `recovering an in-flight order from ${state}`);
  }

  // A state that needs a trade but has none means the strategy row and the
  // trade row disagree — a crash between two writes. Reset rather than
  // dereference nothing; reconciliation has already had its chance to adopt any
  // genuine exposure.
  if (TRADE_STATES.has(state) && !trade) {
    return result(S.IDLE, A.NONE, `no trade record for state ${state} — reset to idle`);
  }

  switch (state) {
    case S.HALTED:
      return result(S.HALTED, A.NONE, 'halted by the operator');

    case S.COMPLETE:
      return result(S.IDLE, A.NONE, 'ready for the next cycle');

    case S.IDLE:
    case S.SCANNING:
      return decideScan(ctx);

    case S.STRIKE_SELECTED:
      return decideHedgeEntry(ctx);

    case S.HEDGE_OPEN:
    case S.ARM_WAIT:
      return decideArmWait(ctx);

    case S.OFFSET_WAIT:
      return decideOffsetWait(ctx);

    case S.POSITION_OPEN:
      return decideMonitor(ctx);

    default:
      return result(S.IDLE, A.NONE, `unknown state ${state} — reset to idle`);
  }
}

/* ------------------------------------------------------- 1. SCAN FOR ENTRY - */
function decideScan(ctx) {
  const { config, session, market, candidate, runtime, risk, halted, now } = ctx;

  if (!session.isTradingDay) return result(S.IDLE, A.NONE, 'not a trading day');
  if (!market.feedHealthy) return result(S.IDLE, A.NONE, 'market data feed is down');

  const entry = parseHHMM(config.entryTime);
  const lastEntry = parseHHMM(config.lastEntryTime);
  const squareOff = parseHHMM(config.squareOffTime);

  if (session.minutes < entry) {
    return result(S.IDLE, A.NONE, `waiting for entry time ${config.entryTime}`);
  }
  if (session.minutes >= lastEntry) {
    return result(S.IDLE, A.NONE, `past last entry ${config.lastEntryTime} — no new positions`);
  }
  if (session.minutes >= squareOff) {
    return result(S.IDLE, A.NONE, 'past square-off time');
  }
  // The kill switch blocks OPENING orders only; exits below are never gated.
  if (halted) return result(S.IDLE, A.NONE, 'trading halted — no new positions');
  if (risk.blockedReason) return result(S.IDLE, A.NONE, risk.blockedReason);

  if (runtime.cooldownUntil && now < runtime.cooldownUntil) {
    const secs = Math.ceil((runtime.cooldownUntil - now) / 1000);
    return result(S.IDLE, A.NONE, `re-entry cooldown ${secs}s`);
  }
  if (!ctx.hasPositionSlot) {
    return result(S.IDLE, A.NONE, 'queued — another strategy holds the position slot');
  }
  if (market.spot == null) {
    return result(S.SCANNING, A.SCAN, 'waiting for the index spot price');
  }
  // The runner scans and passes the result back in; a missing candidate means
  // "keep scanning", not "something is wrong".
  if (!candidate) return result(S.SCANNING, A.SCAN, 'scanning the option chain');
  if (!candidate.ok) return result(S.SCANNING, A.SCAN, `scanning — ${candidate.reason}`);

  return result(S.STRIKE_SELECTED, A.NONE, candidate.reason);
}

/* --------------------------------------------- 2. BUY THE HEDGE, FIRST ----- */
function decideHedgeEntry(ctx) {
  const { candidate } = ctx;
  if (!candidate || !candidate.ok) {
    return result(S.SCANNING, A.SCAN, 'lost the strike candidate — rescanning');
  }
  // Invariant 1 begins here: the hedge order is the first thing that happens.
  return result(S.HEDGE_PENDING, A.PLACE_HEDGE,
    `buying hedge ${candidate.hedge.optionType} ${candidate.hedge.strike} @ ~${candidate.hedge.premium}`);
}

/* ------------------------------------------------- 3. WAIT FOR ARM PRICE --- */
function decideArmWait(ctx) {
  const { config, market, now, trade } = ctx;

  const abandon = shouldAbandonHedge(ctx);
  if (abandon) {
    return result(S.EXIT_HEDGE, A.EXIT_HEDGE, abandon.reason, { exitReason: abandon.code });
  }
  if (market.shortLtp == null) {
    return result(S.ARM_WAIT, A.NONE, 'hedge open — waiting for a quote on the short strike');
  }
  if (isStale(ctx)) {
    return result(S.ARM_WAIT, A.NONE, `hedge open — short quote is stale (${Math.round(market.shortAgeMs / 1000)}s)`);
  }

  const arm = Number(config.armPrice);
  if (market.shortLtp <= arm) {
    return result(S.OFFSET_WAIT, A.NONE,
      `ARMED at ${round(market.shortLtp)} (arm ${arm}) — waiting for a +${config.offset} reversal`,
      { armed: true, armedLow: round(market.shortLtp), armedAt: now });
  }
  return result(S.ARM_WAIT, A.NONE,
    `arm wait · LTP ${round(market.shortLtp)} → needs ≤ ${arm}`
    + (trade ? ` · hedge ${trade.hedgeStrike} held` : ''));
}

/* -------------------------------------------- 4. WAIT FOR OFFSET REVERSAL -- */
function decideOffsetWait(ctx) {
  const { config, market, runtime } = ctx;

  const abandon = shouldAbandonHedge(ctx);
  if (abandon) {
    return result(S.EXIT_HEDGE, A.EXIT_HEDGE, abandon.reason, { exitReason: abandon.code });
  }
  if (market.shortLtp == null) {
    return result(S.OFFSET_WAIT, A.NONE, 'armed — waiting for a quote');
  }
  if (isStale(ctx)) {
    return result(S.OFFSET_WAIT, A.NONE, `armed — quote is stale (${Math.round(market.shortAgeMs / 1000)}s)`);
  }

  // Track the low since arming; needed for offsetFrom === 'LOW'.
  const low = runtime.armedLow == null ? market.shortLtp : Math.min(runtime.armedLow, market.shortLtp);
  const patch = { armedLow: round(low) };

  // ARM: sell when price recovers to armPrice + offset — the doc's rule.
  // LOW: trail the post-arm low instead, which triggers sooner after a deeper
  //      dip. The two only differ when price undershoots the arm level.
  const trigger = config.offsetFrom === 'LOW'
    ? round(low + Number(config.offset))
    : round(Number(config.armPrice) + Number(config.offset));

  if (market.shortLtp >= trigger) {
    // Invariant 1 holds: we only get here with a confirmed hedge behind us.
    return result(S.SHORT_PENDING, A.PLACE_SHORT,
      `offset trigger hit — LTP ${round(market.shortLtp)} ≥ ${trigger}`,
      { ...patch, trigger });
  }
  return result(S.OFFSET_WAIT, A.NONE,
    `offset wait · LTP ${round(market.shortLtp)} → trigger ${trigger} (low ${round(low)})`, patch);
}

/* --------------------------------------------------- 5. MONITOR POSITION --- */
function decideMonitor(ctx) {
  const { config, session, market, trade } = ctx;
  const squareOff = parseHHMM(config.squareOffTime);

  // The time exit is unconditional: it must fire even on a stale quote, because
  // the alternative is carrying a naked-ish intraday position past square-off.
  if (session.minutes >= squareOff) {
    return result(S.EXIT_SHORT, A.EXIT_SHORT, `square-off time ${config.squareOffTime} reached`,
      { exitReason: 'time' });
  }
  if (market.shortLtp == null) {
    return result(S.POSITION_OPEN, A.NONE, 'position open — no quote this tick');
  }
  // Target and stop are NOT evaluated on a stale price. Acting on a minutes-old
  // print can exit at a level that no longer exists; waiting is the safer error.
  if (isStale(ctx)) {
    return result(S.POSITION_OPEN, A.NONE,
      `position open — quote stale (${Math.round(market.shortAgeMs / 1000)}s), holding`);
  }

  const ltp = market.shortLtp;
  if (ltp <= trade.targetPrice) {
    return result(S.EXIT_SHORT, A.EXIT_SHORT, `target hit at ${round(ltp)} (≤ ${trade.targetPrice})`,
      { exitReason: 'target' });
  }
  if (ltp >= trade.slPrice) {
    return result(S.EXIT_SHORT, A.EXIT_SHORT, `stoploss hit at ${round(ltp)} (≥ ${trade.slPrice})`,
      { exitReason: 'stoploss' });
  }

  const unrealised = round((trade.sellPrice - ltp) * trade.qty);
  return result(S.POSITION_OPEN, A.NONE,
    `open · LTP ${round(ltp)} · target ${trade.targetPrice} / stop ${trade.slPrice} · ₹${unrealised}`);
}

/* ------------------------------------------------------------- helpers ----- */
function isStale(ctx) {
  const max = Number(ctx.config.maxQuoteAgeMs) || 15000;
  return ctx.market.shortAgeMs != null && ctx.market.shortAgeMs > max;
}

// A hedge is live but no short was ever opened. Carrying a lone long option
// past the entry window is not the strategy — unwind it.
// Returns { reason, code } or null.
function shouldAbandonHedge(ctx) {
  const { config, session, trade, now } = ctx;
  const lastEntry = parseHHMM(config.lastEntryTime);
  const squareOff = parseHHMM(config.squareOffTime);

  if (session.minutes >= squareOff) {
    return {
      code: 'time',
      reason: `square-off ${config.squareOffTime} reached with no short opened — unwinding the hedge`,
    };
  }
  if (session.minutes >= lastEntry) {
    return {
      code: 'time',
      reason: `last entry ${config.lastEntryTime} passed with no short opened — unwinding the hedge`,
    };
  }
  const timeout = Number(config.armTimeoutSec) || 0;
  if (timeout > 0 && trade?.hedgeOpenedAt && (now - trade.hedgeOpenedAt) / 1000 >= timeout) {
    return {
      code: 'arm_timeout',
      reason: `arm price not reached within ${timeout}s — unwinding the hedge`,
    };
  }
  return null;
}

module.exports = {
  STATES: S, ACTIONS: A,
  EXPOSED_STATES, IN_FLIGHT_STATES, TRADE_STATES,
  decide,
};
