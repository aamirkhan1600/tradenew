const test = require('node:test');
const assert = require('node:assert/strict');
const { ist } = require('./helpers');
const time = require('../src/core/time');

test('bucketStart aligns a 1m bar to the IST minute', () => {
  const at = ist('2026-07-28 10:15:37.400');
  assert.equal(time.bucketStart(at, 60), ist('2026-07-28 10:15:00'));
  assert.equal(time.bucketEnd(time.bucketStart(at, 60), 60), ist('2026-07-28 10:16:00'));
});

test('a bar covers [start, end) — the last millisecond belongs to the same bar', () => {
  const start = ist('2026-07-28 10:15:00');
  assert.equal(time.bucketStart(ist('2026-07-28 10:15:59.999'), 60), start);
  assert.equal(time.bucketStart(ist('2026-07-28 10:16:00.000'), 60), ist('2026-07-28 10:16:00'));
});

test('two builders started seconds apart agree on the bucket', () => {
  // The property the whole candle engine rests on: buckets are absolute, so a
  // restart cannot silently shift the strategy's entries.
  const a = time.bucketStart(ist('2026-07-28 10:15:02'), 60);
  const b = time.bucketStart(ist('2026-07-28 10:15:58'), 60);
  assert.equal(a, b);
});

test('every supported timeframe divides the IST day evenly', () => {
  // A timeframe that does not would produce a short bar at midnight and a
  // boundary that drifts against the exchange's own clock.
  for (const [label, seconds] of Object.entries(time.TIMEFRAMES)) {
    assert.equal(86400 % seconds, 0, `${label} does not divide a day`);
  }
});

test('sub-minute buckets align to the IST second, not the epoch', () => {
  // 5s is what the index trend filter runs on — doc/update-point.md.
  assert.equal(time.bucketStart(ist('2026-07-28 10:15:07'), 5), ist('2026-07-28 10:15:05'));
  assert.equal(time.bucketStart(ist('2026-07-28 10:15:09.999'), 5), ist('2026-07-28 10:15:05'));
  assert.equal(time.bucketStart(ist('2026-07-28 10:15:07'), 15), ist('2026-07-28 10:15:00'));
  assert.equal(time.bucketStart(ist('2026-07-28 10:15:22'), 15), ist('2026-07-28 10:15:15'));
  assert.equal(time.bucketStart(ist('2026-07-28 10:15:44'), 30), ist('2026-07-28 10:15:30'));
});

test('a 4-minute bar would break epoch alignment — IST alignment holds', () => {
  // 19800 / 240 is not an integer, so this is the case that justifies aligning
  // to IST midnight rather than to the Unix epoch.
  const start = time.bucketStart(ist('2026-07-28 10:15:30'), 240);
  assert.equal(start, ist('2026-07-28 10:12:00'));
  assert.equal((start + time.IST_OFFSET_MS) % (240 * 1000), 0);
});

test('tradeDate rolls on IST midnight, not UTC midnight', () => {
  // 05:00 IST is still the previous UTC day. Keying the daily P&L on a UTC date
  // would roll the trading day over in the middle of pre-open.
  assert.equal(time.tradeDate(ist('2026-07-28 05:00:00')), '2026-07-28');
  assert.equal(time.tradeDate(ist('2026-07-28 23:59:00')), '2026-07-28');
  assert.equal(time.tradeDate(ist('2026-07-29 00:01:00')), '2026-07-29');
});

test('parseHhMm accepts HH:MM and HH:MM:SS and rejects nonsense', () => {
  assert.equal(time.parseHhMm('09:20'), 9 * 3600 + 20 * 60);
  assert.equal(time.parseHhMm('15:15:30'), 15 * 3600 + 15 * 60 + 30);
  assert.throws(() => time.parseHhMm('25:00'));
  assert.throws(() => time.parseHhMm('9.20'));
  assert.throws(() => time.parseHhMm(''));
});

test('isWithinSession honours the window and skips weekends', () => {
  // 2026-07-28 is a Tuesday; 2026-08-01 is a Saturday.
  assert.equal(time.isWithinSession(ist('2026-07-28 10:00:00'), '09:20', '15:10'), true);
  assert.equal(time.isWithinSession(ist('2026-07-28 09:19:59'), '09:20', '15:10'), false);
  assert.equal(time.isWithinSession(ist('2026-07-28 15:10:00'), '09:20', '15:10'), false);
  assert.equal(time.isWithinSession(ist('2026-08-01 10:00:00'), '09:20', '15:10'), false);
});

test('atIstTime lands on the same IST day', () => {
  assert.equal(time.atIstTime(ist('2026-07-28 10:00:00'), '15:15'), ist('2026-07-28 15:15:00'));
});

test('unsupported timeframes are refused rather than guessed', () => {
  assert.throws(() => time.timeframeSeconds('2m'), /unsupported/);
  assert.equal(time.isTimeframe('1m'), true);
  assert.equal(time.isTimeframe('2m'), false);
});
