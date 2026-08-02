// newdoc/ema.md — the EMA Trend Confirmation Engine.
//
// Every rule that document states, asserted against the shape of a candle series
// rather than against a hand-fed pair of averages. Feeding `evaluate` two
// numbers and checking the comparison would test the `>` operator; feeding it a
// market that actually turned tests whether this engine notices.
//
// The fixtures are built from CLOSES only, because closes are the only thing the
// specification's §Data Source permits this engine to read. If a change here
// ever starts depending on a high, a low or a tick count, that is the bug.

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const emaEngine = require('../src/ose/ema');
const exits = require('../src/ose/exits');
const settingsService = require('../src/ose/settings');
const C = require('../src/ose/constants');
const h = require('./oseHelpers');

/* ---------------------------------------------------------------- fixtures */

// Index bars from a list of closes. The high and the low are deliberately
// symmetric noise around the close: nothing in this engine may read them, and a
// fixture that made them meaningful would hide it if something started to.
function bars(closes) {
  return closes.map((closeP, i) => ({
    token: 'Nifty 50',
    bucketStart: h.BASE_TS + i * 5000,
    bucketEnd: h.BASE_TS + (i + 1) * 5000,
    openP: closeP, highP: closeP + 50, lowP: closeP - 50, closeP,
    tickCount: 5, synthetic: false, lowConfidence: false, tradable: true,
  }));
}

const ramp = (n, step, from = 2450000) =>
  Array.from({ length: n }, (_, i) => from + i * step);

// A market that falls for 24 candles and then reverses hard. The EMA9/EMA20
// crossover lands on bar 28, which makes this the one fixture that can exercise
// the crossover, the cooldown and the exit rule with the same numbers.
const REVERSAL = (() => {
  const closes = ramp(24, -100);
  for (let k = 1; k <= 10; k += 1) closes.push(closes[23] + k * 900);
  return closes;
})();

// A 22-candle uptrend whose last candles whip 12 points either side of EMA9 —
// "price is moving repeatedly above and below EMA9" with the averages still
// well separated, so the chop rule is the ONLY thing that can refuse it.
const CHOP = (() => {
  const closes = ramp(22, 300);
  const base = closes[21];
  for (const d of [1200, -1200, 1200, -1200, 1200]) closes.push(base + d);
  return closes;
})();

/* =========================================================== §EMA Calculation */

test('ema: EMA9 and EMA20 come from the shared indicator module, not a second copy', () => {
  // One implementation, two runtimes — the browser draws these and the engine
  // decides on them. A private EMA here would let the chart and the engine
  // disagree about what the 9 crossed, with no way to tell which the operator
  // was looking at.
  const indicators = require('../src/shared/indicators');
  const closes = ramp(30, 120);
  const verdict = emaEngine.evaluate(bars(closes));

  const fast = indicators.ema(closes, C.EMA_FAST);
  const slow = indicators.ema(closes, C.EMA_SLOW);

  assert.equal(verdict.ema9P, fast[fast.length - 1]);
  assert.equal(verdict.ema20P, slow[slow.length - 1]);
});

test('ema: the values are NOT rounded — the sign of the difference is the whole signal', () => {
  // A real market, not a linear ramp: a constant step happens to land EMA9 on a
  // whole paise, which would make this assertion pass for the wrong reason.
  const verdict = emaEngine.evaluate(bars(REVERSAL));
  assert.equal(verdict.separationP, verdict.ema9P - verdict.ema20P);
  assert.ok(!Number.isInteger(verdict.ema9P) && !Number.isInteger(verdict.ema20P),
    'rounding the averages to whole paise can flip the sign of a one-paise difference, and '
    + 'that difference is the crossover');
});

/* ================================================================ warm-up */

test('ema: 20 candles is not enough — EMA20 exists but the crossover test needs the bar before', () => {
  assert.equal(emaEngine.warmupCandles(), C.EMA_SLOW + 1);

  const twenty = emaEngine.evaluate(bars(ramp(C.EMA_SLOW, 100)));
  assert.equal(twenty.state, emaEngine.STATE.WARMING_UP);
  assert.equal(twenty.trend, null);
  assert.equal(twenty.ema9P, null, 'a warming verdict must carry no averages to be misread');

  const twentyOne = emaEngine.evaluate(bars(ramp(C.EMA_SLOW + 1, 100)));
  assert.equal(twentyOne.state, emaEngine.BULLISH);
});

test('ema: an unreadable close leaves the averages unwarmed rather than comparing against null', () => {
  // `indicators.ema` SKIPS a non-finite value instead of seeding from it, so a
  // long buffer with one bad bar near its end can still have an unwarmed tail.
  // `null > 0` is false and `null >= 0` is TRUE in JavaScript — a comparison
  // that quietly succeeds is exactly how a filter comes to pass a bar it has no
  // reading for.
  const dirty = bars(ramp(30, 100));
  for (let i = 12; i < 30; i += 1) dirty[i].closeP = NaN;

  const verdict = emaEngine.evaluate(dirty);
  assert.equal(verdict.state, emaEngine.STATE.WARMING_UP);
  assert.equal(verdict.trend, null);
});

/* ================================================ §Bullish / §Bearish rules */

test('ema: a clean uptrend is BULLISH and a clean downtrend is BEARISH', () => {
  const up = emaEngine.evaluate(bars(ramp(24, 100)));
  assert.equal(up.state, emaEngine.BULLISH);
  assert.equal(up.trend, emaEngine.BULLISH);
  assert.equal(up.via, emaEngine.VIA.ALIGNED);
  assert.ok(up.separationP > 0 && up.closeP > up.ema9P);

  const down = emaEngine.evaluate(bars(ramp(24, -100)));
  assert.equal(down.trend, emaEngine.BEARISH);
  assert.ok(down.separationP < 0 && down.closeP < down.ema9P);
});

test('ema: BOTH halves are required — separated averages with the close the wrong side is a refusal', () => {
  // A pullback into the average inside an uptrend. §Bullish EMA Condition reads
  // `EMA9 > EMA20 AND Current Close > EMA9`, and this fixture satisfies only the
  // first. It must NOT come out as a weaker yes.
  const closes = ramp(24, 200);
  closes.push(closes[23] - 900);

  const verdict = emaEngine.evaluate(bars(closes));
  assert.ok(verdict.separationP > 0, 'the averages are still bullishly separated');
  assert.ok(verdict.closeP < verdict.ema9P, 'but the close has fallen through EMA9');
  assert.equal(verdict.state, emaEngine.STATE.NO_CONFIRM);
  assert.equal(verdict.trend, null);
  assert.equal(verdict.via, emaEngine.VIA.CLOSE_AGAINST);
});

test('ema: index BULLISH sells the PE and index BEARISH sells the CE', () => {
  assert.equal(emaEngine.sideFor(emaEngine.BULLISH), 'PE');
  assert.equal(emaEngine.sideFor(emaEngine.BEARISH), 'CE');
  assert.equal(emaEngine.sideFor(null), null);
});

/* ================================================== §Sideways Market, rule 1 */

test('ema: identical closes put EMA9 exactly on EMA20 — the flat rule, with no band needed', () => {
  const verdict = emaEngine.evaluate(bars(Array.from({ length: 25 }, () => 2450000)));
  assert.equal(verdict.separationP, 0);
  assert.equal(verdict.state, emaEngine.STATE.SIDEWAYS);
  assert.equal(verdict.via, emaEngine.VIA.FLAT);
  assert.equal(verdict.trend, null);
});

test('ema: the flat band is what makes "EMA9 == EMA20" a rule that can ever fire', () => {
  // Read literally the equality would fire never on floating averages. A clean
  // uptrend whose separation is inside a wide band must read as flat — that is
  // the band doing its job, and it is the entire content of `[MUST-CONFIRM #18]`.
  const closes = ramp(24, 100);
  const wide = emaEngine.evaluate(bars(closes), { emaFlatP: 100000 });
  assert.equal(wide.state, emaEngine.STATE.SIDEWAYS);
  assert.equal(wide.via, emaEngine.VIA.FLAT);

  const narrow = emaEngine.evaluate(bars(closes), { emaFlatP: 0 });
  assert.equal(narrow.state, emaEngine.BULLISH, 'the same market, judged on a zero band');
});

/* ================================================== §Sideways Market, rule 3 */

test('ema: the crossover candle and the one after it are refused, the next is not', () => {
  const at = (n) => emaEngine.evaluate(bars(REVERSAL.slice(0, n)));

  const crossBar = at(28);
  assert.equal(crossBar.cross, emaEngine.BULLISH, 'EMA9 crossed above EMA20 on this candle');
  assert.equal(crossBar.crossAge, 0);
  assert.equal(crossBar.state, emaEngine.STATE.SIDEWAYS);
  assert.equal(crossBar.via, emaEngine.VIA.FRESH_CROSS);

  const nextBar = at(29);
  assert.equal(nextBar.crossAge, 1);
  assert.equal(nextBar.state, emaEngine.STATE.SIDEWAYS,
    'one candle of confirmation is not the two the cooldown asks for');

  const settled = at(30);
  assert.equal(settled.crossAge, C.EMA_CROSS_COOLDOWN);
  assert.equal(settled.state, emaEngine.BULLISH, 'the cooldown has elapsed — the trend counts now');
});

test('ema: a zero cooldown lets the crossover candle itself through', () => {
  const verdict = emaEngine.evaluate(bars(REVERSAL.slice(0, 28)), { emaCrossCooldown: 0 });
  assert.equal(verdict.state, emaEngine.BULLISH);
  assert.equal(verdict.cross, emaEngine.BULLISH, 'it is still recorded as a crossover');
});

test('ema: the crossover test uses <= exactly as the document writes it', () => {
  // "Previous EMA9 <= Previous EMA20 AND Current EMA9 > Current EMA20". A pair
  // that was exactly level and then separated upward IS a bullish crossover; a
  // strict `<` would silently miss every crossover that came out of a flat.
  const fast = [null, 10, 10, 12];
  const slow = [null, 10, 10, 11];
  assert.equal(emaEngine.crossAt(fast, slow, 2), null, 'level to level is not a crossing');
  assert.equal(emaEngine.crossAt(fast, slow, 3), emaEngine.BULLISH);

  assert.equal(emaEngine.crossAt([10, 10, 9], [10, 10, 11], 2), emaEngine.BEARISH);
  assert.equal(emaEngine.crossAt([null, 12], [null, 11], 1), null,
    'an unwarmed previous bar cannot evidence a crossing');
});

/* ================================================== §Sideways Market, rule 2 */

test('ema: price crossing EMA9 repeatedly is chop, even with the averages well separated', () => {
  const verdict = emaEngine.evaluate(bars(CHOP));

  assert.ok(verdict.separationP > C.EMA_FLAT_P * 10, 'the averages are nowhere near flat');
  assert.ok(verdict.closeP > verdict.ema9P, 'and the close is on the bullish side of EMA9');
  assert.ok(verdict.flips >= C.EMA_CHOP_FLIPS);
  assert.equal(verdict.state, emaEngine.STATE.SIDEWAYS);
  assert.equal(verdict.via, emaEngine.VIA.CHOP,
    'without the chop rule this candle would have read as a clean BULLISH entry');

  // The same market with the rule switched off is exactly that clean entry,
  // which is what makes the assertion above about the RULE and not the fixture.
  const off = emaEngine.evaluate(bars(CHOP), { emaChopFlips: 0 });
  assert.equal(off.state, emaEngine.BULLISH);
});

test('ema: a close sitting exactly on EMA9 is not a side and is not a flip', () => {
  // Counting it either way is wrong: as a flip it turns a flat tape into chop,
  // as a hold it lets a genuine crossing hide behind it.
  const closes = [10, 20, 10, 20];
  const fastLine = [10, 20, 10, 20];
  assert.equal(emaEngine.countFlips(closes, fastLine, 3, 4), 0);

  assert.equal(emaEngine.countFlips([12, 8, 12], [10, 10, 10], 2, 3), 2);
  assert.equal(emaEngine.countFlips([12, 10, 8], [10, 10, 10], 2, 3), 1,
    'the middle bar sat on the average and is skipped, not counted as a side');
});

/* ============================================================== §Trade Rules */

test('ema gate: SELL PE needs BOTH filters bullish, SELL CE needs both bearish', () => {
  const bullish = emaEngine.evaluate(bars(ramp(24, 100)));
  const bearish = emaEngine.evaluate(bars(ramp(24, -100)));

  assert.equal(emaEngine.gate(bullish, 'BULLISH').allowed, true);
  assert.equal(emaEngine.gate(bearish, 'BEARISH').allowed, true);
});

test('ema gate: EMA direction != 3-candle trend is a conflict, named as one', () => {
  const bullish = emaEngine.evaluate(bars(ramp(24, 100)));

  const conflict = emaEngine.gate(bullish, 'BEARISH');
  assert.equal(conflict.allowed, false);
  assert.equal(conflict.outcome, emaEngine.OUTCOME.CONFLICT);
  assert.match(conflict.reason, /BULLISH/);

  // An undetermined 3-candle verdict is a conflict here too. A filter that waves
  // through an absent counterparty is not a filter.
  assert.equal(emaEngine.gate(bullish, null).outcome, emaEngine.OUTCOME.CONFLICT);
});

test('ema gate: the three refusals are DISTINCT outcomes, not one code', () => {
  // The decision log groups the session's tally by these. Collapsing a sideways
  // tape, a close on the wrong side of EMA9 and a disagreement with the trend
  // engine into one code would destroy the only record of which the engine
  // actually spent its day on.
  const warming = emaEngine.gate(emaEngine.evaluate(bars(ramp(5, 100))), 'BULLISH');
  assert.equal(warming.outcome, emaEngine.OUTCOME.WARMING_UP);

  const flat = emaEngine.gate(
    emaEngine.evaluate(bars(Array.from({ length: 25 }, () => 2450000))), 'BULLISH');
  assert.equal(flat.outcome, emaEngine.OUTCOME.SIDEWAYS);

  const pullback = ramp(24, 200);
  pullback.push(pullback[23] - 900);
  const against = emaEngine.gate(emaEngine.evaluate(bars(pullback)), 'BULLISH');
  assert.equal(against.outcome, emaEngine.OUTCOME.FILTER_FAIL);

  const codes = new Set([warming.outcome, flat.outcome, against.outcome]);
  assert.equal(codes.size, 3);
});

/* ======================================================= §Position Exit Rule */

test('ema exit: a short PE is broken when EMA9 falls below EMA20, and not before', () => {
  const stillBullish = emaEngine.evaluate(bars(REVERSAL.slice(0, 34)));
  assert.equal(emaEngine.isBreak(stillBullish, 'PE').broken, false);

  const bearish = emaEngine.evaluate(bars(ramp(24, -100)));
  const broken = emaEngine.isBreak(bearish, 'PE');
  assert.equal(broken.broken, true);
  assert.match(broken.reason, /short PE/);

  // The mirror image: the same bearish structure is exactly what a short CE
  // wants, and must not be read as a break.
  assert.equal(emaEngine.isBreak(bearish, 'CE').broken, false);
});

test('ema exit: the break is the STATE, so a dropped cycle cannot lose it', () => {
  // §4.2 drops a candle that seals while the previous cycle is running. An
  // edge-triggered exit would miss the crossover outright and leave a naked
  // short open on an inverted thesis. Every candle after the crossover must
  // still report the break.
  const crossBar = emaEngine.evaluate(bars(REVERSAL.slice(0, 28)));
  assert.equal(crossBar.cross, emaEngine.BULLISH);

  const onTheEdge = emaEngine.isBreak(crossBar, 'CE');
  assert.equal(onTheEdge.broken, true);
  assert.equal(onTheEdge.fresh, true, 'the crossover happened on this candle');

  for (const n of [29, 30, 31, 34]) {
    const later = emaEngine.isBreak(emaEngine.evaluate(bars(REVERSAL.slice(0, n))), 'CE');
    assert.equal(later.broken, true, `the break must survive to candle ${n}`);
    assert.equal(later.fresh, false, 'and be honest that the crossover was earlier');
  }
});

test('ema exit: a warming-up verdict does NOT close a position', () => {
  // The trend engine treats its own silence as a break; this one must not. Two
  // independent filters that both exit on an absence would close every position
  // the moment the ring buffer was rebuilt after a restart.
  const warming = emaEngine.evaluate(bars(ramp(5, 100)));
  assert.equal(emaEngine.isBreak(warming, 'PE').broken, false);
  assert.equal(emaEngine.isBreak(null, 'CE').broken, false);
});

test('ema exit: the flat band is NOT applied to an open position', () => {
  // Entry demands evidence; holding demands none. An average drifting to dead
  // level under a live naked short is a reason to be out, not to wait.
  const closes = ramp(24, -1);          // a barely-there downtrend
  const verdict = emaEngine.evaluate(bars(closes), { emaFlatP: 100000 });
  assert.equal(verdict.state, emaEngine.STATE.SIDEWAYS, 'far too flat to ENTER on');
  assert.equal(emaEngine.isBreak(verdict, 'PE').broken, true,
    'and still unambiguously the wrong side for a short PE to be held on');
});

test('exits: the crossover fires EXIT_EMA_CROSS, ahead of the validity filter', () => {
  const trade = h.trade({ optionType: 'PE', entryPriceP: 2000, stopPriceP: 2200 });
  const bullishIndex = h.indexBar({ openP: 2450000, highP: 2450500, lowP: 2449800, closeP: 2450400 });

  const res = exits.onCandle({
    trade,
    optionCandle: h.optionBar({ closeP: 1950, highP: 1960 }),
    indexCandle: bullishIndex,
    trend: 'BULLISH',                                        // the 3-candle engine still agrees
    ema: emaEngine.evaluate(bars(ramp(24, -100))),           // the EMA structure has inverted
    quote: null,
    cfg: h.rules(),
  });

  assert.ok(res.exit, 'an inverted EMA structure must close a short PE');
  assert.equal(res.exit.reason, exits.EXIT_REASONS.EMA_CROSS);
  assert.equal(res.extend, null, 'an exit and a target extension are never both set');
});

test('exits: emaExitOnCrossover OFF leaves the position to the other filters', () => {
  const trade = h.trade({ optionType: 'PE', entryPriceP: 2000, stopPriceP: 2200 });

  const res = exits.onCandle({
    trade,
    optionCandle: h.optionBar({ closeP: 1950, highP: 1960 }),
    indexCandle: h.indexBar({ openP: 2450000, highP: 2450500, lowP: 2449800, closeP: 2450400 }),
    trend: 'BULLISH',
    ema: emaEngine.evaluate(bars(ramp(24, -100))),
    quote: null,
    cfg: h.rules({ emaExitOnCrossover: false }),
  });

  assert.ok(!res.exit || res.exit.reason !== exits.EXIT_REASONS.EMA_CROSS);
});

test('exits: the stop still outranks the crossover — a candle spanning both books the loss', () => {
  // §13.4 is unchanged by this filter. The EMA crossover was inserted at 4b, not
  // at the front: money-safety ordering comes first.
  const trade = h.trade({ optionType: 'PE', entryPriceP: 2000, stopPriceP: 2200 });

  const res = exits.onCandle({
    trade,
    optionCandle: h.optionBar({ closeP: 2210, highP: 2260, lowP: 2000 }),
    indexCandle: h.indexBar({ openP: 2450000, highP: 2450500, lowP: 2449800, closeP: 2450400 }),
    trend: 'BULLISH',
    ema: emaEngine.evaluate(bars(ramp(24, -100))),
    quote: null,
    cfg: h.rules(),
  });

  assert.equal(res.exit.reason, exits.EXIT_REASONS.STOP_HIT);
});

/* ================================================================ §3.6, purity */

test('ema: the verdict is a pure function of the buffer — same bars, same answer', () => {
  const series = bars(REVERSAL);
  const before = JSON.stringify(series);

  const a = emaEngine.evaluate(series);
  const b = emaEngine.evaluate(series);

  assert.deepEqual(a, b, 'the determinism gate hashes these; two runs must agree exactly');
  assert.equal(JSON.stringify(series), before, 'and nothing here may mutate the caller\'s buffer');
});

/* ====================================================== §5, the configuration */

test('settings: a chop threshold that can never be reached is refused, not warned about', () => {
  // A rule that cannot fire is worse than one that is off, because nothing says
  // so — the settings page would show a configured filter that never runs.
  const { errors } = settingsService.validate(
    settingsService.withDefaults({ emaChopLookback: 3, emaChopFlips: 5 }));
  assert.ok(errors.some(e => /emaChopFlips/.test(e)));

  const ok = settingsService.validate(
    settingsService.withDefaults({ emaChopLookback: 6, emaChopFlips: 5 }));
  assert.deepEqual(ok.errors, []);

  // Turning the rule off deliberately is always legal.
  const off = settingsService.validate(
    settingsService.withDefaults({ emaChopLookback: 0, emaChopFlips: 0 }));
  assert.deepEqual(off.errors, []);
});

test('settings: the derived _ema block is exactly what ema.resolve() reads', () => {
  const cfg = settingsService.derive(settingsService.withDefaults({
    emaFlatPoints: 0.5, emaChopLookback: 8, emaChopFlips: 4, emaCrossCooldownCandles: 3,
  }));

  assert.equal(cfg._ema.emaFlatP, 50, 'index POINTS on the page, paise in the engine');
  const resolved = emaEngine.resolve(cfg._ema);
  assert.equal(resolved.flatP, 50);
  assert.equal(resolved.chopLookback, 8);
  assert.equal(resolved.chopFlips, 4);
  assert.equal(resolved.crossCooldown, 3);
  assert.equal(resolved.fast, C.EMA_FAST);
  assert.equal(resolved.slow, C.EMA_SLOW);

  // The exit reads `_rules`, not `_ema` — a different object, and it has to
  // carry the switch or the crossover exit silently never runs.
  assert.equal(cfg._rules.emaExitOnCrossover, true);
});

test('settings: both EMA switches ship ON, because ema.md makes the filter mandatory', () => {
  assert.equal(settingsService.DEFAULTS.emaFilterEnabled, true);
  assert.equal(settingsService.DEFAULTS.emaExitOnCrossover, true);

  const warnings = settingsService.validate(
    settingsService.withDefaults({ emaFilterEnabled: false })).warnings;
  assert.ok(warnings.some(w => /emaFilterEnabled is OFF/.test(w)),
    'turning the mandatory filter off must be said out loud');
});

test('settings: a caller with no configuration gets the shipped behaviour, not zeros', () => {
  // Scripts, tests and the backtester call `evaluate` with no cfg. A zero flat
  // band, a zero cooldown and a zero chop threshold would be three rules
  // silently disabled.
  const defaults = emaEngine.resolve();
  assert.equal(defaults.flatP, C.EMA_FLAT_P);
  assert.equal(defaults.chopLookback, C.EMA_CHOP_LOOKBACK);
  assert.equal(defaults.chopFlips, C.EMA_CHOP_FLIPS);
  assert.equal(defaults.crossCooldown, C.EMA_CROSS_COOLDOWN);
});
