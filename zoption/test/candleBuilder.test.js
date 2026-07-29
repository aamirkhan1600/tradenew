const test = require('node:test');
const assert = require('node:assert/strict');
const { ist } = require('./helpers');
const { CandleBuilder, CandleSeries } = require('../src/market/candleBuilder');

function collect(builder) {
  const bars = [];
  const dropped = [];
  builder.on('candle', b => bars.push(b));
  builder.on('discarded', b => dropped.push(b));
  return { bars, dropped };
}

test('the first bucket is partial and never reaches the engine', () => {
  // Its open is wherever the tick stream happened to start, so its OHLC
  // describes the subscription rather than the market.
  const b = new CandleBuilder({ timeframe: '1m', minTicks: 1 });
  const { bars, dropped } = collect(b);
  b.track('T');

  b.addTick('T', 1220, ist('2026-07-28 10:15:30'));   // joined mid-bucket
  b.addTick('T', 1240, ist('2026-07-28 10:15:50'));
  b.addTick('T', 1250, ist('2026-07-28 10:16:10'));   // closes the partial

  assert.equal(dropped.length, 1);
  assert.equal(bars.length, 0, 'nothing tradable is emitted from a partial bar');
  assert.equal(b.stats.discardedPartial, 1);
});

test('a fully observed bar carries the right OHLC and is tradable', () => {
  const b = new CandleBuilder({ timeframe: '1m', minTicks: 2 });
  const { bars } = collect(b);
  b.track('T');

  b.addTick('T', 1200, ist('2026-07-28 10:15:10'));   // partial, discarded
  b.addTick('T', 1210, ist('2026-07-28 10:16:01'));   // opens the real bar
  b.addTick('T', 1260, ist('2026-07-28 10:16:20'));
  b.addTick('T', 1190, ist('2026-07-28 10:16:40'));
  b.addTick('T', 1240, ist('2026-07-28 10:16:59'));
  b.addTick('T', 1300, ist('2026-07-28 10:17:01'));   // closes it

  assert.equal(bars.length, 1);
  const bar = bars[0];
  // The worked example from the documents: O 12.10 H 12.60 L 11.90 C 12.40.
  assert.deepEqual(
    { o: bar.openP, h: bar.highP, l: bar.lowP, c: bar.closeP },
    { o: 1210, h: 1260, l: 1190, c: 1240 });
  assert.equal(bar.bucketStart, ist('2026-07-28 10:16:00'));
  assert.equal(bar.tickCount, 4);
  assert.equal(bar.tradable, true);
  assert.equal(bar.synthetic, false);
});

test('a silent bucket becomes a synthetic bar that is never tradable', () => {
  const b = new CandleBuilder({ timeframe: '1m', minTicks: 1 });
  const { bars } = collect(b);
  b.track('T');

  b.addTick('T', 1200, ist('2026-07-28 10:15:10'));   // partial
  b.addTick('T', 1240, ist('2026-07-28 10:16:10'));   // real bar opens
  b.addTick('T', 1250, ist('2026-07-28 10:19:10'));   // two silent minutes

  assert.equal(bars.length, 3);
  assert.equal(bars[0].synthetic, false);
  assert.equal(bars[0].closeP, 1240);

  for (const gap of bars.slice(1)) {
    assert.equal(gap.synthetic, true);
    assert.equal(gap.tickCount, 0);
    // Offsetting from a stale close is fiction, so a synthetic bar must never
    // be allowed to price an entry.
    assert.equal(gap.tradable, false, 'a synthetic bar must not be tradable');
    assert.equal(gap.openP, 1240);
    assert.equal(gap.closeP, 1240);
  }
  assert.equal(bars[1].bucketStart, ist('2026-07-28 10:17:00'));
  assert.equal(bars[2].bucketStart, ist('2026-07-28 10:18:00'));
});

test('a bar with too few ticks is low-confidence and not tradable', () => {
  const b = new CandleBuilder({ timeframe: '1m', minTicks: 3 });
  const { bars } = collect(b);
  b.track('T');

  b.addTick('T', 1200, ist('2026-07-28 10:15:10'));   // partial
  b.addTick('T', 1240, ist('2026-07-28 10:16:05'));   // one tick only
  b.addTick('T', 1250, ist('2026-07-28 10:17:05'));

  assert.equal(bars.length, 1);
  assert.equal(bars[0].tickCount, 1);
  assert.equal(bars[0].lowConfidence, true);
  assert.equal(bars[0].tradable, false);
});

test('the timer closes a bar even when the strike goes completely quiet', () => {
  // Closing only on the next tick would wedge a leg indefinitely on an illiquid
  // strike — exactly when you least want the engine stuck.
  const s = new CandleSeries({ token: 'T', timeframe: '1m' });
  s.sawFirst = true;                                  // pretend the partial is behind us
  s.addTick(1240, ist('2026-07-28 10:16:10'));

  assert.deepEqual(s.closeIfElapsed(ist('2026-07-28 10:16:59')), [], 'not yet');

  const closed = s.closeIfElapsed(ist('2026-07-28 10:17:05'));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closeP, 1240);
  assert.equal(closed[0].bucketStart, ist('2026-07-28 10:16:00'));
});

test('an out-of-order tick never rewrites a bar the engine may have traded on', () => {
  const b = new CandleBuilder({ timeframe: '1m', minTicks: 1 });
  const { bars } = collect(b);
  b.track('T');

  b.addTick('T', 1200, ist('2026-07-28 10:15:10'));   // partial
  b.addTick('T', 1240, ist('2026-07-28 10:16:10'));
  b.addTick('T', 1300, ist('2026-07-28 10:17:10'));   // closes 10:16 at 1240
  b.addTick('T', 9999, ist('2026-07-28 10:16:30'));   // late frame from a reconnect

  assert.equal(bars.length, 1);
  assert.equal(bars[0].closeP, 1240, 'the closed bar is immutable');
  assert.equal(b.inProgress('T').closeP, 1300, 'and the late tick did not land in the live bar');
});

test('two builders started seconds apart produce identical bars', () => {
  // Same property as the time test, asserted end to end through the builder:
  // a restart must not silently change the strategy's entries.
  const ticks = [];
  for (let s = 0; s < 180; s += 7) {
    ticks.push([1200 + (s % 40), ist('2026-07-28 10:15:00') + s * 1000]);
  }

  const build = (skip) => {
    const b = new CandleBuilder({ timeframe: '1m', minTicks: 1 });
    const { bars } = collect(b);
    b.track('T');
    for (const [p, t] of ticks.slice(skip)) b.addTick('T', p, t);
    return bars;
  };

  const a = build(0);
  const c = build(2);
  // The first (partial) bar differs by construction; every fully observed bar
  // after it must match exactly.
  const key = (x) => `${x.bucketStart}:${x.openP}:${x.highP}:${x.lowP}:${x.closeP}`;
  assert.deepEqual(a.map(key), c.map(key));
});

test('setTokens drops a strike and its half-built bar', () => {
  const b = new CandleBuilder({ timeframe: '1m' });
  b.setTokens(['A', 'B']);
  assert.equal(b.series.size, 2);
  b.addTick('A', 1000, ist('2026-07-28 10:15:10'));
  b.setTokens(['B']);
  assert.equal(b.series.size, 1);
  assert.equal(b.lastClosed('A'), null);
});

test('a zero or negative price is not a price', () => {
  const b = new CandleBuilder({ timeframe: '1m', minTicks: 1 });
  b.track('T');
  b.addTick('T', 0, ist('2026-07-28 10:15:10'));
  b.addTick('T', -5, ist('2026-07-28 10:15:20'));
  assert.equal(b.inProgress('T'), null);
});
