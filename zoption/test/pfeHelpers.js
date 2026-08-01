// Fixtures for the Price-Filter Engine's unit suite.
//
// Kept apart from test/helpers.js because the two engines' state machines have
// different shapes: sharing one `leg()` factory would mean every change to one
// engine's trade object rippling through the other's tests.

require('./helpers');                        // env + charge schedule, before src/config

const time = require('../src/core/time');
const machine = require('../src/pfe/machine');

function ist(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!m) throw new Error(`bad IST timestamp "${text}"`);
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)) - time.IST_OFFSET_MS;
}

// A completed, tradable index bar. Prices in paise: 25100.00 is 2510000.
let barSeq = 0;
function indexBar(overrides = {}) {
  const start = ist('2026-07-28 10:15:00') + (barSeq++) * 5000;
  return {
    token: 'Nifty 50',
    timeframe: '5s',
    bucketStart: start,
    bucketEnd: start + 5000,
    openP: 2510000, highP: 2510500, lowP: 2509800, closeP: 2510400,
    tickCount: 5,
    synthetic: false,
    tradable: true,
    ...overrides,
  };
}

// Three bars of higher highs and higher lows, the last closing up.
function risingBars(n = 3) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(indexBar({
      openP: 2510000 + i * 200,
      lowP: 2509900 + i * 200,
      highP: 2510600 + i * 200,
      closeP: 2510500 + i * 200,
    }));
  }
  return out;
}

function fallingBars(n = 3) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(indexBar({
      openP: 2510000 - i * 200,
      highP: 2510600 - i * 200,
      lowP: 2509900 - i * 200,
      closeP: 2509950 - i * 200,
    }));
  }
  return out;
}

// A completed, tradable OPTION bar. `closeP` in paise — 20.00 is 2000.
function optionBar(overrides = {}) {
  return {
    id: 11,
    token: '54321',
    timeframe: '5s',
    bucketStart: ist('2026-07-28 10:15:00'),
    bucketEnd: ist('2026-07-28 10:15:05'),
    openP: 1990, highP: 2020, lowP: 1980, closeP: 2000,
    tickCount: 5,
    synthetic: false,
    tradable: true,
    ...overrides,
  };
}

// The machine's config, in paise and milliseconds. Defaults are doc/new.md's:
// ₹0.10 offset, ₹1 target, ₹2 stop, a four-rung ladder and a 90-second hold.
function cfg(overrides = {}) {
  return {
    sellOffsetP: 10,
    targetP: 100,
    stopLossP: 200,
    stepP: 100,
    maxSteps: 4,
    trailStartP: 0,
    trailGapP: 100,
    trailTightenP: 20,
    trailMinGapP: 40,
    safetyMarginP: 200,
    pendingTimeoutMs: 5000,
    maxHoldMs: 90000,
    armTimeoutMs: 120000,
    dynamicTarget: true,
    ...overrides,
  };
}

const trade = (overrides = {}) => machine.blank({
  id: 1,
  optionType: 'PE',
  token: '54321',
  symbol: 'NIFTY31JUL2625000PE',
  strike: 25000,
  qty: 75,
  tickP: 5,
  ...overrides,
});

// An instrument-master row as the scanner reads one.
function contract(overrides = {}) {
  return {
    token: '54321',
    segment: 'nse_fo',
    symbol: 'NIFTY31JUL2625000PE',
    strike: 25000,
    option_type: 'PE',
    lot_size: 75,
    tick_size: 0.05,
    ...overrides,
  };
}

// A quote as `neoClient.readQuoteFull` produces one: RUPEES, and anything the
// broker did not send is null rather than 0.
function quote(overrides = {}) {
  return {
    ltp: 20,
    bid: 19.95,
    ask: 20.05,
    bidQty: 500,
    askQty: 450,
    oi: 250000,
    volume: 40000,
    ...overrides,
  };
}

// Drive events through the pure machine, collecting every action.
function run(startTrade, events, config = cfg()) {
  let current = { ...startTrade };
  const actions = [];
  for (const event of events) {
    const next = machine.reduce(current, event, config);
    current = { ...current, ...next.patch, state: next.state };
    actions.push(...next.actions);
  }
  return { trade: current, actions };
}

const actionsOf = (actions, type) => actions.filter(a => a.type === type);
const logsOf = (actions, kind) => actions.filter(a => a.type === 'LOG' && a.kind === kind);

module.exports = {
  ist, indexBar, risingBars, fallingBars, optionBar, optionCandle: optionBar,
  cfg, trade, contract, quote, run, actionsOf, logsOf,
};
