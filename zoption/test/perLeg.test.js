// cycleScope PER_LEG, at the ENGINE level — R6.
//
// The state transition itself is pure and covered in legMachine.test.js. What
// lives here is the part that is not pure and not covered anywhere else: the
// gates the engine puts in front of a re-arm. Getting those wrong is what turns
// PER_LEG from "more trades" into "a hole through the daily loss limit".
//
// The repository is stubbed rather than mocked wholesale: these tests touch no
// database, and the engine is otherwise the real one.

const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');

const repo = require('../src/repositories');
repo.legs.setState = async () => {};
repo.events.log = async () => {};

const { ScalperEngine } = require('../src/strategy/scalperEngine');
const settingsSvc = require('../src/strategy/settings');
const { STATES } = require('../src/strategy/legMachine');

// `_maybeRearm` asks the WALL CLOCK whether the square-off has passed, so these
// tests read the real time of day. The window below was widened to keep them
// inside it, but a window still has edges: `00:01`–`23:58` with a `23:59`
// square-off leaves TWO MINUTES A DAY — 23:59 and 00:00 — where the gates do not
// hold and the three tests that need a re-arm to succeed fail. That is a suite
// which is green all day and red at midnight, which is the worst kind.
//
// So the clock is taken out of it: `isAfter` is pinned false for this file, and
// no test here asserts the square-off gate (that behaviour belongs with the
// square-off, not with PER_LEG re-arming). The window below now only has to be
// self-consistent, not lucky.
const time = require('../src/core/time');
time.isAfter = () => false;

// A session window wide enough that the wall clock is always inside it — these
// tests are about the OTHER gates, and a suite that fails after 15:15 is worse
// than useless.
const BASE = {
  symbol: 'NIFTY', expiryMode: 'CURRENT_WEEKLY', tradeMode: 'BOTH', strikeMode: 'PREMIUM',
  atmOffset: 2, targetPremium: 12, premiumTolerance: 2, entryMode: 'OPTION_CANDLE_CLOSE',
  priceSource: 'CANDLE_CLOSE', candleTimeframe: '1m', sellOffset: 1, useLiveAsk: false,
  useLiveBid: false, useLTP: false, lockStrike: true, reQuoteOnNextCandle: true,
  pendingTimeout: 10, target: 1, stopLoss: 2, positionTimeout: 60, lots: 1,
  sessionStart: '00:01', sessionEnd: '23:58', squareOffAt: '23:59',
  maxOpenCE: 1, maxOpenPE: 1, marketMovePause: 40, marketMoveWindow: 30, cooldownAfterSL: 300,
  maxDailyLoss: 3000, maxDailyProfit: 5000, maxConsecutiveLoss: 3, maxCyclesPerDay: 0,
  mode: 'PAPER', trendFilter: true,
};

function engineWith({ scope, gate = { ok: true }, lockedAgoSec = 60, cycleMaxAge = 900 } = {}) {
  const engine = new ScalperEngine({
    ticker: { on() {} }, candles: { on() {}, start() {}, stop() {} },
    router: {}, reconciler: { on() {} },
    risk: { canEnter: async () => gate }, broker: {},
  });
  engine.settings = settingsSvc.derive({ ...BASE, cycleScope: scope, cycleMaxAge });
  engine.running = true;
  engine.cycle = {
    id: 1,
    qty: 75,
    locked_at: new Date(Date.now() - lockedAgoSec * 1000)
      .toISOString().slice(0, 19).replace('T', ' '),
  };
  return engine;
}

const finishedLeg = (over = {}) => ({
  id: 1, optionType: 'PE', state: STATES.DONE, attemptSeq: 3,
  filledPriceP: 1340, filledQty: 75, targetPriceP: 1240, slPriceP: 1540,
  openedAt: Date.now() - 30000, closedAt: Date.now(), exitReason: 'TARGET',
  confirmations: 2, trailPeakP: 1200, trailingOnly: true, ...over,
});

const stoodDownLeg = (over = {}) => ({
  id: 2, optionType: 'CE', state: STATES.DONE, attemptSeq: 0,
  filledPriceP: null, closedAt: Date.now(), exitReason: 'NO_ENTRY', ...over,
});

/* ------------------------------------------------------------ the gates -- */

test('PER_LEG re-arms a finished leg and clears the round trip that ended', () => {
  const engine = engineWith({ scope: 'PER_LEG' });
  const leg = finishedLeg();
  engine.legs.set('PE', leg);

  return engine._maybeRearm(leg).then((rearmed) => {
    assert.equal(rearmed, true);
    assert.equal(leg.state, STATES.WAIT_CANDLE);
    assert.equal(leg.filledPriceP, null);
    assert.equal(leg.targetPriceP, null);
    assert.equal(leg.exitReason, null);
    assert.equal(leg.confirmations, 0);
    assert.equal(leg.trailingOnly, false);
    assert.equal(leg.attemptSeq, 3, 'the order key counter must keep going');
  });
});

test('BOTH_LEGS never re-arms — the cycle is the unit of re-entry', async () => {
  const engine = engineWith({ scope: 'BOTH_LEGS' });
  const leg = finishedLeg();
  engine.legs.set('PE', leg);

  assert.equal(await engine._maybeRearm(leg), false);
  assert.equal(leg.state, STATES.DONE);
});

test('the risk gate is consulted on EVERY re-arm, not just at cycle open', async () => {
  // Without this PER_LEG is a hole through the daily loss limit, the cooldown
  // and the session window: a leg could re-enter all afternoon on a cycle that
  // passed the gate once, hours earlier.
  const engine = engineWith({ scope: 'PER_LEG', gate: { ok: false, reason: 'daily loss limit' } });
  const leg = finishedLeg();
  engine.legs.set('PE', leg);

  assert.equal(await engine._maybeRearm(leg), false);
  assert.equal(leg.state, STATES.DONE);
});

test('a strike past cycleMaxAge is not re-used — the cycle re-selects instead', async () => {
  const engine = engineWith({ scope: 'PER_LEG', lockedAgoSec: 1200, cycleMaxAge: 900 });
  const leg = finishedLeg();
  engine.legs.set('PE', leg);

  assert.equal(await engine._maybeRearm(leg), false);
  assert.equal(leg.state, STATES.DONE);
});

test('cycleMaxAge 0 means a strike is re-used indefinitely', async () => {
  const engine = engineWith({ scope: 'PER_LEG', lockedAgoSec: 99999, cycleMaxAge: 0 });
  const leg = finishedLeg();
  engine.legs.set('PE', leg);

  assert.equal(await engine._maybeRearm(leg), true);
});

test('a stopped engine re-arms nothing', async () => {
  const engine = engineWith({ scope: 'PER_LEG' });
  engine.running = false;
  const leg = finishedLeg();
  engine.legs.set('PE', leg);

  assert.equal(await engine._maybeRearm(leg), false);
});

/* --------------------------------------------------- reviving a stood-down leg */

const bearish = { state: 'STRONG_BEARISH', allowCE: true, allowPE: false, reason: '3 bearish bars' };
const bullish = { state: 'STRONG_BULLISH', allowCE: false, allowPE: true, reason: '3 bullish bars' };
const choppy = { state: 'CHOPPY', allowCE: false, allowPE: false, reason: 'mixed' };

async function revive(verdict, opts = {}) {
  const engine = engineWith({ scope: 'PER_LEG', ...opts });
  const ce = stoodDownLeg();
  engine.legs.set('CE', ce);
  await engine._reviveStoodDownLegs(verdict);
  return ce;
}

test('a leg that stood down comes back when the index turns its way', async () => {
  // The CE stood down under a bullish index. When the index turns bearish that
  // reason has expired — and nothing else would bring it back, because a leg
  // only re-arms after a completed round trip and this one never had one.
  const ce = await revive(bearish);
  assert.equal(ce.state, STATES.WAIT_CANDLE);
  assert.equal(ce.exitReason, null);
});

test('it stays down while the index still refuses its side', async () => {
  assert.equal((await revive(bullish)).state, STATES.DONE);
  assert.equal((await revive(choppy)).state, STATES.DONE, 'choppy permits nobody');
});

test('a revival goes through the same gates as any other re-arm', async () => {
  assert.equal((await revive(bearish, { gate: { ok: false, reason: 'cooling down' } })).state,
    STATES.DONE, 'the risk gate still applies');
  assert.equal((await revive(bearish, { lockedAgoSec: 1200 })).state,
    STATES.DONE, 'cycleMaxAge still applies');
});

test('BOTH_LEGS does not revive — closing the cycle is its recovery', async () => {
  // Reviving onto a strike chosen for the opposite trend is strictly worse than
  // letting the cycle close and selecting a fresh one, which BOTH_LEGS does in
  // seconds once the stood-down leg is the last one out.
  const engine = engineWith({ scope: 'BOTH_LEGS' });
  const ce = stoodDownLeg();
  engine.legs.set('CE', ce);
  await engine._reviveStoodDownLegs(bearish);
  assert.equal(ce.state, STATES.DONE);
});

test('only a NO_ENTRY leg is revived — a squared-off or halted one is not', async () => {
  for (const reason of ['SQUAREOFF', 'HALT', 'TARGET', 'STOPLOSS']) {
    const engine = engineWith({ scope: 'PER_LEG' });
    const ce = stoodDownLeg({ exitReason: reason });
    engine.legs.set('CE', ce);
    await engine._reviveStoodDownLegs(bearish);
    assert.equal(ce.state, STATES.DONE, `${reason} must not be revived by a trend verdict`);
  }
});

test('reviving never touches a leg that holds a position', async () => {
  const engine = engineWith({ scope: 'PER_LEG' });
  const pe = {
    id: 3, optionType: 'PE', state: STATES.POSITION_OPEN, filledPriceP: 1340,
    filledQty: 75, targetPriceP: 1240, slPriceP: 1540, openedAt: Date.now(),
  };
  engine.legs.set('PE', pe);
  await engine._reviveStoodDownLegs(bullish);
  assert.equal(pe.state, STATES.POSITION_OPEN);
  assert.equal(pe.filledPriceP, 1340);
});
