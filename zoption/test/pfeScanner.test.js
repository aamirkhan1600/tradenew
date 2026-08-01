// Module 2 — premium filter, liquidity filter and the ranking score.
//
// The theme running through this file is the three-outcome rule: PASS, FAIL and
// UNKNOWN are different, and a field the broker never sent must never be
// coerced to zero.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./pfeHelpers');
const scanner = require('../src/pfe/scanner');
const settings = require('../src/pfe/settings');

const cfg = settings.derive(settings.DEFAULTS)._scanner;

const measured = (row, quote) => scanner.measure(row, quote);

test('a premium inside the band and a healthy book passes every gate', () => {
  const g = scanner.gate(measured(h.contract(), h.quote()), cfg);
  assert.equal(g.ok, true);
  assert.deepEqual(g.unavailable, []);
});

test('a premium outside the band is rejected with the number in the reason', () => {
  const g = scanner.gate(measured(h.contract(), h.quote({ ltp: 8 })), cfg);
  assert.equal(g.ok, false);
  assert.match(g.reason, /8\.00 is outside/);
});

test('a premium above the band is rejected too', () => {
  const g = scanner.gate(measured(h.contract(), h.quote({ ltp: 45 })), cfg);
  assert.equal(g.ok, false);
});

test('a contract with no last traded price is frozen, whatever the mode', () => {
  for (const liquidityMode of ['LENIENT', 'STRICT']) {
    const g = scanner.gate(measured(h.contract(), h.quote({ ltp: null })),
      { ...cfg, liquidityMode });
    assert.equal(g.ok, false);
    assert.match(g.reason, /no last traded price/);
  }
});

test('open interest below the floor fails', () => {
  const g = scanner.gate(measured(h.contract(), h.quote({ oi: 500 })), cfg);
  assert.equal(g.ok, false);
  assert.match(g.reason, /open interest/);
});

test('a spread wider than the maximum fails', () => {
  const g = scanner.gate(measured(h.contract(), h.quote({ bid: 19.5, ask: 20.5 })), cfg);
  assert.equal(g.ok, false);
  assert.match(g.reason, /spread/);
});

test('a one-sided book is an UNKNOWN spread, not a narrow one', () => {
  const m = measured(h.contract(), h.quote({ ask: null }));
  assert.equal(m.spreadP, null);
});

test('LENIENT skips a field the broker did not send, and records it', () => {
  const q = h.quote({ oi: null, volume: null, bidQty: null, askQty: null, bid: null, ask: null });
  const g = scanner.gate(measured(h.contract(), q), { ...cfg, liquidityMode: 'LENIENT' });
  assert.equal(g.ok, true);
  assert.deepEqual(g.unavailable.sort(),
    ['askQty', 'bidQty', 'openInterest', 'spread', 'volume'].sort());
});

test('STRICT treats a missing field as a failure and says the account cannot pass', () => {
  const q = h.quote({ oi: null });
  const g = scanner.gate(measured(h.contract(), q), { ...cfg, liquidityMode: 'STRICT' });
  assert.equal(g.ok, false);
  assert.match(g.reason, /STRICT/);
  assert.match(g.reason, /openInterest/);
});

test('a missing open interest is never read as zero open interest', () => {
  const m = measured(h.contract(), h.quote({ oi: null, volume: null }));
  assert.equal(m.oi, null);
  assert.equal(m.volume, null);
  // ...and a genuine zero survives as a zero.
  const z = measured(h.contract(), h.quote({ oi: 0 }));
  assert.equal(z.oi, 0);
});

/* ------------------------------------------------------------------- rank -- */

test('a premium inside the ideal band scores full marks', () => {
  assert.equal(scanner.premiumScore(2000, cfg), 1);      // ₹20, inside 15–25
  assert.equal(scanner.premiumScore(1500, cfg), 1);
  assert.equal(scanner.premiumScore(2500, cfg), 1);
});

test('outside the ideal band the premium score falls off to the edge of the accepted one', () => {
  assert.equal(scanner.premiumScore(1200, cfg), 0);      // the floor of the band
  assert.equal(scanner.premiumScore(3000, cfg), 0);      // the ceiling
  assert.ok(scanner.premiumScore(1350, cfg) > 0 && scanner.premiumScore(1350, cfg) < 1);
});

test('the spread score is 1 at zero and 0 at the configured maximum', () => {
  assert.equal(scanner.spreadScore(0, cfg), 1);
  assert.equal(scanner.spreadScore(cfg.maxSpreadP, cfg), 0);
  assert.equal(scanner.spreadScore(null, cfg), null);
});

test('the best contract in the scan wins', () => {
  const result = scanner.select([
    { row: h.contract({ token: 'a', strike: 25000 }), quote: h.quote({ ltp: 20, oi: 500000 }) },
    { row: h.contract({ token: 'b', strike: 24900 }), quote: h.quote({ ltp: 13, oi: 120000 }) },
  ], cfg);
  assert.equal(result.chosen.token, 'a');
  assert.equal(result.ranked.length, 2);
  assert.ok(result.ranked[0].score > result.ranked[1].score);
});

test('a term nobody has data for is dropped and the score rescaled', () => {
  const bare = { ltp: 20, bid: null, ask: null, bidQty: null, askQty: null, oi: null, volume: null };
  const result = scanner.select([
    { row: h.contract({ token: 'a' }), quote: bare },
  ], cfg);
  assert.equal(result.chosen.componentsUsed.join(','), 'premium',
    'with only a price, the strike is chosen on premium alone');
  assert.equal(result.chosen.score, 100, 'and a perfect premium still scores 100, not 20');
  assert.deepEqual(result.unavailable.sort(),
    ['askQty', 'bidQty', 'openInterest', 'spread', 'volume'].sort());
});

test('a tie breaks toward the further out-of-the-money strike', () => {
  const q = h.quote({ ltp: 20 });                      // identical on every term
  const pe = scanner.select([
    { row: h.contract({ token: 'near', strike: 25000, option_type: 'PE' }), quote: q },
    { row: h.contract({ token: 'far', strike: 24800, option_type: 'PE' }), quote: q },
  ], cfg);
  assert.equal(pe.chosen.token, 'far', 'a lower strike is further OTM for a put');

  const ce = scanner.select([
    { row: h.contract({ token: 'near', strike: 25000, option_type: 'CE' }), quote: q },
    { row: h.contract({ token: 'far', strike: 25200, option_type: 'CE' }), quote: q },
  ], cfg);
  assert.equal(ce.chosen.token, 'far', 'a higher strike is further OTM for a call');
});

test('nothing passing is reported as a reason, not as a nearest guess', () => {
  const result = scanner.select([
    { row: h.contract({ token: 'a' }), quote: h.quote({ ltp: 5 }) },
    { row: h.contract({ token: 'b' }), quote: h.quote({ ltp: 60 }) },
  ], cfg);
  assert.equal(result.chosen, null);
  assert.equal(result.rejected.length, 2);
  assert.match(result.reason, /no strike cleared the filters/);
});

test('an empty scan says so rather than throwing', () => {
  const result = scanner.select([], cfg);
  assert.equal(result.chosen, null);
  assert.match(result.reason, /no contracts were quoted/);
});

test('a zero weight removes a term entirely', () => {
  const weights = { ...cfg.weights, premium: 0 };
  const result = scanner.select([
    { row: h.contract({ token: 'a' }), quote: h.quote() },
  ], { ...cfg, weights });
  assert.equal(result.chosen.componentsUsed.includes('premium'), false);
});
