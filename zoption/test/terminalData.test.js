// The terminal's data plumbing: chart-timeframe arithmetic, candle
// aggregation, candle patterns, and the quote reader that decides which chain
// columns are real.
//
// These four are grouped because they share one theme — they are the layer
// between what the broker actually sends and what the screen shows, and every
// one of them has a way to quietly turn missing data into a confident number.

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const time = require('../src/core/time');
const history = require('../src/market/history');
const patterns = require('../src/shared/patterns');
const neo = require('../src/broker/neoClient');
const { ist } = require('./helpers');

/* ------------------------------------------------------------ timeframes -- */

test('keeps the chart timeframes separate from the strategy timeframes', () => {
  // The engine may be configured with 5s..5m and no more. Adding 1h to the
  // strategy's map would silently make `candleTimeframe: 1h` a legal engine
  // configuration — an entry priced off an hourly close is a different
  // strategy, not a preference.
  assert.equal(time.isTimeframe('1h'), false);
  assert.equal(time.isChartTimeframe('1h'), true);
  assert.equal(time.isChartTimeframe('1d'), true);
  assert.throws(() => time.timeframeSeconds('1h'));
  assert.equal(time.chartTimeframeSeconds('1h'), 3600);
  for (const tf of Object.keys(time.TIMEFRAMES)) {
    assert.equal(time.chartTimeframeSeconds(tf), time.timeframeSeconds(tf),
      'a timeframe in both maps must mean the same thing in both');
  }
});

test('picks a base that divides the requested timeframe exactly', () => {
  assert.equal(time.baseTimeframeFor('15m'), '1m');
  assert.equal(time.baseTimeframeFor('1h'), '1m');
  assert.equal(time.baseTimeframeFor('1d'), '1m');
  assert.equal(time.baseTimeframeFor('15s'), '5s');
  assert.equal(time.baseTimeframeFor('30s'), '5s');
  // Nothing stored divides 5s, so it must be read directly.
  assert.equal(time.baseTimeframeFor('5s'), null);
});

test('aligns a daily bucket to IST midnight, not UTC', () => {
  // 00:30 IST on the 30th is 19:00 UTC on the 29th. A UTC-aligned daily bar
  // would file this print under the previous session.
  const early = ist('2026-07-30 00:30:00');
  const dayStart = time.bucketStart(early, 86400);
  assert.equal(dayStart, ist('2026-07-30 00:00:00'));
  const late = ist('2026-07-30 23:45:00');
  assert.equal(time.bucketStart(late, 86400), dayStart);
});

/* ------------------------------------------------------------- aggregate -- */

const bar = (t, o, h, l, c, ticks = 5, synthetic = false) => ({
  time: t, openP: o, highP: h, lowP: l, closeP: c, tickCount: ticks, synthetic,
});

test('folds base bars into wider ones', () => {
  const minute = 60000;
  const start = ist('2026-07-30 10:00:00');
  const bars = [
    bar(start, 100, 110, 95, 105),
    bar(start + minute, 105, 120, 100, 118),
    bar(start + 2 * minute, 118, 119, 90, 92),
    // A new 3-minute bucket begins here.
    bar(start + 3 * minute, 92, 96, 91, 95),
  ];
  const out = history.aggregate(bars, 180);
  assert.equal(out.length, 2);
  assert.deepEqual(
    { o: out[0].openP, h: out[0].highP, l: out[0].lowP, c: out[0].closeP },
    { o: 100, h: 120, l: 90, c: 92 });
  assert.equal(out[0].tickCount, 15, 'activity sums across the fold');
  assert.equal(out[0].time, start);
  assert.equal(out[1].openP, 92);
});

test('treats a wide bar as real if any bar inside it was', () => {
  const minute = 60000;
  const start = ist('2026-07-30 11:00:00');
  const mixed = history.aggregate([
    bar(start, 100, 100, 100, 100, 0, true),
    bar(start + minute, 100, 104, 99, 103, 7, false),
    bar(start + 2 * minute, 103, 103, 103, 103, 0, true),
  ], 180);
  assert.equal(mixed[0].synthetic, false, 'one real print in three minutes makes the bar real');

  const silent = history.aggregate([
    bar(start, 100, 100, 100, 100, 0, true),
    bar(start + minute, 100, 100, 100, 100, 0, true),
  ], 180);
  assert.equal(silent[0].synthetic, true);
});

test('leaves a gap in the series rather than back-filling it', () => {
  const minute = 60000;
  const start = ist('2026-07-30 12:00:00');
  // Two 5-minute buckets with a 5-minute hole between them. The aggregator
  // must not invent the missing bucket — the candle builder is what decides
  // whether a silent bar exists, and it flags the ones it creates.
  const out = history.aggregate([
    bar(start, 100, 101, 99, 100),
    bar(start + 10 * minute, 100, 101, 99, 100),
  ], 300);
  assert.equal(out.length, 2);
  assert.equal(out[1].time - out[0].time, 10 * minute);
});

/* -------------------------------------------------------------- patterns -- */

const shape = (o, h, l, c) => ({ open: o, high: h, low: l, close: c });

test('recognises the single-bar patterns', () => {
  // Body 0.1 on a range of 10 — a doji.
  assert.ok(patterns.at([shape(100, 105, 95, 100.1)], 0).includes('DOJI'));
  // A long lower wick, a small body at the top, almost no upper wick.
  assert.ok(patterns.at([shape(103, 105, 95, 104)], 0).includes('HAMMER'));
  assert.ok(patterns.at([shape(96.5, 105, 95, 95.5)], 0).includes('SHOOTING_STAR'));
  assert.ok(patterns.at([shape(95, 105, 95, 105)], 0).includes('BULLISH_MARUBOZU'));
  assert.ok(patterns.at([shape(105, 105, 95, 95)], 0).includes('BEARISH_MARUBOZU'));
});

test('classifies a body at the doji threshold as a doji and nothing else', () => {
  // Body exactly 5% of the range with a long lower wick — a dragonfly. The
  // hammer rule requires a body ABOVE the doji threshold, so the bar reads as a
  // doji alone. That is a convention rather than a law; it is asserted here so
  // that changing the threshold is a deliberate act rather than a surprise.
  const dragonfly = patterns.at([shape(104, 105, 95, 104.5)], 0);
  assert.ok(dragonfly.includes('DOJI'));
  assert.equal(dragonfly.includes('HAMMER'), false);
});

test('recognises the two-bar and three-bar patterns', () => {
  const engulf = [shape(102, 103, 99, 100), shape(99, 106, 98, 105)];
  assert.ok(patterns.at(engulf, 1).includes('BULLISH_ENGULFING'));

  const bearEngulf = [shape(100, 103, 99, 102), shape(103, 104, 97, 98)];
  assert.ok(patterns.at(bearEngulf, 1).includes('BEARISH_ENGULFING'));

  // Down bar, small-bodied pause, up bar closing past the first bar's midpoint.
  const morning = [shape(110, 111, 99, 100), shape(99, 100, 97, 99.2), shape(100, 108, 99, 107)];
  assert.ok(patterns.at(morning, 2).includes('MORNING_STAR'));

  const evening = [shape(100, 111, 99, 110), shape(111, 113, 110, 111.2), shape(110, 111, 101, 102)];
  assert.ok(patterns.at(evening, 2).includes('EVENING_STAR'));

  assert.ok(patterns.at([shape(100, 110, 90, 105), shape(101, 106, 95, 102)], 1)
    .includes('INSIDE_BAR'));
  assert.ok(patterns.at([shape(101, 106, 95, 102), shape(100, 110, 90, 105)], 1)
    .includes('OUTSIDE_BAR'));
});

test('rejects a three-bar star whose close does not recover past the midpoint', () => {
  // Same shape as a morning star except the third bar stalls. Dropping this
  // condition is the usual way an implementation ends up marking every
  // alternating triple.
  const weak = [shape(110, 111, 99, 100), shape(99, 100, 97, 99.2), shape(100, 102, 99, 101)];
  assert.equal(patterns.at(weak, 2).includes('MORNING_STAR'), false);
});

test('treats a zero-range bar as a doji rather than as NaN', () => {
  const flat = patterns.at([shape(100, 100, 100, 100)], 0);
  assert.ok(flat.includes('DOJI'));
  assert.ok(flat.every(p => typeof p === 'string'));
});

/* ----------------------------------------------------------- quote reader -- */

test('reads a rich quote under any of the key spellings Kotak uses', () => {
  const q = neo.readQuoteFull({
    tk: '43210', lp: '182.55', op: '175.00', h: '190.10', lo: '171.20', c: '178.40',
    v: '284500', oi: '1250000', prevOi: '1180000', bp1: '182.40', sp1: '182.70',
  });
  assert.equal(q.ltp, 182.55);
  assert.equal(q.open, 175);
  assert.equal(q.high, 190.1);
  assert.equal(q.close, 178.4);
  assert.equal(q.volume, 284500);
  assert.equal(q.oi, 1250000);
  assert.equal(q.oiChange, 70000);
  assert.equal(q.bid, 182.4);
  assert.ok(q.ids.includes('43210'));
});

test('reports a field the broker did not send as null, never as zero', () => {
  const q = neo.readQuoteFull({ tk: '1', ltp: '12.5' });
  assert.equal(q.ltp, 12.5);
  assert.equal(q.oi, null);
  assert.equal(q.volume, null);
  assert.equal(q.bid, null);
  assert.equal(q.oiChange, null, 'no previous OI means no change, not a change of zero');
});

test('treats a zero price as absent but a zero open interest as real', () => {
  const q = neo.readQuoteFull({ tk: '1', ltp: '0', bid: '0', oi: '0', volume: '0' });
  // A price of 0 means "no trade yet", which is absent rather than free.
  assert.equal(q.ltp, null);
  assert.equal(q.bid, null);
  // A strike can legitimately have no open interest and no volume, and saying
  // so is different from saying the broker sent nothing.
  assert.equal(q.oi, 0);
  assert.equal(q.volume, 0);
});

test('summarises which columns a batch of rows actually carried', () => {
  const cover = neo.quoteCoverage([
    { tk: '1', ltp: '10', oi: '500' },
    { tk: '2', ltp: '11' },
  ]);
  assert.equal(cover.total, 2);
  assert.equal(cover.available.ltp, true);
  assert.equal(cover.available.oi, true, 'one row carrying it means the field exists');
  assert.equal(cover.available.volume, false);
  assert.equal(cover.available.bid, false);
  assert.equal(neo.quoteCoverage([]).available.ltp, false);
});

/* ---------------------------------------------------- gateway failures ----- */

const quoteSource = require('../src/market/quoteSource');

test('tries the known-good quote filter before any richer one', () => {
  // The filter is a PATH SEGMENT, so an unrecognised name is an unroutable URL
  // and Kotak answers it with an HTML 503. Probing richest-first therefore
  // fired a burst of unroutable requests before reaching the one that works,
  // and any 503 from those was reported as the reason the spot price was
  // missing. `ltp` is the filter the engine already runs on.
  assert.equal(quoteSource.CANDIDATE_FILTERS[0], 'ltp');
  assert.equal(quoteSource.BASELINE_FILTER, 'ltp');
  assert.equal(quoteSource.RICHER_FILTERS.includes('ltp'), false);
});

test('tells a gateway refusal apart from an empty answer', () => {
  const gateway = (m) => quoteSource.isGatewayError(new Error(m));
  assert.equal(gateway('quotes: HTTP 503 <html>No available server</html>'), true);
  assert.equal(gateway('quotes: HTTP 502 Bad Gateway'), true);
  assert.equal(gateway('quotes: socket hang up'), true);
  assert.equal(gateway('quotes: connect ETIMEDOUT'), true);
  // A 4xx is the broker answering, not the gateway failing to route — it is not
  // retryable and must not trigger the backoff.
  assert.equal(gateway('quotes: HTTP 404 not found'), false);
  assert.equal(gateway('quotes: no data for this instrument'), false);
});

test('reduces an HTML error page to the one sentence that says something', () => {
  const described = quoteSource.describe(new Error(
    'quotes: HTTP 503 <html><body><h2>HTTP Server Error 503</h2>'
    + '<p>No available server to handle this request</p></body></html>'));
  assert.ok(described.includes('No available server to handle this request'));
  // The page says "503" three times — in the status line, the heading and the
  // body. The description says it once.
  assert.equal((described.match(/503/g) || []).length, 1);
  assert.equal(/<[a-z]/i.test(described), false, 'no markup survives into a status field');
  assert.ok(described.includes('diagnose-spot'), 'it must say what to run next');
  // A plain error is passed through untouched rather than dressed up.
  assert.equal(quoteSource.describe(new Error('quotes: connect ECONNREFUSED')),
    'quotes: connect ECONNREFUSED');
});

test('reads Kotak\'s nested ohlc and depth blocks', () => {
  // The richer filters NEST their payload and each returns only its own block —
  // there is no combined response. Read flat-only, an `ohlc` row looks like a
  // row with nothing in it, which is how a filter that works gets classified as
  // one that does not. These are the exact shapes the live gateway returned.
  const ohlc = neo.readQuoteFull({
    exchange_token: 'Nifty 50', exchange: 'nse_cm',
    ohlc: { open: '24249.5500', high: '24342.9500', low: '24187.1000', close: '24250.2000' },
  });
  assert.equal(ohlc.open, 24249.55);
  assert.equal(ohlc.high, 24342.95);
  assert.equal(ohlc.low, 24187.1);
  assert.equal(ohlc.close, 24250.2);
  assert.equal(ohlc.ltp, null, 'the ohlc filter carries no last traded price');

  const depth = neo.readQuoteFull({
    exchange_token: 'Nifty 50', exchange: 'nse_cm',
    depth: {
      buy: [{ price: '24310.50', quantity: '75', orders: '3' }, { price: '24310.00', quantity: '50', orders: '1' }],
      sell: [{ price: '24311.00', quantity: '50', orders: '2' }],
    },
  });
  // The best bid and offer are the first rung. Nothing here trades off level two.
  assert.equal(depth.bid, 24310.5);
  assert.equal(depth.bidQty, 75);
  assert.equal(depth.ask, 24311);
  assert.equal(depth.ltp, null);
});

test('never upgrades to a filter that carries no price', () => {
  // Kotak's filters are mutually exclusive, not cumulative. `ohlc` and `depth`
  // both look richer than `ltp` by field count, and selecting either would
  // trade the one number the whole platform runs on for some extra columns.
  const ohlcRow = { exchange_token: 'X', ohlc: { open: '1', high: '2', low: '0.5', close: '1.5' } };
  const depthRow = { exchange_token: 'X', depth: { buy: [{ price: '1', quantity: '1' }], sell: [{ price: '2', quantity: '1' }] } };
  assert.equal(quoteSource.isRich([ohlcRow]), false);
  assert.equal(quoteSource.isRich([depthRow]), false);
  // A price with nothing extra is not an upgrade either — it is the baseline.
  assert.equal(quoteSource.isRich([{ exchange_token: 'X', ltp: '10' }]), false);
  // A price AND extra fields is the only thing worth switching to.
  assert.equal(quoteSource.isRich([{ exchange_token: 'X', ltp: '10', oi: '500' }]), true);
});
