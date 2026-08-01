// Modules 4, 7 and 10 — the Live Price Position Filter.

const test = require('node:test');
const assert = require('node:assert/strict');

require('./pfeHelpers');
const priceFilter = require('../src/pfe/priceFilter');

// open 100.00, high 200.00, low 50.00 -> bullish mid 150.00, bearish mid 75.00.
// Round numbers so every assertion below can be read without arithmetic.
const bar = (over = {}) => ({
  bucketStart: 0, bucketEnd: 5000,
  openP: 10000, highP: 20000, lowP: 5000, closeP: 15000,
  tickCount: 5, synthetic: false, tradable: true,
  ...over,
});

test('the mids are the midpoints of open-to-high and open-to-low', () => {
  const m = priceFilter.mids(bar());
  assert.equal(m.bullishMidP, 15000);
  assert.equal(m.bearishMidP, 7500);
});

test('a half-paise midpoint is rounded once, here', () => {
  const m = priceFilter.mids(bar({ openP: 10000, highP: 10001 }));
  assert.equal(m.bullishMidP, 10001);         // 10000.5 rounds up
  assert.equal(Number.isInteger(m.bullishMidP), true);
});

test('a flat bar permits neither side', () => {
  const v = priceFilter.entryVerdict({
    candle: bar({ openP: 10000, highP: 10000, lowP: 10000, closeP: 10000 }),
    spotP: 10000,
  });
  assert.equal(v.allowCE, false);
  assert.equal(v.allowPE, false);
});

test('above the bullish mid, only PE may be sold', () => {
  const v = priceFilter.entryVerdict({ candle: bar(), spotP: 16000 });
  assert.equal(v.allowPE, true);
  assert.equal(v.allowCE, false);
});

test('below the bearish mid, only CE may be sold', () => {
  const v = priceFilter.entryVerdict({ candle: bar(), spotP: 6000 });
  assert.equal(v.allowCE, true);
  assert.equal(v.allowPE, false);
});

test('between the two mids nothing is permitted, and it says why', () => {
  const v = priceFilter.entryVerdict({ candle: bar(), spotP: 10000 });
  assert.equal(v.allowCE, false);
  assert.equal(v.allowPE, false);
  assert.match(v.reason, /between the bearish mid/);
});

test('a price exactly ON the mid does not open a trade', () => {
  const v = priceFilter.entryVerdict({ candle: bar(), spotP: 15000 });
  assert.equal(v.allowPE, false, 'entry is strictly above');
});

test('...and a price exactly on the mid DOES close one', () => {
  const v = priceFilter.holdVerdict({ candle: bar(), spotP: 15000, optionType: 'PE' });
  assert.equal(v.ok, false, 'the exit is the exact complement of the entry');
  assert.match(v.reason, /fallen to or below/);
});

test('the hold verdict tracks the side it is asked about', () => {
  assert.equal(priceFilter.holdVerdict({ candle: bar(), spotP: 16000, optionType: 'PE' }).ok, true);
  assert.equal(priceFilter.holdVerdict({ candle: bar(), spotP: 16000, optionType: 'CE' }).ok, false);
  assert.equal(priceFilter.holdVerdict({ candle: bar(), spotP: 6000, optionType: 'CE' }).ok, true);
});

test('no index price holds the position rather than closing it', () => {
  const v = priceFilter.holdVerdict({ candle: bar(), spotP: null, optionType: 'PE' });
  assert.equal(v.ok, true);
  assert.equal(v.undecided, true, 'an absence of information is not a reversal');
});

test('a confirmation is a hold verdict that actually decided', () => {
  assert.equal(priceFilter.isConfirmation({ candle: bar(), spotP: 16000, optionType: 'PE' }), true);
  assert.equal(priceFilter.isConfirmation({ candle: bar(), spotP: 10000, optionType: 'PE' }), false);
  assert.equal(priceFilter.isConfirmation({ candle: bar(), spotP: null, optionType: 'PE' }), false,
    'undecided is not a confirmation — the ladder must not extend on silence');
});

test('the filter needs a completed candle and says so', () => {
  assert.throws(() => priceFilter.mids(null), /completed candle/);
  assert.throws(() => priceFilter.mids({}), /completed candle/);
});

test('nothing the filter returns can be used as an order price', () => {
  const v = priceFilter.entryVerdict({ candle: bar(), spotP: 16000 });
  for (const key of ['sellPrice', 'sellPriceP', 'limitPrice', 'premium', 'ltpPaise']) {
    assert.equal(v[key], undefined);
  }
});
