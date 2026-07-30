// The Start / Stop / Pause buttons must actually reach the engine.
//
// This is a regression test for a shipped bug: `engine_intent` was written by
// the web tier and read back by `/api/status` for display, and NOTHING in
// between ever acted on it. The dashboard could read STOP while a live engine
// kept selling naked options — the two disagreed and neither knew.
//
// The repository is stubbed rather than mocked at the driver level, because
// what is being tested is the wiring: does the clock consult the flag, and does
// the answer decide whether a cycle may open.

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../src/repositories');
const { ScalperEngine } = require('../src/strategy/scalperEngine');

// Swap the two repository calls the intent path touches, and restore them
// afterwards so one test cannot leak into another.
function withFlag(value, fn) {
  const flagsGet = repo.flags.get;
  const eventsLog = repo.events.log;
  const written = [];
  repo.flags.get = async (name, fallback) => (name === 'engine_intent' ? value : fallback);
  repo.events.log = async (row) => { written.push(row); };
  return Promise.resolve(fn(written)).finally(() => {
    repo.flags.get = flagsGet;
    repo.events.log = eventsLog;
  });
}

// The minimum engine that can run one clock without a broker, a feed or a
// database. Everything the clock touches on the no-cycle path is here.
function engine() {
  const opened = [];
  const e = new ScalperEngine({
    ticker: { on() {}, isHealthy: () => true, ltpPaise: () => null, quote: () => null },
    candles: { on() {}, start() {}, stop() {}, setTokens() {} },
    router: {},
    reconciler: { on() {}, runOnce: async () => {} },
    risk: { canEnter: async () => ({ ok: true, reason: null }), recordSpot() {} },
    broker: {},
  });
  e.running = true;
  e.cycle = null;
  e.settings = { squareOffAt: '15:15', trendFilter: false };
  e._maybeOpenCycle = async (now) => { opened.push(now); };
  e.opened = opened;
  return e;
}

test('opens a cycle only when the operator intent is RUN', async () => {
  await withFlag('RUN', async () => {
    const e = engine();
    await e._onClock();
    assert.equal(e.opened.length, 1, 'RUN must let the engine look for a cycle');
    assert.equal(e.intent, 'RUN');
  });
});

test('opens nothing on STOP or PAUSE', async () => {
  for (const value of ['STOP', 'PAUSE']) {
    // eslint-disable-next-line no-await-in-loop
    await withFlag(value, async () => {
      const e = engine();
      await e._onClock();
      assert.equal(e.opened.length, 0, `${value} must not open a cycle`);
      assert.equal(e.intent, value);
    });
  }
});

test('refuses to trade on an unset or unrecognised flag', async () => {
  // The dashboard and `/api/status` both display STOP for an unset flag. The
  // engine must agree with the screen — defaulting to RUN is exactly how the
  // two came to disagree.
  for (const value of [null, undefined, '', 'GO', 'run-please']) {
    // eslint-disable-next-line no-await-in-loop
    await withFlag(value, async () => {
      const e = engine();
      await e._onClock();
      assert.equal(e.opened.length, 0, `"${value}" must not be read as permission to trade`);
      assert.equal(e.intent, 'STOP');
    });
  }
});

test('accepts the flag in any case', async () => {
  await withFlag('run', async () => {
    const e = engine();
    await e._onClock();
    assert.equal(e.opened.length, 1);
    assert.equal(e.intent, 'RUN');
  });
});

test('records every intent change in the audit trail, once', async () => {
  await withFlag('RUN', async (written) => {
    const e = engine();
    await e._onClock();
    await e._onClock();
    await e._onClock();
    // Three clocks, one transition — a reason repeated once a second for twenty
    // minutes tells an operator nothing the first line did not.
    const control = written.filter(w => w.kind === 'CONTROL');
    assert.equal(control.length, 1);
    assert.equal(control[0].toState, 'RUN');
    assert.equal(control[0].fromState, null, 'the first read has no previous value');
    assert.equal(e.opened.length, 3, 'the gate is re-checked every clock, not latched');
  });
});

test('keeps managing an open position while stopped', async () => {
  // STOP halts ENTRIES. It does not abandon a live short — that is the same
  // rule riskManager is built on, and the square-off is what closes positions.
  await withFlag('STOP', async () => {
    const e = engine();
    const dispatched = [];
    e.cycle = { id: 7 };
    e.legs = new Map([['CE', { optionType: 'CE', state: 'POSITION_OPEN' }]]);
    e._dispatch = async (leg, event) => { dispatched.push(event.type); };
    e._dispatchAll = async (event) => { dispatched.push(event.type); };
    e._maybeCloseCycle = async () => {};
    e._recoverStuck = async () => {};

    await e._onClock();
    assert.ok(dispatched.includes('POSITION_TIMEOUT'),
      'an open position must still be managed and timed out while stopped');
    assert.equal(e.opened.length, 0, 'but nothing new may open');
  });
});

test('holds the last intent rather than trading when the flag cannot be read', async () => {
  const flagsGet = repo.flags.get;
  const eventsLog = repo.events.log;
  repo.events.log = async () => {};
  try {
    const e = engine();
    // Establish RUN, then make the database unavailable.
    repo.flags.get = async () => 'RUN';
    await e._onClock();
    assert.equal(e.opened.length, 1);

    repo.flags.get = async () => { throw new Error('connection lost'); };
    await e._onClock();
    // The last known intent stands. A database blip must not flip the engine
    // into trading, and must not strand an operator who had it running either.
    assert.equal(e.intent, 'RUN');
    assert.equal(e.opened.length, 2);
  } finally {
    repo.flags.get = flagsGet;
    repo.events.log = eventsLog;
  }
});

test('refuses when the flag cannot be read and none was ever established', async () => {
  const flagsGet = repo.flags.get;
  const eventsLog = repo.events.log;
  repo.events.log = async () => {};
  repo.flags.get = async () => { throw new Error('connection lost'); };
  try {
    const e = engine();
    await e._onClock();
    assert.equal(e.opened.length, 0, 'with no known intent, the safe answer is no');
  } finally {
    repo.flags.get = flagsGet;
    repo.events.log = eventsLog;
  }
});
