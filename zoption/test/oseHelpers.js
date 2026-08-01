// Fixtures for the Option Selling Engine's unit suite.
//
// Kept apart from test/pfeHelpers.js for the reason that file gives about
// test/helpers.js: the two engines' trade objects have different shapes, and one
// shared factory would mean every change to one rippling through the other's
// tests.
//
// Prices are integer paise throughout, because the engine is (§2). An index at
// 24,500.00 is 2450000; an option premium of ₹20.00 is 2000.

require('./helpers');                        // env + charge schedule, before src/config

const time = require('../src/core/time');
const { newTrade } = require('../src/ose/machine');

function ist(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!m) throw new Error(`bad IST timestamp "${text}"`);
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)) - time.IST_OFFSET_MS;
}

const BASE_TS = ist('2026-07-28 10:15:00');

// A completed, tradable 5s index bar.
function indexBar(over = {}) {
  const start = over.bucketStart ?? BASE_TS;
  return {
    token: 'Nifty 50',
    timeframe: '5s',
    bucketStart: start,
    bucketEnd: start + 5000,
    openP: 2450000, highP: 2450500, lowP: 2449800, closeP: 2450400,
    tickCount: 5,
    synthetic: false,
    lowConfidence: false,
    tradable: true,
    ...over,
  };
}

// A completed, tradable 5s option bar. ₹20.00 premium by default.
function optionBar(over = {}) {
  const start = over.bucketStart ?? BASE_TS;
  return {
    token: '65867',
    timeframe: '5s',
    bucketStart: start,
    bucketEnd: start + 5000,
    openP: 2000, highP: 2010, lowP: 1990, closeP: 2000,
    tickCount: 3,
    synthetic: false,
    lowConfidence: false,
    tradable: true,
    ...over,
  };
}

// A series of `n` index bars, each `step` paise above the last. Negative `step`
// falls. Newest LAST, which is the order §10.1 and `lastN()` both use.
function series(n, step, over = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const close = 2450000 + (i * step);
    out.push(indexBar({
      bucketStart: BASE_TS + (i * 5000),
      openP: close - step,
      highP: Math.max(close, close - step) + 200,
      lowP: Math.min(close, close - step) - 200,
      closeP: close,
      ...over,
    }));
  }
  return out;
}

// A §6.1 OptionQuote in the shape chain.normalise() emits. Every optional field
// defaults to a REAL value here; tests that care about absence pass null
// explicitly, so an accidental omission cannot look like a deliberate one.
function quote(over = {}) {
  const strike = over.strike ?? 24500;
  return {
    token: String(over.token ?? `t${strike}`),
    segment: 'nse_fo',
    symbol: over.symbol ?? `NIFTY26JUL${strike}CE`,
    strike,
    optionType: 'CE',
    expiry: '2026-07-30',
    lotSize: 75,
    tickP: 5,
    ltpP: 2000,
    bidP: 1995,
    askP: 2005,
    spreadP: 10,
    midP: 2000,
    bidQty: 750,
    askQty: 750,
    oi: 600000,
    volume: 200000,
    snapshotTs: BASE_TS,
    ...over,
  };
}

// An instrument-master row, as repo.instruments.chain() returns it.
function instrumentRow(over = {}) {
  const strike = over.strike ?? 24500;
  return {
    token: String(over.token ?? `t${strike}`),
    segment: 'nse_fo',
    symbol: over.symbol ?? `NIFTY26JUL${strike}CE`,
    strike,
    option_type: 'CE',
    // `repo.instruments.chain()` does not SELECT this — the query implies it —
    // so src/ose/snapshot.js attaches it before calling normalise(). The fixture
    // carries it for the same reason: without it every quote is discarded as
    // NO_EXPIRY and the test reads as a chain failure rather than a missing field.
    expiry_date: '2026-07-30',
    lot_size: 75,
    tick_size: 0.05,
    ...over,
  };
}

// An open ActiveTrade: short CE at ₹20.00, stop ₹22.00, first target ₹19.00.
function trade(over = {}) {
  return newTrade({
    tradeId: 'test-uid',
    dbId: 1,
    token: '65867',
    symbol: 'NIFTY26JUL24500CE',
    optionType: 'CE',
    strike: 24500,
    expiry: '2026-07-30',
    lotSize: 75,
    qty: 75,
    filledQty: 75,
    requestedPriceP: 2000,
    entryPriceP: 2000,
    entryTrend: 'BEARISH',
    targetLevel: 1,
    targetPriceP: 1900,
    stopPriceP: 2200,
    candlesHeld: 1,
    ...over,
  });
}

// The `_rules` block settings.derive() hands to exits and ladder.
function rules(over = {}) {
  return {
    targetExtensionPoints: 1,
    premiumSafetyExitPoints: 2,
    trailingStopEnabled: true,
    stopGuardEnabled: true,
    maxHoldCandles: 24,
    liquidityMode: 'STRICT',
    premiumMinP: 1500,
    premiumMaxP: 2500,
    ...over,
  };
}

// The `_gate` block settings.derive() hands to strikes.
function gate(over = {}) {
  return { liquidityMode: 'STRICT', premiumMinP: 1500, premiumMaxP: 2500, ...over };
}

// §17.2's gate and §16.2's square-off both read the WALL CLOCK, so any test
// whose path runs through them passes or fails depending on the time of day it
// is run — green at 11:00 IST and red at 21:00.
//
// Tests about what happens AFTER the session checks allow therefore stub them
// rather than faking time: this says "assume the market is open" in one visible
// place, where freezing the clock would silently change every other date the
// cycle touches (the trade date, the day reset, the decision row's key).
function withOpenSession(fn) {
  const risk = require('../src/ose/risk');
  const saved = {
    canOpenTrade: risk.canOpenTrade,
    isSessionOpen: risk.isSessionOpen,
    isPastSquareOff: risk.isPastSquareOff,
    isEntryWindowClosed: risk.isEntryWindowClosed,
  };
  risk.canOpenTrade = () => ({ allowed: true, verdict: 'ALLOW', reason: null });
  risk.isSessionOpen = () => true;
  risk.isPastSquareOff = () => false;
  risk.isEntryWindowClosed = () => false;
  return Promise.resolve(fn()).finally(() => Object.assign(risk, saved));
}

module.exports = {
  ist, BASE_TS, indexBar, optionBar, series, quote, instrumentRow, trade, rules, gate,
  withOpenSession,
};
