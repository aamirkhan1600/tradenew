// src/ose/spotGuard.js — the index-feed sanity check.
//
// The fixtures are built from the REAL failure of 2026-08-02: a Kotak gateway
// answering `nse_cm|Nifty 50` with 25117.55 while the index was at 24383.60, and
// a live chain whose 37 both-legged strikes priced it at 24382.10. Synthetic
// round numbers would not have caught the thing this module exists for, which is
// that the wrong number looked completely plausible.

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const spotGuard = require('../src/ose/spotGuard');
const settingsService = require('../src/ose/settings');
const h = require('./oseHelpers');

// A both-legged strike priced to satisfy put-call parity EXACTLY at `spotP`:
//
//     C − P = S − K·e^(−rT)
//
// Built backwards from the answer on purpose — a fixture that priced the legs
// forwards from a model would be testing the model. The discount is passed in
// rather than assumed, because assuming it away is precisely the bug these
// fixtures failed to catch the first time.
function pair(strike, spotP, discount = 1) {
  // F ≈ K + (C − P), so C − P = F − K. `discount` is retained only so a test can
  // deliberately construct a chain whose forward differs from its spot.
  const parityP = spotP - strike * 100 * discount;      // = C − P, by identity
  const timeP = 5000;                                   // ₹50 of time value
  const ceP = Math.max(5, timeP + Math.max(0, parityP));
  return [
    h.quote({ strike, optionType: 'CE', token: `${strike}CE`, symbol: `SIM${strike}CE`, ltpP: ceP }),
    h.quote({ strike, optionType: 'PE', token: `${strike}PE`, symbol: `SIM${strike}PE`,
      ltpP: ceP - parityP }),
  ];
}

// The discount the fixtures and the module must BOTH use. Derived from the
// module itself against the helper's default expiry, so the test cannot drift
// from the implementation by hardcoding a number that was right once.
// The estimator no longer discounts the strike — parity gives the FORWARD, and
// K + (C − P) is it. Fixtures are built at 1 so the chain's forward IS `spotP`.
const DISCOUNT = 1;

function chainAt(spotP, { strikes = 9, step = 50, discount = DISCOUNT, expiry } = {}) {
  const atm = Math.round((spotP / 100) / step) * step;
  const out = [];
  for (let i = -Math.floor(strikes / 2); i <= Math.floor(strikes / 2); i += 1) {
    out.push(...pair(atm + i * step, spotP, discount));
  }
  return expiry ? out.map(q => ({ ...q, expiry })) : out;
}

const TRUE_SPOT_P = 2438360;      // 24383.60 — the real index that day
const BAD_FEED_P = 2511755;       // 25117.55 — what the gateway answered

/* ------------------------------------------------------- the implied spot -- */

test('spotGuard: put-call parity recovers the spot from the chain', () => {
  const implied = spotGuard.impliedSpot(chainAt(TRUE_SPOT_P));
  assert.equal(implied.pairs, 9);
  assert.ok(Math.abs(implied.spotP - TRUE_SPOT_P) < 1,
    `recovered ${(implied.spotP / 100).toFixed(2)} from a chain priced at 24383.60`);
});

test('spotGuard: the MEDIAN ignores a stale far-OTM leg that a mean would follow', () => {
  // The real snapshot contained estimates of 23854 and 24050 alongside a dozen
  // at 24381–24384, from strikes whose last trade was hours old. A mean would be
  // dragged hundreds of points by those; the median must not move at all.
  const quotes = chainAt(TRUE_SPOT_P);
  const rotten = [
    ...pair(25650, TRUE_SPOT_P - 33000, DISCOUNT),      // implies ~24053
    ...pair(25700, TRUE_SPOT_P - 46000, DISCOUNT),      // implies ~23923
    ...pair(25250, TRUE_SPOT_P - 52800, DISCOUNT),      // implies ~23855
  ];

  const clean = spotGuard.impliedSpot(quotes).spotP;
  const dirty = spotGuard.impliedSpot([...quotes, ...rotten]).spotP;

  assert.ok(Math.abs(clean - TRUE_SPOT_P) < 1);
  assert.ok(Math.abs(dirty - TRUE_SPOT_P) <= 2000,
    `the median moved ${(Math.abs(dirty - TRUE_SPOT_P) / 100).toFixed(2)} points on three rotten `
    + 'legs — it is behaving like a mean');

  const rows = spotGuard.estimates([...quotes, ...rotten]);
  const mean = rows.reduce((a, r) => a + r.spotP, 0) / rows.length;
  assert.ok(Math.abs(mean - TRUE_SPOT_P) > Math.abs(dirty - TRUE_SPOT_P),
    'the fixture must actually punish a mean, or this test proves nothing');
});

test('spotGuard: a leg with no traded price is skipped, never read as zero', () => {
  // `Number(null)` is 0, and a zero premium yields an estimate that looks like a
  // number and means nothing.
  const quotes = chainAt(TRUE_SPOT_P);
  quotes.push(h.quote({ strike: 24000, optionType: 'CE', token: '24000CE', ltpP: null }));
  quotes.push(h.quote({ strike: 24000, optionType: 'PE', token: '24000PE', ltpP: 0 }));

  const implied = spotGuard.impliedSpot(quotes);
  assert.equal(implied.pairs, 9, 'the untraded strike must not form a pair');
  assert.ok(Math.abs(implied.spotP - TRUE_SPOT_P) < 1);
});

test('spotGuard: a strike quoting only one leg forms no estimate', () => {
  const oneSided = chainAt(TRUE_SPOT_P).filter(q => q.optionType === 'CE');
  assert.equal(spotGuard.impliedSpot(oneSided).pairs, 0);
});

/* ------------------------------------------------------------- the verdict -- */

test('spotGuard: the 2026-08-02 failure is caught', () => {
  const res = spotGuard.check(BAD_FEED_P, chainAt(TRUE_SPOT_P), { maxDivergenceP: 10000 });

  assert.equal(res.ok, false);
  assert.equal(res.verdict, spotGuard.VERDICT.DIVERGED);
  assert.ok(Math.abs(res.impliedSpotP - TRUE_SPOT_P) < 1);
  assert.ok(Math.abs(res.divergenceP - (BAD_FEED_P - TRUE_SPOT_P)) < 1);
  assert.match(res.reason, /24383\.60/);
  assert.match(res.reason, /the FEED is what is wrong/);
});

test('spotGuard: a correct feed passes, and a real 3% day does NOT trip it', () => {
  // The whole reason this uses the chain rather than `ohlc.close`: the second
  // opinion moves WITH the market. A violent session must not read as a fault.
  const calm = spotGuard.check(TRUE_SPOT_P, chainAt(TRUE_SPOT_P));
  assert.equal(calm.ok, true);
  assert.equal(calm.verdict, spotGuard.VERDICT.OK);
  assert.ok(Math.abs(calm.divergenceP) < 1, 'a chain priced at the feed must diverge by nothing');

  const moved = Math.round(TRUE_SPOT_P * 1.03);
  const crash = spotGuard.check(moved, chainAt(moved));
  assert.equal(crash.ok, true, 'a 3% move with a chain that moved too is not a divergence');
});

test('spotGuard: a FAR expiry does not false-positive — the basis is absorbed', () => {
  // Parity gives the FORWARD, and the forward sits above the spot by
  // S·(e^((r−q)T) − 1) — under two points on the front weekly, but over a
  // hundred at a month. If the tolerance ignored that, the guard would refuse
  // every cycle on a perfectly good feed the moment the nearest expiry was a
  // monthly. It widens instead.
  const monthly = new Date(h.BASE_TS + 30 * 86400000).toISOString().slice(0, 10);
  const quotes = chainAt(TRUE_SPOT_P, { expiry: monthly })
    .map(q => ({ ...q, snapshotTs: h.BASE_TS }));

  const basisP = spotGuard.basisAllowanceP(TRUE_SPOT_P, quotes, { nowMs: h.BASE_TS });
  assert.ok(basisP > spotGuard.DEFAULT_MAX_DIVERGENCE_P,
    `a ${(basisP / 100).toFixed(0)}-point basis must exceed the ${
      spotGuard.DEFAULT_MAX_DIVERGENCE_P / 100}-point band, or the fixture proves nothing`);

  // A feed sitting exactly at the spot, on a chain whose forward is that spot:
  // it must PASS even though the raw band is narrower than the basis.
  const res = spotGuard.check(TRUE_SPOT_P, quotes, { nowMs: h.BASE_TS });
  assert.equal(res.ok, true, 'a correct feed on a monthly expiry must pass');

  // And the allowance must not become a blank cheque — the real 734-point
  // failure still has to be caught at a monthly expiry.
  const broken = spotGuard.check(BAD_FEED_P, quotes, { nowMs: h.BASE_TS });
  assert.equal(broken.ok, false, 'the widened band must still catch a 734-point lie');
});

test('spotGuard: the estimate is the FORWARD — K + (C − P), strike undiscounted', () => {
  // The measured reason this is not discounted: on 25 both-legged strikes,
  // K + (C − P) read 24381.90 against a true 24383.60 while discounting the
  // strike read 24373.75. An 8-point systematic bias, every strike agreeing.
  const quotes = chainAt(TRUE_SPOT_P);
  const rows = spotGuard.estimates(quotes);
  for (const r of rows) {
    assert.equal(r.spotP, (r.ceP - r.peP) + r.strike * 100,
      `strike ${r.strike} must be K + (C − P) with no discount applied`);
  }
});

test('spotGuard: divergence inside the band passes, outside it fails', () => {
  const cfg = { maxDivergenceP: 10000 };                  // 100 index points
  const near = spotGuard.check(TRUE_SPOT_P + 9000, chainAt(TRUE_SPOT_P), cfg);
  assert.equal(near.ok, true);

  const far = spotGuard.check(TRUE_SPOT_P + 11000, chainAt(TRUE_SPOT_P), cfg);
  assert.equal(far.ok, false);

  // Symmetric — a feed reading LOW is exactly as dangerous as one reading high.
  const low = spotGuard.check(TRUE_SPOT_P - 11000, chainAt(TRUE_SPOT_P), cfg);
  assert.equal(low.ok, false);
  assert.ok(low.divergenceP < 0);
});

test('spotGuard: too few both-legged strikes is UNKNOWN, and does NOT stop the engine', () => {
  // A thin chain is already the business of CHAIN_CORRUPT and NO_LIQUID_STRIKE.
  // Stopping the engine twice for one fault helps nobody, and a guard that
  // refuses whenever it cannot measure would refuse on every quiet open.
  const thin = [...pair(24400, TRUE_SPOT_P, DISCOUNT), ...pair(24450, TRUE_SPOT_P, DISCOUNT)];
  const res = spotGuard.check(BAD_FEED_P, thin, { minPairs: 5 });

  assert.equal(res.ok, true, 'an unmeasurable chain must not block trading');
  assert.equal(res.verdict, spotGuard.VERDICT.UNKNOWN);
  assert.equal(res.impliedSpotP, null);
  assert.match(res.reason, /2 strike/);
});

test('spotGuard: no sealed index close is UNKNOWN rather than a divergence', () => {
  for (const bad of [null, undefined, 0, -1, NaN]) {
    const res = spotGuard.check(bad, chainAt(TRUE_SPOT_P));
    assert.equal(res.verdict, spotGuard.VERDICT.UNKNOWN, `feed spot ${bad}`);
    assert.equal(res.ok, true);
  }
});

test('spotGuard: disabled says so explicitly rather than quietly passing', () => {
  const res = spotGuard.check(BAD_FEED_P, chainAt(TRUE_SPOT_P), { enabled: false });
  assert.equal(res.ok, true);
  assert.equal(res.verdict, spotGuard.VERDICT.DISABLED,
    'an OFF guard and a PASSING guard must never look the same to a caller');
});

test('spotGuard: every return path carries the feed spot it judged', () => {
  // The engine logs this. A verdict that cannot say what it was judging is a
  // log line an operator cannot act on.
  const probe = 2400000;                       // a value used by no other fixture
  const cases = {
    diverged: spotGuard.check(probe, chainAt(TRUE_SPOT_P)),
    unknown: spotGuard.check(probe, [], {}),
    disabled: spotGuard.check(probe, chainAt(TRUE_SPOT_P), { enabled: false }),
    ok: spotGuard.check(probe, chainAt(probe)),
  };

  assert.equal(cases.diverged.verdict, spotGuard.VERDICT.DIVERGED);
  assert.equal(cases.unknown.verdict, spotGuard.VERDICT.UNKNOWN);
  assert.equal(cases.disabled.verdict, spotGuard.VERDICT.DISABLED);
  assert.equal(cases.ok.verdict, spotGuard.VERDICT.OK);

  for (const [name, c] of Object.entries(cases)) {
    assert.equal(c.feedSpotP, probe, `the ${name} verdict lost the spot it was judging`);
  }
});

test('spotGuard: pure — it does not mutate the quotes it was handed', () => {
  const quotes = chainAt(TRUE_SPOT_P);
  const before = JSON.stringify(quotes);
  spotGuard.check(BAD_FEED_P, quotes);
  assert.equal(JSON.stringify(quotes), before);
});

/* ----------------------------------------------------------- configuration -- */

test('settings: the derived _spotCheck block is what spotGuard.check reads', () => {
  const cfg = settingsService.derive(settingsService.withDefaults({
    spotCheckMaxDivergencePoints: 60, spotCheckMinPairs: 8,
  }));
  assert.equal(cfg._spotCheck.enabled, true);
  assert.equal(cfg._spotCheck.maxDivergenceP, 6000, 'index POINTS on the page, paise in the engine');
  assert.equal(cfg._spotCheck.minPairs, 8);

  const res = spotGuard.check(TRUE_SPOT_P + 7000, chainAt(TRUE_SPOT_P), cfg._spotCheck);
  assert.equal(res.ok, false, 'the 60-point band must actually be applied');
});

test('settings: the check ships ON, and turning it off is said out loud', () => {
  assert.equal(settingsService.DEFAULTS.spotCheckEnabled, true);
  assert.equal(settingsService.DEFAULTS.spotCheckMaxDivergencePoints, 100);

  const { warnings } = settingsService.validate(
    settingsService.withDefaults({ spotCheckEnabled: false }));
  assert.ok(warnings.some(w => /spotCheckEnabled is OFF/.test(w)));
});

test('settings: a caller with no configuration still gets the guard, not zeros', () => {
  // A zero divergence band would refuse every cycle; an absent one must not
  // silently become that.
  const res = spotGuard.check(TRUE_SPOT_P, chainAt(TRUE_SPOT_P), {});
  assert.equal(res.ok, true);
  assert.equal(spotGuard.DEFAULT_MAX_DIVERGENCE_P, 10000);
  assert.equal(spotGuard.check(BAD_FEED_P, chainAt(TRUE_SPOT_P), {}).ok, false);
});
