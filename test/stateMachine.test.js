// The state machine is where money is decided, so this suite is deliberately
// exhaustive about the two invariants:
//   1. the short is never sent before the hedge is confirmed
//   2. the hedge is never sold before the short is bought back

const test = require('node:test');
const assert = require('node:assert/strict');

const { decide, STATES: S, ACTIONS: A } = require('../src/strategy/stateMachine');
const { defaults } = require('../src/strategy/config');

const NOON = 12 * 60;   // minutes past IST midnight — inside every default window

function ctx(overrides = {}) {
  const base = {
    state: S.IDLE,
    config: { ...defaults(), premiumMin: 35, premiumMax: 45, armPrice: 40, offset: 0.5 },
    session: { minutes: NOON, isTradingDay: true, marketOpen: true },
    market: { spot: 38050, shortLtp: 41, shortAgeMs: 200, hedgeLtp: 10, feedHealthy: true },
    candidate: null,
    trade: null,
    runtime: { armed: false, armedLow: null, cooldownUntil: 0 },
    risk: { blockedReason: null },
    halted: false,
    hasPositionSlot: true,
    now: 1_800_000_000_000,
  };
  return {
    ...base, ...overrides,
    config: { ...base.config, ...(overrides.config || {}) },
    session: { ...base.session, ...(overrides.session || {}) },
    market: { ...base.market, ...(overrides.market || {}) },
    runtime: { ...base.runtime, ...(overrides.runtime || {}) },
    risk: { ...base.risk, ...(overrides.risk || {}) },
  };
}

const goodCandidate = {
  ok: true,
  short: { optionType: 'CE', strike: 38350, premium: 41 },
  hedge: { optionType: 'CE', strike: 38450, premium: 10 },
  reason: 'CE 38350 @ 41 · hedge 38450 @ 10',
};

/* ------------------------------------------------------------- entry gates */
test('does not scan outside the entry window', () => {
  assert.equal(decide(ctx({ session: { minutes: 9 * 60 } })).action, A.NONE);
  assert.match(decide(ctx({ session: { minutes: 9 * 60 } })).reason, /entry time/);

  const late = decide(ctx({ session: { minutes: 14 * 60 + 45 } }));
  assert.equal(late.action, A.NONE);
  assert.match(late.reason, /last entry/);
});

test('does not scan on a non-trading day or with a dead feed', () => {
  assert.match(decide(ctx({ session: { isTradingDay: false } })).reason, /not a trading day/);
  assert.match(decide(ctx({ market: { feedHealthy: false } })).reason, /feed is down/);
});

test('the kill switch blocks new entries', () => {
  const r = decide(ctx({ halted: true }));
  assert.equal(r.next, S.IDLE);
  assert.match(r.reason, /halted/);
});

test('a risk block stops entry and says why', () => {
  const r = decide(ctx({ risk: { blockedReason: 'daily loss limit hit (-₹5,000 …)' } }));
  assert.match(r.reason, /daily loss limit/);
});

test('the queue holds a strategy back when another owns the slot', () => {
  const r = decide(ctx({ hasPositionSlot: false, candidate: goodCandidate }));
  assert.equal(r.next, S.IDLE);
  assert.match(r.reason, /queued/);
});

test('a cooldown defers re-entry', () => {
  const now = 1_800_000_000_000;
  const r = decide(ctx({ now, runtime: { cooldownUntil: now + 30_000 } }));
  assert.match(r.reason, /cooldown 30s/);
});

/* --------------------------------------------------- invariant 1: hedge 1st */
test('a valid candidate selects the strike but places nothing yet', () => {
  const r = decide(ctx({ candidate: goodCandidate }));
  assert.equal(r.next, S.STRIKE_SELECTED);
  assert.equal(r.action, A.NONE);
});

test('INVARIANT 1: the first order placed is always the hedge', () => {
  const r = decide(ctx({ state: S.STRIKE_SELECTED, candidate: goodCandidate }));
  assert.equal(r.action, A.PLACE_HEDGE);
  assert.equal(r.next, S.HEDGE_PENDING);
});

test('INVARIANT 1: no path reaches PLACE_SHORT without passing through the hedge states', () => {
  // Drive every non-hedged state with a price sitting on the sell trigger and
  // assert none of them will short.
  for (const state of [S.IDLE, S.SCANNING, S.STRIKE_SELECTED, S.COMPLETE]) {
    const r = decide(ctx({
      state, candidate: goodCandidate, market: { shortLtp: 40.5 },
      runtime: { armed: true, armedLow: 39.9 },
    }));
    assert.notEqual(r.action, A.PLACE_SHORT, `${state} must not place the short`);
  }
});

/* ----------------------------------------------------- arm + offset trigger */
const hedgedTrade = {
  id: 1, optionType: 'CE', sellStrike: 38350, hedgeStrike: 38450,
  hedgePrice: 10, qty: 30, hedgeOpenedAt: 1_800_000_000_000,
};

test('ARM: does not arm while the premium is above the arm price', () => {
  const r = decide(ctx({ state: S.ARM_WAIT, trade: hedgedTrade, market: { shortLtp: 40.7 } }));
  assert.equal(r.next, S.ARM_WAIT);
  assert.match(r.reason, /arm wait/);
});

test('ARM: arms the moment the premium reaches the arm price', () => {
  const r = decide(ctx({ state: S.ARM_WAIT, trade: hedgedTrade, market: { shortLtp: 40.0 } }));
  assert.equal(r.next, S.OFFSET_WAIT);
  assert.equal(r.patch.armed, true);
  assert.equal(r.patch.armedLow, 40);
});

test("OFFSET: replays the doc's price path exactly — sells at 40.50, not before", () => {
  // 41 -> 40.70 -> 40.30 -> 40.00 [ARMED] -> 39.90 -> 40.10 -> 40.30 -> 40.50 [SELL]
  const path = [41, 40.7, 40.3, 40.0, 39.9, 40.1, 40.3, 40.5];
  const expected = [
    S.ARM_WAIT, S.ARM_WAIT, S.ARM_WAIT, S.OFFSET_WAIT,
    S.OFFSET_WAIT, S.OFFSET_WAIT, S.OFFSET_WAIT, S.SHORT_PENDING,
  ];

  let state = S.ARM_WAIT;
  let runtime = { armed: false, armedLow: null, cooldownUntil: 0 };
  const seen = [];

  for (const ltp of path) {
    const r = decide(ctx({ state, trade: hedgedTrade, runtime, market: { shortLtp: ltp } }));
    state = r.next;
    runtime = { ...runtime, ...(r.patch || {}) };
    seen.push(state);
  }

  assert.deepEqual(seen, expected);
  assert.equal(runtime.armedLow, 39.9, 'the post-arm low must be tracked');
});

test('OFFSET: offsetFrom=LOW triggers off the post-arm low instead', () => {
  const r = decide(ctx({
    state: S.OFFSET_WAIT, trade: hedgedTrade,
    config: { offsetFrom: 'LOW', offset: 0.5, armPrice: 40 },
    runtime: { armed: true, armedLow: 39.9 },
    market: { shortLtp: 40.4 },
  }));
  // 39.90 + 0.50 = 40.40 -> triggers, where the ARM rule (40.50) would not.
  assert.equal(r.next, S.SHORT_PENDING);
  assert.equal(r.action, A.PLACE_SHORT);
});

test('OFFSET: a stale quote never triggers the short', () => {
  const r = decide(ctx({
    state: S.OFFSET_WAIT, trade: hedgedTrade,
    runtime: { armed: true, armedLow: 39.9 },
    market: { shortLtp: 40.5, shortAgeMs: 90_000 },
  }));
  assert.equal(r.action, A.NONE);
  assert.match(r.reason, /stale/);
});

/* ------------------------------------------------- lone-hedge abandonment -- */
test('a hedge with no short is unwound once the entry window closes', () => {
  for (const state of [S.ARM_WAIT, S.OFFSET_WAIT]) {
    const r = decide(ctx({
      state, trade: hedgedTrade, session: { minutes: 14 * 60 + 31 },
      runtime: { armed: state === S.OFFSET_WAIT, armedLow: 39.9 },
    }));
    assert.equal(r.action, A.EXIT_HEDGE, `${state} must unwind the lone hedge`);
    assert.equal(r.patch.exitReason, 'time');
  }
});

test('armTimeoutSec abandons a hedge that never armed', () => {
  const now = hedgedTrade.hedgeOpenedAt + 400_000;
  const r = decide(ctx({
    state: S.ARM_WAIT, trade: hedgedTrade, now,
    config: { armTimeoutSec: 300 },
  }));
  assert.equal(r.action, A.EXIT_HEDGE);
  assert.equal(r.patch.exitReason, 'arm_timeout');
});

/* ---------------------------------------------------------- open position -- */
const openTrade = {
  ...hedgedTrade, sellPrice: 40.5, targetPrice: 35.5, slPrice: 52.5, qty: 30,
};

test('holds while price sits between target and stop', () => {
  const r = decide(ctx({ state: S.POSITION_OPEN, trade: openTrade, market: { shortLtp: 39 } }));
  assert.equal(r.action, A.NONE);
  assert.match(r.reason, /open ·/);
});

test('INVARIANT 2: target exits the SHORT first, never the hedge', () => {
  const r = decide(ctx({ state: S.POSITION_OPEN, trade: openTrade, market: { shortLtp: 35.5 } }));
  assert.equal(r.action, A.EXIT_SHORT);
  assert.equal(r.next, S.EXIT_SHORT);
  assert.equal(r.patch.exitReason, 'target');
});

test('INVARIANT 2: the stoploss also exits the short first', () => {
  const r = decide(ctx({ state: S.POSITION_OPEN, trade: openTrade, market: { shortLtp: 52.5 } }));
  assert.equal(r.action, A.EXIT_SHORT);
  assert.equal(r.patch.exitReason, 'stoploss');
});

test('a stale quote does NOT trigger target or stop', () => {
  const r = decide(ctx({
    state: S.POSITION_OPEN, trade: openTrade,
    market: { shortLtp: 35.0, shortAgeMs: 90_000 },
  }));
  assert.equal(r.action, A.NONE);
  assert.match(r.reason, /stale/);
});

test('the time exit fires even on a stale quote — square-off is unconditional', () => {
  const r = decide(ctx({
    state: S.POSITION_OPEN, trade: openTrade,
    session: { minutes: 15 * 60 + 20 },
    market: { shortLtp: 39, shortAgeMs: 900_000 },
  }));
  assert.equal(r.action, A.EXIT_SHORT);
  assert.equal(r.patch.exitReason, 'time');
});

test('the kill switch does NOT force-close an open position', () => {
  const r = decide(ctx({ state: S.POSITION_OPEN, trade: openTrade, halted: true, market: { shortLtp: 39 } }));
  assert.equal(r.action, A.NONE);
});

/* ------------------------------------------------------------- recovery --- */
test('an in-flight state always reconciles before deciding anything', () => {
  for (const state of [S.HEDGE_PENDING, S.SHORT_PENDING, S.EXIT_SHORT, S.EXIT_HEDGE]) {
    const r = decide(ctx({ state, trade: openTrade }));
    assert.equal(r.action, A.RECONCILE, `${state} must reconcile`);
    assert.equal(r.next, state, 'reconciliation must not advance the state on its own');
  }
});

test('a live state with no trade record resets to idle instead of crashing', () => {
  const r = decide(ctx({ state: S.POSITION_OPEN, trade: null }));
  assert.equal(r.next, S.IDLE);
  assert.match(r.reason, /no trade record/);
});

test('COMPLETE returns to IDLE for the next cycle', () => {
  assert.equal(decide(ctx({ state: S.COMPLETE })).next, S.IDLE);
});

test('HALTED stays halted until an operator intervenes', () => {
  const r = decide(ctx({ state: S.HALTED }));
  assert.equal(r.next, S.HALTED);
  assert.equal(r.action, A.NONE);
});
