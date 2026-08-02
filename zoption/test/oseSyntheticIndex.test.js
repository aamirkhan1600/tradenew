// src/ose/syntheticIndex.js — the index derived from the option chain.
//
// The pure half is here. The ENGINE half — leg subscription, the source switch
// and the candle-buffer reset — is in oseEngine.test.js, because the thing most
// likely to break is the wiring rather than the arithmetic.

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const synthetic = require('../src/ose/syntheticIndex');
const spotGuard = require('../src/ose/spotGuard');
const settingsService = require('../src/ose/settings');
const h = require('./oseHelpers');

const TRUE_SPOT_P = 2438360;                       // 24383.60
const DISCOUNT = 1;      // parity gives the forward: F = K + (C − P)

// A chain row pair priced to satisfy parity exactly at `spotP`.
function chainAt(spotP, { strikes = 9, step = 50 } = {}) {
  const atm = Math.round((spotP / 100) / step) * step;
  const out = [];
  for (let i = -Math.floor(strikes / 2); i <= Math.floor(strikes / 2); i += 1) {
    const strike = atm + i * step;
    const parityP = spotP - strike * 100 * DISCOUNT;
    const ceP = Math.max(5, 5000 + Math.max(0, parityP));
    out.push(h.quote({ strike, optionType: 'CE', token: `${strike}CE`, ltpP: ceP }));
    out.push(h.quote({ strike, optionType: 'PE', token: `${strike}PE`, ltpP: ceP - parityP }));
  }
  return out;
}

// The ticker's sample map, built from a chain so the two agree by construction.
function samplesFrom(quotes, { ts = h.BASE_TS } = {}) {
  const m = new Map();
  for (const q of quotes) m.set(String(q.token), { ltpPaise: q.ltpP, ts });
  return m;
}

/* ------------------------------------------------------- leg selection ---- */

test('synthetic: picks the strikes nearest the money that quote BOTH legs', () => {
  const legs = synthetic.pickLegs(chainAt(TRUE_SPOT_P), { spotP: TRUE_SPOT_P, count: 4 });
  assert.equal(legs.length, 4);
  for (const l of legs) assert.ok(l.CE && l.PE, `strike ${l.strike} is missing a leg`);
  // 24383.60 -> the four nearest 50s are 24350, 24400, 24300, 24450.
  assert.deepEqual(legs.map(l => l.strike).sort((a, b) => a - b), [24300, 24350, 24400, 24450]);
});

test('synthetic: a one-sided strike is never selected', () => {
  const quotes = chainAt(TRUE_SPOT_P).filter(q =>
    !(q.strike === 24400 && q.optionType === 'PE'));
  const legs = synthetic.pickLegs(quotes, { spotP: TRUE_SPOT_P, count: 4 });
  assert.ok(!legs.some(l => l.strike === 24400),
    'a strike with no put cannot express a parity estimate');
});

test('synthetic: selection tolerates a WRONG centre — that is the point', () => {
  // The only spot available when this first runs is the one under suspicion.
  // Parity is an identity, so a window centred 734 points away still recovers
  // the right level; that was verified against the live chain on 2026-08-02.
  const quotes = chainAt(TRUE_SPOT_P, { strikes: 41 });
  const legs = synthetic.pickLegs(quotes, { spotP: 2511755, count: 6 });
  const res = synthetic.compute(legs, samplesFrom(quotes), { nowMs: h.BASE_TS });

  assert.ok(res.levelP != null, 'a badly centred window must still produce a level');
  assert.ok(Math.abs(res.levelP - TRUE_SPOT_P) < 200,
    `centred on 25117.55 it read ${(res.levelP / 100).toFixed(2)}, not 24383.60`);
});

test('synthetic: tokensFor yields exactly the instruments to subscribe', () => {
  const legs = synthetic.pickLegs(chainAt(TRUE_SPOT_P), { spotP: TRUE_SPOT_P, count: 3 });
  const tokens = synthetic.tokensFor(legs);
  assert.equal(tokens.length, 6, 'three strikes is six legs');
  for (const t of tokens) {
    assert.ok(t.token && t.segment, 'the ticker needs both a token and a segment');
  }
});

/* --------------------------------------------------------- the level ------ */

test('synthetic: recovers the index from the legs', () => {
  const quotes = chainAt(TRUE_SPOT_P);
  const legs = synthetic.pickLegs(quotes, { spotP: TRUE_SPOT_P, count: 6 });
  const res = synthetic.compute(legs, samplesFrom(quotes), { nowMs: h.BASE_TS });

  assert.equal(res.used, 6);
  assert.equal(res.dropped, 0);
  assert.ok(Math.abs(res.levelP - TRUE_SPOT_P) < 100,
    `got ${(res.levelP / 100).toFixed(2)} for a chain priced at 24383.60`);
  assert.ok(Number.isInteger(res.levelP), 'the candle builder is fed whole paise');
});

test('synthetic: it agrees with the guard, because it IS the guard', () => {
  // If these two computed the index differently, the engine could switch to a
  // synthetic source the guard then rejected.
  const quotes = chainAt(TRUE_SPOT_P);
  const legs = synthetic.pickLegs(quotes, { spotP: TRUE_SPOT_P, count: 6 });
  const level = synthetic.compute(legs, samplesFrom(quotes), { nowMs: h.BASE_TS }).levelP;

  const check = spotGuard.check(level, quotes, { nowMs: h.BASE_TS });
  assert.equal(check.ok, true);
  assert.ok(Math.abs(check.divergenceP) < 100,
    'the derived index must not read as divergent against the chain it came from');
});

/* ------------------------------------------------------- stale legs ------- */

test('synthetic: a strike whose legs are not BOTH fresh is dropped, not averaged', () => {
  // A call that ticks while its put does not moves `C − P` for a reason that has
  // nothing to do with the index.
  const quotes = chainAt(TRUE_SPOT_P);
  const legs = synthetic.pickLegs(quotes, { spotP: TRUE_SPOT_P, count: 6 });
  const samples = samplesFrom(quotes);

  // Age one leg of one strike past the window, and corrupt it so that keeping it
  // would visibly move the answer.
  const stale = legs[0];
  samples.set(stale.CE.token, { ltpPaise: 99999, ts: h.BASE_TS - 60000 });

  const res = synthetic.compute(legs, samples, { nowMs: h.BASE_TS, maxSampleAgeMs: 2000 });
  assert.equal(res.dropped, 1);
  assert.equal(res.used, 5);
  assert.ok(Math.abs(res.levelP - TRUE_SPOT_P) < 100,
    'the stale strike must not have reached the median');
});

test('synthetic: too few fresh strikes returns null — a refusal, not a zero', () => {
  const quotes = chainAt(TRUE_SPOT_P);
  const legs = synthetic.pickLegs(quotes, { spotP: TRUE_SPOT_P, count: 6 });
  const res = synthetic.compute(legs, new Map(), { nowMs: h.BASE_TS });

  assert.equal(res.levelP, null, 'null feeds nothing to the candle builder');
  assert.notEqual(res.levelP, 0, 'a zero would be a price, and would be traded on');
  assert.match(res.reason, /fresh/);
});

test('synthetic: a zero or negative premium is not a quote', () => {
  const quotes = chainAt(TRUE_SPOT_P);
  const legs = synthetic.pickLegs(quotes, { spotP: TRUE_SPOT_P, count: 6 });
  const samples = samplesFrom(quotes);
  for (const l of legs.slice(0, 4)) samples.set(l.CE.token, { ltpPaise: 0, ts: h.BASE_TS });

  const res = synthetic.compute(legs, samples, { nowMs: h.BASE_TS });
  assert.equal(res.used, 2);
  assert.equal(res.levelP, null, 'two strikes is below the floor for a median');
});

test('synthetic: pure — it does not mutate the legs or the samples it is given', () => {
  const quotes = chainAt(TRUE_SPOT_P);
  const legs = synthetic.pickLegs(quotes, { spotP: TRUE_SPOT_P, count: 6 });
  const samples = samplesFrom(quotes);
  const beforeLegs = JSON.stringify(legs);
  const beforeSize = samples.size;

  synthetic.compute(legs, samples, { nowMs: h.BASE_TS });

  assert.equal(JSON.stringify(legs), beforeLegs);
  assert.equal(samples.size, beforeSize);
});

/* ----------------------------------------------------- configuration ------ */

test('settings: the derived _synthetic block is what the engine reads', () => {
  const cfg = settingsService.derive(settingsService.withDefaults({
    syntheticIndexMode: 'force', syntheticIndexStrikes: 8,
  }));
  assert.equal(cfg._synthetic.mode, 'FORCE', 'the mode is upper-cased once, here');
  assert.equal(cfg._synthetic.strikes, 8);
  assert.ok(cfg._synthetic.minStrikes >= 3);
  assert.ok(cfg._synthetic.maxSampleAgeMs > 0);
});

test('settings: AUTO ships, and every mode is validated', () => {
  assert.equal(settingsService.DEFAULTS.syntheticIndexMode, 'AUTO');
  assert.deepEqual(settingsService.SYNTHETIC_MODES, ['AUTO', 'OFF', 'FORCE']);

  for (const mode of settingsService.SYNTHETIC_MODES) {
    const { errors } = settingsService.validate(
      settingsService.withDefaults({ syntheticIndexMode: mode }));
    assert.deepEqual(errors, [], `${mode} must be accepted`);
  }
  const bad = settingsService.validate(
    settingsService.withDefaults({ syntheticIndexMode: 'BANANA' }));
  assert.ok(bad.errors.some(e => /syntheticIndexMode/.test(e)));
});

test('settings: the legs fit the quote batch they have to share', () => {
  // The whole design rests on the legs riding in the poll that was happening
  // anyway. If the default ever grew past the batch, it would silently become a
  // second HTTP request per second against a shared rate budget.
  const config = require('../src/config');
  const cfg = settingsService.derive(settingsService.withDefaults({}));
  const legs = cfg._synthetic.strikes * 2;
  assert.ok(legs + 4 <= config.neo.quoteBatch,
    `${legs} parity legs plus the index and the held contract must fit `
    + `NEO_QUOTE_BATCH (${config.neo.quoteBatch})`);
});
