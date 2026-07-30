// The shared indicator library.
//
// This module runs in two places — the browser draws with it and the server
// reasons with it — so these tests are the only thing standing between "the
// chart says the 9 crossed the 20" and "the alert says it did not".
//
// The assertions are on PROPERTIES rather than on hand-copied magic numbers
// wherever a property is available: an EMA of a constant series is that
// constant, an RSI of a monotonic rise is 100, a Bollinger band of a flat series
// collapses onto its middle. Those cannot be satisfied by a subtly wrong
// implementation the way a single spot value can.

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const ind = require('../src/shared/indicators');

// A bar series from closes, with a plausible high/low around each.
function bars(closes, startSeconds = 0, stepSeconds = 60) {
  return closes.map((c, i) => ({
    time: startSeconds + i * stepSeconds,
    open: i === 0 ? c : closes[i - 1],
    high: c + 1,
    low: c - 1,
    close: c,
    volume: 10,
  }));
}

const lastOf = (arr) => arr[arr.length - 1];

test('pads every output to the input length', () => {
  const b = bars([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const closes = ind.closes(b);
  for (const series of [ind.sma(closes, 5), ind.ema(closes, 5), ind.rsi(b, 5), ind.atr(b, 5)]) {
    assert.equal(series.length, b.length,
      'a shorter array would make every caller do index arithmetic to line a value up with its bar');
  }
  // The warm-up is null, not zero. An unwarmed indicator and an indicator that
  // happens to read zero are different facts.
  assert.equal(ind.sma(closes, 5)[3], null);
  assert.equal(typeof ind.sma(closes, 5)[4], 'number');
});

test('averages a constant series to that constant', () => {
  const closes = new Array(50).fill(100);
  assert.equal(lastOf(ind.sma(closes, 20)), 100);
  assert.equal(lastOf(ind.ema(closes, 20)), 100);
  assert.equal(lastOf(ind.wilder(closes, 14)), 100);
});

test('seeds the EMA from an SMA, not from the first value', () => {
  const closes = [10, 20, 30, 40, 50];
  const ema = ind.ema(closes, 5);
  // The first computable point is the mean of the whole window.
  assert.equal(ema[4], 30);
  assert.equal(ema[3], null);
});

test('separates Wilder smoothing from an EMA of the same period', () => {
  // Wilder's 1/p smoothing is an EMA of period 2p-1. Substituting one for the
  // other is why an RSI ends up several points away from every other terminal.
  //
  // The series has to be long enough for a 27-period EMA to warm up at all,
  // and long enough for both to forget their different seeds — they converge on
  // the same decay, not on the same starting point.
  const values = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 9) * 20);
  const wilder14 = lastOf(ind.wilder(values, 14));
  assert.notEqual(wilder14, lastOf(ind.ema(values, 14)));
  assert.ok(Math.abs(wilder14 - lastOf(ind.ema(values, 27))) < 0.5,
    'Wilder(p) must behave as EMA(2p-1)');
});

test('reads RSI 100 on an unbroken advance and 0 on an unbroken decline', () => {
  const up = bars(Array.from({ length: 40 }, (_, i) => 100 + i));
  assert.equal(lastOf(ind.rsi(up, 14)), 100);
  const down = bars(Array.from({ length: 40 }, (_, i) => 200 - i));
  assert.equal(lastOf(ind.rsi(down, 14)), 0);
});

test('holds RSI near 50 for a perfectly alternating series', () => {
  const closes = [];
  for (let i = 0; i < 60; i++) closes.push(i % 2 ? 101 : 100);
  const rsi = lastOf(ind.rsi(bars(closes), 14));
  // Not exactly 50, and it should not be: Wilder's average moves 1/14 of the
  // way on every bar, so an alternating series leaves the gain and loss
  // averages oscillating about ±0.036 either side of 0.5 and the reading
  // wobbles a few points with the phase of the last bar. A test asserting
  // exactly 50 would be asserting a smoothing this indicator does not do.
  assert.ok(Math.abs(rsi - 50) < 5, `expected about 50, got ${rsi}`);
});

test('collapses the Bollinger bands onto the middle for a flat series', () => {
  const b = bars(new Array(40).fill(250));
  const bb = ind.bollinger(b, 20, 2);
  assert.equal(lastOf(bb.middle), 250);
  assert.equal(lastOf(bb.upper), 250);
  assert.equal(lastOf(bb.lower), 250);
  assert.equal(lastOf(bb.width), 0);
});

test('measures ATR as the mean true range', () => {
  // Every bar spans exactly 2 and never gaps, so the true range is 2 throughout.
  const b = bars(new Array(40).fill(100));
  assert.equal(lastOf(ind.atr(b, 14)), 2);
});

test('takes the MACD signal from the MACD line, not from the price', () => {
  const b = bars(Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 6) * 5));
  const m = ind.macd(b);
  assert.equal(m.macd.length, b.length);
  // The signal must warm up AFTER the line — seeding it from bar 0 would eat
  // the leading nulls and start the histogram wrong.
  const firstLine = m.macd.findIndex(v => v !== null);
  const firstSignal = m.signal.findIndex(v => v !== null);
  assert.ok(firstSignal > firstLine, 'the signal cannot exist before the line it averages');
  for (let i = 0; i < b.length; i++) {
    if (m.histogram[i] === null) continue;
    assert.ok(Math.abs(m.histogram[i] - (m.macd[i] - m.signal[i])) < 1e-9);
  }
});

test('drives ADX high on a trend and low on a chop', () => {
  const trend = bars(Array.from({ length: 80 }, (_, i) => 100 + i * 2));
  const chop = bars(Array.from({ length: 80 }, (_, i) => 100 + (i % 2)));
  const trending = lastOf(ind.adx(trend, 14).adx);
  const choppy = lastOf(ind.adx(chop, 14).adx);
  assert.ok(trending > 40, `a clean trend should read high, got ${trending}`);
  assert.ok(choppy < 30, `a two-tick chop should read low, got ${choppy}`);
  assert.ok(lastOf(ind.adx(trend, 14).plusDI) > lastOf(ind.adx(trend, 14).minusDI));
});

test('flips SuperTrend direction with the market', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 2)
    .concat(Array.from({ length: 40 }, (_, i) => 178 - i * 3));
  const st = ind.supertrend(bars(closes), 10, 3);
  assert.equal(st.direction[39], 1, 'still long at the top of the advance');
  assert.equal(lastOf(st.direction), -1, 'short after the decline');
  // The line sits below price in an uptrend and above it in a downtrend — the
  // whole point of it being usable as a stop.
  assert.ok(st.value[39] < closes[39]);
  assert.ok(lastOf(st.value) > lastOf(closes));
});

test('resets VWAP on each session', () => {
  const day = 24 * 3600;
  // Two sessions: the first flat at 100, the second flat at 200. Without a
  // reset the second day's VWAP would drag toward 150 and stop being the
  // fair-value line traders read it as.
  const first = bars(new Array(10).fill(100), 4 * 3600);
  const second = bars(new Array(10).fill(200), 4 * 3600 + day);
  const all = first.concat(second);
  const v = ind.vwap(all, (t) => Math.floor((t + 5.5 * 3600) / day));
  assert.equal(v[9], 100);
  assert.equal(lastOf(v), 200);
});

test('computes pivots and CPR from one previous session', () => {
  const p = ind.pivots({ high: 110, low: 90, close: 100 });
  assert.equal(p.pivot, 100);
  assert.equal(p.r1, 110);
  assert.equal(p.s1, 90);
  assert.equal(p.r2, 120);
  assert.equal(p.s2, 80);
  // BC is the mid of the range, TC its mirror through the pivot. Here they
  // coincide, which is the narrowest possible CPR.
  assert.equal(p.cprWidth, 0);
  assert.equal(p.prevClose, 100);
  assert.equal(ind.pivots(null), null);
  assert.equal(ind.pivots({ high: null, low: 1, close: 1 }), null);
});

test('measures a volume ratio against the bars before it, not including it', () => {
  const b = bars(new Array(40).fill(100));
  for (const bar of b) bar.volume = 10;
  lastOf(b).volume = 100;
  const profile = ind.volumeProfile(b, 20);
  assert.equal(lastOf(profile.average), 10, 'the spike must not be in its own average');
  assert.equal(lastOf(profile.ratio), 10);
});

test('splits a bar into buying and selling pressure', () => {
  assert.deepEqual(ind.pressure({ high: 110, low: 100, close: 110 }), { buying: 100, selling: 0 });
  assert.deepEqual(ind.pressure({ high: 110, low: 100, close: 105 }), { buying: 50, selling: 50 });
  // A bar with no range has no pressure either way rather than a division by
  // zero.
  assert.deepEqual(ind.pressure({ high: 100, low: 100, close: 100 }), { buying: 50, selling: 50 });
});

test('drops unusable bars instead of reading them as zero', () => {
  const normalised = ind.normalise([
    { time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
    null,
    { time: 2, close: 'not a number' },
    { time: 3, c: 4 },                     // the short key spelling
  ]);
  assert.equal(normalised.length, 2);
  assert.equal(normalised[1].close, 4);
  // A bar with only a close is a real thing (a line series); its OHLC collapses
  // onto that close rather than onto zero.
  assert.equal(normalised[1].high, 4);
});
