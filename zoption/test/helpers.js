// Everything the unit suite needs before `src/config` is loaded.
//
// config/index.js calls process.exit(1) on a missing TOKEN_ENC_KEY or
// JWT_SECRET, which would kill the test runner rather than fail a test. Setting
// them here — before any require of a src module — keeps the pure tests pure:
// nothing in the unit suite touches a database or a broker.

process.env.TOKEN_ENC_KEY = process.env.TOKEN_ENC_KEY
  || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-secret-that-is-definitely-long-enough';
process.env.ALLOW_INSECURE_COOKIES = 'true';
process.env.NODE_ENV = 'test';

// The charge schedule is PINNED here, unconditionally, and not read from .env.
//
// These assignments happen before src/config is required, and dotenv does not
// overwrite an already-set variable — so the suite tests the charge MODEL
// rather than whatever plan the operator happens to be on. Without this, moving
// to a zero-brokerage plan silently changes what the unit tests assert, which
// is the wrong way round: the tests should tell you the model still works, and
// a separate test covers the zero-brokerage case explicitly.
process.env.CHG_BROKERAGE_PER_ORDER = '20';
process.env.CHG_STT_SELL_PCT = '0.1';
process.env.CHG_EXCH_TXN_PCT = '0.03503';
process.env.CHG_SEBI_PCT = '0.0001';
process.env.CHG_GST_PCT = '18';
process.env.CHG_STAMP_BUY_PCT = '0.003';

const time = require('../src/core/time');

// An IST wall-clock instant, for tests that need to reason in market time.
// `ist('2026-07-28 10:15:00')` is the moment a 10:15 bar opens.
function ist(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/.exec(text);
  if (!m) throw new Error(`bad IST timestamp "${text}"`);
  const [, y, mo, d, h, mi, s, ms] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0), +(ms || 0)) - time.IST_OFFSET_MS;
}

// A minimal leg, as the state machine expects one.
function leg(overrides = {}) {
  return {
    id: 1,
    optionType: 'CE',
    token: '12345',
    symbol: 'NIFTY31JUL2625250CE',
    strike: 25250,
    state: 'IDLE',
    attemptSeq: 0,
    sellPriceP: null,
    filledPriceP: null,
    targetPriceP: null,
    slPriceP: null,
    filledQty: 0,
    entryCandleId: null,
    openedAt: null,
    sellPlacedAt: null,
    sellOrderId: null,
    targetOrderId: null,
    exitOrderId: null,
    exitReason: null,
    haltAfterCancel: false,
    waitingSince: null,
    ...overrides,
  };
}

// The config the machine reads, in paise and milliseconds. Defaults match the
// documented profile: ₹1 offset, ₹1 target, ₹2 stop.
function cfg(overrides = {}) {
  return {
    sellOffsetP: 100,
    targetP: 100,
    stopLossP: 200,
    pendingTimeoutMs: 10000,
    positionTimeoutMs: 60000,
    legEntryTimeoutMs: 180000,
    ...overrides,
  };
}

// A tradable closed candle. `closeP` in paise.
function candle(overrides = {}) {
  return {
    id: 7,
    token: '12345',
    timeframe: '1m',
    bucketStart: ist('2026-07-28 10:15:00'),
    bucketEnd: ist('2026-07-28 10:16:00'),
    openP: 1210, highP: 1260, lowP: 1190, closeP: 1240,
    tickCount: 40,
    synthetic: false,
    partial: false,
    lowConfidence: false,
    tradable: true,
    ...overrides,
  };
}

// Drive a sequence of events through the machine, returning the final leg and
// every action produced along the way.
function run(machine, startLeg, events, config = cfg()) {
  let current = { ...startLeg };
  const actions = [];
  for (const event of events) {
    const next = machine.reduce(current, event, config);
    current = { ...current, ...next.patch, state: next.state };
    actions.push(...next.actions);
  }
  return { leg: current, actions };
}

const actionsOf = (actions, type) => actions.filter(a => a.type === type);
const logsOf = (actions, kind) => actions.filter(a => a.type === 'LOG' && a.kind === kind);

module.exports = { ist, leg, cfg, candle, run, actionsOf, logsOf };
