// The trend-filter replay.
//
// The replay drives the REAL filter — `src/strategy/trendFilter.js`, unmodified
// — so these tests are about the harness around it: does it count what it says
// it counts, does it score a signal against the right direction, and does it
// refuse to quietly change a threshold.
//
// That last one matters most. A backtest that adjusts a setting to make the
// numbers look reasonable, and then reports the numbers, is worse than no
// backtest at all.

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const replayer = require('../src/backtest/trendReplay');
const { ist } = require('./helpers');

const MINUTE = 60 * 1000;

// A bar in the shape the filter reads. `tickCount` is high enough to pass the
// sample guard unless a test is specifically about it.
function bar(i, o, h, l, c, extra = {}) {
  const start = ist('2026-07-30 09:20:00') + i * MINUTE;
  return {
    bucketStart: start,
    bucketEnd: start + MINUTE,
    openP: o, highP: h, lowP: l, closeP: c,
    tickCount: 50,
    synthetic: false,
    source: 'LIVE',
    ...extra,
  };
}

// A textbook strong bar: a big body, closing on its extreme.
const bull = (i, base) => bar(i, base, base + 210, base - 10, base + 200);
const bear = (i, base) => bar(i, base, base + 10, base - 210, base - 200);
const flat = (i, base) => bar(i, base, base + 100, base - 100, base + 2);

const CFG = {
  confirmBars: 3, bodyPct: 60, closeNearPct: 25, strongBodyPct: 70,
  wickPct: 15, minScore: 5, minTicks: 4, momentum: true,
  // 30 points across the window, so the three-bar runs below are not rejected
  // by the volatility ceiling before the direction rule is reached.
  maxRangeP: 3000,
};

test('permits the PE side on a bullish run and the CE side on a bearish one', () => {
  // A bullish index permits selling PUTS — the side that profits from the move
  // continuing. Getting this backwards is the single worst bug this replay
  // could have, because the hit rate would then look like an edge inverted.
  const up = [bull(0, 2400000), bull(1, 2400200), bull(2, 2400400), bull(3, 2400600)];
  const r = replayer.replay(up, CFG, { lookaheadBars: 1 });
  assert.ok(r.signals > 0, 'a clean three-bar advance must permit something');
  assert.equal(r.ce, 0);
  assert.equal(r.pe, r.signals);
  assert.equal(r.detail[0].side, 'PE');

  const down = [bear(0, 2400000), bear(1, 2399800), bear(2, 2399600), bear(3, 2399400)];
  const d = replayer.replay(down, CFG, { lookaheadBars: 1 });
  assert.ok(d.signals > 0);
  assert.equal(d.pe, 0);
  assert.equal(d.detail[0].side, 'CE');
});

test('scores a signal by whether the index continued the permitted way', () => {
  // Three bullish bars, then a bar that keeps rising: the PE permission was
  // right.
  const good = [bull(0, 2400000), bull(1, 2400200), bull(2, 2400400), bull(3, 2400600)];
  const r = replayer.replay(good, CFG, { lookaheadBars: 1 });
  assert.equal(r.detail[0].correct, true);
  assert.ok(r.avgMovePoints > 0, 'a favourable move is signed positive');
  assert.equal(r.hitRate, 1);

  // The same three bars followed by a collapse: the permission was wrong, and
  // the favourable-signed move goes negative.
  const bad = [bull(0, 2400000), bull(1, 2400200), bull(2, 2400400),
    bar(3, 2400600, 2400610, 2390000, 2390100)];
  const b = replayer.replay(bad, CFG, { lookaheadBars: 1 });
  assert.equal(b.detail[0].correct, false);
  assert.ok(b.avgMovePoints < 0);
  assert.equal(b.hitRate, 0);
});

test('counts every verdict, not only the ones that permitted a trade', () => {
  const bars = [flat(0, 2400000), flat(1, 2400000), flat(2, 2400000),
    bull(3, 2400000), bull(4, 2400200), bull(5, 2400400)];
  const r = replayer.replay(bars, CFG, { lookaheadBars: 1 });
  // Six bars, a three-bar window: four evaluations.
  assert.equal(r.evaluated, 4);
  assert.equal(Object.values(r.states).reduce((a, b) => a + b, 0), r.evaluated,
    'the histogram must account for every evaluation');
  assert.ok(r.signalRate >= 0 && r.signalRate <= 1);
});

test('produces nothing rather than guessing when there are too few bars', () => {
  const r = replayer.replay([bull(0, 2400000), bull(1, 2400200)], CFG, { lookaheadBars: 1 });
  assert.equal(r.signals, 0);
  assert.equal(r.hitRate, null);
  assert.equal(r.avgMovePoints, null);
  assert.equal(replayer.replay([], CFG).evaluated, 0);
});

test('leaves the last signal unscored rather than scoring it against itself', () => {
  // The final bar has no future, so `forwardMove` returns null and the signal
  // is counted but not scored. Scoring it as a zero move would drag the hit
  // rate toward 50% with a measurement that does not exist.
  const bars = [bull(0, 2400000), bull(1, 2400200), bull(2, 2400400)];
  const r = replayer.replay(bars, CFG, { lookaheadBars: 3 });
  assert.equal(r.signals, 1);
  assert.equal(r.scored, 0);
  assert.equal(r.hitRate, null);
  assert.equal(r.detail[0].correct, null);
});

test('measures the forward move close to close', () => {
  const bars = [bull(0, 2400000), bull(1, 2400200), bull(2, 2400400), bull(3, 2400600)];
  // Bar 0 closes at 2400200; bar 2 closes at 2400600 — 400 paise, i.e. 4 points.
  assert.equal(replayer.forwardMove(bars, 0, 2), bars[2].closeP - bars[0].closeP);
  // Asking past the end clamps rather than throwing.
  assert.equal(replayer.forwardMove(bars, 0, 99), bars[3].closeP - bars[0].closeP);
  assert.equal(replayer.forwardMove(bars, 3, 3), null, 'the last bar has no future');
});

test('sweeps a grid without touching the settings it was given', () => {
  const bars = [];
  for (let i = 0; i < 40; i++) bars.push(bull(i, 2400000 + i * 200));
  const frozen = JSON.stringify(CFG);
  const swept = replayer.sweep(bars, CFG, { minScore: [0, 5], confirmBars: [2, 3] });
  assert.equal(swept.length, 4);
  assert.equal(JSON.stringify(CFG), frozen, 'the sweep must not mutate the base config');
  for (const s of swept) {
    assert.ok(Object.prototype.hasOwnProperty.call(s.override, 'minScore'));
    assert.ok(Object.prototype.hasOwnProperty.call(s.override, 'confirmBars'));
  }
  // Sorted best-first so the top of the table is the answer.
  const rates = swept.map(s => s.hitRate ?? -1);
  assert.deepEqual(rates, rates.slice().sort((a, b) => b - a));
});

test('blocks on a bar that measured nothing', () => {
  // The sample guard is what stops a "60% body" drawn from two REST polls being
  // read as a trend. The replay must not quietly bypass it on live bars.
  const bars = [bull(0, 2400000), bull(1, 2400200),
    bar(2, 2400400, 2400610, 2400390, 2400600, { tickCount: 1 })];
  const r = replayer.replay(bars, CFG, { lookaheadBars: 1 });
  assert.equal(r.signals, 0);
  assert.ok(r.states.NO_DATA > 0);
});
