const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const s = require('../src/strategy/selectors');

const EXPIRIES = ['2026-07-28', '2026-08-04', '2026-08-11', '2026-08-25', '2026-09-29'];

// A NIFTY ladder around 25150, 50-point steps.
function chain({ from = 24800, to = 25500, step = 50, premium = null } = {}) {
  const rows = [];
  for (let k = from; k <= to; k += step) {
    for (const type of ['CE', 'PE']) {
      rows.push({
        token: `${k}${type}`,
        segment: 'nse_fo',
        symbol: `NIFTY31JUL26${k}${type}`,
        strike: k,
        option_type: type,
        lot_size: 75,
        tick_size: 0.05,
      });
    }
  }
  void premium;
  return rows;
}

/* ---------------------------------------------------------------- expiry -- */

test('CURRENT_WEEKLY is the nearest expiry the master actually carries', () => {
  // Never a hardcoded weekday: NSE has moved expiry day, and a hardcoded
  // Thursday silently trades the wrong contract when it does.
  assert.equal(s.selectExpiry({ mode: 'CURRENT_WEEKLY', expiries: EXPIRIES }), '2026-07-28');
});

test('NEXT_WEEKLY is the one after that, and fails loudly when there is none', () => {
  assert.equal(s.selectExpiry({ mode: 'NEXT_WEEKLY', expiries: EXPIRIES }), '2026-08-04');
  assert.throws(() => s.selectExpiry({ mode: 'NEXT_WEEKLY', expiries: ['2026-07-28'] }),
    /only one expiry/);
});

test('MONTHLY is the last expiry of the nearest month', () => {
  assert.equal(s.selectExpiry({ mode: 'MONTHLY', expiries: EXPIRIES }), '2026-07-28');
  assert.equal(
    s.selectExpiry({ mode: 'MONTHLY', expiries: ['2026-08-04', '2026-08-11', '2026-08-25'] }),
    '2026-08-25');
});

test('MANUAL insists the date exists in the master', () => {
  assert.equal(
    s.selectExpiry({ mode: 'MANUAL', expiries: EXPIRIES, manualExpiry: '2026-08-11' }),
    '2026-08-11');
  assert.throws(
    () => s.selectExpiry({ mode: 'MANUAL', expiries: EXPIRIES, manualExpiry: '2026-08-12' }),
    /not in the master/);
  assert.throws(() => s.selectExpiry({ mode: 'MANUAL', expiries: EXPIRIES }), /manualExpiry/);
});

test('an empty master is an error, not a silent no-trade', () => {
  assert.throws(() => s.selectExpiry({ mode: 'CURRENT_WEEKLY', expiries: [] }), /no expiries/);
});

/* ---------------------------------------------------------------- strike -- */

test('the ladder step is read from the chain rather than assumed', () => {
  assert.equal(s.strikeStep(chain()), 50);
  assert.equal(s.strikeStep(chain({ step: 100 })), 100);
});

test('ATM rounds the spot to the nearest strike — the documents\' example', () => {
  // Spot 25135 -> ATM 25150.
  assert.equal(s.atmStrike(25135, 50), 25150);
  assert.equal(s.atmStrike(25120, 50), 25100);
  assert.equal(s.atmStrike(25125, 50), 25150);
});

test('ATM mode puts both legs on the money', () => {
  const out = s.selectStrikes({ chain: chain(), spot: 25135, mode: 'ATM', tradeMode: 'BOTH' });
  assert.equal(out.atm, 25150);
  assert.equal(Number(out.ce.strike), 25150);
  assert.equal(Number(out.pe.strike), 25150);
});

test('ATM_OFFSET moves each leg AWAY from the money — the documents\' example', () => {
  // ATM 25150, offset 2 -> CE 25250, PE 25050.
  const out = s.selectStrikes({
    chain: chain(), spot: 25135, mode: 'ATM_OFFSET', atmOffset: 2, tradeMode: 'BOTH',
  });
  assert.equal(Number(out.ce.strike), 25250);
  assert.equal(Number(out.pe.strike), 25050);
});

test('PREMIUM mode picks the strike nearest the target inside tolerance', () => {
  const rows = chain();
  // ₹12 target, ±2 tolerance: 10–14 is the band.
  const premiums = { '25250CE': 1300, '25300CE': 900, '25200CE': 1800, '25050PE': 1150 };
  const out = s.selectStrikes({
    chain: rows, spot: 25135, mode: 'PREMIUM',
    targetPremium: 12, premiumTolerance: 2, tradeMode: 'BOTH',
    premiumPaise: (t) => premiums[t] ?? null,
  });
  assert.equal(Number(out.ce.strike), 25250, '13.00 is nearest 12.00 inside the band');
  assert.equal(Number(out.pe.strike), 25050);
});

test('PREMIUM mode returns NO TRADE rather than the nearest miss', () => {
  // The band is a constraint, not a suggestion. A selector that quietly returns
  // the closest strike outside tolerance turns configuration into decoration.
  const premiums = { '25250CE': 2500, '25050PE': 2500 };
  const out = s.selectStrikes({
    chain: chain(), spot: 25135, mode: 'PREMIUM',
    targetPremium: 12, premiumTolerance: 2, tradeMode: 'BOTH',
    premiumPaise: (t) => premiums[t] ?? null,
  });
  assert.equal(out.ce, null);
  assert.equal(out.pe, null);
  assert.match(out.reason, /inside/);
});

test('PREMIUM mode ignores strikes with no live price', () => {
  const out = s.selectStrikes({
    chain: chain(), spot: 25135, mode: 'PREMIUM',
    targetPremium: 12, premiumTolerance: 2, tradeMode: 'CE',
    premiumPaise: () => null,
  });
  assert.equal(out.ce, null);
});

test('a tie breaks toward the further strike', () => {
  // Both 11.00 and 13.00 are one rupee from 12.00; further out of the money is
  // the safer of two the band likes equally.
  const premiums = { '25250CE': 1100, '25300CE': 1300 };
  const out = s.selectStrikes({
    chain: chain(), spot: 25135, mode: 'PREMIUM',
    targetPremium: 12, premiumTolerance: 2, tradeMode: 'CE',
    premiumPaise: (t) => premiums[t] ?? null,
  });
  assert.equal(Number(out.ce.strike), 25300);
});

test('tradeMode CE or PE selects one leg only', () => {
  const ce = s.selectStrikes({ chain: chain(), spot: 25135, mode: 'ATM', tradeMode: 'CE' });
  assert.ok(ce.ce);
  assert.equal(ce.pe, null);

  const pe = s.selectStrikes({ chain: chain(), spot: 25135, mode: 'ATM', tradeMode: 'PE' });
  assert.equal(pe.ce, null);
  assert.ok(pe.pe);
});

test('a strike outside the ladder is reported, not invented', () => {
  const out = s.selectStrikes({
    chain: chain({ from: 25100, to: 25200 }), spot: 25150,
    mode: 'ATM_OFFSET', atmOffset: 20, tradeMode: 'BOTH',
  });
  assert.equal(out.ce, null);
  assert.match(out.reason, /no (CE|PE) at strike/);
});

test('an empty chain and an unknown mode both fail loudly', () => {
  assert.throws(() => s.selectStrikes({ chain: [], spot: 25135, mode: 'ATM' }), /empty/);
  assert.throws(() => s.selectStrikes({ chain: chain(), spot: 25135, mode: 'VIBES' }),
    /unknown strikeMode/);
});
