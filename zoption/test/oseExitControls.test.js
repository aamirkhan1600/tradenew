// The exit controls that an operator can actually turn — and the two that could
// not be turned at all until this file existed.
//
// Both bugs covered here are the same shape, and it is the shape that keeps
// recurring in this engine: a setting that READS as configurable, renders in the
// settings page, saves without complaint, and is then ignored because the value
// never reaches the code that would act on it. `initialTargetPoints` was pinned
// to 1 by the ladder. `maxHoldCandles` was pinned to the constant by derive().
// Neither failed loudly. Both looked exactly like a working control.
//
// So these tests assert the WIRE, not the rule: that a number put into settings
// arrives at exits.js and changes what it does. A test that only checked the
// default would have passed against both bugs.

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const exits = require('../src/ose/exits');
const settingsService = require('../src/ose/settings');
const C = require('../src/ose/constants');
const h = require('./oseHelpers');

/* ------------------------------------------------- §16.2.6, the holding clock */

test('maxHoldCandles reaches _rules — it was pinned to the constant before', () => {
  for (const v of [6, 24, 100, 0]) {
    const derived = settingsService.derive(settingsService.withDefaults({ maxHoldCandles: v }));
    assert.equal(derived._rules.maxHoldCandles, v,
      `maxHoldCandles ${v} must survive derive(); pinning it to C.MAX_HOLD_CANDLES is the bug`);
  }
});

test('the default is still the specification\'s 24 when nothing is set', () => {
  const derived = settingsService.derive(settingsService.withDefaults({}));
  assert.equal(derived._rules.maxHoldCandles, C.MAX_HOLD_CANDLES);
});

test('a shortened clock fires EARLIER, which is the whole point of the control', () => {
  // Held for 6 candles: over a 6-candle cap, under the default 24.
  const trade = h.trade({ candlesHeld: 6 });
  const args = {
    indexCandle: h.indexBar(), optionCandle: h.optionBar(),
    trend: 'BEARISH', quote: h.quote(), ema: null,
  };

  const short = exits.onCandle({ ...args, trade, cfg: h.rules({ maxHoldCandles: 6 }) });
  assert.equal(short.exit && short.exit.reason, exits.EXIT_REASONS.MAX_HOLD);

  const long = exits.onCandle({ ...args, trade, cfg: h.rules({ maxHoldCandles: 24 }) });
  assert.notEqual(long.exit && long.exit.reason, exits.EXIT_REASONS.MAX_HOLD,
    'six candles is not over a twenty-four candle cap');
});

test('maxHoldCandles 0 disables the clock instead of closing on the FIRST candle', () => {
  // `candlesHeld >= maxHold` with maxHold 0 is true at candlesHeld 0, so the
  // naive reading of "0 means off" would flatten every position the instant it
  // opened. The guard in exits.js exists for this and nothing else.
  for (const held of [0, 1, 50, 500]) {
    const res = exits.onCandle({
      trade: h.trade({ candlesHeld: held }),
      indexCandle: h.indexBar(), optionCandle: h.optionBar(),
      trend: 'BEARISH', quote: h.quote(), ema: null,
      cfg: h.rules({ maxHoldCandles: 0 }),
    });
    assert.notEqual(res.exit && res.exit.reason, exits.EXIT_REASONS.MAX_HOLD,
      `with the clock off, ${held} candles held must never be a MAX_HOLD exit`);
  }
});

test('0 is accepted but warned about; a negative clock is rejected', () => {
  const off = settingsService.validate(settingsService.withDefaults({ maxHoldCandles: 0 }));
  assert.equal(off.errors.length, 0, '0 is a legal choice, not an error');
  assert.ok(off.warnings.some(w => /16\.2\.6/.test(w)),
    'turning off a time exit must say so — it is not a neutral default');

  const bad = settingsService.validate(settingsService.withDefaults({ maxHoldCandles: -1 }));
  assert.ok(bad.errors.some(e => /maxHoldCandles/.test(e)));
});

/* --------------------------------------- §13.3, the position validity filter */

test('each half stops §13.3 CLOSING but not EVALUATING, independently', () => {
  // A candle that fails the validity filter outright: short CE entered BEARISH,
  // and the trend has turned BULLISH underneath it.
  const args = {
    trade: h.trade({ optionType: 'CE', candlesHeld: 1 }),
    indexCandle: h.indexBar(), optionCandle: h.optionBar(),
    trend: 'BULLISH', quote: h.quote(), ema: null,
  };

  const on = exits.onCandle({ ...args, cfg: h.rules({ trendBreakExitEnabled: true, filterFailExitEnabled: true }) });
  assert.ok(on.exit, 'with the filter on, a broken thesis closes the position');
  assert.ok([exits.EXIT_REASONS.TREND_BREAK, exits.EXIT_REASONS.FILTER_FAIL]
    .includes(on.exit.reason), `unexpected reason ${on.exit && on.exit.reason}`);

  const off = exits.onCandle({ ...args, cfg: h.rules({ trendBreakExitEnabled: false, filterFailExitEnabled: false }) });
  assert.equal(off.exit, null, 'with the filter off, the same candle must not close it');

  // The evaluation still HAPPENED. The /ose panel and the decision log are built
  // on `checks`, and an operator comparing the two configurations needs to see
  // how often the filter would have fired — a switch that also silences the
  // reporting makes its own effect unmeasurable.
  const validity = (off.checks || []).find(c => c.name === 'validity');
  assert.ok(validity, 'the validity check must still be recorded when it no longer closes');
  assert.equal(validity.hit, true,
    'and it must still record that it FAILED — a suppressed exit is not a passing check');
});

test('the switch cannot reach a SAFETY exit — only the thesis exits', () => {
  // The stop is not an opinion about the trade, and neither are the priority-0
  // conditions. If this ever passes with the stop suppressed, the switch has
  // been wired too wide.
  const res = exits.onCandle({
    trade: h.trade({ optionType: 'CE', stopPriceP: 1900, candlesHeld: 1 }),
    indexCandle: h.indexBar(),
    optionCandle: h.optionBar({ closeP: 2100, highP: 2100 }),   // through the stop
    trend: 'BULLISH', quote: h.quote(), ema: null,
    cfg: h.rules({ trendBreakExitEnabled: false, filterFailExitEnabled: false }),
  });
  assert.ok(res.exit, 'the stop must still fire with the thesis filter disabled');
  assert.equal(res.exit.reason, exits.EXIT_REASONS.STOP_HIT);
});

test('the default keeps v3.0 behaviour — the filter closes unless it is turned off', () => {
  const derived = settingsService.derive(settingsService.withDefaults({}));
  assert.equal(derived._rules.trendBreakExitEnabled, true,
    '§13.3 is the shipped rule; disabling it must be a recorded decision');
  assert.equal(derived._rules.filterFailExitEnabled, true);
});

/* ---------------------------------------- the controls have to be REACHABLE */

test('both switches survive a form POST — a setting the page cannot send is not a setting', () => {
  // §13.3 and the holding clock were both added to settings.js before they were
  // added to the route's coercion lists, so for a while neither could be changed
  // from the only interface that exists. An unchecked box is simply ABSENT from
  // a form body, which is why the page posts these explicitly and why the
  // "false" string has to survive coercion as a boolean.
  const { coerce } = require('../src/http/oseRoutes');

  for (const key of ['trendBreakExitEnabled', 'filterFailExitEnabled']) {
    assert.equal(coerce({ [key]: 'false' })[key], false, key);
    assert.equal(coerce({ [key]: 'true' })[key], true, key);
  }

  const held = coerce({ maxHoldCandles: '6' }).maxHoldCandles;
  assert.equal(held, 6);
  assert.equal(typeof held, 'number', 'a string would fail the whole-number validation');
});

/* -------------------------------------- the two halves are INDEPENDENT switches */

// A candle whose trend has reversed under the short, and one that merely stopped
// breaking its midpoint while the trend still holds. Keeping them apart is the
// whole point of the split — one switch must not silence the other's exit.
const reversedTrend = () => ({
  trade: h.trade({ optionType: 'CE', candlesHeld: 1 }),
  indexCandle: h.indexBar(), optionCandle: h.optionBar(),
  trend: 'BULLISH', quote: h.quote(), ema: null,        // short CE, trend flipped up
});
const midpointLost = () => ({
  trade: h.trade({ optionType: 'CE', candlesHeld: 1 }),
  // Trend still BEARISH, but the close sits ABOVE the bearish midpoint, so §13.3's
  // second condition fails on its own.
  indexCandle: h.indexBar({ openP: 2450000, highP: 2450600, lowP: 2449800, closeP: 2450500 }),
  optionCandle: h.optionBar(), trend: 'BEARISH', quote: h.quote(), ema: null,
});

test('trendBreakExitEnabled off silences ONLY the trend break', () => {
  const cfg = h.rules({ trendBreakExitEnabled: false, filterFailExitEnabled: true });

  const flipped = exits.onCandle({ ...reversedTrend(), cfg });
  assert.notEqual(flipped.exit && flipped.exit.reason, exits.EXIT_REASONS.TREND_BREAK,
    'the trend break is switched off');

  const consolidated = exits.onCandle({ ...midpointLost(), cfg });
  assert.equal(consolidated.exit && consolidated.exit.reason, exits.EXIT_REASONS.FILTER_FAIL,
    'the midpoint filter is still on and must still close');
});

test('filterFailExitEnabled off silences ONLY the midpoint filter', () => {
  const cfg = h.rules({ trendBreakExitEnabled: true, filterFailExitEnabled: false });

  const consolidated = exits.onCandle({ ...midpointLost(), cfg });
  assert.equal(consolidated.exit, null, 'a consolidation candle is no longer an exit');

  const flipped = exits.onCandle({ ...reversedTrend(), cfg });
  assert.equal(flipped.exit && flipped.exit.reason, exits.EXIT_REASONS.TREND_BREAK,
    'a reversed trend must still close — that is the other switch');
});

test('neither switch can suppress §3.8, the unreadable-candle refusal', () => {
  // entry.stillValid() reports a missing index candle as EXIT_FILTER_FAIL for
  // want of a better code. It is not a thesis failure — it is the engine
  // refusing to hold a naked short on absent information. If `filterFailExitEnabled`
  // ever reaches it, turning off a consolidation exit would also turn off the
  // engine's response to a dead feed.
  for (const candle of [null, undefined, { closeP: 2450000 }]) {
    const res = exits.onCandle({
      trade: h.trade({ optionType: 'CE', candlesHeld: 1 }),
      indexCandle: candle, optionCandle: h.optionBar(),
      trend: 'BEARISH', quote: h.quote(), ema: null,
      cfg: h.rules({ trendBreakExitEnabled: false, filterFailExitEnabled: false }),
    });
    assert.ok(res.exit, `an unreadable index candle must still close the position (${candle})`);
    assert.equal(res.exit.reason, exits.EXIT_REASONS.FILTER_FAIL);
  }
});
