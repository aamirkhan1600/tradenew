const test = require('node:test');
const assert = require('node:assert/strict');
const { ist, leg, cfg, candle, run, actionsOf, logsOf } = require('./helpers');
const m = require('../src/strategy/legMachine');

const { STATES } = m;
const T0 = ist('2026-07-28 10:16:00');

/* ------------------------------------------------------------- the pricing */

test('the sell price is the candle close plus the offset — the documents\' example', () => {
  assert.equal(m.calculateSellPrice(candle({ closeP: 1240 }), 100), 1340);
  assert.equal(m.calculateSellPrice(candle({ closeP: 1180 }), 100), 1280);
});

test('the target comes off the FILLED price, not the price asked for', () => {
  // A limit that filled better should keep the improvement; one that filled
  // worse should not have its target quietly moved.
  assert.equal(m.calculateTargetPrice(1345, 100), 1245);
  assert.equal(m.calculateStopPrice(1345, 200), 1545);
});

test('the target never goes below one tick', () => {
  assert.equal(m.calculateTargetPrice(50, 100), 5);
});

/* --------------------------------------------------------------- the happy path */

test('arm → candle → sell → fill → target → done', () => {
  const { leg: end, actions } = run(m, leg(), [
    { type: 'ARM', tsMs: T0 },
    { type: 'CANDLE_CLOSED', candle: candle(), gateOk: true, tsMs: T0 },
    { type: 'SELL_PLACED', orderId: 11, tsMs: T0 },
    { type: 'SELL_FILLED', filledPriceP: 1340, filledQty: 75, tsMs: T0 + 2000 },
    { type: 'TARGET_PLACED', orderId: 12, tsMs: T0 + 2100 },
    { type: 'TARGET_FILLED', filledPriceP: 1240, tsMs: T0 + 30000 },
  ]);

  assert.equal(end.state, STATES.DONE);
  assert.equal(end.exitReason, 'TARGET');

  const sells = actionsOf(actions, 'PLACE_SELL');
  assert.equal(sells.length, 1);
  assert.equal(sells[0].pricePaise, 1340, '12.40 close + 1.00 offset');

  const targets = actionsOf(actions, 'PLACE_TARGET');
  assert.equal(targets.length, 1);
  assert.equal(targets[0].pricePaise, 1240, '13.40 fill − 1.00 target');

  const closes = actionsOf(actions, 'CLOSE_LEG');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].exitPriceP, 1240);
});

/* ------------------------------------------------------------- requote path */

test('an unfilled sell cancels and waits for the NEXT candle — it does not requote at once', () => {
  // v3.0 supersedes the v2.0 SDD here. The idle gap between the cancel and the
  // next close is what "never chase the market" means mechanically.
  const start = leg({ state: STATES.SELL_WORKING, sellOrderId: 11, sellPlacedAt: T0, attemptSeq: 1 });

  const early = m.reduce(start, { type: 'PENDING_TIMEOUT', tsMs: T0 + 5000 }, cfg());
  assert.equal(early.state, STATES.SELL_WORKING, 'five seconds is not ten');
  assert.equal(early.actions.length, 0);

  const late = m.reduce(start, { type: 'PENDING_TIMEOUT', tsMs: T0 + 10001 }, cfg());
  assert.equal(late.state, STATES.SELL_CANCELLING);
  assert.equal(actionsOf(late.actions, 'CANCEL_SELL').length, 1);
  // Crucially: no new sell is placed here.
  assert.equal(actionsOf(late.actions, 'PLACE_SELL').length, 0);

  const after = m.reduce({ ...start, state: STATES.SELL_CANCELLING },
    { type: 'SELL_CANCELLED', tsMs: T0 + 11000 }, cfg());
  assert.equal(after.state, STATES.WAIT_CANDLE);
  assert.equal(actionsOf(after.actions, 'PLACE_SELL').length, 0,
    'the requote waits for a candle, not for the cancel');
});

test('the requote prices off the NEW close and bumps the attempt', () => {
  const { leg: end, actions } = run(m, leg({ state: STATES.WAIT_CANDLE, attemptSeq: 1 }), [
    { type: 'CANDLE_CLOSED', candle: candle({ closeP: 1290, id: 8 }), gateOk: true, tsMs: T0 },
  ]);
  assert.equal(end.sellPriceP, 1390);
  assert.equal(end.attemptSeq, 2, 'the attempt seq feeds the idempotency key');
  assert.equal(end.entryCandleId, 8, 'the leg records which candle priced it');
  assert.equal(actionsOf(actions, 'PLACE_SELL')[0].pricePaise, 1390);
});

/* ----------------------------------------------------------- refusal paths */

test('a synthetic bar never prices an entry', () => {
  const r = m.reduce(leg({ state: STATES.WAIT_CANDLE }),
    { type: 'CANDLE_CLOSED', candle: candle({ synthetic: true, tradable: false, tickCount: 0 }), gateOk: true, tsMs: T0 },
    cfg());
  assert.equal(r.state, STATES.WAIT_CANDLE);
  assert.equal(actionsOf(r.actions, 'PLACE_SELL').length, 0);
  assert.equal(logsOf(r.actions, 'CANDLE_SKIPPED').length, 1);
});

test('a low-confidence bar never prices an entry', () => {
  const r = m.reduce(leg({ state: STATES.WAIT_CANDLE }),
    { type: 'CANDLE_CLOSED', candle: candle({ lowConfidence: true, tradable: false, tickCount: 1 }), gateOk: true, tsMs: T0 },
    cfg());
  assert.equal(actionsOf(r.actions, 'PLACE_SELL').length, 0);
});

test('a failed premium gate skips the candle without pricing', () => {
  const r = m.reduce(leg({ state: STATES.WAIT_CANDLE }),
    { type: 'CANDLE_CLOSED', candle: candle(), gateOk: false, gateReason: 'quote is 9s stale', tsMs: T0 },
    cfg());
  assert.equal(r.state, STATES.WAIT_CANDLE);
  assert.equal(actionsOf(r.actions, 'PLACE_SELL').length, 0);
  assert.equal(logsOf(r.actions, 'PREMIUM_GATE_REJECT').length, 1);
});

test('a failed index trend gate skips the candle without pricing', () => {
  // doc/update-point.md. The index verdict arrives as a boolean exactly like the
  // premium gate's, so no NIFTY price can reach the entry calculation.
  const r = m.reduce(leg({ state: STATES.WAIT_CANDLE }), {
    type: 'CANDLE_CLOSED',
    candle: candle(),
    gateOk: true,
    trendOk: false,
    trendReason: 'the index is bullish — only the PE side may sell',
    trendState: 'STRONG_BULLISH',
    tsMs: T0,
  }, cfg());

  assert.equal(r.state, STATES.WAIT_CANDLE);
  assert.equal(actionsOf(r.actions, 'PLACE_SELL').length, 0);
  assert.equal(logsOf(r.actions, 'TREND_GATE_REJECT').length, 1);
  assert.equal(logsOf(r.actions, 'TREND_GATE_REJECT')[0].trendState, 'STRONG_BULLISH');
});

test('an absent trend verdict means the filter is off, not that it refused', () => {
  // `trendOk` is only ever false when the filter actually said no. A candle
  // event with no trend field at all must still price an entry, or turning the
  // filter off would silently stop the engine trading.
  const r = m.reduce(leg({ state: STATES.WAIT_CANDLE }),
    { type: 'CANDLE_CLOSED', candle: candle({ closeP: 1240 }), gateOk: true, tsMs: T0 }, cfg());
  assert.equal(r.state, STATES.SELL_WORKING);
  assert.equal(actionsOf(r.actions, 'PLACE_SELL')[0].pricePaise, 1340);
});

test('the premium gate is checked before the trend gate — the closer reason wins', () => {
  const r = m.reduce(leg({ state: STATES.WAIT_CANDLE }), {
    type: 'CANDLE_CLOSED', candle: candle(),
    gateOk: false, gateReason: 'the premium has left the band',
    trendOk: false, trendReason: 'choppy',
    tsMs: T0,
  }, cfg());
  assert.equal(logsOf(r.actions, 'PREMIUM_GATE_REJECT').length, 1);
  assert.equal(logsOf(r.actions, 'TREND_GATE_REJECT').length, 0);
});

/* --------------------------------------------------- per-leg re-entry (R6) */

test('a finished leg re-arms onto the same strike and clears the round trip', () => {
  const finished = leg({
    state: STATES.DONE, attemptSeq: 3,
    sellPriceP: 1340, filledPriceP: 1340, filledQty: 75,
    targetPriceP: 1240, slPriceP: 1540, entryCandleId: 9,
    openedAt: T0, closedAt: T0 + 30000, exitReason: 'TARGET',
    confirmations: 2, trailPeakP: 1200, trailingOnly: true,
  });
  const r = m.reduce(finished, { type: 'REARM', tsMs: T0 + 31000 }, cfg());

  assert.equal(r.state, STATES.WAIT_CANDLE);
  for (const field of ['filledPriceP', 'targetPriceP', 'slPriceP', 'entryCandleId',
    'openedAt', 'closedAt', 'exitReason', 'sellPriceP']) {
    assert.equal(r.patch[field], null, `${field} should be cleared`);
  }
  assert.equal(r.patch.filledQty, 0);
  assert.equal(r.patch.confirmations, 0);
  assert.equal(r.patch.trailingOnly, false);
  assert.equal(r.patch.waitingSince, T0 + 31000, 'the stand-down clock restarts');
});

test('re-arming does NOT reset attemptSeq — it is part of the order key', () => {
  // Resetting it would make the next entry collide with the round trip that
  // just finished, and place() would return the old filled order instead of
  // sending anything.
  const r = m.reduce(leg({ state: STATES.DONE, attemptSeq: 3, closedAt: T0 }),
    { type: 'REARM', tsMs: T0 + 1000 }, cfg());
  assert.equal(r.patch.attemptSeq, undefined, 'left alone');
});

test('re-arming only applies to a leg that is actually finished', () => {
  for (const state of [STATES.POSITION_OPEN, STATES.WAIT_CANDLE, STATES.EXITING,
    STATES.SELL_WORKING, STATES.TARGET_MOVING]) {
    const r = m.reduce(leg({ state }), { type: 'REARM', tsMs: T0 }, cfg());
    assert.equal(r.state, state, `${state} must not be re-armed`);
    assert.equal(r.actions.length, 0);
  }
});

test('a re-armed leg takes the next candle exactly like a fresh one', () => {
  const { leg: end, actions } = run(m, leg({ state: STATES.DONE, attemptSeq: 1, closedAt: T0 }), [
    { type: 'REARM', tsMs: T0 + 1000 },
    { type: 'CANDLE_CLOSED', candle: candle({ closeP: 1180 }), gateOk: true, tsMs: T0 + 60000 },
  ]);
  assert.equal(end.state, STATES.SELL_WORKING);
  assert.equal(actionsOf(actions, 'PLACE_SELL')[0].pricePaise, 1280);
  assert.equal(end.attemptSeq, 2, 'the second attempt of this cycle');
});

/* ------------------------------------------------- standing a blocked leg down */

test('a leg that never gets permission stands down so the cycle can unlock', () => {
  // The deadlock this exists to break: the cycle releases the strike only when
  // BOTH legs are DONE, and a one-sided trend filter means the blocked leg never
  // enters. Without this it holds the lock until the square-off.
  const start = leg({ state: STATES.WAIT_CANDLE, waitingSince: T0 });

  const early = m.reduce(start, { type: 'ENTRY_TIMEOUT', tsMs: T0 + 179000 }, cfg());
  assert.equal(early.state, STATES.WAIT_CANDLE, 'not yet');
  assert.equal(early.actions.length, 0);

  const late = m.reduce(start, {
    type: 'ENTRY_TIMEOUT', tsMs: T0 + 180001,
    reason: 'the index is bullish — only the PE side may sell',
  }, cfg());
  assert.equal(late.state, STATES.DONE);
  assert.equal(late.patch.exitReason, 'NO_ENTRY');
  assert.equal(logsOf(late.actions, 'NO_ENTRY').length, 1);
  assert.match(logsOf(late.actions, 'NO_ENTRY')[0].reason, /only the PE side/);
});

test('a gate rejection does NOT reset the stand-down clock', () => {
  // The whole point. If a refused candle restarted the timer, a permanently
  // blocked leg would reset its own deadline on every close and never stand
  // down — the deadlock would survive the fix.
  const { leg: end } = run(m, leg({ state: STATES.WAIT_CANDLE, waitingSince: T0 }), [
    { type: 'CANDLE_CLOSED', candle: candle(), gateOk: true, trendOk: false, tsMs: T0 + 60000 },
    { type: 'CANDLE_CLOSED', candle: candle(), gateOk: true, trendOk: false, tsMs: T0 + 120000 },
    { type: 'CANDLE_CLOSED', candle: candle(), gateOk: false, tsMs: T0 + 170000 },
  ]);
  assert.equal(end.state, STATES.WAIT_CANDLE);
  assert.equal(end.waitingSince, T0, 'the clock never moved');

  const out = m.reduce(end, { type: 'ENTRY_TIMEOUT', tsMs: T0 + 180001 }, cfg());
  assert.equal(out.state, STATES.DONE);
});

test('a requote DOES reset it — a leg that is trading is not a leg that is stuck', () => {
  const cancelled = m.reduce(
    leg({ state: STATES.SELL_CANCELLING, waitingSince: T0, sellOrderId: 11 }),
    { type: 'SELL_CANCELLED', tsMs: T0 + 170000 }, cfg());
  assert.equal(cancelled.state, STATES.WAIT_CANDLE);
  assert.equal(cancelled.patch.waitingSince, T0 + 170000);

  const rejected = m.reduce(
    leg({ state: STATES.SELL_WORKING, waitingSince: T0, sellOrderId: 11 }),
    { type: 'SELL_REJECTED', reason: 'margin', tsMs: T0 + 170000 }, cfg());
  assert.equal(rejected.patch.waitingSince, T0 + 170000);
});

test('arming stamps the clock, and a timeout of 0 disables the rule', () => {
  const armed = m.reduce(leg({ state: STATES.IDLE }), { type: 'ARM', tsMs: T0 }, cfg());
  assert.equal(armed.patch.waitingSince, T0);

  const off = m.reduce(leg({ state: STATES.WAIT_CANDLE, waitingSince: T0 }),
    { type: 'ENTRY_TIMEOUT', tsMs: T0 + 999999 }, cfg({ legEntryTimeoutMs: 0 }));
  assert.equal(off.state, STATES.WAIT_CANDLE);
});

test('standing down never touches a leg holding a position', () => {
  // It releases a lock; it is not a risk control and must not close a short.
  for (const state of [STATES.POSITION_OPEN, STATES.SELL_WORKING, STATES.EXITING]) {
    const out = m.reduce(leg({ state, waitingSince: T0, filledPriceP: 1340 }),
      { type: 'ENTRY_TIMEOUT', tsMs: T0 + 999999 }, cfg());
    assert.equal(out.state, state, `${state} must be left alone`);
    assert.equal(out.actions.length, 0);
  }
});

test('a stood-down leg produces no order and no position to book', () => {
  const out = m.reduce(leg({ state: STATES.WAIT_CANDLE, waitingSince: T0 }),
    { type: 'ENTRY_TIMEOUT', tsMs: T0 + 180001 }, cfg());
  assert.equal(actionsOf(out.actions, 'CLOSE_LEG').length, 0, 'nothing was ever opened');
  assert.equal(actionsOf(out.actions, 'EXIT_MARKET').length, 0);
  assert.equal(actionsOf(out.actions, 'PLACE_SELL').length, 0);
});

test('a rejected sell returns to waiting rather than retrying the same price', () => {
  const r = m.reduce(leg({ state: STATES.SELL_WORKING, sellOrderId: 11, sellPriceP: 1340 }),
    { type: 'SELL_REJECTED', reason: 'insufficient margin', tsMs: T0 }, cfg());
  assert.equal(r.state, STATES.WAIT_CANDLE);
  assert.equal(r.patch.sellPriceP, null);
  assert.equal(actionsOf(r.actions, 'PLACE_SELL').length, 0);
});

/* ------------------------------------------------------------------ exits */

test('a tick at or above the stop starts the exit — but only after cancelling the target', () => {
  const open = leg({
    state: STATES.POSITION_OPEN, filledPriceP: 1340, targetPriceP: 1240,
    slPriceP: 1540, targetOrderId: 12, filledQty: 75, openedAt: T0,
  });

  const below = m.reduce(open, { type: 'TICK', ltpPaise: 1539, tsMs: T0 + 1000 }, cfg());
  assert.equal(below.state, STATES.POSITION_OPEN);

  const hit = m.reduce(open, { type: 'TICK', ltpPaise: 1540, tsMs: T0 + 2000 }, cfg());
  assert.equal(hit.state, STATES.EXITING);
  assert.equal(actionsOf(hit.actions, 'CANCEL_TARGET').length, 1);
  // INVARIANT I3: no exit order is emitted before the cancel is confirmed.
  assert.equal(actionsOf(hit.actions, 'EXIT_MARKET').length, 0);
});

test('the exit market order is emitted only once the cancel confirms', () => {
  const exiting = leg({
    state: STATES.EXITING, exitReason: 'STOPLOSS', targetOrderId: 12, filledQty: 75,
  });
  const r = m.reduce(exiting, { type: 'TARGET_CANCELLED', tsMs: T0 }, cfg());
  const exits = actionsOf(r.actions, 'EXIT_MARKET');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].reason, 'STOPLOSS');
  assert.equal(exits[0].qty, 75);
});

test('if the target won the cancel race, NO exit order is sent', () => {
  // The dangerous case. Sending an exit here would open a naked long on a
  // position that is already flat.
  const exiting = leg({
    state: STATES.EXITING, exitReason: 'STOPLOSS', targetOrderId: 12,
    targetPriceP: 1240, filledQty: 75,
  });
  const r = m.reduce(exiting, { type: 'TARGET_CANCEL_FAILED_FILLED', tsMs: T0 }, cfg());

  assert.equal(r.state, STATES.DONE);
  assert.equal(r.patch.exitReason, 'TARGET');
  assert.equal(actionsOf(r.actions, 'EXIT_MARKET').length, 0, 'no second exit');
  assert.equal(actionsOf(r.actions, 'CLOSE_LEG')[0].reason, 'TARGET');
  assert.equal(logsOf(r.actions, 'TARGET_WON_RACE').length, 1);
});

test('a target fill arriving during EXITING is a flat position, not an error', () => {
  const exiting = leg({ state: STATES.EXITING, exitReason: 'TIMEOUT', filledQty: 75 });
  const r = m.reduce(exiting, { type: 'TARGET_FILLED', filledPriceP: 1240, tsMs: T0 }, cfg());
  assert.equal(r.state, STATES.DONE);
  assert.equal(logsOf(r.actions, 'TARGET_WON_RACE').length, 1);
});

test('the position timeout waits the full hold time', () => {
  const open = leg({
    state: STATES.POSITION_OPEN, openedAt: T0, targetOrderId: 12, filledQty: 75,
    filledPriceP: 1340, slPriceP: 1540,
  });
  assert.equal(m.reduce(open, { type: 'POSITION_TIMEOUT', tsMs: T0 + 59000 }, cfg()).state,
    STATES.POSITION_OPEN);
  const out = m.reduce(open, { type: 'POSITION_TIMEOUT', tsMs: T0 + 60001 }, cfg());
  assert.equal(out.state, STATES.EXITING);
  assert.equal(out.patch.exitReason, 'TIMEOUT');
});

/* ------------------------------------------------------ fills mid-cancel */

test('a fill that lands while the cancel is in flight opens the position', () => {
  // The cancel lost the race. That is a filled short, not an error.
  const cancelling = leg({ state: STATES.SELL_CANCELLING, sellOrderId: 11, sellPriceP: 1340 });
  const r = m.reduce(cancelling,
    { type: 'SELL_FILLED', filledPriceP: 1340, filledQty: 75, tsMs: T0 }, cfg());
  assert.equal(r.state, STATES.POSITION_OPEN);
  assert.equal(r.patch.targetPriceP, 1240);
  assert.equal(r.patch.slPriceP, 1540);
  assert.equal(actionsOf(r.actions, 'PLACE_TARGET').length, 1);
});

/* --------------------------------------------------------- halt / squareoff */

test('square-off from an open position goes through the same cancel-first door', () => {
  const open = leg({ state: STATES.POSITION_OPEN, targetOrderId: 12, filledQty: 75, filledPriceP: 1340 });
  const r = m.reduce(open, { type: 'SQUARE_OFF', tsMs: T0 }, cfg());
  assert.equal(r.state, STATES.EXITING);
  assert.equal(r.patch.exitReason, 'SQUAREOFF');
  assert.equal(actionsOf(r.actions, 'CANCEL_TARGET').length, 1);
  assert.equal(actionsOf(r.actions, 'EXIT_MARKET').length, 0);
});

test('square-off on a flat leg simply stops it', () => {
  const r = m.reduce(leg({ state: STATES.WAIT_CANDLE }), { type: 'SQUARE_OFF', tsMs: T0 }, cfg());
  assert.equal(r.state, STATES.DONE);
});

test('a halt stops new entries but never abandons an open position', () => {
  const waiting = m.reduce(leg({ state: STATES.WAIT_CANDLE }),
    { type: 'HALT', reason: 'daily loss limit', tsMs: T0 }, cfg());
  assert.equal(waiting.state, STATES.DONE);

  const open = leg({ state: STATES.POSITION_OPEN, targetOrderId: 12, filledQty: 75 });
  const held = m.reduce(open, { type: 'HALT', reason: 'daily loss limit', tsMs: T0 }, cfg());
  assert.equal(held.state, STATES.POSITION_OPEN, 'an open short keeps being managed');
  assert.equal(held.actions.length, 0);
});

test('a leg cancelling because of a halt stops instead of re-arming', () => {
  const cancelling = leg({ state: STATES.SELL_CANCELLING, haltAfterCancel: true, sellOrderId: 11 });
  const r = m.afterSellCancel(cancelling, T0);
  assert.equal(r.state, STATES.DONE);
});

/* --------------------------------------------------------------- hygiene */

test('events that do not belong to the current state are ignored, not thrown', () => {
  // A duplicate fill report or a late timeout must not corrupt the leg.
  for (const state of Object.values(STATES)) {
    for (const type of ['SELL_FILLED', 'TARGET_FILLED', 'PENDING_TIMEOUT', 'TICK', 'EXIT_FILLED']) {
      const r = m.reduce(
        leg({ state, filledQty: 75, slPriceP: 1540, openedAt: T0, sellPlacedAt: T0 }),
        { type, tsMs: T0, filledPriceP: 1240, filledQty: 75, ltpPaise: 1000 },
        cfg());
      assert.ok(Object.values(STATES).includes(r.state), `${state} + ${type} left a valid state`);
    }
  }
});

test('an unknown event is a no-op', () => {
  const r = m.reduce(leg({ state: STATES.POSITION_OPEN }), { type: 'NONSENSE' }, cfg());
  assert.equal(r.state, STATES.POSITION_OPEN);
  assert.equal(r.actions.length, 0);
});
