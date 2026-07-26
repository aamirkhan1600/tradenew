// Replays the worked examples from doc/Option Selling Auto Trading Platform.md.
// If these fail, the implementation has drifted from the specification.

const test = require('node:test');
const assert = require('node:assert/strict');

const scanner = require('../src/strategy/scanner');
const { defaults } = require('../src/strategy/config');

// --- the doc's "Premium Scanner" table -------------------------------------
//   38100 -> 72 ignore | 38200 -> 54 ignore | 38300 -> 44 accept
//   38350 -> 41 accept | 38400 -> 38 accept | 38500 -> 28 reject
// plus 38450 -> 10, the hedge the doc picks.
const PRICES = {
  38100: 72, 38200: 54, 38300: 44, 38350: 41,
  38400: 38, 38450: 10, 38500: 28, 38550: 8, 38600: 6,
};
const STRIKES = [38100, 38200, 38300, 38350, 38400, 38450, 38500, 38550, 38600];
const SPOT = 38050;

function buildChain({ tradable = () => true } = {}) {
  return STRIKES.map((strike, i) => ({
    strike,
    ce: {
      zToken: String(9000 + i), zSymbol: `BNF${strike}CE`,
      kToken: `k${9000 + i}`, kSymbol: `BANKNIFTY${strike}CE`,
      kSegment: 'nse_fo', lotSize: 15, tickSize: 0.05, tradable: tradable(strike),
    },
  }));
}

function priceOfFor(chain, { ageMs = 100, missing = [] } = {}) {
  return (zToken) => {
    const row = chain.find(r => r.ce.zToken === String(zToken));
    if (!row || missing.includes(row.strike)) return null;
    return { ltp: PRICES[row.strike], ageMs };
  };
}

const config = {
  ...defaults(),
  optionType: 'CE', premiumMin: 35, premiumMax: 45, armPrice: 40,
  hedgeMode: 'PREMIUM', hedgePremium: 10,
};

test('strike interval is inferred from the chain', () => {
  assert.equal(scanner.strikeInterval(buildChain()), 50);
});

test('selects 38350 CE @ 41 — the strike nearest the arm price', () => {
  const chain = buildChain();
  const res = scanner.selectStrike({ chain, priceOf: priceOfFor(chain), spot: SPOT, config });

  assert.equal(res.selected.strike, 38350);
  assert.equal(res.selected.premium, 41);
  assert.equal(res.selected.optionType, 'CE');

  // Exactly the doc's accepted set, no more and no less.
  assert.deepEqual(res.candidates.map(c => c.strike).sort(), [38300, 38350, 38400]);
});

test('rejects premiums outside the configured range', () => {
  const chain = buildChain();
  const res = scanner.selectStrike({ chain, priceOf: priceOfFor(chain), spot: SPOT, config });
  const outOfRange = res.rejected.filter(r => /outside/.test(r.reason)).map(r => r.strike);
  for (const strike of [38100, 38200, 38450, 38500]) {
    assert.ok(outOfRange.includes(strike), `${strike} should be rejected on premium`);
  }
});

test('never selects a strike with no Kotak contract, however good the premium', () => {
  const chain = buildChain({ tradable: (s) => s !== 38350 });
  const res = scanner.selectStrike({ chain, priceOf: priceOfFor(chain), spot: SPOT, config });
  assert.notEqual(res.selected.strike, 38350);
  assert.ok(res.rejected.some(r => r.strike === 38350 && /Kotak/.test(r.reason)));
});

test('never selects a strike whose quote is stale', () => {
  const chain = buildChain();
  const res = scanner.selectStrike({
    chain, priceOf: priceOfFor(chain, { ageMs: 60000 }), spot: SPOT, config,
  });
  assert.equal(res.selected, null);
  assert.ok(res.rejected.every(r => /stale|Kotak/.test(r.reason) || /outside/.test(r.reason)));
});

test('selects ITM strikes never — calls must be above spot', () => {
  const chain = buildChain();
  const res = scanner.selectStrike({
    chain, priceOf: priceOfFor(chain), spot: 38380, config,
  });
  assert.ok(res.selected == null || res.selected.strike > 38380);
});

test('hedge by premium picks 38450 @ 10, as the doc does', () => {
  const chain = buildChain();
  const priceOf = priceOfFor(chain);
  const short = scanner.selectStrike({ chain, priceOf, spot: SPOT, config }).selected;
  const res = scanner.selectHedge({ chain, priceOf, config, short });

  assert.equal(res.hedge.strike, 38450);
  assert.equal(res.hedge.premium, 10);
});

test('hedge by strike distance lands the configured number of intervals out', () => {
  const chain = buildChain();
  const priceOf = priceOfFor(chain);
  const cfg = { ...config, hedgeMode: 'STRIKE', hedgeDistance: 2 };
  const short = scanner.selectStrike({ chain, priceOf, spot: SPOT, config: cfg }).selected;
  const res = scanner.selectHedge({ chain, priceOf, config: cfg, short });

  // 38350 + 2 x 50 = 38450
  assert.equal(res.hedge.strike, 38450);
});

test('a missing hedge strike falls back further out, never nearer', () => {
  const chain = buildChain();
  const cfg = { ...config, hedgeMode: 'STRIKE', hedgeDistance: 2 };
  const priceOf = priceOfFor(chain, { missing: [38450] });
  const short = scanner.selectStrike({ chain, priceOf, spot: SPOT, config: cfg }).selected;
  const res = scanner.selectHedge({ chain, priceOf, config: cfg, short });

  assert.ok(res.hedge.strike > 38450, 'fallback must be further OTM than the target');
});

test('the hedge is never as expensive as the short', () => {
  const chain = buildChain();
  const priceOf = priceOfFor(chain);
  const short = { optionType: 'CE', strike: 38350, premium: 41 };
  const res = scanner.selectHedge({ chain, priceOf, config, short });
  assert.ok(res.hedge.premium < short.premium);
});

test('findCandidate produces both legs in one call', () => {
  const chain = buildChain();
  const res = scanner.findCandidate({ chain, priceOf: priceOfFor(chain), spot: SPOT, config });
  assert.equal(res.ok, true);
  assert.equal(res.short.strike, 38350);
  assert.equal(res.hedge.strike, 38450);
});

test('findCandidate explains itself when no strike qualifies', () => {
  const chain = buildChain();
  const res = scanner.findCandidate({
    chain, priceOf: priceOfFor(chain), spot: SPOT,
    config: { ...config, premiumMin: 200, premiumMax: 300, armPrice: 250 },
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /premium range/);
});
