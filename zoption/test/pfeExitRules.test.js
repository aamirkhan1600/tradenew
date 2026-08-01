// Modules 5, 6, 8, 9 and 10 — pricing, the ladder, the trail and the exits.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const h = require('./pfeHelpers');
const rules = require('../src/pfe/exitRules');

/* --------------------------------------------------- Module 5, the price -- */

test('the sell price is a completed candle close plus the offset', () => {
  assert.equal(rules.calculateSellPrice(h.optionBar({ closeP: 2000 }), 10), 2010);
});

test('calculateSellPrice takes a candle and an offset, and nothing else', () => {
  // The structural guarantee, asserted the same way the scalper's is: an arity
  // of two means no quote object can be threaded in, whatever a future caller
  // intends.
  assert.equal(rules.calculateSellPrice.length, 2);

  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'pfe', 'exitRules.js'), 'utf8');
  const body = src.slice(src.indexOf('function calculateSellPrice'));
  const fn = body.slice(0, body.indexOf('\n}\n') + 3);
  for (const word of ['ltp', 'quote', 'bid', 'ask', 'tick']) {
    assert.equal(new RegExp(`\\b${word}`, 'i').test(fn), false,
      `calculateSellPrice must not mention ${word}`);
  }
});

test('a bar that measured nothing cannot price an order', () => {
  assert.throws(() => rules.calculateSellPrice(h.optionBar({ tradable: false }), 10),
    /measured nothing/);
  assert.throws(() => rules.calculateSellPrice(null, 10), /completed option candle/);
});

/* ------------------------------------------------- Module 6, initial risk -- */

test("the target and stop are priced off the FILL, not off what was asked for", () => {
  assert.equal(rules.calculateTargetPrice(2000, 100), 1900);
  assert.equal(rules.calculateStopPrice(2000, 200), 2200);
  // A limit that filled better keeps the improvement.
  assert.equal(rules.calculateTargetPrice(2050, 100), 1950);
});

test('a target can never be priced below one tick', () => {
  assert.equal(rules.calculateTargetPrice(50, 500), 5);
});

/* --------------------------------------------------- Module 8, the ladder -- */

test("the ladder walks 1, 2, 3, 4 points and then withdraws the target", () => {
  const fill = 2000;
  assert.equal(rules.ladderTarget(fill, 0, 100, 100, 4), 1900, 'entry: 1 point');
  assert.equal(rules.ladderTarget(fill, 1, 100, 100, 4), 1800, 'first confirmation: 2');
  assert.equal(rules.ladderTarget(fill, 2, 100, 100, 4), 1700, 'second: 3');
  assert.equal(rules.ladderTarget(fill, 3, 100, 100, 4), 1600, 'third: 4');
  assert.equal(rules.ladderTarget(fill, 4, 100, 100, 4), null, 'fourth+: trail until exit');
  assert.equal(rules.ladderTarget(fill, 9, 100, 100, 4), null);
});

/* ---------------------------------------------------- Module 9, the trail -- */

test("the trail reproduces the document's worked example exactly", () => {
  // entry 20.00, initial stop 22.00, gap 1.00 tightening by 0.20 to a floor of
  // 0.40 — doc/new.md Module 9.
  const base = {
    filledPriceP: 2000, trailStartPaise: 0,
    trailGapPaise: 100, tightenPaise: 20, minGapPaise: 40,
  };
  assert.equal(rules.trailStop({ ...base, bestPaise: 1920, currentStopP: 2200, trails: 0 }), 2020);
  assert.equal(rules.trailStop({ ...base, bestPaise: 1850, currentStopP: 2020, trails: 1 }), 1930);
  assert.equal(rules.trailStop({ ...base, bestPaise: 1780, currentStopP: 1930, trails: 2 }), 1840);
});

test('the gap never shrinks past its floor', () => {
  const stop = rules.trailStop({
    filledPriceP: 2000, bestPaise: 1700, currentStopP: 1840,
    trailStartPaise: 0, trailGapPaise: 100, tightenPaise: 20, minGapPaise: 40, trails: 9,
  });
  assert.equal(stop, 1740, 'best 17.00 + the 0.40 floor');
});

test('THE STOP NEVER MOVES BACKWARD', () => {
  const widen = rules.trailStop({
    filledPriceP: 2000, bestPaise: 1900, currentStopP: 1840,
    trailStartPaise: 0, trailGapPaise: 100, tightenPaise: 0, minGapPaise: 40, trails: 0,
  });
  assert.equal(widen, null, 'a stop that can widen is not a stop');
});

test('the trail does not engage until the position is far enough in profit', () => {
  const base = {
    filledPriceP: 2000, currentStopP: 2200,
    trailStartPaise: 50, trailGapPaise: 100, tightenPaise: 0, minGapPaise: 40, trails: 0,
  };
  assert.equal(rules.trailStop({ ...base, bestPaise: 1970 }), null, '0.30 of profit is not enough');
  assert.equal(rules.trailStop({ ...base, bestPaise: 1940 }), 2040, '0.60 is');
});

test('a zero gap disables trailing entirely', () => {
  assert.equal(rules.trailStop({
    filledPriceP: 2000, bestPaise: 1800, currentStopP: 2200,
    trailStartPaise: 0, trailGapPaise: 0, tightenPaise: 0, minGapPaise: 0, trails: 0,
  }), null);
});

/* ---------------------------------------------------- Module 10, the exits */

test('the premium safety exit measures from the fill, not from the best price', () => {
  assert.equal(rules.premiumSafetyBreached(2000, 2200, 200), true);
  assert.equal(rules.premiumSafetyBreached(2000, 2199, 200), false);
  // Having been 3 points in profit first makes no difference — this is a hard
  // ceiling on how far one trade may go wrong.
  assert.equal(rules.premiumSafetyBreached(2000, 2200, 200), true);
  assert.equal(rules.premiumSafetyBreached(2000, 2500, 0), false, '0 disables it');
});

test('a broker that sends no book reports the liquidity exit as blind, not as passing', () => {
  const v = rules.liquidityBroken({ ltp: 20 }, { exitSpreadPaise: 50, minBidQty: 100 });
  assert.equal(v.broken, false);
  assert.equal(v.blind, true, 'the operator must be told the check cannot fire');
});

test('a vanished bid is an exit', () => {
  const gone = rules.liquidityBroken({ ltp: 20, bid: null, ask: 20.1 }, { exitSpreadPaise: 50 });
  assert.equal(gone.broken, true);
  assert.equal(gone.blind, false);
  assert.match(gone.reason, /bid/);
});

test('a spread wider than the exit threshold is an exit', () => {
  const wide = rules.liquidityBroken({ bid: 19.5, ask: 20.2 }, { exitSpreadPaise: 50 });
  assert.equal(wide.broken, true);
  assert.match(wide.reason, /spread/);

  const fine = rules.liquidityBroken({ bid: 19.9, ask: 20.2 }, { exitSpreadPaise: 50 });
  assert.equal(fine.broken, false);
  assert.equal(fine.blind, false);
});

test('the maximum hold is measured from the fill', () => {
  assert.equal(rules.heldTooLong(1000, 1000 + 89999, 90000), false);
  assert.equal(rules.heldTooLong(1000, 1000 + 90000, 90000), true);
  assert.equal(rules.heldTooLong(1000, 1e12, 0), false, '0 disables it');
  assert.equal(rules.heldTooLong(null, 1e12, 90000), false, 'nothing has opened yet');
});

/* --------------------------------------------------- Module 11, re-entry -- */

test('re-entry waits the configured number of completed candles', () => {
  assert.equal(rules.reentryAllowed(0, 2), false);
  assert.equal(rules.reentryAllowed(1, 2), false);
  assert.equal(rules.reentryAllowed(2, 2), true);
  assert.equal(rules.reentryAllowed(0, 0), true, '0 waits for nothing');
});
