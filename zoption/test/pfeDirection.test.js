// Module 3 — the trend direction filter.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./pfeHelpers');
const direction = require('../src/pfe/direction');

const { STATES } = direction;

test('three bars of higher highs and higher lows read BULLISH', () => {
  const v = direction.verdict(h.risingBars(3), { bars: 3, minTicks: 3 });
  assert.equal(v.state, STATES.BULLISH);
  assert.equal(v.bullish, true);
});

test('a bullish index permits the PE side and blocks the CE side', () => {
  const v = direction.verdict(h.risingBars(3), { bars: 3, minTicks: 3 });
  assert.equal(v.allowPE, true, 'selling PE profits if the move continues');
  assert.equal(v.allowCE, false, 'selling CE stands in front of it');
});

test('three bars of lower highs and lower lows read BEARISH and permit CE', () => {
  const v = direction.verdict(h.fallingBars(3), { bars: 3, minTicks: 3 });
  assert.equal(v.state, STATES.BEARISH);
  assert.equal(v.allowCE, true);
  assert.equal(v.allowPE, false);
});

test('an EQUAL high is not a higher high', () => {
  const bars = h.risingBars(3);
  bars[2].highP = bars[1].highP;
  const v = direction.verdict(bars, { bars: 3, minTicks: 3 });
  assert.equal(v.state, STATES.NONE);
  assert.match(v.reason, /high is not above/);
});

test('a higher high with a lower low is not a trend', () => {
  const bars = h.risingBars(3);
  bars[2].lowP = bars[0].lowP - 100;
  const v = direction.verdict(bars, { bars: 3, minTicks: 3 });
  assert.equal(v.state, STATES.NONE);
});

test('the structure can hold while the newest bar closes against it', () => {
  const bars = h.risingBars(3);
  bars[2].closeP = bars[2].openP - 50;             // closes down
  const strict = direction.verdict(bars, { bars: 3, minTicks: 3, closeRule: 'LAST' });
  assert.equal(strict.state, STATES.NONE, 'the close rule refuses it');

  const loose = direction.verdict(bars, { bars: 3, minTicks: 3, closeRule: 'OFF' });
  assert.equal(loose.state, STATES.BULLISH, 'structure alone accepts it');
});

test('closeRule ALL requires every bar to close with the trend', () => {
  const bars = h.risingBars(3);
  bars[0].closeP = bars[0].openP - 50;
  assert.equal(direction.verdict(bars, { bars: 3, minTicks: 3, closeRule: 'LAST' }).state,
    STATES.BULLISH);
  assert.equal(direction.verdict(bars, { bars: 3, minTicks: 3, closeRule: 'ALL' }).state,
    STATES.NONE);
});

test('a synthetic bar in the window blocks — a silent feed is not a trend', () => {
  const bars = h.risingBars(3);
  bars[1].synthetic = true;
  bars[1].tickCount = 0;
  const v = direction.verdict(bars, { bars: 3, minTicks: 3 });
  assert.equal(v.state, STATES.NO_DATA);
  assert.equal(v.allowCE, false);
  assert.equal(v.allowPE, false);
});

test('a bar with too few ticks measured nothing', () => {
  const bars = h.risingBars(3);
  bars[2].tickCount = 1;
  const v = direction.verdict(bars, { bars: 3, minTicks: 3 });
  assert.equal(v.state, STATES.NO_DATA);
  assert.match(v.reason, /1 ticks/);
});

test('too few bars is WARMING_UP, not a refusal to trade', () => {
  const v = direction.verdict(h.risingBars(2), { bars: 3, minTicks: 3 });
  assert.equal(v.state, STATES.WARMING_UP);
  assert.match(v.reason, /2 completed index bars/);
});

test('only the tail of the buffer is read', () => {
  // Five bars where the first two disagree with the last three.
  const bars = [...h.fallingBars(2), ...h.risingBars(3)];
  assert.equal(direction.verdict(bars, { bars: 3, minTicks: 3 }).state, STATES.BULLISH);
});

test('the verdict carries no price the caller could trade off', () => {
  const v = direction.verdict(h.risingBars(3), { bars: 3, minTicks: 3 });
  for (const key of ['price', 'sellPrice', 'sellPriceP', 'ltp', 'ltpPaise', 'premium']) {
    assert.equal(v[key], undefined, `the verdict must not carry ${key}`);
  }
});

test('isBreak is about the side, and an absence of data is not a break', () => {
  const bullish = direction.verdict(h.risingBars(3), { bars: 3, minTicks: 3 });
  assert.equal(direction.isBreak(bullish, 'PE'), false, 'PE is the permitted side');
  assert.equal(direction.isBreak(bullish, 'CE'), true);

  const warming = direction.verdict([], { bars: 3 });
  assert.equal(direction.isBreak(warming, 'PE'), false,
    'WARMING_UP must not close a live position');

  const silent = direction.verdict(
    h.risingBars(3).map(b => ({ ...b, synthetic: true, tickCount: 0 })), { bars: 3 });
  assert.equal(silent.state, STATES.NO_DATA);
  assert.equal(direction.isBreak(silent, 'PE'), false,
    'a silent feed must not hand the market a free exit');
});
