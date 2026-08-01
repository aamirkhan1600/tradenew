// The settings form's coercion — the one place a §22 sign-off is recorded.
//
// A browser form posts strings, posts nothing at all for an unticked checkbox,
// and cannot post a number. Every one of those has a way of going wrong that is
// silent: a sign-off that cannot be withdrawn, a boolean that can be turned on
// but never off, a "1.0" stored where a 1 was meant. LIVE mode's gate reads the
// output of this function, so it is tested rather than trusted.

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const { coerce } = require('../src/http/oseRoutes');
const C = require('../src/ose/constants');
const settingsService = require('../src/ose/settings');

test('form numbers arrive as strings and must not be stored as strings', () => {
  const out = coerce({ premiumMin: '15.5', lots: '2', scanRange: '12', maxTradesPerDay: '30' });
  assert.equal(out.premiumMin, 15.5);
  assert.equal(out.lots, 2);
  assert.equal(out.scanRange, 12);
  assert.equal(typeof out.maxTradesPerDay, 'number');
});

test('a boolean can be turned OFF, not just on', () => {
  // The page uses a <select> ON/OFF for these rather than a checkbox — the
  // house pattern, and the one that cannot go wrong here: a select ALWAYS
  // posts, where an unticked checkbox posts nothing and is indistinguishable
  // from a field that was never on the form. `'on'` is still accepted so a
  // checkbox elsewhere would keep working.
  assert.equal(coerce({ trailingStopEnabled: 'false' }).trailingStopEnabled, false);
  assert.equal(coerce({ trailingStopEnabled: 'on' }).trailingStopEnabled, true);
  assert.equal(coerce({ stopGuardEnabled: 'false' }).stopGuardEnabled, false);
  assert.equal(coerce({ tradeOnExpiryDay: 'true' }).tradeOnExpiryDay, true);
});

test('ticked confirm_<id> boxes become the §22 register', () => {
  const out = coerce({ confirm_form: '1', confirm_1: 'on', confirm_2: 'true', confirm_10: 'on' });
  assert.deepEqual(out.confirmed, [1, 2, 10]);
  // The raw form fields must not survive into the stored settings row.
  assert.equal(out.confirm_1, undefined);
  assert.equal(out.confirm_10, undefined);
  assert.equal(out.confirm_form, undefined);
});

test('an unticked box WITHDRAWS a sign-off — the register is not a ratchet', () => {
  // A desk must be able to withdraw a sign-off when a rule changes underneath
  // it. If this stopped working, an item signed once could never be un-signed
  // and the LIVE gate would be permanently satisfied by a stale decision.
  const out = coerce({ confirm_form: '1', confirm_1: 'on' });
  assert.deepEqual(out.confirmed, [1]);
  assert.deepEqual(coerce({ confirm_form: '1' }).confirmed, [],
    'the owning form posting no boxes clears the register');
});

test('a save from ANY OTHER form leaves the register untouched', () => {
  // The register lives on its own form, and an absent checkbox is
  // indistinguishable from an unticked one. Without the ownership marker,
  // changing `lots` would silently withdraw all seventeen sign-offs — the
  // settings page undoing the desk's approvals as a side effect of an
  // unrelated edit, and the operator's only clue would be LIVE refusing later.
  const out = coerce({ lots: '2', premiumMin: '15', trailingStopEnabled: 'true' });
  assert.equal(out.confirmed, undefined,
    'no marker means the key is absent, so save() keeps the stored value');
  assert.equal(out.lots, 2, 'the fields that WERE posted still coerce');
});

test('signing every item is exactly what unlocks the LIVE gate', () => {
  const all = { confirm_form: '1' };
  for (const id of C.MUST_CONFIRM_IDS) all[`confirm_${id}`] = 'on';
  const settings = settingsService.withDefaults(coerce(all));

  assert.equal(settings.confirmed.length, C.MUST_CONFIRM.length);
  assert.equal(settingsService.unsignedItems(settings).length, 0);

  // ...and one missing box is enough to keep it shut.
  const short = { ...all };
  delete short.confirm_12;
  const partial = settingsService.withDefaults(coerce(short));
  assert.deepEqual(settingsService.unsignedItems(partial).map(m => m.id), [12]);
});

test('LIVE still refuses in a non-production environment even fully signed', () => {
  // Two independent gates, and the sign-off does not stand in for the other:
  // a live order from a process that believes it is a development box is the
  // one mistake this engine cannot take back.
  const all = { confirm_form: '1' };
  for (const id of C.MUST_CONFIRM_IDS) all[`confirm_${id}`] = 'on';
  const settings = settingsService.withDefaults({ ...coerce(all), mode: 'LIVE' });
  assert.throws(() => settingsService.assertLiveAllowed(settings), /NODE_ENV/);
});
