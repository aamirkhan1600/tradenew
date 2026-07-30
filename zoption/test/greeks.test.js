// Black-Scholes, checked against values that can be looked up.
//
// The reference set is the textbook one — S=100, K=100, T=1, r=5%, sigma=20% —
// because a greeks implementation that agrees with itself proves nothing. Every
// number below appears in Hull and in every online calculator, so a regression
// here is unambiguous rather than a matter of opinion.

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const greeks = require('../src/market/greeks');

const near = (actual, expected, tolerance, what) => {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${what}: expected ~${expected}, got ${actual}`);
};

test('prices the textbook option', () => {
  near(greeks.price('CE', 100, 100, 1, 0.05, 0.2), 10.4506, 1e-4, 'call');
  near(greeks.price('PE', 100, 100, 1, 0.05, 0.2), 5.5735, 1e-4, 'put');
});

test('satisfies put-call parity', () => {
  // C - P = S - K·e^(-rT). Parity is the one property that cannot be satisfied
  // by a call formula and a put formula that are each subtly wrong.
  for (const [S, K, T, r, v] of [[100, 100, 1, 0.05, 0.2], [24800, 25000, 0.02, 0.065, 0.13],
    [24800, 24000, 0.5, 0.065, 0.4]]) {
    const c = greeks.price('CE', S, K, T, r, v);
    const p = greeks.price('PE', S, K, T, r, v);
    near(c - p, S - K * Math.exp(-r * T), 1e-6, `parity at K=${K}`);
  }
});

test('produces the reference greeks in desk units', () => {
  const g = greeks.greeks('CE', 100, 100, 1, 0.05, 0.2);
  near(g.delta, 0.6368, 1e-4, 'delta');
  near(g.gamma, 0.018762, 1e-6, 'gamma');
  // Vega is per VOL POINT and theta is per CALENDAR DAY. The raw formulas give
  // per-unit-sigma and per-year; publishing those unscaled is the classic bug
  // and would show a vega a hundred times too large.
  near(g.vega, 0.3752, 1e-4, 'vega per 1% vol');
  near(g.theta, -6.414 / 365, 1e-5, 'theta per day');
  near(g.rho, 0.5323, 1e-4, 'rho per 1% rate');

  const p = greeks.greeks('PE', 100, 100, 1, 0.05, 0.2);
  near(p.delta, -0.3632, 1e-4, 'put delta');
  // Gamma and vega do not depend on the option type.
  near(p.gamma, g.gamma, 1e-12, 'put gamma equals call gamma');
  near(p.vega, g.vega, 1e-12, 'put vega equals call vega');
  assert.ok(p.rho < 0, 'put rho is negative');
});

test('recovers the volatility it priced with', () => {
  for (const sigma of [0.05, 0.12, 0.2, 0.55, 1.4]) {
    for (const type of ['CE', 'PE']) {
      const price = greeks.price(type, 24800, 25000, 0.02, 0.065, sigma);
      const solved = greeks.impliedVol(type, price, 24800, 25000, 0.02, 0.065);
      near(solved, sigma, 1e-4, `${type} iv at sigma ${sigma}`);
    }
  }
});

test('solves a deep in-the-money European put below its intrinsic value', () => {
  // A European put cannot be exercised early, so it legitimately trades under
  // K − S by the interest on the strike. Using intrinsic as the search floor
  // rejected exactly these strikes and returned null for every greek on them.
  const S = 24800; const K = 25000; const T = 0.02; const r = 0.065;
  const price = greeks.price('PE', S, K, T, r, 0.05);
  assert.ok(price < K - S, 'the reference price really is below intrinsic');
  const solved = greeks.impliedVol('PE', price, S, K, T, r);
  assert.ok(solved !== null, 'a priceable put must have a solvable volatility');
  assert.ok(Math.abs(solved - 0.05) < 1e-4);
});

test('refuses a price the model cannot reach at any volatility', () => {
  // Below intrinsic: no volatility prices a 24000 call at ₹10 when spot is
  // 25000. Returning a boundary value here would print a number a trader could
  // act on.
  assert.equal(greeks.impliedVol('CE', 10, 25000, 24000, 0.02, 0.065), null);
  // Above the underlying: a call cannot be worth more than the spot.
  assert.equal(greeks.impliedVol('CE', 26000, 25000, 24000, 0.02, 0.065), null);
  assert.equal(greeks.impliedVol('CE', 0, 25000, 25000, 0.02, 0.065), null);
});

test('measures time to 15:30 IST on the expiry date', () => {
  // 09:15 IST on expiry day: 6h15m of a 365-day year.
  const openIst = Date.UTC(2026, 6, 30, 9, 15) - 5.5 * 3600 * 1000;
  const T = greeks.yearsToExpiry('2026-07-30', openIst);
  near(T, (6.25 / 24) / 365, 1e-9, 'hours to expiry');

  // Past expiry the floor keeps the maths finite rather than dividing by zero.
  const after = Date.UTC(2026, 6, 31) - 5.5 * 3600 * 1000;
  assert.ok(greeks.yearsToExpiry('2026-07-30', after) > 0);
  assert.ok(greeks.yearsToExpiry('2026-07-30', after) < 1e-5);
});

test('splits a premium into intrinsic and time value', () => {
  const itm = greeks.analyse({
    type: 'CE', premium: 210, spot: 25100, strike: 25000,
    expiryDate: '2026-08-27', nowMs: Date.UTC(2026, 6, 30),
  });
  assert.equal(itm.intrinsic, 100);
  assert.equal(itm.timeValue, 110);

  const otm = greeks.analyse({
    type: 'CE', premium: 12, spot: 25100, strike: 25500,
    expiryDate: '2026-08-27', nowMs: Date.UTC(2026, 6, 30),
  });
  assert.equal(otm.intrinsic, 0);
  assert.equal(otm.timeValue, 12);
  assert.ok(otm.delta > 0 && otm.delta < 0.5, 'an OTM call has a delta under a half');
  assert.ok(otm.theta < 0, 'a long option decays');
});

test('reports nulls rather than zeros when it cannot model', () => {
  const dead = greeks.analyse({
    type: 'PE', premium: 0, spot: 25100, strike: 25000, expiryDate: '2026-08-27',
  });
  assert.equal(dead.iv, null);
  assert.equal(dead.delta, null);
  assert.equal(dead.theta, null);
  // A zero delta and a missing delta are different facts, and a chain that
  // printed 0.000 for an untraded strike would be stating the wrong one.
  assert.notEqual(dead.delta, 0);
});

test('recovers the index level from option premiums by put-call parity', () => {
  // This is the identity the terminal falls back on when the account cannot
  // quote the index itself: C − P = S − K·e^(−rT), so S = C − P + K·e^(−rT).
  // It is an identity rather than a model, so on prices generated by the model
  // it must recover the spot exactly at EVERY strike — including deep in and
  // out of the money, where the individual premiums are nothing alike.
  const spot = 24873;
  const T = greeks.yearsToExpiry('2026-08-06', Date.UTC(2026, 6, 30));
  const r = 0.065;
  for (const strike of [24000, 24500, 24850, 24900, 25500, 26000]) {
    const call = greeks.price('CE', spot, strike, T, r, 0.12);
    const put = greeks.price('PE', spot, strike, T, r, 0.12);
    const derived = call - put + strike * Math.exp(-r * T);
    near(derived, spot, 1e-6, `parity-derived spot at strike ${strike}`);
  }
});
