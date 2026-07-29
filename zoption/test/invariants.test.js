// The three invariants whose violation costs money. Each gets a dedicated test
// because each one is easy to break with a well-meaning refactor and expensive
// to discover in a live session.
//
//   I1  No order is ever priced from a quote, tick, ask, bid or LTP.
//   I2  A leg never has two working SELL orders.
//   I3  No exit market order is sent while a target order is still working.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ist, leg, cfg, candle } = require('./helpers');
const m = require('../src/strategy/legMachine');

const { STATES } = m;
const T0 = ist('2026-07-28 10:16:00');
const SRC = path.join(__dirname, '..', 'src');

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/* ============================ I1 — the entry price is a candle ============ */

test('I1: calculateSellPrice takes exactly a candle and an offset', () => {
  // Arity is the cheapest possible guard: a third parameter is the shape a
  // "just clamp it to the ask" change would take.
  assert.equal(m.calculateSellPrice.length, 2);
});

test('I1: no live-price symbol is reachable from the pricing functions', () => {
  const source = read('strategy/legMachine.js');

  // Strip comments — this file explains at length why it must not touch a
  // quote, and those sentences must not fail the test that enforces it.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const forbidden = /\b(ltp|ltpPaise|quote|bestAsk|askPrice|bidPrice|lastPrice|ticker)\b/i;

  // The pricing helpers, extracted by name.
  for (const fn of ['calculateSellPrice', 'calculateTargetPrice', 'calculateStopPrice']) {
    const start = code.indexOf(`function ${fn}`);
    assert.ok(start >= 0, `${fn} not found`);
    const body = code.slice(start, code.indexOf('\n}', start) + 2);
    assert.doesNotMatch(body, forbidden, `${fn} references a live price`);
  }

  // And the CANDLE_CLOSED branch, which is where an entry price is decided.
  const branch = code.slice(code.indexOf("case 'CANDLE_CLOSED'"), code.indexOf("case 'SELL_PLACED'"));
  assert.ok(branch.length > 100, 'the CANDLE_CLOSED branch was not located');
  // `ltpPaise` must not appear here; the gate verdict arrives as a boolean.
  assert.doesNotMatch(branch, /\bltpPaise\b/, 'the entry branch reads a live price');
  assert.match(branch, /gateOk/, 'the gate verdict should arrive as a boolean');
});

test('I1: the only tick-driven decision in the machine is the stop-loss', () => {
  const code = read('strategy/legMachine.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const tickBranch = code.slice(code.indexOf("case 'TICK'"), code.indexOf("case 'POSITION_TIMEOUT'"));
  // A tick may compare against the stop. It must not place a sell.
  assert.doesNotMatch(tickBranch, /PLACE_SELL/, 'a tick must never price an entry');
});

test('I1: a TICK event cannot produce a sell order from any state', () => {
  for (const state of Object.values(STATES)) {
    const r = m.reduce(
      leg({ state, filledPriceP: 1340, slPriceP: 1540, targetOrderId: 12, filledQty: 75 }),
      { type: 'TICK', ltpPaise: 1200, tsMs: T0 }, cfg());
    assert.equal(r.actions.filter(a => a.type === 'PLACE_SELL').length, 0,
      `a tick produced a sell from ${state}`);
  }
});

/* ============================ I2 — one working sell per leg =============== */

test('I2: a second candle close while a sell is working does not place another', () => {
  const working = leg({ state: STATES.SELL_WORKING, sellOrderId: 11, sellPriceP: 1340, sellPlacedAt: T0 });
  const r = m.reduce(working,
    { type: 'CANDLE_CLOSED', candle: candle({ closeP: 1300 }), gateOk: true, tsMs: T0 + 60000 },
    cfg());
  assert.equal(r.state, STATES.SELL_WORKING);
  assert.equal(r.actions.length, 0, 'the working order stands until it times out');
});

test('I2: a sell is placed only from WAIT_CANDLE', () => {
  for (const state of Object.values(STATES)) {
    const r = m.reduce(leg({ state, sellPlacedAt: T0 }),
      { type: 'CANDLE_CLOSED', candle: candle(), gateOk: true, tsMs: T0 }, cfg());
    const placed = r.actions.filter(a => a.type === 'PLACE_SELL').length;
    assert.equal(placed, state === STATES.WAIT_CANDLE ? 1 : 0,
      `state ${state} produced ${placed} sell orders`);
  }
});

test('I2: the cancel/requote cycle never overlaps two sells', () => {
  // Walk the full requote loop and count. Two PLACE_SELLs across two candles is
  // correct; two before a cancel confirms is not.
  let current = leg({ state: STATES.WAIT_CANDLE });
  const placed = [];
  const step = (event) => {
    const r = m.reduce(current, event, cfg());
    current = { ...current, ...r.patch, state: r.state };
    for (const a of r.actions) if (a.type === 'PLACE_SELL') placed.push(current.state);
  };

  step({ type: 'CANDLE_CLOSED', candle: candle(), gateOk: true, tsMs: T0 });
  step({ type: 'SELL_PLACED', orderId: 11, tsMs: T0 });
  // A candle closes while the order is still working — must not place a second.
  step({ type: 'CANDLE_CLOSED', candle: candle({ closeP: 1350 }), gateOk: true, tsMs: T0 + 60000 });
  assert.equal(placed.length, 1);

  step({ type: 'PENDING_TIMEOUT', tsMs: T0 + 61000 });
  // Still cancelling — a candle here must not place either.
  step({ type: 'CANDLE_CLOSED', candle: candle({ closeP: 1360 }), gateOk: true, tsMs: T0 + 62000 });
  assert.equal(placed.length, 1);

  step({ type: 'SELL_CANCELLED', tsMs: T0 + 63000 });
  step({ type: 'CANDLE_CLOSED', candle: candle({ closeP: 1370 }), gateOk: true, tsMs: T0 + 120000 });
  assert.equal(placed.length, 2, 'only after the cancel confirms does a new sell go out');
});

/* ============================ I3 — cancel before exit ==================== */

test('I3: no state emits EXIT_MARKET while a target order is still working', () => {
  const exitTriggers = [
    { type: 'TICK', ltpPaise: 9999, tsMs: T0 },
    { type: 'POSITION_TIMEOUT', tsMs: T0 + 999999 },
    { type: 'SQUARE_OFF', tsMs: T0 },
  ];
  for (const event of exitTriggers) {
    const open = leg({
      state: STATES.POSITION_OPEN, filledPriceP: 1340, slPriceP: 1540,
      targetPriceP: 1240, targetOrderId: 12, filledQty: 75, openedAt: T0,
    });
    const r = m.reduce(open, event, cfg());
    const exits = r.actions.filter(a => a.type === 'EXIT_MARKET');
    const cancels = r.actions.filter(a => a.type === 'CANCEL_TARGET');
    assert.equal(exits.length, 0, `${event.type} sent an exit before cancelling`);
    assert.equal(cancels.length, 1, `${event.type} did not cancel the target`);
  }
});

test('I3: EXIT_MARKET is emitted only by TARGET_CANCELLED', () => {
  const code = require('fs').readFileSync(
    require('path').join(SRC, 'strategy/legMachine.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // Exactly one construction site for the action. More than one means a second
  // path could bypass the cancel.
  const occurrences = (code.match(/type:\s*'EXIT_MARKET'/g) || []).length;
  assert.equal(occurrences, 1, 'EXIT_MARKET should be constructed in exactly one place');

  const branch = code.slice(
    code.indexOf("case 'TARGET_CANCELLED'"),
    code.indexOf("case 'TARGET_CANCEL_FAILED_FILLED'"));
  assert.match(branch, /EXIT_MARKET/, 'the one site should be the confirmed-cancel branch');
});

test('I3: a target is never REPLACED without a confirmed cancel either', () => {
  // Moving a target is a cancel and a place, and the place must sit behind the
  // same door an exit does. If any event in POSITION_OPEN could emit
  // PLACE_TARGET directly, a leg could end up with two resting buys.
  const open = leg({
    state: STATES.POSITION_OPEN, filledPriceP: 2000, slPriceP: 2200,
    targetPriceP: 1900, targetOrderId: 12, filledQty: 75, openedAt: T0,
    confirmations: 1, trailPeakP: 2000,
  });
  const dynamic = cfg({
    dynamicTarget: true, dynamicStepP: 100, dynamicMax: 4,
    trailStartP: 50, trailGapP: 50, exitOnReversal: true,
  });

  const events = [
    { type: 'TREND_CONFIRMED', tsMs: T0 + 5000 },
    { type: 'TREND_REVERSED', reason: 'turned', tsMs: T0 + 5000 },
    { type: 'TICK', ltpPaise: 1700, tsMs: T0 + 5000 },
    { type: 'TICK', ltpPaise: 9999, tsMs: T0 + 5000 },
    { type: 'POSITION_TIMEOUT', tsMs: T0 + 999999 },
    { type: 'SQUARE_OFF', tsMs: T0 },
  ];
  for (const event of events) {
    const r = m.reduce(open, event, dynamic);
    assert.equal(r.actions.filter(a => a.type === 'PLACE_TARGET').length, 0,
      `${event.type} placed a target from POSITION_OPEN without cancelling first`);
  }
});

test('I2: each rung of the target ladder gets its own idempotency key', () => {
  // The ladder cancels and re-places the target several times inside ONE
  // attempt. Without a revision every rung collides on client_ref, place()
  // returns the cancelled predecessor instead of sending, and the leg believes
  // it holds a target that does not exist at the broker.
  const { clientRef } = require('../src/execution/orderRouter');
  const base = { cycleId: 7, optionType: 'PE', attemptSeq: 1, stage: 'TARGET' };

  const rungs = [0, 2, 3, 4].map(revision => clientRef({ ...base, revision }));
  assert.equal(new Set(rungs).size, rungs.length, `rungs collided: ${rungs.join(' ')}`);

  // ...but a RETRY of the same rung must still collapse onto one order, which is
  // the entire purpose of the key.
  assert.equal(clientRef({ ...base, revision: 3 }), clientRef({ ...base, revision: 3 }));

  // The un-revised form is unchanged, so existing refs keep their meaning.
  assert.equal(clientRef(base), 'ZO-7-PE-1-TARGET');
  assert.equal(clientRef({ ...base, revision: 3 }), 'ZO-7-PE-1-TARGET-R3');
});

test('I3: a lost cancel race closes the leg without a second order', () => {
  const exiting = leg({
    state: STATES.EXITING, exitReason: 'STOPLOSS', targetOrderId: 12,
    targetPriceP: 1240, filledQty: 75,
  });
  const r = m.reduce(exiting, { type: 'TARGET_CANCEL_FAILED_FILLED', tsMs: T0 }, cfg());
  assert.equal(r.actions.filter(a => a.type === 'EXIT_MARKET').length, 0);
  assert.equal(r.state, STATES.DONE);
});

/* ==================== the order layer's three-way failure rule ============ */

test('an uncertain placement is never retried — the router marks it UNKNOWN', () => {
  const code = read('execution/orderRouter.js');
  // The rule, asserted structurally: the uncertain branch marks UNKNOWN and
  // returns. It must not call place() again.
  const branch = code.slice(
    code.indexOf('BrokerUncertainError || err.uncertain'),
    code.indexOf('BrokerRejectedError || err.status === 422'));
  assert.match(branch, /markUnknown/);
  assert.doesNotMatch(branch, /this\.broker\.placeOrder|this\.place\(/,
    'an uncertain outcome must never resend');
});

test('only a pre-send rate limit resets an order to PENDING', () => {
  const code = read('execution/orderRouter.js');
  const resets = (code.match(/resetToPending/g) || []).length;
  assert.equal(resets, 1, 'exactly one path may make an order retryable');
  const branch = code.slice(code.indexOf('err instanceof RateLimitedError'),
    code.indexOf('BrokerUncertainError || err.uncertain'));
  assert.match(branch, /resetToPending/);
});

test('the settings validator refuses a live-price entry configuration', () => {
  const { validate } = require('../src/strategy/settings');
  const base = {
    symbol: 'NIFTY', expiryMode: 'CURRENT_WEEKLY', strikeMode: 'PREMIUM', tradeMode: 'BOTH',
    cycleScope: 'BOTH_LEGS', mode: 'PAPER', candleTimeframe: '1m', priceSource: 'CANDLE_CLOSE',
    useLiveAsk: false, useLiveBid: false, useLTP: false, lockStrike: true,
    sellOffset: 1, target: 1, stopLoss: 2, pendingTimeout: 10, positionTimeout: 180, lots: 1,
    sessionStart: '09:20', sessionEnd: '15:10', squareOffAt: '15:15',
  };
  assert.equal(validate(base).errors.length, 0, `unexpected: ${validate(base).errors}`);

  for (const flag of ['useLiveAsk', 'useLiveBid', 'useLTP']) {
    const bad = validate({ ...base, [flag]: true });
    assert.ok(bad.errors.some(e => e.includes(flag)), `${flag}: true should be refused`);
  }
  assert.ok(validate({ ...base, lockStrike: false }).errors.some(e => /lockStrike/.test(e)));
  assert.ok(validate({ ...base, priceSource: 'LTP' }).errors.some(e => /priceSource/.test(e)));
});

test('the documented default profile warns about the timeout/timeframe conflict', () => {
  // positionTimeout 60 with a 1m candle: the conflict flagged as R7. It is a
  // warning, not an error — the numbers are the operator's call — but it must
  // not pass silently.
  const { validate } = require('../src/strategy/settings');
  const documented = {
    symbol: 'NIFTY', expiryMode: 'CURRENT_WEEKLY', strikeMode: 'PREMIUM', tradeMode: 'BOTH',
    cycleScope: 'BOTH_LEGS', mode: 'PAPER', candleTimeframe: '1m', priceSource: 'CANDLE_CLOSE',
    useLiveAsk: false, useLiveBid: false, useLTP: false, lockStrike: true,
    sellOffset: 1, target: 1, stopLoss: 2, pendingTimeout: 10, positionTimeout: 60, lots: 1,
    sessionStart: '09:20', sessionEnd: '15:10', squareOffAt: '15:15',
  };
  const { errors, warnings } = validate(documented);
  assert.equal(errors.length, 0);
  assert.ok(warnings.some(w => /positionTimeout/.test(w)), 'R7 should surface as a warning');
});
