// The Start / Pause / Stop buttons must actually reach the engine.
//
// This is the OSE's copy of test/engineIntent.test.js, and it exists for the
// same reason that one does: `engine_intent` was once written by the web tier,
// read back by the dashboard for display, and NOTHING in between ever acted on
// it. The page could read STOP while a live engine kept selling naked options —
// the two disagreed and neither knew.
//
// So what is tested here is the WIRING, not the flag:
//
//   * does the cycle consult the intent, and does the answer decide whether an
//     entry may be evaluated at all
//   * does PAUSE leave an open position being managed, rather than abandoning it
//   * does STOP actually flatten, through the same Exit Engine as everything else
//   * does a database hiccup leave a deliberate pause in place

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./oseHelpers');
const repo = require('../src/repositories');
const exits = require('../src/ose/exits');
const { OseEngine, OUTCOME, INTENT_FLAG, INTENTS } = require('../src/ose/engine');
const { STATES } = require('../src/ose/machine');
const settingsService = require('../src/ose/settings');

function withFlag(value, fn) {
  // Every repository call the cycle AND the safety timer can reach. One
  // unstubbed call opens the real connection pool, the pool holds the event
  // loop open, and the file then hangs with every assertion passing — a failure
  // with nothing failing in it. `_onSafetyTimer` alone reaches four of these.
  const saved = {
    get: repo.flags.get,
    set: repo.flags.set,
    decisions: repo.oseDecisions.log,
    transitions: repo.oseTransitions.log,
    ensure: repo.oseStats.ensure,
    workingForOse: repo.orders.workingForOseTrade,
    orderById: repo.orders.byId,
    // `_onSafetyTimer` now reloads settings, which reads the database. Left
    // unstubbed it opens the pool and the pool holds the event loop open — the
    // file passes every assertion and then hangs.
    settingsLoad: require('../src/ose/settings').load,
  };
  const written = { decisions: [], published: [] };
  repo.flags.get = async (name, fallback) => (name === INTENT_FLAG ? value : fallback);
  repo.flags.set = async (name, v) => { written.published.push([name, v]); };
  repo.oseDecisions.log = async (row) => { written.decisions.push(row); };
  repo.oseTransitions.log = async () => {};
  repo.oseStats.ensure = async () => ({ trades_today: 0, consecutive_losses: 0, halted: 0 });
  repo.orders.workingForOseTrade = async () => [];
  repo.orders.byId = async () => null;
  require('../src/ose/settings').load = async () => { throw new Error('stubbed: no db in unit tests'); };

  return Promise.resolve(fn(written)).finally(() => {
    repo.flags.get = saved.get;
    repo.flags.set = saved.set;
    repo.oseDecisions.log = saved.decisions;
    repo.oseTransitions.log = saved.transitions;
    repo.oseStats.ensure = saved.ensure;
    repo.orders.workingForOseTrade = saved.workingForOse;
    repo.orders.byId = saved.orderById;
    require('../src/ose/settings').load = saved.settingsLoad;
  });
}

function engine() {
  const e = new OseEngine({
    ticker: { on() {}, subscribe() {}, unsubscribe() {} },
    indexCandles: { on() {}, start() {}, stop() {}, track() {}, untrack() {}, addTick() {} },
    optionCandles: { on() {}, start() {}, stop() {}, track() {}, untrack() {}, addTick() {} },
    quoteSource: { snapshot: async () => new Map() },
    router: {},
    reconciler: { runOnce: async () => {} },
    broker: { mode: 'PAPER', status: () => ({ connected: true }) },
  });
  e.cfg = settingsService.derive(settingsService.withDefaults({ mode: 'PAPER' }));
  e.machine.current = STATES.SCANNING;
  e.indexToken = 'Nifty 50';
  e.indexSeries = h.warmSeries(100);
  // The engine must never reach a chain fetch in these tests; if it does, the
  // intent was not consulted and that is the failure.
  e.chain.get = () => { throw new Error('the intent was not consulted before the chain'); };
  return e;
}

test('the engine reads the intent flag rather than assuming RUN', async () => {
  for (const intent of INTENTS) {
    await withFlag(intent, async () => {
      const e = engine();
      assert.equal(e.intent, 'RUN', 'it starts optimistic');
      await e._refreshIntent();
      assert.equal(e.intent, intent, `the ${intent} flag must reach the engine`);
    });
  }
});

test('PAUSE stops the cycle before it evaluates an entry', async () => {
  await withFlag('PAUSE', async (written) => {
    const e = engine();
    await e._refreshIntent();
    await e._cycle(h.indexBar());
    assert.equal(written.decisions[0].outcome, OUTCOME.PAUSED);
  });
});

test('STOP stops the cycle before it evaluates an entry', async () => {
  await withFlag('STOP', async (written) => {
    const e = engine();
    await e._refreshIntent();
    await e._cycle(h.indexBar());
    assert.equal(written.decisions[0].outcome, OUTCOME.STOPPED);
  });
});

test('RUN lets the cycle proceed to the chain', async () => {
  // The mirror image, and the reason the other two mean anything: if the engine
  // rejected every cycle regardless, the tests above would pass while the
  // control did nothing.
  await withFlag('RUN', async () => {
    await h.withOpenSession(async () => {
      const e = engine();
      await e._refreshIntent();
      await e._cycle(h.indexBar());
      // The stubbed chain throws, and §20.5 turns that into a cycle exception —
      // which is proof the entry path was entered.
      assert.equal(e.stats.exceptions, 1, 'RUN must reach the chain');
    });
  });
});

test('PAUSE leaves an open position being managed — it does NOT abandon it', async () => {
  // Halting entries is a risk control; abandoning a live short is not.
  await withFlag('PAUSE', async () => {
    await h.withOpenSession(async () => {
      const e = engine();
      await e._refreshIntent();
      e.trade = h.trade();
      e.machine.current = STATES.POSITION_MANAGEMENT;

      const sent = [];
      e.orders.ordersLive = async () => [];
      e.orders.placeExit = async () => { sent.push('exit'); return { placed: true, order: { id: 1 } }; };

      await e._onSafetyTimer();
      assert.equal(sent.length, 0, 'PAUSE must not flatten');
      assert.equal(e.machine.current, STATES.POSITION_MANAGEMENT);
    });
  });
});

test('STOP flattens an open position through the Exit Engine', async () => {
  await withFlag('STOP', async () => {
    await h.withOpenSession(async () => {
    const e = engine();
    await e._refreshIntent();
    e.trade = h.trade();
    e.machine.current = STATES.POSITION_MANAGEMENT;

    const sent = [];
    e.orders.ordersLive = async () => [];
    e.orders.placeExit = async (trade, reason) => {
      sent.push(reason);
      return { placed: true, order: { id: 1 } };
    };

    await e._onSafetyTimer();
    assert.deepEqual(sent, [exits.EXIT_REASONS.OPERATOR_STOP]);
    assert.equal(e.machine.current, STATES.EXIT_PENDING);
    });
  });
});

test('the kill switch still outranks a mere Stop', async () => {
  // Two levers with different costs to reverse. If Stop could mask the kill
  // switch, the hard lever would be the one that did less.
  const hit = exits.onTimer({ operatorStop: true, killSwitch: true });
  assert.equal(hit.reason, exits.EXIT_REASONS.KILL_SWITCH);
});

test('an unreadable flag leaves a deliberate PAUSE in place', async () => {
  // A database hiccup must never silently un-pause an engine somebody paused.
  await withFlag('PAUSE', async () => {
    const e = engine();
    await e._refreshIntent();
    assert.equal(e.intent, 'PAUSE');

    const saved = repo.flags.get;
    repo.flags.get = async () => { throw new Error('database is down'); };
    try {
      await e._refreshIntent();
    } finally {
      repo.flags.get = saved;
    }
    assert.equal(e.intent, 'PAUSE', 'a failed read must not fall back to RUN');
  });
});

test('the published state fits system_flags.value and survives a round trip', async () => {
  // `system_flags.value` is VARCHAR(255). Publishing more does NOT fail loudly:
  // MySQL truncates, the JSON loses its closing brace, the page's parse returns
  // null, and the page then reports "not running" forever about an engine that
  // is running perfectly — a silent permanent lie on the one field an operator
  // uses to decide whether to intervene.
  await withFlag('RUN', async (written) => {
    const e = engine();
    // A realistically loaded engine: full ring buffer, a chain, a long state name.
    e.indexSeries = h.series(200, 5);
    e.stats.cycles = 987654;
    e.chain.snapshot = { quotes: new Array(82).fill(h.quote()) };
    e.quoteSource.filter = 'market_depth';
    e.machine.current = STATES.POSITION_MANAGEMENT;
    e.counters.halted = true;

    await e._publishState();

    const [name, value] = written.published[0];
    assert.equal(name, 'ose_state');
    assert.ok(value.length <= 255, `published ${value.length} chars into a VARCHAR(255)`);

    const parsed = JSON.parse(value);           // throws if it was truncated
    assert.equal(parsed.state, STATES.POSITION_MANAGEMENT);
    assert.equal(parsed.intent, 'RUN');
    assert.equal(parsed.halted, true);
    assert.equal(parsed.filter, 'market_depth');
    assert.equal(parsed.quotes, 82);
    assert.ok(Number.isFinite(parsed.atMs), 'the staleness stamp must survive — the page '
      + 'cannot tell a quiet engine from a dead one without it');
  });
});

test('the watch record still fits VARCHAR(255) with the implied spot on it', async () => {
  // Same trap as `ose_state`: MySQL truncates silently, the JSON loses its
  // closing brace, the page's parse returns null, and the watch box goes blank
  // forever. The implied-spot field was added to a record that was already
  // close to the ceiling, so its size is asserted rather than assumed.
  await withFlag('RUN', async (written) => {
    const e = engine();
    const spotP = 2511755;
    e.indexSeries = h.warmSeries(100).map(b => ({ ...b, closeP: spotP }));

    // A full chain, and one that disagrees with the feed — the worst case for
    // length, because that is when the extra field is present.
    const quotes = [];
    for (let i = -20; i <= 20; i += 1) {
      const strike = 24400 + i * 50;
      quotes.push(h.quote({ strike, optionType: 'CE', token: `${strike}CE`,
        symbol: `NIFTY2680${strike}CE`, ltpP: 5000 + Math.max(0, 2438360 - strike * 100) }));
      quotes.push(h.quote({ strike, optionType: 'PE', token: `${strike}PE`,
        symbol: `NIFTY2680${strike}PE`, ltpP: 5000 - Math.min(0, 2438360 - strike * 100) }));
    }
    e.chain.snapshot = Object.freeze({ ts: Date.now(), quotes, corrupt: false });
    e.chain.get = () => ({ ok: true, snapshot: e.chain.snapshot });

    await e._publishWatch();

    const row = written.published.find(([name]) => name === 'ose_watch');
    assert.ok(row, 'the watch record must be published');
    const [, value] = row;
    assert.ok(value.length <= 255, `published ${value.length} chars into a VARCHAR(255)`);

    const parsed = JSON.parse(value);            // throws if it was truncated
    assert.ok(Number.isFinite(parsed.is),
      'a feed this far from the chain must carry the implied spot');
    assert.ok(Math.abs(parsed.is - 2438360) < 5000,
      `the chain prices the index near 24383.60, got ${(parsed.is / 100).toFixed(2)}`);
  });
});

test('the implied spot is omitted when the feed and the chain agree', async () => {
  // It is a disagreement marker, not a second price. Publishing it always would
  // spend bytes on the record's tight budget to say nothing.
  await withFlag('RUN', async (written) => {
    const e = engine();
    const spotP = 2438360;
    e.indexSeries = h.warmSeries(100).map(b => ({ ...b, closeP: spotP }));

    const quotes = [];
    for (let i = -3; i <= 3; i += 1) {
      const strike = 24400 + i * 50;
      const parity = spotP - strike * 100;
      quotes.push(h.quote({ strike, optionType: 'CE', token: `${strike}CE`,
        ltpP: 5000 + Math.max(0, parity) }));
      quotes.push(h.quote({ strike, optionType: 'PE', token: `${strike}PE`,
        ltpP: 5000 + Math.max(0, parity) - parity }));
    }
    e.chain.snapshot = Object.freeze({ ts: Date.now(), quotes, corrupt: false });
    e.chain.get = () => ({ ok: true, snapshot: e.chain.snapshot });

    await e._publishWatch();
    const [, value] = written.published.find(([name]) => name === 'ose_watch');
    assert.equal(JSON.parse(value).is, undefined);
  });
});

test('a chain fault cannot take the safety timer down with it', async () => {
  // The safety timer is what squares off a position when the candle feed has
  // stopped (§16.2 priority 0). It also refreshes the display, and a display
  // refresh that could throw would stop the square-off — the one job on this
  // timer that must never stop running.
  await withFlag('RUN', async () => {
    await h.withOpenSession(async () => {
      const e = engine();
      e.indexSeries = h.warmSeries(100);
      e.chain.get = () => { throw new Error('the chain exploded'); };

      await e._onSafetyTimer();          // must not reject
      assert.ok(true, 'the timer survived a throwing chain');
    });
  });
});

test('an unrecognised intent is ignored rather than obeyed', async () => {
  await withFlag('BANANA', async () => {
    const e = engine();
    await e._refreshIntent();
    assert.equal(e.intent, 'RUN', 'a value the engine does not understand changes nothing');
  });
});

/* ================================================ §5.1 — live settings reload */

// The settings page tells the operator the engine picks a change up on its next
// cycle. It did not: `start(cfg)` set the config once and nothing reloaded it,
// so the premium band on the page and the band the engine selected on could
// disagree indefinitely. Same defect as a Start button nothing reads.
const settingsSvc = require('../src/ose/settings');

function withSettings(seq, fn) {
  const saved = settingsSvc.load;
  let i = 0;
  settingsSvc.load = async () => seq[Math.min(i++, seq.length - 1)];
  return Promise.resolve(fn()).finally(() => { settingsSvc.load = saved; });
}

const cfgWith = (over) => settingsSvc.derive(settingsSvc.withDefaults({ mode: 'PAPER', ...over }));

test('a saved settings change reaches the engine without a restart', async () => {
  await withFlag('RUN', async () => {
    const a = cfgWith({ premiumMin: 15, premiumMax: 25 });
    const b = cfgWith({ premiumMin: 60, premiumMax: 90 });
    await withSettings([b], async () => {
      const e = engine();
      e.cfg = a;
      e._settingsFingerprint = null;      // as if boot had seeded it from `a`
      e._settingsCheckedAt = null;

      await e._reloadSettings();
      assert.equal(e.cfg._gate.premiumMinP, 6000, 'the new band must be in force');
      assert.equal(e.cfg._gate.premiumMaxP, 9000);
    });
  });
});

test('a change is HELD while a position is open, and applied when it closes', async () => {
  // A trade is managed to the rules it was opened under. Moving
  // premiumSafetyExitPoints under a live short would exit it on a rule it was
  // never entered on.
  await withFlag('RUN', async () => {
    const a = cfgWith({ premiumMin: 15, premiumMax: 25 });
    const b = cfgWith({ premiumMin: 60, premiumMax: 90 });
    await withSettings([b], async () => {
      const e = engine();
      e.cfg = a;
      e._settingsFingerprint = null;
      e._settingsCheckedAt = null;
      e.trade = h.trade();

      await e._reloadSettings();
      assert.equal(e.cfg._gate.premiumMinP, 1500, 'the open trade keeps its own rules');
      assert.ok(e._pendingCfg, 'but the change is remembered, not discarded');
    });
  });
});

test('an unreadable settings row leaves the engine on the config it has', async () => {
  await withFlag('RUN', async () => {
    const a = cfgWith({ premiumMin: 15, premiumMax: 25 });
    const saved = settingsSvc.load;
    settingsSvc.load = async () => { throw new Error('database is down'); };
    try {
      const e = engine();
      e.cfg = a;
      e._settingsCheckedAt = null;
      await e._reloadSettings();
      assert.equal(e.cfg._gate.premiumMinP, 1500, 'a failed read must not blank the config');
    } finally {
      settingsSvc.load = saved;
    }
  });
});
