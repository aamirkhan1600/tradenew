// newdoc/paralle.md — the merge step and the Validation Output Object.
//
// The Final Decision Matrix is tested AS A TABLE, row by row, in the document's
// own terms. That is the point of the file: the matrix was implemented before
// this module existed, spread across three early returns, and there was nothing
// a reviewer could hold up against the document.

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const validator = require('../src/ose/validation');
const trendEngine = require('../src/ose/trend');
const emaEngine = require('../src/ose/ema');
const entry = require('../src/ose/entry');
const h = require('./oseHelpers');

/* ---------------------------------------------------------------- fixtures */

// The three verdicts, built directly rather than by feeding candles through the
// engines — this module's job is the MERGE, and a fixture that had to produce a
// bearish EMA from real bars would be testing ./ema.js again.
const trendOf = (t) => ({
  trend: t,
  via: t === null ? trendEngine.VIA.TIE : trendEngine.VIA.CLOSE,
  reason: 'fixture',
});
const warmingTrend = () => ({
  trend: null, via: trendEngine.VIA.WARMING_UP, reason: 'only 2 completed index candles',
});
const emaOf = (t) => ({
  trend: t,
  state: t === null ? emaEngine.STATE.SIDEWAYS : t,
  via: t === null ? emaEngine.VIA.FLAT : emaEngine.VIA.ALIGNED,
  reason: 'fixture',
  separationP: t === emaEngine.BULLISH ? 500 : (t === emaEngine.BEARISH ? -500 : 0),
  ema9P: 2438400, ema20P: 2438350, cross: null, crossAge: null, flips: 0, closeP: 2438500,
});
const emaWarming = () => ({
  trend: null, state: emaEngine.STATE.WARMING_UP, via: emaEngine.VIA.WARMING_UP,
  reason: 'only 5 completed index candles', separationP: null,
});
// A midpoint decision. `pass` with the side it offers, or a named refusal.
const midOf = (optionType) => ({
  allowed: true, optionType, reason: optionType === 'PE' ? 'SELL_PE' : 'SELL_CE',
  detail: 'fixture', bullishMidP: 2438400, bearishMidP: 2438300,
});
const midFail = (reason = entry.REASONS.NO_MIDPOINT_BREAK) => ({
  allowed: false, optionType: null, reason, detail: 'fixture',
  bullishMidP: 2438400, bearishMidP: 2438300,
});

const B = emaEngine.BULLISH;
const R = emaEngine.BEARISH;

/* ================================================ the Final Decision Matrix */

test('paralle.md matrix: every row, in the document\'s own terms', () => {
  const rows = [
    // ema        3-candle   midpoint            expected side   expected result
    [B, B, midOf('PE'), 'SELL_PE', 'VALID_ENTRY'],
    [R, R, midOf('CE'), 'SELL_CE', 'VALID_ENTRY'],
    [B, R, midOf('CE'), null, 'EMA_TREND_CONFLICT'],
    [R, B, midOf('PE'), null, 'EMA_TREND_CONFLICT'],
    [null, B, midOf('PE'), null, 'EMA_SIDEWAYS'],
    [null, R, midOf('CE'), null, 'EMA_SIDEWAYS'],
    [B, null, midFail(entry.REASONS.TREND_UNDETERMINED), null, 'EMA_TREND_CONFLICT'],
    [B, B, midFail(), null, 'NO_ENTRY'],
    [R, R, midFail(), null, 'NO_ENTRY'],
  ];

  for (const [ema, trend, midpoint, side, result] of rows) {
    const out = validator.merge({ trend: trendOf(trend), ema: emaOf(ema), midpoint });
    const label = `EMA ${ema ?? 'SIDEWAYS'} · 3-candle ${trend ?? 'UNDETERMINED'} · midpoint `
      + `${midpoint.allowed ? 'PASS' : 'FAIL'}`;
    assert.equal(out.result, result, label);
    assert.equal(out.side, side, label);
    assert.equal(out.entryAllowed, side !== null, label);
  }
});

test('paralle.md: the output object has exactly the documented shape', () => {
  const out = validator.merge({
    trend: trendOf(B), ema: emaOf(B), midpoint: midOf('PE'),
  });

  // The document's own example, field for field.
  assert.equal(out.emaTrend, 'BULLISH');
  assert.equal(out.threeCandleTrend, 'BULLISH');
  assert.equal(out.midpoint, true);
  assert.equal(out.entryAllowed, true);
  assert.equal(out.side, 'SELL_PE');
  assert.equal(out.result, 'VALID_ENTRY');
  // And the engine's own vocabulary alongside it — this is what the decision log
  // stores and what the /ose panel tallies.
  assert.equal(out.reason, 'SELL_PE');
});

/* ------------------------------------------------------------- precedence -- */

test('the reason names the EARLIEST thing that was wrong, not the last', () => {
  // A cycle can fail several rows of the matrix at once. Reporting "no midpoint
  // break" about candles that have not warmed up yet is true and useless.
  const everythingWrong = validator.merge({
    trend: warmingTrend(), ema: emaWarming(), midpoint: midFail(),
  });
  assert.equal(everythingWrong.reason, 'WARMING_UP');
  assert.equal(everythingWrong.result, 'WARMING_UP');

  // With the trend warm but the EMA not, the EMA is the earliest cause.
  const emaNotWarm = validator.merge({
    trend: trendOf(B), ema: emaWarming(), midpoint: midFail(),
  });
  assert.equal(emaNotWarm.reason, emaEngine.OUTCOME.WARMING_UP);

  // With both warm, the midpoint is what is left.
  const midpointOnly = validator.merge({
    trend: trendOf(B), ema: emaOf(B), midpoint: midFail(),
  });
  assert.equal(midpointOnly.reason, entry.REASONS.NO_MIDPOINT_BREAK);
});

test('the EMA refusals keep their DISTINCT codes through the merge', () => {
  // The /ose panel is built on this granularity. Collapsing them into the
  // document's single EMA_SIDEWAYS would make a warming engine indistinguishable
  // from a chopping market on the one screen that exists to tell them apart.
  const seen = new Set();
  seen.add(validator.merge({ trend: trendOf(B), ema: emaWarming(), midpoint: midOf('PE') }).reason);
  seen.add(validator.merge({ trend: trendOf(B), ema: emaOf(null), midpoint: midOf('PE') }).reason);
  seen.add(validator.merge({ trend: trendOf(R), ema: emaOf(B), midpoint: midOf('CE') }).reason);

  assert.equal(seen.size, 3, `expected three distinct codes, got ${[...seen].join(', ')}`);
  assert.ok(seen.has(emaEngine.OUTCOME.WARMING_UP));
  assert.ok(seen.has(emaEngine.OUTCOME.SIDEWAYS));
  assert.ok(seen.has(emaEngine.OUTCOME.CONFLICT));
});

/* ----------------------------------------------------- the filter switched off */

test('with the EMA filter OFF it still REPORTS, it just does not refuse', () => {
  // The object must always say what the averages read — an operator comparing
  // the filter on against off needs both columns populated.
  const out = validator.merge({
    trend: trendOf(B), ema: emaOf(R), midpoint: midOf('PE'), emaEnabled: false,
  });

  assert.equal(out.entryAllowed, true, 'a disagreeing EMA must not block when it is not a gate');
  assert.equal(out.side, 'SELL_PE');
  assert.equal(out.emaTrend, 'BEARISH', 'and the disagreement is still on the record');
});

test('the trend warm-up refuses even with the EMA filter off', () => {
  // §10 owns that one — it is not the EMA filter's to waive.
  const out = validator.merge({
    trend: warmingTrend(), ema: null, midpoint: midFail(), emaEnabled: false,
  });
  assert.equal(out.entryAllowed, false);
  assert.equal(out.reason, 'WARMING_UP');
});

/* ------------------------------------------------------------------ purity */

test('merge is pure — same verdicts, same object, and no input mutated', () => {
  const trend = trendOf(B);
  const ema = emaOf(B);
  const midpoint = midOf('PE');
  const before = JSON.stringify([trend, ema, midpoint]);

  const a = validator.merge({ trend, ema, midpoint });
  const b = validator.merge({ trend, ema, midpoint });

  assert.deepEqual(a, b);
  assert.equal(JSON.stringify([trend, ema, midpoint]), before);
});

test('merge survives a missing verdict rather than throwing into the cycle', () => {
  // §20.5 turns a throw here into a CYCLE_EXCEPTION and closes an open position.
  // A merge that cannot cope with a null is a merge that can cost a trade.
  const out = validator.merge({ trend: trendOf(B), ema: null, midpoint: null });
  assert.equal(out.entryAllowed, false);
  assert.ok(out.reason, 'a refusal must still be named');
});

/* -------------------------------------------- it agrees with the engine's parts */

test('the merge reproduces what the three engines decide on real candles', () => {
  // Built from actual bars through the real modules, so the merge cannot quietly
  // disagree with the pieces it is merging.
  const series = h.warmSeries(100);
  const bar = h.indexBar({
    openP: 2450000, highP: 2450500, lowP: 2449800, closeP: 2450400,
    bucketStart: h.BASE_TS + 500000,
  });

  const trend = trendEngine.evaluate(series, 3);
  const ema = emaEngine.evaluate(series);
  const midpoint = entry.validate(bar, trend.trend);
  const out = validator.merge({ trend, ema, midpoint });

  assert.equal(out.threeCandleTrend, trend.trend);
  assert.equal(out.emaTrend, ema.trend);
  assert.equal(out.midpoint, midpoint.allowed);
  assert.equal(out.entryAllowed, true, 'a clean rising series with a midpoint break is an entry');
  assert.equal(out.side, 'SELL_PE');
});
