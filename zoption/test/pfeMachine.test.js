// The Price-Filter Engine's state machine.
//
// The invariants at the bottom of this file are the ones that cost money if
// they break, and they are asserted against the SOURCE as well as against
// behaviour — a future branch that learns to send an exit without a confirmed
// cancel behind it must fail the build, not merely fail to be tested.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const h = require('./pfeHelpers');
const machine = require('../src/pfe/machine');

const { STATES, EXIT_REASONS } = machine;

const armed = (over = {}) => h.trade({ state: STATES.ARMED, armedAt: 1000, waitingSince: 1000, ...over });
const open = (over = {}) => h.trade({
  state: STATES.POSITION_OPEN,
  filledPriceP: 2000, filledQty: 75, targetPriceP: 1900, slPriceP: 2200,
  trailPeakP: 2000, targetOrderId: 55, openedAt: 1000, attemptSeq: 1,
  ...over,
});

/* --------------------------------------------------------------- arming -- */

test('ARM moves an idle trade to ARMED and starts its clock', () => {
  const { trade, actions } = h.run(h.trade(), [{ type: 'ARM', tsMs: 1000, symbol: 'X' }]);
  assert.equal(trade.state, STATES.ARMED);
  assert.equal(trade.waitingSince, 1000);
  assert.equal(h.logsOf(actions, 'ARMED').length, 1);
});

test('an armed contract that never gets a chance is released, not held forever', () => {
  const { trade, actions } = h.run(armed(), [{ type: 'ARM_TIMEOUT', tsMs: 1000 + 120000 }]);
  assert.equal(trade.state, STATES.DONE);
  assert.equal(trade.exitReason, EXIT_REASONS.NO_ENTRY);
  assert.equal(h.logsOf(actions, 'NO_ENTRY').length, 1);
});

test('the release timer does not fire early', () => {
  const { trade } = h.run(armed(), [{ type: 'ARM_TIMEOUT', tsMs: 1000 + 119999 }]);
  assert.equal(trade.state, STATES.ARMED);
});

/* -------------------------------------------------- Module 5, the entry -- */

test('a tradable candle prices the sell at close + offset and sends it', () => {
  const { trade, actions } = h.run(armed(), [{
    type: 'OPTION_CANDLE', candle: h.optionBar({ closeP: 2000 }), entryOk: true, tsMs: 2000,
  }]);
  assert.equal(trade.state, STATES.SELL_WORKING);
  assert.equal(trade.sellPriceP, 2010);
  const [place] = h.actionsOf(actions, 'PLACE_SELL');
  assert.equal(place.pricePaise, 2010);
  assert.equal(place.attemptSeq, 1);
});

test('a refused gate keeps the trade armed and records why', () => {
  const { trade, actions } = h.run(armed(), [{
    type: 'OPTION_CANDLE', candle: h.optionBar(), entryOk: false,
    entryReason: 'the index turned', tsMs: 2000,
  }]);
  assert.equal(trade.state, STATES.ARMED);
  assert.equal(h.actionsOf(actions, 'PLACE_SELL').length, 0);
  assert.equal(h.logsOf(actions, 'ENTRY_REJECTED')[0].reason, 'the index turned');
});

test('a synthetic bar never prices an order', () => {
  const { trade, actions } = h.run(armed(), [{
    type: 'OPTION_CANDLE',
    candle: h.optionBar({ synthetic: true, tradable: false, tickCount: 0 }),
    entryOk: true, tsMs: 2000,
  }]);
  assert.equal(trade.state, STATES.ARMED);
  assert.equal(h.actionsOf(actions, 'PLACE_SELL').length, 0);
  assert.match(h.logsOf(actions, 'CANDLE_SKIPPED')[0].reason, /synthetic/);
});

test('an unfilled limit is cancelled and then WAITS for the next candle', () => {
  const working = h.trade({
    state: STATES.SELL_WORKING, sellOrderId: 9, sellPlacedAt: 1000, sellPriceP: 2010,
  });
  const { trade, actions } = h.run(working, [
    { type: 'PENDING_TIMEOUT', tsMs: 1000 + 5000 },
    { type: 'SELL_CANCELLED', tsMs: 1000 + 5100 },
  ]);
  assert.equal(h.actionsOf(actions, 'CANCEL_SELL').length, 1);
  assert.equal(trade.state, STATES.ARMED, 'not requoted immediately');
  assert.equal(trade.sellPriceP, null);
});

test('a working sell is withdrawn when the filter that justified it turns', () => {
  const working = h.trade({ state: STATES.SELL_WORKING, sellOrderId: 9, sellPlacedAt: 1000 });
  const { trade, actions } = h.run(working, [
    { type: 'FILTER_FAIL', reason: 'the index fell below the bullish mid', tsMs: 2000 },
  ]);
  assert.equal(trade.state, STATES.SELL_CANCELLING);
  assert.equal(h.actionsOf(actions, 'CANCEL_SELL').length, 1);
  assert.equal(trade.haltAfterCancel, false, 'a withdrawn quote is not a stop');
});

test('a fill that beats a cancel is still a filled short', () => {
  const cancelling = h.trade({ state: STATES.SELL_CANCELLING, sellOrderId: 9 });
  const { trade } = h.run(cancelling, [
    { type: 'SELL_FILLED', filledPriceP: 2010, filledQty: 75, tsMs: 3000 },
  ]);
  assert.equal(trade.state, STATES.POSITION_OPEN);
  assert.equal(trade.filledPriceP, 2010);
});

test('a fill sets the brackets off the fill and rests a target', () => {
  const working = h.trade({ state: STATES.SELL_WORKING, sellOrderId: 9 });
  const { trade, actions } = h.run(working, [
    { type: 'SELL_FILLED', filledPriceP: 2000, filledQty: 75, tsMs: 3000 },
  ]);
  assert.equal(trade.state, STATES.POSITION_OPEN);
  assert.equal(trade.targetPriceP, 1900);
  assert.equal(trade.slPriceP, 2200);
  assert.equal(trade.trailPeakP, 2000, 'the best price starts at the fill');
  assert.equal(h.actionsOf(actions, 'PLACE_TARGET')[0].pricePaise, 1900);
});

/* --------------------------------------------------- Module 8, the ladder */

test('a confirmation cancels the resting target before replacing it', () => {
  const { trade, actions } = h.run(open(), [{ type: 'CONFIRMED', tsMs: 4000 }]);
  assert.equal(trade.state, STATES.TARGET_MOVING);
  assert.equal(trade.confirmations, 1);
  assert.equal(trade.pendingTargetP, 1800);
  assert.equal(h.actionsOf(actions, 'CANCEL_TARGET').length, 1);
  assert.equal(h.actionsOf(actions, 'PLACE_TARGET').length, 0,
    'nothing is placed until the cancel confirms');
});

test('...and places the new rung only once the cancel confirms', () => {
  const { trade, actions } = h.run(open(), [
    { type: 'CONFIRMED', tsMs: 4000 },
    { type: 'TARGET_CANCELLED', tsMs: 4100 },
  ]);
  assert.equal(trade.state, STATES.POSITION_OPEN);
  assert.equal(trade.targetPriceP, 1800);
  assert.equal(h.actionsOf(actions, 'PLACE_TARGET')[0].pricePaise, 1800);
});

test('past the top of the ladder the target is withdrawn and the trail takes over', () => {
  const { trade, actions } = h.run(open({ confirmations: 3 }), [
    { type: 'CONFIRMED', tsMs: 4000 },
    { type: 'TARGET_CANCELLED', tsMs: 4100 },
  ]);
  assert.equal(trade.confirmations, 4);
  assert.equal(trade.trailingOnly, true);
  assert.equal(trade.targetPriceP, null);
  assert.equal(trade.state, STATES.POSITION_OPEN);
  assert.equal(h.actionsOf(actions, 'PLACE_TARGET').length, 0);
});

test('the ladder never walks the target backwards', () => {
  // A configuration whose step is smaller than the initial target would
  // otherwise turn a move going our way into a smaller win.
  const wide = open({ targetPriceP: 1700 });          // already 3 points out
  const { trade, actions } = h.run(wide, [{ type: 'CONFIRMED', tsMs: 4000 }],
    h.cfg({ targetP: 100, stepP: 10 }));
  assert.equal(trade.state, STATES.POSITION_OPEN, 'no cancel, no replacement');
  assert.equal(trade.targetPriceP, 1700);
  assert.equal(h.actionsOf(actions, 'CANCEL_TARGET').length, 0);
});

test('with dynamicTarget off a confirmation only counts', () => {
  const { trade, actions } = h.run(open(), [{ type: 'CONFIRMED', tsMs: 4000 }],
    h.cfg({ dynamicTarget: false }));
  assert.equal(trade.state, STATES.POSITION_OPEN);
  assert.equal(trade.confirmations, 1);
  assert.equal(h.actionsOf(actions, 'CANCEL_TARGET').length, 0);
});

/* ------------------------------------------------- Module 9, the trailing */

test('a tick that improves the best price trails the stop down', () => {
  const { trade, actions } = h.run(open(), [{ type: 'TICK', ltpPaise: 1920, tsMs: 5000 }]);
  assert.equal(trade.trailPeakP, 1920);
  assert.equal(trade.slPriceP, 2020);
  assert.equal(trade.trails, 1);
  assert.equal(h.logsOf(actions, 'TRAIL_STOP').length, 1);
});

test('an adverse tick never widens the stop', () => {
  // The trail has already tightened to its floor against a best of 19.00, so
  // there is nothing left to give: a tick back up to 19.60 must move neither the
  // best price nor the stop.
  const { trade, actions } = h.run(open({ trailPeakP: 1900, slPriceP: 1940, trails: 3 }),
    [{ type: 'TICK', ltpPaise: 1960, tsMs: 5000 }]);
  assert.equal(trade.slPriceP, 1940);
  assert.equal(trade.trailPeakP, 1900);
  assert.equal(h.logsOf(actions, 'TRAIL_STOP').length, 0);
});

test('the trail keeps catching up to an established best, but only downwards', () => {
  // Same best, but the gap has not finished tightening. The stop moves DOWN to
  // 19.00 + 0.80 — which is the trail working, not widening.
  const { trade } = h.run(open({ trailPeakP: 1900, slPriceP: 2000, trails: 1 }),
    [{ type: 'TICK', ltpPaise: 1960, tsMs: 5000 }]);
  assert.equal(trade.slPriceP, 1980);
  assert.ok(trade.slPriceP < 2000, 'a stop may only ever come down');
});

/* --------------------------------------------------- Module 10, the exits */

// The safety margin is widened for these two so the STOP is the thing being
// tested. On the shipped defaults it is not — see the test below it.
const stopOnly = h.cfg({ safetyMarginP: 500 });

test('the stop being hit cancels the target FIRST and sends nothing yet', () => {
  const { trade, actions } = h.run(open(), [{ type: 'TICK', ltpPaise: 2250, tsMs: 5000 }], stopOnly);
  assert.equal(trade.state, STATES.EXITING);
  assert.equal(trade.exitReason, EXIT_REASONS.STOPLOSS);
  assert.equal(h.actionsOf(actions, 'CANCEL_TARGET').length, 1);
  assert.equal(h.actionsOf(actions, 'EXIT_MARKET').length, 0);
});

test('...and the market buy-back goes only once that cancel is confirmed', () => {
  const { trade, actions } = h.run(open(), [
    { type: 'TICK', ltpPaise: 2250, tsMs: 5000 },
    { type: 'TARGET_CANCELLED', tsMs: 5100 },
  ], stopOnly);
  assert.equal(trade.state, STATES.EXITING);
  const [exit] = h.actionsOf(actions, 'EXIT_MARKET');
  assert.equal(exit.reason, EXIT_REASONS.STOPLOSS);
  assert.equal(exit.qty, 75);
});

test('on the shipped defaults the premium safety exit pre-empts the stop entirely', () => {
  // doc/new.md sets both to 2 points, so the configured stop-loss level is never
  // reached: the safety exit fires at the same premium and names itself. This is
  // exactly what settings.validate() warns about, asserted rather than assumed.
  const { trade } = h.run(open(), [{ type: 'TICK', ltpPaise: 2200, tsMs: 5000 }]);
  assert.equal(trade.state, STATES.EXITING);
  assert.equal(trade.exitReason, EXIT_REASONS.PREMIUM_SAFETY);
});

test('the safety exit still fires when the stop has been trailed out of reach', () => {
  const { trade } = h.run(open({ slPriceP: 2400 }), [{ type: 'TICK', ltpPaise: 2200, tsMs: 5000 }]);
  assert.equal(trade.exitReason, EXIT_REASONS.PREMIUM_SAFETY);
});

test('a filter failure on an open position is an exit, not a stop-loss', () => {
  const { trade, actions } = h.run(open(), [
    { type: 'FILTER_FAIL', reason: 'the index fell to the bullish mid', tsMs: 5000 },
    { type: 'TARGET_CANCELLED', tsMs: 5100 },
  ]);
  assert.equal(trade.exitReason, EXIT_REASONS.FILTER_FAIL);
  assert.equal(h.actionsOf(actions, 'EXIT_MARKET')[0].reason, EXIT_REASONS.FILTER_FAIL);
});

test('a trend break is its own exit reason', () => {
  const { trade } = h.run(open(), [{ type: 'TREND_BREAK', reason: 'structure gone', tsMs: 5000 }]);
  assert.equal(trade.exitReason, EXIT_REASONS.TREND_BREAK);
});

test('the maximum hold outranks the ladder', () => {
  const { trade } = h.run(open(), [{ type: 'MAX_HOLD', tsMs: 1000 + 90000 }]);
  assert.equal(trade.state, STATES.EXITING);
  assert.equal(trade.exitReason, EXIT_REASONS.MAX_HOLD);
});

test('the maximum hold does not fire early', () => {
  const { trade } = h.run(open(), [{ type: 'MAX_HOLD', tsMs: 1000 + 89999 }]);
  assert.equal(trade.state, STATES.POSITION_OPEN);
});

test('an exit that arrives during a target move overtakes the replacement', () => {
  const { trade, actions } = h.run(open(), [
    { type: 'CONFIRMED', tsMs: 4000 },                       // -> TARGET_MOVING
    { type: 'MAX_HOLD', tsMs: 1000 + 90000 },                // records pendingExit
    { type: 'TARGET_CANCELLED', tsMs: 4200 },
  ]);
  assert.equal(trade.state, STATES.EXITING);
  assert.equal(h.actionsOf(actions, 'EXIT_MARKET').length, 1);
  assert.equal(h.actionsOf(actions, 'PLACE_TARGET').length, 0,
    'sending both is exactly the naked long this design prevents');
  assert.equal(h.logsOf(actions, 'RETARGET_ABANDONED').length, 1);
});

test('a cancel that comes back ALREADY FILLED books the target and sends nothing', () => {
  const { trade, actions } = h.run(open(), [
    { type: 'TICK', ltpPaise: 2250, tsMs: 5000 },
    { type: 'TARGET_CANCEL_FAILED_FILLED', filledPriceP: 1900, tsMs: 5100 },
  ]);
  assert.equal(trade.state, STATES.DONE);
  assert.equal(trade.exitReason, EXIT_REASONS.TARGET);
  assert.equal(h.actionsOf(actions, 'EXIT_MARKET').length, 0);
  assert.equal(h.actionsOf(actions, 'CLOSE_TRADE')[0].exitPriceP, 1900);
});

test('the target winning a race from TARGET_MOVING is a flat position, not a problem', () => {
  const { trade } = h.run(open(), [
    { type: 'CONFIRMED', tsMs: 4000 },
    { type: 'TARGET_FILLED', filledPriceP: 1900, tsMs: 4100 },
  ]);
  assert.equal(trade.state, STATES.DONE);
  assert.equal(trade.exitReason, EXIT_REASONS.TARGET);
});

test('the square-off flattens an open position and stops an armed one', () => {
  const flat = h.run(open(), [{ type: 'SQUARE_OFF', tsMs: 9000 }]);
  assert.equal(flat.trade.state, STATES.EXITING);
  assert.equal(flat.trade.exitReason, EXIT_REASONS.SQUAREOFF);

  const idle = h.run(armed(), [{ type: 'SQUARE_OFF', tsMs: 9000 }]);
  assert.equal(idle.trade.state, STATES.DONE);
});

test('a halt stops new entries and never abandons an open position', () => {
  const { trade } = h.run(open(), [{ type: 'HALT', reason: 'daily loss', tsMs: 9000 }]);
  assert.equal(trade.state, STATES.POSITION_OPEN,
    'walking away from a live naked short is not a risk control');
});

test('a halted working sell stops rather than re-arming after its cancel', () => {
  const working = h.trade({ state: STATES.SELL_WORKING, sellOrderId: 9 });
  const halted = machine.reduce(working, { type: 'HALT', reason: 'x', tsMs: 1 }, h.cfg());
  const after = machine.afterSellCancel({ ...working, ...halted.patch, state: halted.state }, 2);
  assert.equal(after.state, STATES.DONE);
});

/* ------------------------------------------------------------ invariants -- */

test('I1 — no order price is ever derived from a live quote', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pfe', 'machine.js'), 'utf8');
  // The machine may READ a tick's price for the stop and the safety exit. It may
  // never use one to price an order: every price that reaches an action comes
  // from `rules.*`, which take candles and fills.
  const placements = src.match(/pricePaise:\s*[^,\n]+/g) || [];
  for (const p of placements) {
    assert.equal(/ltp|quote|bid|ask/i.test(p), false, `${p} must not come from a live price`);
  }
});

test('I2 — a trade never has two working SELL orders', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pfe', 'machine.js'), 'utf8');
  const count = (src.match(/type: 'PLACE_SELL'/g) || []).length;
  assert.equal(count, 1, 'there is exactly one place a sell can be constructed');

  // ...and it is only reachable from ARMED.
  for (const state of Object.values(STATES)) {
    if (state === STATES.ARMED) continue;
    const { actions } = h.run(h.trade({ state }), [{
      type: 'OPTION_CANDLE', candle: h.optionBar(), entryOk: true, tsMs: 1,
    }]);
    assert.equal(h.actionsOf(actions, 'PLACE_SELL').length, 0,
      `a candle close must not place a sell from ${state}`);
  }
});

test('I3 — no exit market order exists without a confirmed cancel behind it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pfe', 'machine.js'), 'utf8');
  const sites = (src.match(/type: 'EXIT_MARKET'/g) || []).length;
  assert.equal(sites, 1, 'exactly one construction site, and it sits behind TARGET_CANCELLED');

  // Behaviourally: every exit trigger from an open position must produce a
  // cancel and no exit, until the cancel confirms.
  const triggers = [
    { type: 'TICK', ltpPaise: 2250, tsMs: 5000 },
    { type: 'FILTER_FAIL', reason: 'x', tsMs: 5000 },
    { type: 'TREND_BREAK', reason: 'x', tsMs: 5000 },
    { type: 'LIQUIDITY_FAIL', reason: 'x', tsMs: 5000 },
    { type: 'MAX_HOLD', tsMs: 1000 + 90000 },
    { type: 'SQUARE_OFF', tsMs: 5000 },
  ];
  for (const trigger of triggers) {
    const { actions } = h.run(open(), [trigger]);
    assert.equal(h.actionsOf(actions, 'EXIT_MARKET').length, 0,
      `${trigger.type} must not send an exit while a target is working`);
    assert.equal(h.actionsOf(actions, 'CANCEL_TARGET').length, 1,
      `${trigger.type} must cancel the target first`);
  }
});

test('I4 — a completed round trip is booked exactly once', () => {
  const { actions } = h.run(open(), [
    { type: 'TICK', ltpPaise: 2250, tsMs: 5000 },
    { type: 'TARGET_CANCELLED', tsMs: 5100 },
    { type: 'EXIT_FILLED', filledPriceP: 2250, tsMs: 5200 },
    { type: 'EXIT_FILLED', filledPriceP: 2250, tsMs: 5300 },   // a duplicate report
  ]);
  assert.equal(h.actionsOf(actions, 'CLOSE_TRADE').length, 1);
});
