// §8.4, §9.2 and §16 — the parts that had to change for Kotak Neo.
//
// The single most important test in this file is `absent is null, never zero`.
// `Number(null) === 0`, and a chain where every strike reports zero open
// interest does not read as "the broker sent nothing" — it reads as "nobody
// holds these", which is a lie a filter will act on. §3.9 is a rule; this is its
// executable form.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./oseHelpers');
const chain = require('../src/ose/chain');
const strikes = require('../src/ose/strikes');
const exits = require('../src/ose/exits');
const C = require('../src/ose/constants');

const NOW = h.BASE_TS + 1000;
const opts = (over = {}) => ({ snapshotTs: h.BASE_TS, nowMs: NOW, ...over });

// A raw Kotak quote row as neoClient.readQuoteFull() emits it: RUPEES, and
// anything the broker did not send is null.
const raw = (over = {}) => ({
  ltp: 20, bid: 19.95, ask: 20.05, bidQty: 750, askQty: 750,
  oi: 600000, volume: 200000, ...over,
});

/* ========================================== §3.9 — absent is null, never zero */

test('CHAIN: a field the broker never sent is null, NOT zero', () => {
  const { quote, discard } = chain.normalise(
    h.instrumentRow(),
    raw({ oi: null, volume: null, bidQty: null, askQty: null }),
    opts({ liquidityMode: 'LENIENT' }));

  assert.equal(discard, null);
  assert.equal(quote.oi, null, 'a missing OI must be null — 0 would read as "nobody holds this"');
  assert.equal(quote.volume, null);
  assert.equal(quote.bidQty, null);
  assert.equal(quote.askQty, null);
  assert.notEqual(quote.oi, 0);
});

test('CHAIN: a one-sided book yields a null spread, not a narrow one', () => {
  const { quote } = chain.normalise(h.instrumentRow(), raw({ ask: null }),
    opts({ liquidityMode: 'LENIENT' }));
  assert.equal(quote.spreadP, null, 'one-sided is an UNKNOWN spread, not a tight one');
  assert.equal(quote.midP, null);
});

test('CHAIN: present-and-invalid is discarded in BOTH modes; absent is not', () => {
  // A quoted zero bid is a statement about the book — and it says this contract
  // cannot be got out of.
  for (const mode of ['STRICT', 'LENIENT']) {
    const bad = chain.normalise(h.instrumentRow(), raw({ bid: 0 }), opts({ liquidityMode: mode }));
    assert.equal(bad.quote, null, `${mode}: a quoted zero bid is a discard`);
    assert.equal(bad.discard, chain.DISCARD.BAD_BOOK);

    const crossed = chain.normalise(h.instrumentRow(), raw({ bid: 21, ask: 20 }),
      opts({ liquidityMode: mode }));
    assert.equal(crossed.discard, chain.DISCARD.CROSSED);
  }

  // Absent, however, is only fatal under STRICT.
  assert.equal(chain.normalise(h.instrumentRow(), raw({ bid: null, ask: null }),
    opts({ liquidityMode: 'STRICT' })).discard, chain.DISCARD.NO_BOOK);
  assert.ok(chain.normalise(h.instrumentRow(), raw({ bid: null, ask: null }),
    opts({ liquidityMode: 'LENIENT' })).quote);
});

test('CHAIN: an ltp-only entitlement discards the WHOLE chain under STRICT', () => {
  // §29.2 — this is the shipped default's honest behaviour on a Kotak retail
  // account, and it must be visible rather than look like a quiet market.
  const rows = [24400, 24450, 24500, 24550].map(strike => ({
    row: h.instrumentRow({ strike }),
    quote: { ltp: 20, bid: null, ask: null, bidQty: null, askQty: null, oi: null, volume: null },
  }));

  const strict = chain.validateSnapshot(rows, opts({ liquidityMode: 'STRICT' }));
  assert.equal(strict.quotes.length, 0);
  assert.equal(strict.corrupt, true);
  assert.equal(strict.dominantDiscard.reason, chain.DISCARD.NO_BOOK,
    'the engine must be able to say WHY — entitlement, not market');

  const lenient = chain.validateSnapshot(rows, opts({ liquidityMode: 'LENIENT' }));
  assert.equal(lenient.quotes.length, 4);
  assert.equal(lenient.corrupt, false);
});

test('CHAIN: the 40% discard threshold is a strict inequality', () => {
  const make = (n, good) => Array.from({ length: n }, (_, i) => ({
    row: h.instrumentRow({ strike: 24000 + i * 50 }),
    quote: i < good ? raw() : raw({ bid: 0 }),
  }));
  // 6 of 10 good -> 40% discarded, which is NOT over the limit.
  assert.equal(chain.validateSnapshot(make(10, 6), opts()).corrupt, false);
  // 5 of 10 good -> 50%, over.
  assert.equal(chain.validateSnapshot(make(10, 5), opts()).corrupt, true);
});

test('CHAIN: a stale snapshot is rejected before anything else is considered', () => {
  const stale = chain.normalise(h.instrumentRow(), raw(),
    opts({ nowMs: h.BASE_TS + C.CHAIN_MAX_AGE_MS + 1 }));
  assert.equal(stale.discard, chain.DISCARD.STALE);
});

test('CHAIN: a strike off the 50-point grid is discarded', () => {
  assert.equal(
    chain.normalise(h.instrumentRow({ strike: 24525 }), raw(), opts()).discard,
    chain.DISCARD.BAD_STRIKE);
});

test('CHAIN: selectExpiry takes the nearest at-or-after today and flags expiry day', () => {
  const list = ['2026-07-23', '2026-07-30', '2026-08-06'];
  assert.deepEqual(chain.selectExpiry(list, '2026-07-28'),
    { expiry: '2026-07-30', isExpiryDay: false });
  assert.deepEqual(chain.selectExpiry(list, '2026-07-30'),
    { expiry: '2026-07-30', isExpiryDay: true });
  assert.equal(chain.selectExpiry(list, '2026-09-01').expiry, null);
});

/* ================================================== §9 — the strike selector */

test('STRIKES: the premium band is inclusive at both ends', () => {
  const quotes = [
    h.quote({ strike: 24400, ltpP: 1500 }),   // exactly premiumMin
    h.quote({ strike: 24450, ltpP: 2500 }),   // exactly premiumMax
    h.quote({ strike: 24500, ltpP: 1499 }),   // just under
    h.quote({ strike: 24550, ltpP: 2501 }),   // just over
  ];
  const picked = strikes.select(quotes, 'CE', h.gate());
  const kept = picked.ranked.map(r => r.strike);
  assert.deepEqual(kept.sort(), [24400, 24450]);
});

test('STRIKES PROPERTY: the winner is identical across 200 input shuffles', () => {
  // §25.2 — order-independence. The comparator must be TOTAL, or the winner
  // depends on how the broker happened to order its rows.
  const quotes = [
    h.quote({ strike: 24400, oi: 600000, volume: 200000 }),
    h.quote({ strike: 24450, oi: 600000, volume: 200000 }),   // a deliberate exact tie
    h.quote({ strike: 24500, oi: 900000, volume: 300000 }),
    h.quote({ strike: 24550, oi: 700000, volume: 250000 }),
  ];
  const expected = strikes.select(quotes, 'CE', h.gate()).chosen.symbol;

  for (let i = 0; i < 200; i += 1) {
    const shuffled = [...quotes];
    for (let j = shuffled.length - 1; j > 0; j -= 1) {
      const k = (i * 7 + j * 13) % (j + 1);          // deterministic, not Math.random
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    assert.equal(strikes.select(shuffled, 'CE', h.gate()).chosen.symbol, expected);
  }
});

test('STRIKES PROPERTY: order-independence holds when every optional field is null', () => {
  // The ltp-only case, where every score component is unavailable and the
  // comparator falls all the way through to strike and symbol.
  const bare = [24400, 24450, 24500].map(strike => h.quote({
    strike, oi: null, volume: null, bidQty: null, askQty: null,
    bidP: null, askP: null, spreadP: null, midP: null,
  }));
  const gate = h.gate({ liquidityMode: 'LENIENT' });
  const expected = strikes.select(bare, 'CE', gate).chosen.symbol;
  assert.equal(strikes.select([...bare].reverse(), 'CE', gate).chosen.symbol, expected);
});

test('STRIKES: LENIENT records which filters could not be run', () => {
  const bare = [h.quote({ oi: null, volume: null, bidQty: null, askQty: null, spreadP: null })];
  const picked = strikes.select(bare, 'CE', h.gate({ liquidityMode: 'LENIENT' }));
  assert.ok(picked.chosen, 'LENIENT selects on the checks it could make');
  assert.ok((picked.unavailable || []).length > 0,
    'and it must SAY which ones it skipped — an unrecorded skip is an unrecorded risk');
});

// Selection driven by the premium band alone — the only field this Kotak
// entitlement sends, and what an operator setting a band is actually asking for.
const bare = (strike, type, ltpP) => h.quote({
  strike, optionType: type, symbol: `N${strike}${type}`, token: `t${strike}${type}`, ltpP,
  oi: null, volume: null, bidQty: null, askQty: null,
  bidP: null, askP: null, spreadP: null, midP: null,
});

test('STRIKES: an IN THE MONEY strike is never sold', () => {
  // A short ITM option carries intrinsic value: high delta, moving nearly
  // one-for-one with the index, and the "premium" collected is largely not time
  // value at all. It is a different trade from the one this engine makes.
  const spot = 24383;                               // -> at-the-money strike 24400
  const gate = h.gate({ liquidityMode: 'LENIENT', premiumMinP: 5000, premiumMaxP: 12000,
    spotP: spot * 100 });

  const ce = [bare(24300, 'CE', 11000), bare(24400, 'CE', 7750), bare(24500, 'CE', 5200)];
  const pe = [bare(24300, 'PE', 5200), bare(24400, 'PE', 7200), bare(24500, 'PE', 11000)];

  const ceOut = strikes.select(ce, 'CE', gate);
  assert.ok(ceOut.ranked.every(c => c.strike >= 24400), 'a call below the money is unsellable');
  assert.ok(ceOut.rejected.some(r => r.strike === 24300 && /in the money/.test(r.reason)));

  const peOut = strikes.select(pe, 'PE', gate);
  assert.ok(peOut.ranked.every(c => c.strike <= 24400), 'a put above the money is unsellable');
  assert.ok(peOut.rejected.some(r => r.strike === 24500 && /in the money/.test(r.reason)));
});

test('STRIKES: the AT the money strike is sellable on both sides', () => {
  // Neither in nor out. Refusing it would push every trade one strike further
  // out for no reason.
  const gate = h.gate({ liquidityMode: 'LENIENT', premiumMinP: 5000, premiumMaxP: 12000,
    spotP: 2438300 });
  for (const type of ['CE', 'PE']) {
    const out = strikes.select([bare(24400, type, 7500)], type, gate);
    assert.ok(out.chosen, `the ATM ${type} must be selectable`);
    assert.equal(out.chosen.strike, 24400);
  }
});

test('STRIKES: among ATM/OTM candidates the HIGHEST premium wins', () => {
  // Most credit. Safe to maximise only because everything in the set is already
  // ATM or OTM — without that filter the richest call is always the deepest ITM.
  const gate = h.gate({ liquidityMode: 'LENIENT', premiumMinP: 5000, premiumMaxP: 12000,
    spotP: 2438300 });
  const ce = [bare(24400, 'CE', 7750), bare(24450, 'CE', 6000), bare(24500, 'CE', 5200)];
  const pe = [bare(24400, 'PE', 7200), bare(24350, 'PE', 6000), bare(24300, 'PE', 5200)];

  assert.equal(strikes.select(ce, 'CE', gate).chosen.ltpP, 7750);
  assert.equal(strikes.select(pe, 'PE', gate).chosen.ltpP, 7200);
});

test('STRIKES: with no spot supplied nothing is rejected for moneyness', () => {
  // The caller omitting a parameter must not look like a market with nothing in
  // it. Every strike stays selectable and the premium band still applies.
  const gate = h.gate({ liquidityMode: 'LENIENT', premiumMinP: 5000, premiumMaxP: 12000 });
  const out = strikes.select([bare(24300, 'CE', 11000), bare(24500, 'CE', 5200)], 'CE', gate);
  assert.equal(out.ranked.length, 2);
  assert.equal(out.chosen.ltpP, 11000, 'and the highest premium still wins');
});

test('STRIKES: premium ranking never overrides a score that CAN discriminate', () => {
  // On an entitlement that sends OI and volume, §9.4 is unchanged — the premium
  // step sits below score, oi, volume and spread.
  const gate = h.gate({ premiumMinP: 5000, premiumMaxP: 12000, spotP: 2438300 });
  const rich = [
    h.quote({ strike: 24400, optionType: 'CE', symbol: 'RICHER', ltpP: 7750, oi: 100000, volume: 50000 }),
    h.quote({ strike: 24500, optionType: 'CE', symbol: 'DEEPER', ltpP: 5200, oi: 900000, volume: 400000 }),
  ];
  assert.equal(strikes.select(rich, 'CE', gate).chosen.symbol, 'DEEPER',
    'far more open interest and volume must still win on score');
});

test('STRIKES: a wrong-type quote is never selected', () => {
  const quotes = [h.quote({ optionType: 'PE', strike: 24400 })];
  assert.equal(strikes.select(quotes, 'CE', h.gate()).chosen, null);
});

/* ======================================================= §13.4 — exit order */

test('EXITS: a candle spanning both stop and target books the LOSS', () => {
  // §13.4 — stops are evaluated before targets so the conservative outcome wins.
  const trade = h.trade();                                  // entry 2000, stop 2200, target 1900
  const spanning = h.optionBar({ lowP: 1850, highP: 2250, closeP: 1880 });
  const res = exits.onCandle({
    trade, optionCandle: spanning, indexCandle: h.indexBar(),
    trend: 'BEARISH', quote: h.quote(), cfg: h.rules(),
  });
  assert.equal(res.exit.reason, exits.EXIT_REASONS.STOP_HIT);
  assert.equal(res.extend, null, 'the target must not also advance on the losing candle');
});

test('EXITS: the premium floor outranks everything on the candle clock', () => {
  const trade = h.trade();
  const res = exits.onCandle({
    trade, optionCandle: h.optionBar({ closeP: 90, highP: 95, lowP: 85 }),
    indexCandle: h.indexBar(), trend: 'BEARISH', quote: h.quote(), cfg: h.rules(),
  });
  assert.equal(res.exit.reason, exits.EXIT_REASONS.PREMIUM_FLOOR);
});

test('EXITS: premium safety firing without the stop is flagged as a sole trigger', () => {
  // §16.2.4 — it should be impossible in production, so when it happens the
  // caller must be able to raise an alert rather than log another exit.
  const trade = h.trade({ stopPriceP: 9999 });             // a stop that cannot fire
  const res = exits.onCandle({
    trade, optionCandle: h.optionBar({ closeP: 2200, highP: 2210, lowP: 2190 }),
    indexCandle: h.indexBar(), trend: 'BEARISH', quote: h.quote(), cfg: h.rules(),
  });
  assert.equal(res.exit.reason, exits.EXIT_REASONS.PREMIUM_SAFETY);
  assert.equal(res.exit.soleTrigger, true);
});

test('EXITS: max hold fires at the boundary, not one candle late', () => {
  const trade = h.trade({ candlesHeld: C.MAX_HOLD_CANDLES });
  const res = exits.onCandle({
    trade, optionCandle: h.optionBar(), indexCandle: h.indexBar(),
    trend: 'BEARISH', quote: h.quote(), cfg: h.rules(),
  });
  assert.equal(res.exit.reason, exits.EXIT_REASONS.MAX_HOLD);
});

test('EXITS: the option clock evaluates stops but NOT the index-based filters', () => {
  // §13.1 — an option candle says nothing about the index, so a trend break
  // cannot be concluded from one.
  const trade = h.trade();
  const res = exits.onOptionCandle({
    trade, optionCandle: h.optionBar({ highP: 2250, closeP: 2100 }), cfg: h.rules(),
  });
  assert.equal(res.exit.reason, exits.EXIT_REASONS.STOP_HIT);

  const quiet = exits.onOptionCandle({
    trade, optionCandle: h.optionBar({ closeP: 1950, highP: 1960 }), cfg: h.rules(),
  });
  assert.equal(quiet.exit, null, 'a quiet option bar says nothing about the index thesis');
});

test('EXITS: the §16.4 stop guard fires on a fresh live sample and is silent on a stale one', () => {
  const trade = h.trade();                                  // stop 2200
  const base = { trade, stopGuardEnabled: true, maxSampleAgeMs: 2000 };

  assert.equal(exits.onTimer({ ...base, livePremiumP: 2250, sampleAgeMs: 500 }).reason,
    exits.EXIT_REASONS.STOP_GUARD);
  assert.equal(exits.onTimer({ ...base, livePremiumP: 2250, sampleAgeMs: 9000 }), null,
    'a stale sample expresses no opinion — acting on it exits for a reason no longer true');
  assert.equal(exits.onTimer({ ...base, livePremiumP: 2150, sampleAgeMs: 500 }), null);
  assert.equal(
    exits.onTimer({ ...base, livePremiumP: 2250, sampleAgeMs: 500, stopGuardEnabled: false }), null);
});

test('EXITS: the kill switch outranks the stop guard and every market condition', () => {
  const trade = h.trade();
  const hit = exits.onTimer({
    trade, stopGuardEnabled: true, maxSampleAgeMs: 2000,
    livePremiumP: 2250, sampleAgeMs: 100,
    killSwitch: true, optionGapCandles: 5, pastSquareOff: true,
  });
  assert.equal(hit.reason, exits.EXIT_REASONS.KILL_SWITCH,
    'nothing the engine believes about the market may outrank a human deciding to be flat');
});

test('EXITS: every reason has a stage and a priority — none can reach the book unmapped', () => {
  for (const reason of Object.values(exits.EXIT_REASONS)) {
    assert.ok(exits.stageFor(reason), `${reason} has no orders.stage mapping`);
    assert.equal(typeof exits.PRIORITY[reason], 'number', `${reason} has no priority`);
  }
});
