// Downloaded history: validation, and the coordinate system it has to land in.
//
// Nothing here touches the network. The Yahoo service's own validation is
// exercised directly, and the mapper is fed bars shaped exactly as the live API
// returns them — the fixtures below are real timestamps and prices taken from a
// live download, not invented ones, because the entire point of the mapper is
// to agree with what Yahoo actually sends.

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const time = require('../src/core/time');
const yahoo = require('../src/market/yahoo');
const backfill = require('../src/market/backfill');
const { ist } = require('./helpers');

/* ------------------------------------------------------------ validation -- */

test('maps the platform underlyings to Yahoo symbols and passes others through', () => {
  assert.equal(yahoo.resolveSymbol('NIFTY'), '^NSEI');
  assert.equal(yahoo.resolveSymbol('nifty'), '^NSEI');
  assert.equal(yahoo.resolveSymbol('BANKNIFTY'), '^NSEBANK');
  assert.equal(yahoo.resolveSymbol('INDIAVIX'), '^INDIAVIX');
  // A raw Yahoo symbol is legitimate — the service is not limited to the four
  // indices this strategy trades.
  assert.equal(yahoo.resolveSymbol('RELIANCE.NS'), 'RELIANCE.NS');
  assert.equal(yahoo.resolveSymbol('^NSEI'), '^NSEI');
});

test('rejects a symbol that would not survive a URL path', () => {
  assert.throws(() => yahoo.resolveSymbol(''));
  assert.throws(() => yahoo.resolveSymbol('   '));
  assert.throws(() => yahoo.resolveSymbol('a/../../etc'));
  assert.throws(() => yahoo.resolveSymbol('x'.repeat(40)));
});

test('accepts only the documented intervals', () => {
  for (const iv of ['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1d', '1wk', '1mo']) {
    assert.equal(yahoo.validateInterval(iv), iv);
  }
  assert.throws(() => yahoo.validateInterval('7m'));
  assert.throws(() => yahoo.validateInterval('1h'), /interval must be one of/);
});

test('reads dates as ISO, epoch seconds or epoch milliseconds', () => {
  assert.equal(yahoo.parseDate('2026-07-30', 'd'), Date.UTC(2026, 6, 30));
  assert.equal(yahoo.parseDate(1785405300000, 'd'), 1785405300000);
  // Ten digits is seconds. Guessing wrong puts the request in 1970, and Yahoo
  // answers an out-of-range request with an empty series rather than an error —
  // the least debuggable outcome available.
  assert.equal(yahoo.parseDate(1785405300, 'd'), 1785405300000);
  assert.equal(yahoo.parseDate(null, 'd'), null);
  assert.throws(() => yahoo.parseDate('30-07-2026', 'd'));
  assert.throws(() => yahoo.parseDate('not a date', 'd'));
});

/* ---------------------------------------------------------------- mapper -- */

// A bar as the live API returns one: timestamped at its START, in UTC.
const bar = (utcMs, o, h, l, c) => ({ time: utcMs, open: o, high: h, low: l, close: c, volume: 0 });

test('maps a Yahoo bar into an aligned candle row in paise', () => {
  const start = ist('2026-07-30 09:15:00');
  const mapped = backfill.toCandleRow(bar(start, 24010.5, 24040.25, 24000.1, 24030.75),
    { token: '26000', timeframe: '5m', seconds: 300 });
  assert.ok(mapped.row, mapped.reject);
  assert.equal(mapped.row.bucketStart, start);
  assert.equal(mapped.row.openP, 2401050);
  assert.equal(mapped.row.highP, 2404025);
  assert.equal(mapped.row.lowP, 2400010);
  assert.equal(mapped.row.closeP, 2403075);
  assert.equal(mapped.row.source, 'BACKFILL');
  // Not a sample count — an exchange-aggregated bar has none, which is exactly
  // why the `source` column exists for readers to gate on instead.
  assert.equal(mapped.row.tickCount, 0);
  assert.equal(mapped.row.synthetic, false);
});

test('rejects a bar that does not sit on an absolute IST bucket boundary', () => {
  // 09:15 IST is a valid 5-minute boundary but NOT an hourly one: this
  // platform's buckets run 09:00-10:00 while NSE's session-relative hours run
  // 09:15-10:15. They are different bars, and merging them would be meaningless.
  const start = ist('2026-07-30 09:15:00');
  assert.equal(backfill.toCandleRow(bar(start, 1, 2, 0.5, 1.5),
    { token: 'T', timeframe: '1h', seconds: 3600 }).reject, 'unaligned');
  assert.ok(backfill.toCandleRow(bar(start, 1, 2, 0.5, 1.5),
    { token: 'T', timeframe: '5m', seconds: 300 }).row);
});

test('snaps a daily bar to IST midnight rather than rejecting it', () => {
  // Yahoo stamps a daily bar at the session open. The bar covers the whole
  // session either way, so moving the label is lossless — unlike the hourly
  // case above, where the content itself differs.
  const open = ist('2026-07-30 09:15:00');
  const mapped = backfill.toCandleRow(bar(open, 24010, 24300, 23900, 24250),
    { token: 'T', timeframe: '1d', seconds: 86400, snapToDay: true });
  assert.ok(mapped.row, mapped.reject);
  assert.equal(mapped.row.bucketStart, ist('2026-07-30 00:00:00'));
  assert.equal(time.tradeDate(mapped.row.bucketStart), '2026-07-30');
});

test('rejects a bar whose own OHLC contradicts itself', () => {
  const start = ist('2026-07-30 09:15:00');
  const at = (o, h, l, c) => backfill.toCandleRow(bar(start, o, h, l, c),
    { token: 'T', timeframe: '5m', seconds: 300 }).reject;
  assert.equal(at(100, 90, 95, 96), 'inconsistent', 'high below low');
  assert.equal(at(100, 105, 95, 110), 'inconsistent', 'close above high');
  assert.equal(at(100, 105, 95, 90), 'inconsistent', 'close below low');
  assert.equal(at(0, 0, 0, 0), 'price');
  assert.equal(backfill.toCandleRow({ time: 'x', open: 1, high: 1, low: 1, close: 1 },
    { token: 'T', timeframe: '5m', seconds: 300 }).reject, 'timestamp');
});

/* ------------------------------------------------------------------ fold -- */

test('folds session-relative bars into absolute hourly buckets', () => {
  // Twelve five-minute bars from 09:15 — the exchange's first session hour,
  // which straddles this platform's 09:00 and 10:00 buckets.
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const start = ist('2026-07-30 09:15:00') + i * 5 * 60 * 1000;
    const mapped = backfill.toCandleRow(bar(start, 100 + i, 110 + i, 90 + i, 105 + i),
      { token: 'T', timeframe: '5m', seconds: 300 });
    assert.ok(mapped.row, `bar ${i}: ${mapped.reject}`);
    rows.push(mapped.row);
  }

  const folded = backfill.foldRows(rows, 'T', '1h', 3600);
  // 09:15-09:55 falls in the 09:00 bucket; 10:00-10:10 in the 10:00 one.
  assert.equal(folded.length, 2);
  assert.equal(folded[0].bucketStart, ist('2026-07-30 09:00:00'));
  assert.equal(folded[1].bucketStart, ist('2026-07-30 10:00:00'));
  for (const f of folded) {
    assert.equal(time.bucketStart(f.bucketStart, 3600), f.bucketStart,
      'every folded bar must land on an absolute boundary');
    assert.equal(f.source, 'BACKFILL');
  }
  // The first bucket holds bars 0..8 (09:15 through 09:55).
  assert.equal(folded[0].openP, rows[0].openP);
  assert.equal(folded[0].closeP, rows[8].closeP);
  assert.equal(folded[0].highP, Math.max(...rows.slice(0, 9).map(r => r.highP)));
  assert.equal(folded[0].lowP, Math.min(...rows.slice(0, 9).map(r => r.lowP)));
});

test('refuses to backfill a timeframe Yahoo cannot source', () => {
  // Nothing below a minute exists at Yahoo, so 5s/15s/30s can only ever be live
  // recordings. Saying so beats storing an empty series.
  for (const tf of ['5s', '15s', '30s', '3m']) {
    assert.throws(() => backfill.sourceFor(tf), /cannot be backfilled/);
  }
  assert.equal(backfill.sourceFor('1m').interval, '1m');
  assert.equal(backfill.sourceFor('15m').interval, '15m');
  // 1h is sourced from five-minute bars precisely because Yahoo's own hourly
  // bars follow the exchange session and cannot be aligned.
  assert.equal(backfill.sourceFor('1h').interval, '5m');
  assert.equal(backfill.sourceFor('1h').fold, true);
  assert.equal(backfill.sourceFor('1d').snapToDay, true);
});
