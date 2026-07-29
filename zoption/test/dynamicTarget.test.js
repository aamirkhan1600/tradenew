// The dynamic target ladder and the trailing stop — doc/traling-traget -stoploss.md.
//
// Two things are being tested here and only one of them is arithmetic. The
// ladder and the trail are easy; what matters is that MOVING a target goes
// through the same confirmed-cancel door an exit does, and that when an exit and
// a target move race each other, the exit wins and no replacement target is ever
// placed. A leg that ends up with a resting BUY and a market BUY has bought its
// short back twice and is now naked long.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ist, leg, cfg, actionsOf, logsOf } = require('./helpers');
const m = require('../src/strategy/legMachine');

const { STATES, EXIT_REASONS } = m;
const T0 = ist('2026-07-29 10:16:00');

// A filled short at 20.00 with the documented starting brackets: target 19.00,
// stop 22.00 — the document's own worked example.
const open = (over = {}) => leg({
  state: STATES.POSITION_OPEN,
  filledPriceP: 2000, filledQty: 75,
  targetPriceP: 1900, slPriceP: 2200,
  targetOrderId: 42, openedAt: T0,
  confirmations: 0, trailPeakP: 2000, trailingOnly: false, pendingExit: null,
  ...over,
});

// Dynamic target on, ladder of 4 × ₹1, trail 0.50 above the best after 0.50 of
// profit — the defaults.
const dyn = (over = {}) => cfg({
  dynamicTarget: true, dynamicStepP: 100, dynamicMax: 4,
  trailStartP: 50, trailGapP: 50, exitOnReversal: true,
  ...over,
});

/* ------------------------------------------------------------- the ladder -- */

test('the ladder is priced off the fill, one step per confirmation', () => {
  assert.equal(m.calculateLadderTarget(2000, 1, 100, 4), 1900);
  assert.equal(m.calculateLadderTarget(2000, 2, 100, 4), 1800);
  assert.equal(m.calculateLadderTarget(2000, 3, 100, 4), 1700);
  assert.equal(m.calculateLadderTarget(2000, 4, 100, 4), 1600);
  assert.equal(m.calculateLadderTarget(2000, 5, 100, 4), null, '5th+ — trail until reversal');
});

test('the ladder never prices a target below one tick', () => {
  assert.equal(m.calculateLadderTarget(150, 4, 100, 9), 5);
});

test('the first confirmation lands on the target already resting, so nothing moves', () => {
  // The initial target IS one step out. The ladder starts biting on the second.
  const r = m.reduce(open(), { type: 'TREND_CONFIRMED', tsMs: T0 + 5000 }, dyn());
  assert.equal(r.state, STATES.POSITION_OPEN);
  assert.equal(r.patch.confirmations, 1);
  assert.equal(r.actions.length, 0);
});

test('a confirmation moves the target through a CONFIRMED cancel, never a bare place', () => {
  const r = m.reduce(open({ confirmations: 1 }), { type: 'TREND_CONFIRMED', tsMs: T0 + 10000 }, dyn());

  assert.equal(r.state, STATES.TARGET_MOVING);
  assert.equal(r.patch.confirmations, 2);
  assert.equal(r.patch.pendingTargetP, 1800);
  assert.equal(actionsOf(r.actions, 'CANCEL_TARGET').length, 1);
  assert.equal(actionsOf(r.actions, 'PLACE_TARGET').length, 0,
    'nothing may be placed until the cancel confirms');
});

test('the ladder never walks the target BACKWARDS into less profit', () => {
  // target 2.00 with a 1.00 step: confirmation 1 prices 19.00 against a target
  // already resting at 18.00. Moving there would shrink a winner.
  const wide = open({ targetPriceP: 1800 });
  const r = m.reduce(wide, { type: 'TREND_CONFIRMED', tsMs: T0 + 5000 }, dyn());
  assert.equal(r.state, STATES.POSITION_OPEN);
  assert.equal(actionsOf(r.actions, 'CANCEL_TARGET').length, 0);
  assert.equal(r.patch.confirmations, 1);
});

test('the replacement is placed only once the cancel confirms', () => {
  const moving = { ...open({ confirmations: 1 }), state: STATES.TARGET_MOVING, pendingTargetP: 1800 };
  const r = m.reduce(moving, { type: 'TARGET_CANCELLED', tsMs: T0 + 5100 }, dyn());

  assert.equal(r.state, STATES.POSITION_OPEN);
  assert.equal(r.patch.targetPriceP, 1800);
  const placed = actionsOf(r.actions, 'PLACE_TARGET');
  assert.equal(placed.length, 1);
  assert.equal(placed[0].pricePaise, 1800);
  assert.equal(placed[0].qty, 75);
});

test('the whole documented run: 20.00 short laddering out to 4 points', () => {
  let state = open();
  const seen = [];
  for (let n = 1; n <= 5; n++) {
    const moved = m.reduce(state, { type: 'TREND_CONFIRMED', tsMs: T0 + n * 5000 }, dyn());
    state = { ...state, ...moved.patch, state: moved.state };
    const done = m.reduce(state, { type: 'TARGET_CANCELLED', tsMs: T0 + n * 5000 + 100 }, dyn());
    state = { ...state, ...done.patch, state: done.state };
    seen.push(state.targetPriceP);
  }
  // Confirmation 1 is a no-op (the resting target is already one step out), so
  // the ladder reads 19.00, 18.00, 17.00, 16.00, then trail-only.
  assert.deepEqual(seen, [1900, 1800, 1700, 1600, null]);
  assert.equal(state.trailingOnly, true);
  assert.equal(state.state, STATES.POSITION_OPEN);
});

test('past the ladder the target is WITHDRAWN and not replaced', () => {
  const top = open({ confirmations: 4, targetPriceP: 1600 });
  const r = m.reduce(top, { type: 'TREND_CONFIRMED', tsMs: T0 + 25000 }, dyn());
  assert.equal(r.state, STATES.TARGET_MOVING);
  assert.equal(r.patch.trailingOnly, true);
  assert.equal(actionsOf(r.actions, 'CANCEL_TARGET').length, 1);

  const after = m.reduce({ ...top, ...r.patch, state: r.state },
    { type: 'TARGET_CANCELLED', tsMs: T0 + 25100 }, dyn());
  assert.equal(after.state, STATES.POSITION_OPEN);
  assert.equal(after.patch.targetPriceP, null, 'no resting target at all');
  assert.equal(actionsOf(after.actions, 'PLACE_TARGET').length, 0);
});

test('a confirmation that does not change the price sends no cancel', () => {
  // Re-confirming at a level already resting must not churn the order book.
  const r = m.reduce(open({ confirmations: 0, targetPriceP: 1900 }),
    { type: 'TREND_CONFIRMED', tsMs: T0 + 5000 }, dyn());
  assert.equal(r.state, STATES.POSITION_OPEN);
  assert.equal(r.actions.length, 0);
  assert.equal(r.patch.confirmations, 1);
});

test('with dynamicTarget off a confirmation does nothing at all', () => {
  const r = m.reduce(open(), { type: 'TREND_CONFIRMED', tsMs: T0 + 5000 },
    dyn({ dynamicTarget: false }));
  assert.equal(r.state, STATES.POSITION_OPEN);
  assert.equal(r.actions.length, 0);
});

/* --------------------------------------------------------------- the trail */

test('the trail follows the document\'s arithmetic: stop = best + gap', () => {
  const args = { filledPriceP: 2000, currentSlP: 2200, trailStartPaise: 50, trailGapPaise: 50 };
  assert.equal(m.calculateTrailStop({ ...args, bestPaise: 1880 }), 1930, '18.80 -> 19.30');
  assert.equal(m.calculateTrailStop({ ...args, bestPaise: 1800 }), 1850, '18.00 -> 18.50');
});

test('the trail does not engage until the position is far enough in profit', () => {
  const args = { filledPriceP: 2000, currentSlP: 2200, trailStartPaise: 50, trailGapPaise: 50 };
  assert.equal(m.calculateTrailStop({ ...args, bestPaise: 1980 }), null, '0.20 of profit');
  assert.equal(m.calculateTrailStop({ ...args, bestPaise: 1950 }), 2000, '0.50 — breakeven stop');
});

test('the trail NEVER widens', () => {
  // The document is explicit: 22.00 -> 21.20 -> 20.50 -> 19.80, never back out.
  const args = { filledPriceP: 2000, trailStartPaise: 50, trailGapPaise: 50 };
  assert.equal(m.calculateTrailStop({ ...args, bestPaise: 1800, currentSlP: 1850 }), null,
    'already there — no move');
  assert.equal(m.calculateTrailStop({ ...args, bestPaise: 1900, currentSlP: 1850 }), null,
    'a worse level than the stop already holds must be refused');
});

test('trailGap 0 disables trailing entirely', () => {
  assert.equal(m.calculateTrailStop({
    filledPriceP: 2000, bestPaise: 1700, currentSlP: 2200, trailStartPaise: 50, trailGapPaise: 0,
  }), null);
});

test('a tick tightens the stop and records the new high-water mark', () => {
  const r = m.reduce(open(), { type: 'TICK', ltpPaise: 1880, tsMs: T0 + 3000 }, dyn());
  assert.equal(r.state, STATES.POSITION_OPEN, 'still open — this is a profit, not a stop');
  assert.equal(r.patch.trailPeakP, 1880);
  assert.equal(r.patch.slPriceP, 1930);
  assert.equal(logsOf(r.actions, 'TRAIL_STOP').length, 1);
  assert.equal(logsOf(r.actions, 'TRAIL_STOP')[0].lockedP, 70, '0.70 locked in');
});

test('an adverse tick does not move the high-water mark', () => {
  const r = m.reduce(open({ trailPeakP: 1880, slPriceP: 1930 }),
    { type: 'TICK', ltpPaise: 1910, tsMs: T0 + 4000 }, dyn());
  assert.equal(r.patch.trailPeakP, undefined, 'the best price stands');
  assert.equal(r.patch.slPriceP, undefined, 'and so does the stop');
  assert.equal(r.state, STATES.POSITION_OPEN);
});

test('a trailed stop is what actually fires', () => {
  // Stop trailed to 19.30; the premium comes back to 19.30 and the trade is
  // closed in PROFIT, which is the entire point of the feature.
  const r = m.reduce(open({ trailPeakP: 1880, slPriceP: 1930 }),
    { type: 'TICK', ltpPaise: 1930, tsMs: T0 + 5000 }, dyn());
  assert.equal(r.state, STATES.EXITING);
  assert.equal(r.patch.exitReason, EXIT_REASONS.STOPLOSS);
  assert.equal(actionsOf(r.actions, 'CANCEL_TARGET').length, 1);
  assert.equal(actionsOf(r.actions, 'EXIT_MARKET').length, 0, 'not until the cancel confirms');
});

/* ------------------------------------------------------------- the reversal */

test('a reversal exits through the same confirmed-cancel door', () => {
  const r = m.reduce(open({ confirmations: 3 }),
    { type: 'TREND_REVERSED', reason: 'the index is choppy', tsMs: T0 + 20000 }, dyn());
  assert.equal(r.state, STATES.EXITING);
  assert.equal(r.patch.exitReason, EXIT_REASONS.REVERSAL);
  assert.equal(actionsOf(r.actions, 'CANCEL_TARGET').length, 1);
  assert.equal(actionsOf(r.actions, 'EXIT_MARKET').length, 0);

  const after = m.reduce({ ...open(), ...r.patch, state: r.state },
    { type: 'TARGET_CANCELLED', tsMs: T0 + 20100 }, dyn());
  const exits = actionsOf(after.actions, 'EXIT_MARKET');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].reason, EXIT_REASONS.REVERSAL);
});

test('exitOnReversal off leaves the position to its target, stop and clock', () => {
  const r = m.reduce(open(), { type: 'TREND_REVERSED', reason: 'choppy', tsMs: T0 + 20000 },
    dyn({ exitOnReversal: false }));
  assert.equal(r.state, STATES.POSITION_OPEN);
  assert.equal(r.actions.length, 0);
});

/* ------------------------------------------------- the races that must not lose */

test('a stop that fires mid-move waits for the cancel, then exits — and no target is replaced', () => {
  // THE case this state exists for. A cancel is already in flight to move the
  // target; the stop hits before it confirms. Sending an exit now would race the
  // replacement, and replacing the target after the exit would leave a resting
  // BUY against a position that is already flat.
  const moving = {
    ...open({ confirmations: 2 }), state: STATES.TARGET_MOVING,
    pendingTargetP: 1800, trailPeakP: 1880, slPriceP: 1930,
  };

  const hit = m.reduce(moving, { type: 'TICK', ltpPaise: 1935, tsMs: T0 + 6000 }, dyn());
  assert.equal(hit.state, STATES.TARGET_MOVING, 'stays put — the cancel is still out');
  assert.equal(hit.patch.pendingExit, EXIT_REASONS.STOPLOSS);
  assert.equal(actionsOf(hit.actions, 'EXIT_MARKET').length, 0);
  assert.equal(actionsOf(hit.actions, 'CANCEL_TARGET').length, 0, 'no second cancel');

  const settled = m.reduce({ ...moving, ...hit.patch }, { type: 'TARGET_CANCELLED', tsMs: T0 + 6100 }, dyn());
  assert.equal(settled.state, STATES.EXITING);
  assert.equal(settled.patch.exitReason, EXIT_REASONS.STOPLOSS);
  assert.equal(actionsOf(settled.actions, 'EXIT_MARKET').length, 1);
  assert.equal(actionsOf(settled.actions, 'PLACE_TARGET').length, 0,
    'THE assertion: the replacement target is abandoned');
  assert.equal(settled.patch.pendingTargetP, null);
});

test('a reversal mid-move also abandons the replacement', () => {
  const moving = { ...open(), state: STATES.TARGET_MOVING, pendingTargetP: 1800 };
  const rev = m.reduce(moving, { type: 'TREND_REVERSED', reason: 'turned', tsMs: T0 + 6000 }, dyn());
  assert.equal(rev.patch.pendingExit, EXIT_REASONS.REVERSAL);

  const settled = m.reduce({ ...moving, ...rev.patch }, { type: 'TARGET_CANCELLED', tsMs: T0 + 6100 }, dyn());
  assert.equal(settled.state, STATES.EXITING);
  assert.equal(actionsOf(settled.actions, 'PLACE_TARGET').length, 0);
  assert.equal(actionsOf(settled.actions, 'EXIT_MARKET')[0].reason, EXIT_REASONS.REVERSAL);
});

test('the maximum hold outranks the ladder, mid-move included', () => {
  const moving = { ...open(), state: STATES.TARGET_MOVING, pendingTargetP: 1800 };
  const late = m.reduce(moving, { type: 'POSITION_TIMEOUT', tsMs: T0 + 60001 }, dyn());
  assert.equal(late.patch.pendingExit, EXIT_REASONS.TIMEOUT);

  const settled = m.reduce({ ...moving, ...late.patch }, { type: 'TARGET_CANCELLED', tsMs: T0 + 60100 }, dyn());
  assert.equal(settled.state, STATES.EXITING);
  assert.equal(actionsOf(settled.actions, 'PLACE_TARGET').length, 0);
  assert.equal(actionsOf(settled.actions, 'EXIT_MARKET')[0].reason, EXIT_REASONS.TIMEOUT);
});

test('a trailing winner is still cut off by the maximum hold', () => {
  const running = open({ confirmations: 6, trailingOnly: true, targetPriceP: null, slPriceP: 1850 });
  const r = m.reduce(running, { type: 'POSITION_TIMEOUT', tsMs: T0 + 60001 }, dyn());
  assert.equal(r.state, STATES.EXITING);
  assert.equal(r.patch.exitReason, EXIT_REASONS.TIMEOUT);
});

test('the square-off reaches a leg mid-move', () => {
  const moving = { ...open(), state: STATES.TARGET_MOVING, pendingTargetP: 1800 };
  const r = m.reduce(moving, { type: 'SQUARE_OFF', tsMs: T0 + 100000 }, dyn());
  assert.equal(r.patch.pendingExit, EXIT_REASONS.SQUAREOFF);

  const settled = m.reduce({ ...moving, ...r.patch }, { type: 'TARGET_CANCELLED', tsMs: T0 + 100100 }, dyn());
  assert.equal(actionsOf(settled.actions, 'EXIT_MARKET')[0].reason, EXIT_REASONS.SQUAREOFF);
});

test('a target that fills while being moved is a flat position, not an error', () => {
  const moving = { ...open(), state: STATES.TARGET_MOVING, pendingTargetP: 1800 };

  const won = m.reduce(moving, { type: 'TARGET_FILLED', filledPriceP: 1900, tsMs: T0 + 6000 }, dyn());
  assert.equal(won.state, STATES.DONE);
  assert.equal(won.patch.exitReason, EXIT_REASONS.TARGET);
  assert.equal(actionsOf(won.actions, 'CLOSE_LEG')[0].exitPriceP, 1900);
  assert.equal(logsOf(won.actions, 'TARGET_WON_RACE').length, 1);

  // And the same when the broker refuses the cancel because it already executed.
  const refused = m.reduce(moving,
    { type: 'TARGET_CANCEL_FAILED_FILLED', filledPriceP: 1900, tsMs: T0 + 6000 }, dyn());
  assert.equal(refused.state, STATES.DONE);
  assert.equal(actionsOf(refused.actions, 'CLOSE_LEG').length, 1);
  assert.equal(actionsOf(refused.actions, 'EXIT_MARKET').length, 0,
    'sending anything here would open a naked long');
});

test('no path out of TARGET_MOVING ever emits both a target and an exit', () => {
  // Exhaustive over every event the state accepts. One order out, at most.
  const moving = {
    ...open({ confirmations: 2 }), state: STATES.TARGET_MOVING,
    pendingTargetP: 1800, trailPeakP: 1880, slPriceP: 1930,
  };
  const events = [
    { type: 'TICK', ltpPaise: 1935, tsMs: T0 + 6000 },
    { type: 'TICK', ltpPaise: 1700, tsMs: T0 + 6000 },
    { type: 'TREND_REVERSED', reason: 'turned', tsMs: T0 + 6000 },
    { type: 'TREND_CONFIRMED', tsMs: T0 + 6000 },
    { type: 'POSITION_TIMEOUT', tsMs: T0 + 60001 },
    { type: 'SQUARE_OFF', tsMs: T0 + 100000 },
    { type: 'TARGET_CANCELLED', tsMs: T0 + 6100 },
    { type: 'TARGET_FILLED', filledPriceP: 1900, tsMs: T0 + 6000 },
    { type: 'TARGET_CANCEL_FAILED_FILLED', filledPriceP: 1900, tsMs: T0 + 6000 },
    { type: 'EXIT_FILLED', filledPriceP: 1930, tsMs: T0 + 6000 },
  ];
  for (const event of events) {
    const r = m.reduce(moving, event, dyn());
    const places = actionsOf(r.actions, 'PLACE_TARGET').length;
    const exits = actionsOf(r.actions, 'EXIT_MARKET').length;
    assert.ok(places + exits <= 1,
      `${event.type} produced ${places} target(s) and ${exits} exit(s)`);
    assert.ok(actionsOf(r.actions, 'CANCEL_TARGET').length === 0,
      `${event.type} sent a second cancel while one was already in flight`);
  }
});
