// The NIFTY 5-second 3-candle trend confirmation — doc/update-point.md.
//
// The filter is a pure function of a bar array, so every row of the document's
// decision table is testable directly: no market, no clock, no broker. The
// document's own cases are asserted verbatim, because a filter that quietly
// disagrees with the spec it was written from is worse than no filter at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ist } = require('./helpers');
const tf = require('../src/strategy/trendFilter');

const { BAR_STATES, VERDICT_STATES } = tf;

// A 5-second NIFTY bar. Prices are index points; paise are what the engine
// actually carries, so `p()` converts once here rather than in every case.
const p = (points) => Math.round(points * 100);

let seq = 0;
function bar({ o, h, l, c, ticks = 20, synthetic = false, at = null } = {}) {
  const start = at ?? ist('2026-07-28 14:00:00') + (seq++) * 5000;
  return {
    token: 'NIFTY-IDX',
    timeframe: '5s',
    bucketStart: start,
    bucketEnd: start + 5000,
    openP: p(o), highP: p(h), lowP: p(l), closeP: p(c),
    tickCount: synthetic ? 0 : ticks,
    synthetic,
    partial: false,
  };
}

// ↑ and ↓ from the document's table: a textbook strong bar of either direction,
// clearing both the classification thresholds and the quality score.
function up(base, size = 2) {
  return bar({ o: base, h: base + size * 1.02, l: base - size * 0.02, c: base + size });
}
function down(base, size = 2) {
  return bar({ o: base, h: base + size * 0.02, l: base - size * 1.02, c: base - size });
}

const cfg = (over = {}) => ({
  confirmBars: 3, bodyPct: 60, closeNearPct: 25, strongBodyPct: 70, wickPct: 15,
  maxRangeP: p(10), minScore: 5, minTicks: 4, momentum: true, ...over,
});

/* ------------------------------------------------------ the three bar states */

test('a strong bullish bar: big body, close near the high', () => {
  const out = tf.classify(bar({ o: 25100, h: 25102.1, l: 25099.9, c: 25102 }), cfg());
  assert.equal(out.state, BAR_STATES.STRONG_BULLISH);
});

test('a strong bearish bar: big body, close near the low', () => {
  const out = tf.classify(bar({ o: 25102, h: 25102.1, l: 25099.9, c: 25100 }), cfg());
  assert.equal(out.state, BAR_STATES.STRONG_BEARISH);
});

test('a small body inside a long range is NEUTRAL, however green it looks', () => {
  // Green, and worthless: a 0.4-point body inside a 5-point range.
  const out = tf.classify(bar({ o: 25100, h: 25104, l: 25099, c: 25100.4 }), cfg());
  assert.equal(out.state, BAR_STATES.NEUTRAL);
  assert.match(out.reason, /body is 8%/);
});

test('a doji with long wicks is NEUTRAL, not a direction', () => {
  const out = tf.classify(bar({ o: 25100, h: 25101.5, l: 25098.5, c: 25100.1 }), cfg());
  assert.equal(out.state, BAR_STATES.NEUTRAL);
});

test('a big body that closes mid-range is NEUTRAL — the close must be at the extreme', () => {
  // A 65% body, so it clears the body test, but it gave a third of the range
  // back before the close. Direction without a close at the extreme is a bar
  // that was already being sold into.
  const out = tf.classify(bar({ o: 25100, h: 25103, l: 25099.9, c: 25102 }), cfg());
  assert.equal(out.state, BAR_STATES.NEUTRAL);
  assert.match(out.reason, /below the high/);
});

/* -------------------------------------------------------------- thin bars -- */

test('a bar with no ticks is NO_DATA — a silent feed is not a flat market', () => {
  const out = tf.classify(bar({ o: 25100, h: 25100, l: 25100, c: 25100, synthetic: true }), cfg());
  assert.equal(out.state, VERDICT_STATES.NO_DATA);
});

test('a bar built from too few samples is NO_DATA, whatever shape it appears to be', () => {
  // Textbook-bullish geometry drawn from two REST polls. The shape describes the
  // poller, not the market, so it is refused rather than classified.
  const thin = bar({ o: 25100, h: 25102.1, l: 25099.9, c: 25102, ticks: 2 });
  assert.equal(tf.classify(thin, cfg()).state, VERDICT_STATES.NO_DATA);
  assert.match(tf.classify(thin, cfg()).reason, /2 ticks, under the 4/);

  // Same bar, threshold lowered: now it measures something.
  assert.equal(tf.classify(thin, cfg({ minTicks: 2 })).state, BAR_STATES.STRONG_BULLISH);
});

test('the candle builder\'s own tradable flag is honoured', () => {
  const flagged = { ...bar({ o: 25100, h: 25102.1, l: 25099.9, c: 25102 }), tradable: false };
  assert.equal(tf.classify(flagged, cfg()).state, VERDICT_STATES.NO_DATA);
});

/* -------------------------------------------------- the document's six cases */

test('case 1 — ↑ ↑ ↑ allows the PE sell and BLOCKS the CE sell', () => {
  const v = tf.verdict([up(25100), up(25102), up(25104)], cfg());
  assert.equal(v.state, BAR_STATES.STRONG_BULLISH);
  assert.equal(v.allowPE, true, 'a rising index means selling puts');
  assert.equal(v.allowCE, false, 'and never selling calls into it');
});

test('case 2 — ↓ ↓ ↓ allows the CE sell and BLOCKS the PE sell', () => {
  const v = tf.verdict([down(25104), down(25102), down(25100)], cfg());
  assert.equal(v.state, BAR_STATES.STRONG_BEARISH);
  assert.equal(v.allowCE, true);
  assert.equal(v.allowPE, false);
});

test('case 3 — ↑ ↑ ↓ is bullish but weak: skip', () => {
  const v = tf.verdict([up(25100), up(25102), down(25104)], cfg());
  assert.equal(v.state, VERDICT_STATES.CHOPPY);
  assert.equal(v.allowCE, false);
  assert.equal(v.allowPE, false);
  assert.match(v.reason, /↑ ↑ ↓/);
});

test('case 4 — ↓ ↓ ↑ is bearish but weak: skip', () => {
  const v = tf.verdict([down(25104), down(25102), up(25100)], cfg());
  assert.equal(v.state, VERDICT_STATES.CHOPPY);
  assert.equal(v.allowCE, false);
  assert.equal(v.allowPE, false);
});

test('case 5 — ↑ ↓ ↑ is choppy: skip', () => {
  const v = tf.verdict([up(25100), down(25102), up(25100)], cfg());
  assert.equal(v.state, VERDICT_STATES.CHOPPY);
  assert.equal(v.allowPE, false);
});

test('case 6 — ↓ ↑ ↓ is choppy: skip', () => {
  const v = tf.verdict([down(25102), up(25100), down(25102)], cfg());
  assert.equal(v.state, VERDICT_STATES.CHOPPY);
  assert.equal(v.allowCE, false);
});

test('three neutral bars agree with each other and still do not trade', () => {
  const flat = () => bar({ o: 25100, h: 25101, l: 25099, c: 25100.1 });
  const v = tf.verdict([flat(), flat(), flat()], cfg());
  assert.equal(v.state, BAR_STATES.NEUTRAL);
  assert.equal(v.allowCE, false);
  assert.equal(v.allowPE, false);
});

/* ------------------------------------------------ the combined volatility -- */

test('volatility is measured across the WHOLE window, not bar by bar', () => {
  // Three individually-calm 4-point bars that together travel 12 points. Each
  // one passes on its own; the move they add up to is the thing being filtered.
  const v = tf.verdict([up(25100, 4), up(25104, 4), up(25108, 4)], cfg());
  assert.equal(v.state, VERDICT_STATES.HIGH_VOLATILITY);
  assert.match(v.reason, /span 12\.2 points/);
  assert.equal(v.allowPE, false);
});

test('a window inside the 10-point span is allowed', () => {
  const v = tf.verdict([up(25100, 2), up(25102, 2), up(25104, 2)], cfg());
  assert.equal(v.state, BAR_STATES.STRONG_BULLISH);
  assert.equal(v.allowPE, true);
});

test('one silent bar in the window blocks it — the filter never guesses', () => {
  const bars = [
    up(25100),
    bar({ o: 25102, h: 25102, l: 25102, c: 25102, synthetic: true }),
    up(25102),
  ];
  const v = tf.verdict(bars, cfg());
  assert.equal(v.state, VERDICT_STATES.NO_DATA);
  assert.equal(v.allowCE, false);
  assert.equal(v.allowPE, false);
});

/* ------------------------------------------------------------- momentum --- */

test('continuously shrinking ranges are a fading trend: skip', () => {
  // The document's own example, scaled to stay inside the 10-point span limit
  // so it is the momentum rule being tested and not the volatility one.
  const v = tf.verdict([up(25100, 3), up(25103, 2), up(25105, 1)], cfg());
  assert.equal(v.state, VERDICT_STATES.WEAKENING);
  assert.equal(v.allowPE, false);
  assert.match(v.reason, /3\.1 → 2\.1 → 1\.0/);
});

test('growing ranges are strengthening momentum and pass', () => {
  // 2 → 3 → 4 points, and 9.2 total: inside the span limit.
  const v = tf.verdict([up(25100, 2), up(25102, 3), up(25105, 4)], cfg());
  assert.equal(v.state, BAR_STATES.STRONG_BULLISH);
  assert.equal(v.allowPE, true);
});

test('equal ranges are not shrinking ranges', () => {
  const v = tf.verdict([up(25100, 2), up(25102, 2), up(25104, 2)], cfg());
  assert.equal(v.state, BAR_STATES.STRONG_BULLISH);
});

test('the momentum rule can be turned off without touching anything else', () => {
  const shrinking = [up(25100, 3), up(25103, 2), up(25105, 1)];
  assert.equal(tf.verdict(shrinking, cfg()).state, VERDICT_STATES.WEAKENING);
  assert.equal(tf.verdict(shrinking, cfg({ momentum: false })).state, BAR_STATES.STRONG_BULLISH);
});

/* ---------------------------------------------------------------- score --- */

test('the quality score is out of 5 — there is no volume in this feed to score', () => {
  assert.equal(tf.MAX_SCORE, 5);
  const s = tf.strength(bar({ o: 25100, h: 25102.1, l: 25099.98, c: 25102 }), cfg());
  assert.deepEqual(s.parts, { body: 2, smallOpposingWick: 1, closeAtExtreme: 2 });
  assert.equal(s.total, 5);
});

test('each term of the score is earned separately', () => {
  // 65% body: clears the 60% classification bar, misses the 70% score bar.
  const softBody = tf.strength(bar({ o: 25100, h: 25101.8, l: 25099.8, c: 25101.3 }), cfg());
  assert.equal(softBody.parts.body, 0);
  assert.ok(softBody.total < 5);

  // A long upper wick on a bullish bar: the close is not at the extreme either.
  const wicked = tf.strength(bar({ o: 25100, h: 25103, l: 25099.9, c: 25102 }), cfg());
  assert.equal(wicked.parts.smallOpposingWick, 0);
  assert.equal(wicked.parts.closeAtExtreme, 0);
});

test('EVERY bar must clear the score, not just the newest', () => {
  // Three bullish bars; the middle one closes short of the extreme. The document
  // asks for three consecutive STRONG candles, so one weak bar refuses the set.
  const weakMiddle = bar({ o: 25102, h: 25104.5, l: 25101.9, c: 25104 });
  const v = tf.verdict([up(25100), weakMiddle, up(25104)], cfg());
  assert.equal(v.state, VERDICT_STATES.CHOPPY);
  assert.match(v.reason, /bar 2 of 3 scores/);
  assert.equal(v.allowPE, false);
});

test('minScore 0 leaves the plain direction rule the document starts from', () => {
  const weakMiddle = bar({ o: 25102, h: 25104.5, l: 25101.9, c: 25104 });
  const bars = [up(25100), weakMiddle, up(25104)];
  assert.equal(tf.verdict(bars, cfg()).state, VERDICT_STATES.CHOPPY);
  assert.equal(tf.verdict(bars, cfg({ minScore: 0 })).state, BAR_STATES.STRONG_BULLISH);
});

/* ----------------------------------------------------------------- warm-up */

test('the verdict refuses until three bars exist', () => {
  const v = tf.verdict([up(25100), up(25102)], cfg());
  assert.equal(v.state, VERDICT_STATES.WARMING_UP);
  assert.equal(v.allowCE, false);
  assert.equal(v.allowPE, false);

  const ready = tf.verdict([up(25100), up(25102), up(25104)], cfg());
  assert.equal(ready.state, BAR_STATES.STRONG_BULLISH);
});

test('an empty or missing buffer is WARMING_UP, never a permission', () => {
  for (const input of [[], null, undefined]) {
    const v = tf.verdict(input, cfg());
    assert.equal(v.state, VERDICT_STATES.WARMING_UP);
    assert.equal(v.allowCE, false);
    assert.equal(v.allowPE, false);
  }
});

test('only the newest three bars are read — the buffer may be longer', () => {
  const stale = [down(25120), down(25118), down(25116)];
  const v = tf.verdict([...stale, up(25100), up(25102), up(25104)], cfg());
  assert.equal(v.state, BAR_STATES.STRONG_BULLISH);
  assert.equal(v.window.length, 3);
});

/* ------------------------------------------------------------- the anchor -- */

test('the verdict is stamped with the newest bar\'s close, so staleness is measurable', () => {
  // "A signal is valid only until the next 5-second candle closes" — the engine
  // measures that against this field.
  const bars = [up(25100), up(25102), up(25104)];
  const v = tf.verdict(bars, cfg());
  assert.equal(v.atMs, bars[bars.length - 1].bucketEnd);
});

/* --------------------------------------------------------- the price fence */

test('nothing in the module returns an index PRICE to trade from', () => {
  // doc/update-point.md: "The Option Candle is still used only for calculating
  // the SELL price." The verdict carries booleans and diagnostics; the engine
  // has no way to turn one into a limit.
  const v = tf.verdict([up(25100), up(25102), up(25104)], cfg());

  assert.equal(typeof v.allowCE, 'boolean');
  assert.equal(typeof v.allowPE, 'boolean');
  for (const key of ['price', 'pricePaise', 'limitP', 'sellP', 'closeP', 'offsetP']) {
    assert.equal(v[key], undefined, `the verdict must not carry ${key}`);
  }
});
