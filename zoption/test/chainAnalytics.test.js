// Option-chain analytics.
//
// The theme of this file is the difference between "zero" and "unknown". Kotak's
// quote endpoint may refuse every filter richer than `ltp`, in which case there
// is no open interest at all — and a max-pain strike, a PCR or an OI build-up
// computed from an absent OI column is not a conservative estimate, it is a
// fabricated number on a trading screen. Half the tests below exist to prove
// those functions say null instead.

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const a = require('../src/market/chainAnalytics');

// A chain shaped like the feed's: rows of { strike, call, put }.
function chain(spec) {
  return spec.map(([strike, callOi, putOi, extra]) => ({
    strike,
    call: Object.assign({ oi: callOi, volume: null }, (extra && extra.call) || {}),
    put: Object.assign({ oi: putOi, volume: null }, (extra && extra.put) || {}),
  }));
}

test('finds the strike that costs the writers least', () => {
  // All the call OI sits at 25000 and all the put OI at 24000. Settling
  // anywhere between them pays out on one side or the other; the minimum is
  // wherever the weighted intrinsic total bottoms out.
  const rows = chain([
    [23800, 0, 0],
    [24000, 0, 1000],
    [24200, 0, 0],
    [25000, 1000, 0],
  ]);
  const pain = a.maxPain(rows);
  assert.ok(pain !== null);
  assert.ok(pain.strike >= 24000 && pain.strike <= 25000);

  // With every strike's open interest equal, max pain is the middle of the
  // ladder — the classic sanity check.
  const flat = chain([[24000, 100, 100], [24100, 100, 100], [24200, 100, 100]]);
  assert.equal(a.maxPain(flat).strike, 24100);
});

test('refuses to invent a max pain when there is no open interest', () => {
  const rows = chain([[24000, null, null], [24100, null, null], [24200, null, null]]);
  assert.equal(a.maxPain(rows), null,
    'without OI every candidate scores zero and the "winner" is just the lowest strike');
});

test('computes both PCRs and says which are real', () => {
  const rows = chain([
    [24000, 100, 300, { call: { volume: 10 }, put: { volume: 40 } }],
    [24100, 100, 100, { call: { volume: 10 }, put: { volume: 10 } }],
  ]);
  const p = a.pcr(rows);
  assert.equal(p.callOi, 200);
  assert.equal(p.putOi, 400);
  assert.equal(p.oi, 2);
  assert.equal(p.volume, 2.5);

  const blind = a.pcr(chain([[24000, null, null]]));
  assert.equal(blind.oi, null);
  assert.equal(blind.callOi, null);
});

test('classifies the four OI build-up quadrants', () => {
  const t = { priceThreshold: 0.05, oiThreshold: 100 };
  assert.equal(a.buildup(Object.assign({ priceChange: 5, oiChange: 5000 }, t)), 'LONG_BUILDUP');
  assert.equal(a.buildup(Object.assign({ priceChange: -5, oiChange: 5000 }, t)), 'SHORT_BUILDUP');
  assert.equal(a.buildup(Object.assign({ priceChange: 5, oiChange: -5000 }, t)), 'SHORT_COVERING');
  assert.equal(a.buildup(Object.assign({ priceChange: -5, oiChange: -5000 }, t)), 'LONG_UNWINDING');
});

test('calls a rounding error flat rather than telling a story about it', () => {
  const t = { priceThreshold: 0.05, oiThreshold: 100 };
  assert.equal(a.buildup(Object.assign({ priceChange: 0.01, oiChange: 12 }, t)), 'FLAT');
  // A big premium move on no OI change is not a build-up of anything.
  assert.equal(a.buildup(Object.assign({ priceChange: 9, oiChange: 12 }, t)), 'FLAT');
  assert.equal(a.buildup({ priceChange: null, oiChange: 5000 }), null);
  assert.equal(a.buildup({ priceChange: 5, oiChange: null }), null);
});

test('reads writing bias from whichever side added more open interest', () => {
  assert.equal(a.writingBias({ call: { oiChange: 5000 }, put: { oiChange: 100 } }), 'CALL_WRITING');
  assert.equal(a.writingBias({ call: { oiChange: 100 }, put: { oiChange: 5000 } }), 'PUT_WRITING');
  // Both unwinding is not writing at all.
  assert.equal(a.writingBias({ call: { oiChange: -5000 }, put: { oiChange: -100 } }), null);
  assert.equal(a.writingBias({ call: {}, put: {} }), null);
});

test('marks moneyness from the strike, the spot and the side', () => {
  assert.equal(a.moneyness(24000, 24010, 'CE', 50), 'ATM');
  assert.equal(a.moneyness(23900, 24200, 'CE', 50), 'ITM');
  assert.equal(a.moneyness(24500, 24200, 'CE', 50), 'OTM');
  assert.equal(a.moneyness(24500, 24200, 'PE', 50), 'ITM');
  assert.equal(a.moneyness(23900, 24200, 'PE', 50), 'OTM');
  assert.equal(a.moneyness(24000, null, 'CE', 50), null);
});

test('picks the most decayed strike as the highest theta, not the least', () => {
  const rows = [
    { strike: 24000, call: { theta: -1.2, oi: 10 }, put: { theta: -0.4, oi: 10 } },
    { strike: 24100, call: { theta: -8.5, oi: 10 }, put: { theta: -0.9, oi: 10 } },
  ];
  const ex = a.extremes(rows);
  // Theta is negative for a long option, so "highest theta" means the most
  // negative. Comparing with > would highlight the strike decaying LEAST, which
  // is the opposite of what an option seller is looking for.
  assert.equal(ex.callTheta, 24100);
  assert.equal(ex.putTheta, 24100);
});

test('reports which summary numbers came from the broker', () => {
  const blind = a.chainSummary(chain([[24000, null, null], [24100, null, null]]),
    // Deliberately not 24050: that is exactly between the two strikes and which
    // one wins a tie is not a rule this module claims to have.
    { spot: 24060, expiry: '2026-08-27', lotSize: 75 });
  assert.equal(blind.pcr, null);
  assert.equal(blind.maxPain, null);
  assert.equal(blind.totalCallOi, null);
  assert.equal(blind.netOi, null);
  assert.equal(blind.available.oi, false);
  assert.equal(blind.available.maxPain, false);
  // The ATM is derived from the spot alone, so it survives a missing OI feed.
  assert.equal(blind.atmStrike, 24100);

  const full = a.chainSummary(chain([[24000, 100, 500], [24100, 900, 100]]),
    { spot: 24050, vix: 12.4 });
  assert.equal(full.available.oi, true);
  assert.equal(full.totalCallOi, 1000);
  assert.equal(full.totalPutOi, 600);
  assert.equal(full.netOi, -400);
  assert.equal(full.available.vix, true);
  assert.equal(full.extremes.callOi, 24100);
  assert.equal(full.extremes.putOi, 24000);
});
