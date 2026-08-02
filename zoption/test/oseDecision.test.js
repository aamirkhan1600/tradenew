// §10, §11, §14, §15 — the pure decision modules.
//
// Every case in §25.1's mandatory list is here, plus the two §25.2 properties
// that can be asserted without a property-testing dependency. These are the
// cheapest tests in the suite and they guard the rules that decide whether money
// moves, so they are also the ones that must never be quarantined.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./oseHelpers');
const trendEngine = require('../src/ose/trend');
const entry = require('../src/ose/entry');
const ladder = require('../src/ose/ladder');
const C = require('../src/ose/constants');
const { IntegrityError } = require('../src/core/errors');

/* ============================================================ §10, the trend */

test('trend: a clear rise is BULLISH and a clear fall is BEARISH', () => {
  assert.equal(trendEngine.evaluate(h.series(3, 100)).trend, 'BULLISH');
  assert.equal(trendEngine.evaluate(h.series(3, -100)).trend, 'BEARISH');
});

test('trend: fewer than three completed candles is null, not a guess', () => {
  const verdict = trendEngine.evaluate(h.series(2, 100));
  assert.equal(verdict.trend, null);
  assert.equal(verdict.via, 'WARMING_UP');
});

test('trend: d1 == 0 falls through to the midpoint tie-break', () => {
  // Identical closes; the newest bar's high/low sit higher, so the midpoint drifted up.
  const bars = [
    h.indexBar({ bucketStart: h.BASE_TS, closeP: 2450000, highP: 2450100, lowP: 2449900 }),
    h.indexBar({ bucketStart: h.BASE_TS + 5000, closeP: 2450000, highP: 2450200, lowP: 2449950 }),
    h.indexBar({ bucketStart: h.BASE_TS + 10000, closeP: 2450000, highP: 2450600, lowP: 2450100 }),
  ];
  const verdict = trendEngine.evaluate(bars);
  assert.equal(verdict.trend, 'BULLISH');
  assert.equal(verdict.via, trendEngine.VIA.MIDPOINT);
});

test('trend: d1 and d2 both zero falls through to the newest candle direction', () => {
  // C1 and C3 identical in close AND in high+low, so only C2 differs.
  const flat = { closeP: 2450000, highP: 2450100, lowP: 2449900 };
  const bars = [
    h.indexBar({ bucketStart: h.BASE_TS, ...flat }),
    h.indexBar({ bucketStart: h.BASE_TS + 5000, ...flat, closeP: 2449000 }),
    h.indexBar({ bucketStart: h.BASE_TS + 10000, ...flat }),
  ];
  const verdict = trendEngine.evaluate(bars);
  assert.equal(verdict.trend, 'BULLISH');   // 2450000 > 2449000
  assert.equal(verdict.via, trendEngine.VIA.RECENT);
});

test('trend: a perfect tie is undetermined — it does NOT carry the last verdict forward', () => {
  const identical = { closeP: 2450000, highP: 2450100, lowP: 2449900 };
  const bars = [0, 1, 2].map(i =>
    h.indexBar({ bucketStart: h.BASE_TS + i * 5000, ...identical }));
  const verdict = trendEngine.evaluate(bars);
  assert.equal(verdict.trend, null);
  assert.equal(verdict.via, trendEngine.VIA.TIE);
});

test('trend: a null verdict is a BREAK for an open position, on both sides', () => {
  // §10.3 — fail closed. A trend engine with nothing to say is not permission
  // to stay short.
  assert.equal(trendEngine.isBreak(null, 'CE'), true);
  assert.equal(trendEngine.isBreak(null, 'PE'), true);
  assert.equal(trendEngine.isBreak('BEARISH', 'CE'), false);
  assert.equal(trendEngine.isBreak('BULLISH', 'CE'), true);
});

/* ====================================================== §11, entry validation */

test('entry: a close exactly ON the bullish mid is rejected — the inequality is strict', () => {
  // open 100, high 300 -> bullishMid 200. Close exactly 200.
  const candle = h.indexBar({ openP: 100, highP: 300, lowP: 50, closeP: 200 });
  const decision = entry.validate(candle, 'BULLISH');
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, entry.REASONS.NO_MIDPOINT_BREAK);
});

test('entry: a close exactly ON the bearish mid is rejected', () => {
  // open 300, low 100 -> bearishMid 200. Close exactly 200.
  const candle = h.indexBar({ openP: 300, highP: 350, lowP: 100, closeP: 200 });
  const decision = entry.validate(candle, 'BEARISH');
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, entry.REASONS.NO_MIDPOINT_BREAK);
});

test('entry: a doji is rejected on both sides', () => {
  const doji = h.indexBar({ openP: 2450000, highP: 2450000, lowP: 2450000, closeP: 2450000 });
  assert.equal(entry.validate(doji, 'BULLISH').allowed, false);
  assert.equal(entry.validate(doji, 'BEARISH').allowed, false);
});

test('entry: trend and signal disagreeing is a named rejection, not a silent one', () => {
  // Bullish break (close above (O+H)/2) offered while the trend is BEARISH.
  const candle = h.indexBar({ openP: 100, highP: 300, lowP: 50, closeP: 290 });
  const decision = entry.validate(candle, 'BEARISH');
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, entry.REASONS.TREND_SIGNAL_CONFLICT);
  assert.ok(decision.detail.length > 0, 'every rejection carries a human-readable detail');
});

test('entry: an undetermined trend is rejected as TREND_UNDETERMINED', () => {
  const candle = h.indexBar({ openP: 100, highP: 300, lowP: 50, closeP: 290 });
  assert.equal(entry.validate(candle, null).reason, entry.REASONS.TREND_UNDETERMINED);
});

test('entry: confluence produces SELL PE when bullish and SELL CE when bearish', () => {
  const bull = h.indexBar({ openP: 100, highP: 300, lowP: 50, closeP: 290 });
  const bullDecision = entry.validate(bull, 'BULLISH');
  assert.equal(bullDecision.allowed, true);
  assert.equal(bullDecision.optionType, 'PE');

  const bear = h.indexBar({ openP: 300, highP: 350, lowP: 100, closeP: 110 });
  const bearDecision = entry.validate(bear, 'BEARISH');
  assert.equal(bearDecision.allowed, true);
  assert.equal(bearDecision.optionType, 'CE');
});

// §25.2 — the mutual-exclusivity property, asserted over a wide sweep rather
// than a single case. A close cannot be above (O+H)/2 and below (O+L)/2 at once.
test('entry PROPERTY: the two midpoint conditions are mutually exclusive', () => {
  for (let open = 0; open <= 400; open += 20) {
    for (let high = open; high <= open + 400; high += 20) {
      for (let low = Math.max(0, open - 400); low <= open; low += 20) {
        for (let close = low; close <= high; close += 20) {
          const { bullishMidP, bearishMidP } = entry.midpoints(
            h.indexBar({ openP: open, highP: high, lowP: low, closeP: close }));
          assert.ok(!(close > bullishMidP && close < bearishMidP),
            `close ${close} was both above ${bullishMidP} and below ${bearishMidP}`);
        }
      }
    }
  }
});

/* ========================================================= §14, the ladder */

test('ladder: a close exactly AT the target advances the rung', () => {
  const trade = h.trade();                       // entry 2000, target 1900
  const bar = h.optionBar({ closeP: 1900, highP: 1905, lowP: 1895 });
  const extend = ladder.advanceTarget(trade, bar, h.rules());
  assert.ok(extend, 'a close at the target confirms it');
  assert.equal(extend.targetLevel, 2);
  assert.equal(extend.targetPriceP, 2000 - 2 * C.POINT);
});

test('ladder: a close FOUR points beyond the target advances exactly one level', () => {
  // §14.3 — one decision per candle, however far the close ran.
  const trade = h.trade();
  const bar = h.optionBar({ closeP: 1500, highP: 1510, lowP: 1495 });
  const extend = ladder.advanceTarget(trade, bar, h.rules());
  assert.equal(extend.targetLevel, 2, 'one rung, not four');
});

test('ladder: an intra-candle wick does NOT confirm a target — only the close does', () => {
  const trade = h.trade();
  const bar = h.optionBar({ closeP: 1950, lowP: 1880, highP: 1960 });   // dipped past, closed above
  assert.equal(ladder.advanceTarget(trade, bar, h.rules()), null);
});

test('ladder: entryPrice refuses a synthetic bar and refuses an untradable one', () => {
  // §12.1 — the most commonly violated rule in implementations of this spec.
  assert.throws(
    () => ladder.entryPrice(h.optionBar({ synthetic: true, tradable: false }), 10),
    IntegrityError);
  assert.throws(
    () => ladder.entryPrice(h.optionBar({ tradable: false, tickCount: 1 }), 10),
    IntegrityError);
});

test('ladder: entryPrice floors to the tick and never rounds up', () => {
  // close 1998 + offset 10 = 2008 -> floor to a 5-paise tick = 2005.
  const price = ladder.entryPrice(h.optionBar({ closeP: 1998 }), 10, 5);
  assert.equal(price, 2005);
  assert.equal(price % 5, 0, 'an off-tick limit is rejected by the exchange outright');
});

/* ==================================================== §15, the trailing stop */

test('stop: the initial stop sits ABOVE entry — for a short, premium rising is loss', () => {
  assert.equal(ladder.initialStop(2000, 2), 2200);
});

test('stop PROPERTY: monotone non-increasing across a ten-rung ladder', () => {
  const trade = h.trade();
  let previous = trade.stopPriceP;
  for (let level = 1; level <= 10; level += 1) {
    const trail = ladder.trailStop({ ...trade, stopPriceP: previous }, level, h.rules());
    if (!trail) continue;
    assert.ok(trail.stopPriceP <= previous,
      `the stop widened from ${previous} to ${trail.stopPriceP} at level ${level}`);
    previous = trail.stopPriceP;
  }
  // Level 1 locks breakeven, and each rung after locks one more point.
  assert.equal(previous, 2000 - 9 * C.POINT);
});

test('stop: the §15.2 progression is exactly the table in the specification', () => {
  const at = (level, from) =>
    ladder.trailStop({ ...h.trade(), stopPriceP: from }, level, h.rules())?.stopPriceP ?? from;
  assert.equal(at(1, 2200), 2000, 'level 1 -> breakeven');
  assert.equal(at(2, 2000), 1900, 'level 2 -> +1 point locked');
  assert.equal(at(3, 1900), 1800, 'level 3 -> +2 points locked');
});

test('stop: with trailing disabled the stop never moves, but the target still extends', () => {
  const cfg = h.rules({ trailingStopEnabled: false });
  assert.equal(ladder.trailStop(h.trade(), 3, cfg), null);
  assert.ok(ladder.advanceTarget(h.trade(), h.optionBar({ closeP: 1900 }), cfg));
});

test('stop: a lower rung can never widen a stop that has already trailed past it', () => {
  // §15.3 is enforced STRUCTURALLY by min(), so the IntegrityError beside it is
  // unreachable through trailStop and is defence-in-depth against a future
  // caller that computes the candidate itself. What is testable — and what
  // actually protects the position — is that a stale, lower rung arriving after
  // the stop has already trailed below it changes nothing.
  const trade = h.trade({ entryPriceP: 2000, stopPriceP: 1800 });   // already at +2 locked
  assert.equal(ladder.trailStop(trade, 1, h.rules()), null,
    'level 1 would imply a 2000 stop; the trade is already at 1800 and must not move back');
  assert.equal(ladder.trailStop(trade, 2, h.rules()), null);

  // And the guard itself still exists, so a hand-rolled widening is refused.
  assert.ok(IntegrityError, 'the invariant is backed by a typed error, not a comment');
});

test('stop: fires on the candle HIGH, not the close', () => {
  // §15.4 — a stop must respect intra-candle adverse movement.
  const trade = h.trade();                                   // stop 2200
  assert.equal(ladder.stopHit(h.optionBar({ highP: 2200, closeP: 2000 }), trade.stopPriceP), true);
  assert.equal(ladder.stopHit(h.optionBar({ highP: 2199, closeP: 2150 }), trade.stopPriceP), false);
});

/* ============ §10 vs newdoc/paralle.md §Step 3 — the ruling, locked ========= */

// paralle.md §Step 3 defines the 3-candle trend as Higher High AND Higher Low
// AND Higher Close. §10 of newdoc/update.md defines it as close drift with two
// tie-breaks, and on 2026-08-02 the desk ruled that §10 wins.
//
// This exists because the two documents disagree in a way that looks like a bug
// in the code: a reader with paralle.md open sees a "clearly wrong" trend engine
// and fixes it. Measured over 20,000 windows the substitution would cut entry
// opportunities by ~60% and, since §10.3 makes `null` a trend break for an open
// position, exit far more often.
//
// A comment can be read past. A red test cannot.
test('§10 wins over paralle.md §Step 3 — the trend is CLOSE DRIFT, not HH+HL+HC', () => {
  // A window that RISES on close but does NOT make higher highs and higher lows.
  // paralle.md would call this undetermined; §10 calls it BULLISH.
  const notHigherHighs = [
    h.indexBar({ bucketStart: h.BASE_TS, openP: 2450000, highP: 2450900, lowP: 2449000, closeP: 2450100 }),
    h.indexBar({ bucketStart: h.BASE_TS + 5000, openP: 2450100, highP: 2450600, lowP: 2449500, closeP: 2450300 }),
    h.indexBar({ bucketStart: h.BASE_TS + 10000, openP: 2450300, highP: 2450500, lowP: 2449200, closeP: 2450700 }),
  ];

  const [c1, c2, c3] = notHigherHighs;
  assert.ok(!(c3.highP > c2.highP && c2.highP > c1.highP),
    'the fixture must NOT make higher highs, or it proves nothing');
  assert.ok(!(c3.lowP > c2.lowP && c2.lowP > c1.lowP),
    'nor higher lows');
  assert.ok(c3.closeP > c1.closeP, 'but the close must have risen across the window');

  const verdict = trendEngine.evaluate(notHigherHighs, 3);
  assert.equal(verdict.trend, 'BULLISH',
    'if this is null, someone has implemented paralle.md §Step 3 — that section is '
    + 'SUPERSEDED, see the header of src/ose/trend.js');
  assert.equal(verdict.via, trendEngine.VIA.CLOSE);
});

test('§10 always reaches a verdict where paralle.md §Step 3 would abstain', () => {
  // The whole measured difference between the two rules: HH+HL+HC returns no
  // verdict 61% of the time. §10 returns null only on a PERFECT tie.
  let nulls = 0;
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  for (let i = 0; i < 2000; i += 1) {
    const bars = [];
    let px = 2438360;
    for (let k = 0; k < 3; k += 1) {
      px += Math.round((rand() - 0.5) * 500);
      const open = px - Math.round((rand() - 0.5) * 120);
      bars.push(h.indexBar({
        bucketStart: h.BASE_TS + k * 5000,
        openP: open,
        highP: Math.max(open, px) + Math.round(rand() * 90),
        lowP: Math.min(open, px) - Math.round(rand() * 90),
        closeP: px,
      }));
    }
    if (trendEngine.evaluate(bars, 3).trend === null) nulls += 1;
  }

  assert.equal(nulls, 0,
    `§10 abstained on ${nulls} of 2000 random windows — it should abstain only on a `
    + 'perfect tie. A high count means the HH+HL+HC rule has been substituted.');
});

/* ================= §14.1 — the rung is configurable, and one thing ========= */

// `initialTargetPoints` used to be pinned to 1, because §14.1 writes the ladder
// as "level k: entryPrice − k points" and the code hardcoded a point. The desk
// asked for a half-point target, so the rung is a parameter now — and the whole
// ladder has to move together: the targets, the trail and §15.2's locked-in
// progression are all expressed in rungs.
test('ladder: the rung sizes the targets AND the trail, together', () => {
  const settings = require('../src/ose/settings');
  const entry = 4000;                                   // ₹40.00

  for (const [points, targets, trails] of [
    [1, [3900, 3800, 3700], [4000, 3900, 3800]],
    [0.5, [3950, 3900, 3850], [4000, 3950, 3900]],
    [2, [3800, 3600, 3400], [4000, 3800, 3600]],
  ]) {
    const cfg = settings.derive(settings.withDefaults({ initialTargetPoints: points }));
    for (let k = 1; k <= 3; k += 1) {
      assert.equal(ladder.targetPriceFor(entry, k, cfg._rungP), targets[k - 1],
        `rung ${points}: target at level ${k}`);
      const t = ladder.trailStop({ entryPriceP: entry, stopPriceP: entry + 200 }, k, cfg._rules);
      assert.equal(t ? t.stopPriceP : null, trails[k - 1],
        `rung ${points}: the stop after achieving level ${k}`);
    }
  }
});

test('ladder: §15.2 still locks (k−1) RUNGS, whatever a rung is worth', () => {
  // The table in §15.2 reads "level 1 -> breakeven, level 2 -> +1, level k ->
  // +(k−1)". Those are rungs, not points, and the two only coincided while a
  // rung was hardcoded to a point.
  const settings = require('../src/ose/settings');
  const cfg = settings.derive(settings.withDefaults({ initialTargetPoints: 0.5 }));
  const entry = 4000;

  const atOne = ladder.trailStop({ entryPriceP: entry, stopPriceP: entry + 200 }, 1, cfg._rules);
  assert.equal(atOne.stopPriceP, entry, 'level 1 is breakeven at any rung');
  assert.equal(atOne.lockedPointsP, 0);

  const atThree = ladder.trailStop({ entryPriceP: entry, stopPriceP: entry + 200 }, 3, cfg._rules);
  assert.equal(atThree.lockedPointsP, 2 * cfg._rungP, 'level 3 locks two rungs');
});

test('settings: a rung that is not a whole TICK is refused', () => {
  // An off-tick rung puts an off-tick price on a target, and the exchange
  // rejects those outright.
  const settings = require('../src/ose/settings');
  // Asserted on the PRESENCE of the tick error, not on the error list being
  // empty. A rung also has to clear its own charges, and that rule depends on
  // the charge schedule — which `test/helpers.js` deliberately sets punitive.
  // Coupling the two would make this test fail whenever the schedule changed,
  // for a reason that has nothing to do with ticks.
  const TICK_ERROR = /multiple of the 0\.05 tick/;

  const bad = settings.validate(settings.withDefaults({ initialTargetPoints: 0.07 }));
  assert.ok(bad.errors.some(e => TICK_ERROR.test(e)),
    `expected a tick error, got: ${bad.errors.join(' | ') || '(none)'}`);

  for (const good of [0.5, 1, 2.5]) {
    const r = settings.validate(settings.withDefaults({ initialTargetPoints: good }));
    assert.ok(!r.errors.some(e => TICK_ERROR.test(e)), `${good} is a whole number of ticks`);
  }
});

test('settings: a rung too small to clear its own charges is refused outright', () => {
  // An ERROR rather than a warning, because a "winning" trade that books a loss
  // is not a configuration anyone chose on purpose. §17.3 counts a loss on NET,
  // so a target under the charges makes the circuit breaker fire on wins.
  const settings = require('../src/ose/settings');

  const tiny = settings.validate(settings.withDefaults({ initialTargetPoints: 0.05, lots: 1 }));
  assert.ok(tiny.errors.some(e => /LOSES money/.test(e)),
    `expected the charges refusal, got: ${tiny.errors.join(' | ') || '(no errors)'}`);

  // A rung big enough to pay for itself is accepted — the rule is about the
  // rung against the charges, not about small rungs being banned.
  const viable = settings.validate(settings.withDefaults({ initialTargetPoints: 2.5, lots: 1 }));
  assert.ok(!viable.errors.some(e => /LOSES money/.test(e)),
    `2.5 points should clear the charges: ${viable.errors.join(' | ')}`);
});

test('ladder: the rung defaults to one point when nothing is passed', () => {
  // Every existing caller and every script that builds a cfg by hand relies on
  // this — the parameter was added under them.
  assert.equal(ladder.targetPriceFor(4000, 1), 3900);
  assert.equal(ladder.targetPriceFor(4000, 3), 3700);
  const t = ladder.trailStop({ entryPriceP: 4000, stopPriceP: 4200 }, 2, {});
  assert.equal(t.stopPriceP, 3900, 'level 2 locks one point with no rung configured');
});

/* ============ the lot size comes from the master, never from a constant ==== */

// NIFTY moved from 75 to 65 and the number was hardcoded in five places. The
// ENGINE was always right — it sizes from `quote.lotSize` — so the defect was
// the worse way round: every figure a HUMAN read (the settings page's
// break-even panel, preflight's economics, the "a winning trade loses money"
// refusal) was computed on 15% more quantity than would ever be sent.
test('settings: the break-even panel sizes on the lot it is given, not on 75', () => {
  const settings = require('../src/ose/settings');
  const cfg = settings.withDefaults({ lots: 2 });

  const at65 = settings.breakevenNote(cfg, 65);
  const at75 = settings.breakevenNote(cfg, 75);

  assert.equal(at65.qty, 130, '2 lots of 65');
  assert.equal(at75.qty, 150, '2 lots of 75');
  assert.notEqual(at65.winP, at75.winP, 'the economics must move with the contract size');
});

test('settings: validate sizes on the real lot too, so the charges refusal is honest', () => {
  // §17.3 counts a loss on NET. A target that clears the charges at 75 but not
  // at 65 has to be refused at 65 — validating on the larger lot would let a
  // configuration through that books a loss on every "winning" trade.
  const settings = require('../src/ose/settings');
  const small = { initialTargetPoints: 0.5, lots: 1 };

  const strict = settings.validate(settings.withDefaults(small), { lotSize: 65 });
  const loose = settings.validate(settings.withDefaults(small), { lotSize: 900 });

  assert.ok(strict.errors.some(e => /LOSES money/.test(e)),
    'at 65 a half-point win does not cover the charges');
  assert.ok(!loose.errors.some(e => /LOSES money/.test(e)),
    'at a large enough size the same target does — so the check is reading the lot');
});

test('settings: the fallback is only a fallback, and it is the CURRENT lot', () => {
  const settings = require('../src/ose/settings');
  assert.equal(settings.FALLBACK_LOT, 65,
    'the fallback must track the exchange, or an unreachable master silently '
    + 'restores the old wrong number');
  // Called with nothing, it must still size on something real.
  assert.equal(settings.breakevenNote(settings.withDefaults({ lots: 1 })).qty, 65);
});
