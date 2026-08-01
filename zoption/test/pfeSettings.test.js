// The Price-Filter Engine's settings: what is refused, what is merely warned
// about, and what the engine actually runs on.

const test = require('node:test');
const assert = require('node:assert/strict');

require('./pfeHelpers');
const settings = require('../src/pfe/settings');

const D = settings.DEFAULTS;
const withOverride = (over) => ({ ...D, ...over });
const hasWarning = (list, pattern) => list.some(w => pattern.test(w));

test('the shipped profile is valid', () => {
  const { errors } = settings.validate(D);
  assert.deepEqual(errors, [], errors.join('\n'));
});

test('a profile missing a key that was added later still boots', () => {
  const old = { ...D };
  delete old.trailTighten;
  delete old.liquidityMode;
  const filled = settings.withDefaults(old);
  assert.equal(filled.trailTighten, D.trailTighten);
  assert.equal(filled.liquidityMode, D.liquidityMode);
  assert.deepEqual(settings.validate(old).errors, []);
});

/* ------------------------------------------------------------- refusals -- */

test('an ideal band outside the accepted band is refused', () => {
  const { errors } = settings.validate(withOverride({ premiumIdealMin: 5 }));
  assert.ok(errors.some(e => /ideal premium band/.test(e)));
});

test('an inverted premium band is refused', () => {
  const { errors } = settings.validate(withOverride({ premiumMin: 30, premiumMax: 12 }));
  assert.ok(errors.some(e => /premiumMin must be below premiumMax/.test(e)));
});

test('a trail floor above the starting gap is refused — it cannot tighten upwards', () => {
  const { errors } = settings.validate(withOverride({ trailGap: 0.5, trailMinGap: 1.0 }));
  assert.ok(errors.some(e => /trailMinGap/.test(e)));
});

test('an unknown liquidity mode is refused rather than silently defaulted', () => {
  const { errors } = settings.validate(withOverride({ liquidityMode: 'SOMETIMES' }));
  assert.ok(errors.some(e => /liquidityMode/.test(e)));
});

test('a timeframe the engine cannot build is refused', () => {
  const { errors } = settings.validate(withOverride({ optionTimeframe: '1h' }));
  assert.ok(errors.some(e => /optionTimeframe/.test(e)));
});

test('MANUAL expiry without a date is refused', () => {
  const { errors } = settings.validate(withOverride({ expiryMode: 'MANUAL', manualExpiry: null }));
  assert.ok(errors.some(e => /manualExpiry/.test(e)));
});

test('a session that ends before it starts is refused', () => {
  const { errors } = settings.validate(withOverride({ sessionStart: '15:00', lastEntryAt: '09:16' }));
  assert.ok(errors.some(e => /sessionStart must be before/.test(e)));
});

/* -------------------------------------------------------------- warnings -- */

test('both liquidity modes warn, because both have a failure mode worth naming', () => {
  assert.ok(hasWarning(settings.validate(withOverride({ liquidityMode: 'LENIENT' })).warnings,
    /SKIPPED/), 'LENIENT quietly chooses on premium alone');
  assert.ok(hasWarning(settings.validate(withOverride({ liquidityMode: 'STRICT' })).warnings,
    /NO STRIKE WILL EVER BE SELECTED/), 'STRICT quietly selects nothing');
});

test("the document's own 1.0 / 2.0 warns about the win rate it needs", () => {
  const { warnings } = settings.validate(withOverride({ target: 1.0, stopLoss: 2.0 }));
  assert.ok(hasWarning(warnings, /win rate/));
});

test('turning the ladder off warns that the risk/reward is then upside down', () => {
  const { warnings } = settings.validate(withOverride({ dynamicTarget: false }));
  assert.ok(hasWarning(warnings, /dynamicTarget is OFF/));
});

test('a safety exit inside the stop warns that the stop is now unreachable', () => {
  const { warnings } = settings.validate(withOverride({ premiumSafetyExit: 1.0, stopLoss: 2.0 }));
  assert.ok(hasWarning(warnings, /effective stop/));
});

test('a liquidity exit no wider than the selection filter warns', () => {
  const { warnings } = settings.validate(withOverride({ maxSpread: 0.6, liquidityExitSpread: 0.5 }));
  assert.ok(hasWarning(warnings, /liquidityExitSpread/));
});

test('a hold shorter than the ladder needs warns that winners get cut off', () => {
  const { warnings } = settings.validate(withOverride({ maxHoldSeconds: 15, maxTargetSteps: 4 }));
  assert.ok(hasWarning(warnings, /ladder needs/));
});

test('no re-entry wait warns — the document asks for two candles', () => {
  const { warnings } = settings.validate(withOverride({ reentryCandles: 0 }));
  assert.ok(hasWarning(warnings, /reentryCandles is 0/));
});

/* --------------------------------------------------------------- derive -- */

test('derive precomputes everything the hot path needs, in paise and ms', () => {
  const d = settings.derive(D);
  assert.equal(d._sellOffsetP, 10);
  assert.equal(d._targetP, 100);
  assert.equal(d._stopLossP, 200);
  assert.equal(d._maxHoldMs, 90000);
  assert.equal(d._optionSeconds, 5);
  assert.equal(d._trendSeconds, 5);
});

test('the machine config is a complete, self-contained block', () => {
  const m = settings.derive(D)._machine;
  for (const key of ['sellOffsetP', 'targetP', 'stopLossP', 'stepP', 'maxSteps',
    'trailStartP', 'trailGapP', 'trailTightenP', 'trailMinGapP', 'safetyMarginP',
    'pendingTimeoutMs', 'maxHoldMs', 'armTimeoutMs', 'dynamicTarget']) {
    assert.notEqual(m[key], undefined, `_machine.${key} is missing`);
  }
});

test('the scanner config carries the bands in paise and the weights', () => {
  const s = settings.derive(D)._scanner;
  assert.equal(s.premiumMinP, 1200);
  assert.equal(s.premiumMaxP, 3000);
  assert.equal(s.premiumIdealMinP, 1500);
  assert.equal(s.premiumIdealMaxP, 2500);
  assert.equal(s.maxSpreadP, 20);
  assert.equal(s.weights.premium, 1);
});

/* ------------------------------------------------------------ economics -- */

test('the breakeven note reports the first rung AND the full ladder', () => {
  const note = settings.breakevenNote(D, 75);
  assert.equal(note.qty, 75);
  assert.ok(note.chargesP > 0);
  assert.equal(note.targetP, 100);
  assert.equal(note.ladderTargetP, 400, '1 point plus three more of ₹1');
  assert.ok(note.ladderRequiredWinRate < note.requiredWinRate,
    'a wider target needs a lower hit rate — that is what the ladder is for');
});

test('a configuration where a win loses money is an ERROR, not a warning', () => {
  // A target so small that charges eat it whole on one lot.
  const { errors } = settings.validate(withOverride({ target: 0.05, lots: 1 }));
  assert.ok(errors.some(e => /LOSES money/.test(e)), errors.join('\n'));
});
