// §4.2, §12.3 and §16.4 — the wiring.
//
// The pure modules are covered in oseDecision/oseChain. What is tested here is
// whether the ENGINE actually consults them, and whether the money-safety rules
// survive contact with the orchestration:
//
//   * one sealed candle produces exactly one decision row, always
//   * a candle that seals mid-cycle is dropped, not queued
//   * the engine never sends the same order twice
//   * a dead broker session stops the cycle before it evaluates anything
//
// The repository is stubbed rather than mocked at the driver level, following
// test/engineIntent.test.js: what is under test is the wiring, not the SQL.

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./oseHelpers');
const repo = require('../src/repositories');
const risk = require('../src/ose/risk');
const { OseEngine, OUTCOME } = require('../src/ose/engine');
const { STATES } = require('../src/ose/machine');
const settingsService = require('../src/ose/settings');

/* ------------------------------------------------------------- the harness */

// Swap every repository call the cycle can reach. Restored afterwards so one
// test cannot leak into another.
// EVERY repository method the cycle can reach must be stubbed, including the
// ones on the HALT path. A single unstubbed call opens the real connection pool
// and the pool then holds the event loop open — the file's tests all pass and
// the runner hangs until it is killed, which reads as a failure with no failing
// assertion in it. `test/helpers.js` states the rule: nothing in the unit suite
// touches a database or a broker.
function withRepo(fn) {
  const saved = {
    decisions: repo.oseDecisions.log,
    transitions: repo.oseTransitions.log,
    statsEnsure: repo.oseStats.ensure,
    statsBumpEntry: repo.oseStats.bumpEntry,
    statsHalt: repo.oseStats.halt,
    openTrades: repo.oseTrades.openTrades,
    setState: repo.oseTrades.setState,
    release: repo.oseTrades.release,
    markError: repo.oseTrades.markError,
    dangling: repo.orders.danglingForPrefix,
    workingForOse: repo.orders.workingForOseTrade,
    orderById: repo.orders.byId,
  };
  const written = { decisions: [], transitions: [], halts: [] };

  repo.oseDecisions.log = async (row) => { written.decisions.push(row); };
  repo.oseTransitions.log = async (row) => { written.transitions.push(row); };
  repo.oseStats.ensure = async () => ({ trades_today: 0, consecutive_losses: 0, halted: 0 });
  repo.oseStats.bumpEntry = async () => {};
  repo.oseStats.halt = async (date, reason) => { written.halts.push(reason); };
  repo.oseTrades.openTrades = async () => [];
  repo.oseTrades.setState = async () => {};
  repo.oseTrades.release = async () => {};
  repo.oseTrades.markError = async () => {};
  repo.orders.danglingForPrefix = async () => [];
  repo.orders.workingForOseTrade = async () => [];
  repo.orders.byId = async () => null;

  return Promise.resolve(fn(written)).finally(() => {
    repo.oseDecisions.log = saved.decisions;
    repo.oseTransitions.log = saved.transitions;
    repo.oseStats.ensure = saved.statsEnsure;
    repo.oseStats.bumpEntry = saved.statsBumpEntry;
    repo.oseStats.halt = saved.statsHalt;
    repo.oseTrades.openTrades = saved.openTrades;
    repo.oseTrades.setState = saved.setState;
    repo.oseTrades.release = saved.release;
    repo.oseTrades.markError = saved.markError;
    repo.orders.danglingForPrefix = saved.dangling;
    repo.orders.workingForOseTrade = saved.workingForOse;
    repo.orders.byId = saved.orderById;
  });
}

// The shared session stub lives in oseHelpers — see the note there.
const withOpenSession = h.withOpenSession;

const cfg = () => settingsService.derive(settingsService.withDefaults({ mode: 'PAPER' }));

// The minimum engine that can run one cycle without a broker, a feed or a DB.
function engine(over = {}) {
  const e = new OseEngine({
    ticker: { on() {}, subscribe() {}, unsubscribe() {} },
    indexCandles: { on() {}, start() {}, stop() {}, track() {}, untrack() {} },
    optionCandles: { on() {}, start() {}, stop() {}, track() {}, untrack() {} },
    quoteSource: { snapshot: async () => new Map(), filter: 'ltp', coverage: { ltp: true } },
    router: {},
    reconciler: { runOnce: async () => {} },
    broker: { mode: 'PAPER', status: () => ({ mode: 'PAPER', connected: true }) },
    session: null,
    ...over,
  });
  e.cfg = cfg();
  e.machine.current = STATES.SCANNING;
  e.indexToken = 'Nifty 50';
  return e;
}

/* ============================================== §11.5 — no silent rejection */

test('every sealed candle writes exactly one decision row, whatever it decided', async () => {
  await withRepo(async (written) => {
    const e = engine();
    // Warming up, a rejection, and a chain miss — three very different paths.
    await e._cycle(h.indexBar());
    e.indexSeries = h.series(3, 100);
    await e._cycle(h.indexBar({ bucketStart: h.BASE_TS + 5000 }));
    await e._cycle(h.indexBar({ bucketStart: h.BASE_TS + 10000 }));

    assert.equal(written.decisions.length, 3, 'one row per candle, no more and no fewer');
    for (const row of written.decisions) {
      assert.ok(row.outcome, 'a row with no outcome is a silent rejection');
      assert.ok(Number.isFinite(row.candleTs));
    }
  });
});

test('the decision row carries the sample count behind it', async () => {
  // §19.4 — tick_count and low_confidence are how a degrading Kotak sampler is
  // detected after the fact rather than only while it is happening.
  await withRepo(async (written) => {
    const e = engine();
    await e._cycle(h.indexBar({ tickCount: 1, lowConfidence: true }));
    const row = written.decisions[0];
    assert.equal(row.tickCount, 1);
    assert.equal(row.lowConfidence, true);
  });
});

test('the first cycles report WARMING_UP rather than guessing a trend', async () => {
  await withRepo(async (written) => {
    const e = engine();
    await e._cycle(h.indexBar());
    assert.equal(written.decisions[0].outcome, OUTCOME.WARMING_UP);
  });
});

/* =================================================== §4.2 — the overrun guard */

test('a candle sealed mid-cycle is DROPPED, not queued', async () => {
  // Queueing would run a decision on a candle that is no longer the latest —
  // stale data wearing a fresh timestamp.
  await withRepo(async (written) => {
    const e = engine();
    e.indexSeries = h.series(3, 100);
    e._cycleBusy = true;

    e._onIndexCandle(h.indexBar({ bucketStart: h.BASE_TS + 20000 }));

    assert.equal(e.stats.overruns, 1);
    assert.equal(written.decisions.length, 0, 'the dropped candle must not produce a decision');
  });
});

test('three overruns inside the window halt the engine', async () => {
  await withRepo(async () => {
    const e = engine();
    e._cycleBusy = true;
    for (let i = 0; i < 3; i += 1) {
      e._onIndexCandle(h.indexBar({ bucketStart: h.BASE_TS + i * 5000 }));
    }
    await new Promise(r => setImmediate(r));
    assert.equal(e.counters.halted, true);
    assert.match(e.counters.haltReason, /OVERRUN/);
  });
});

/* ============================================== §4.2 — the broker-session gate */

test('a dead broker session stops the cycle before it evaluates anything', async () => {
  await withRepo(async (written) => {
    const e = engine({
      broker: { mode: 'LIVE', status: () => ({ connected: false }) },
    });
    e.indexSeries = h.series(3, 100);
    await e._cycle(h.indexBar());

    assert.equal(written.decisions[0].outcome, OUTCOME.BROKER_SESSION);
    assert.equal(written.decisions[0].trend, 'NONE',
      'the trend must not even be computed against a dead session');
  });
});

test('a halted engine refuses the cycle and says so', async () => {
  await withRepo(async (written) => {
    const e = engine();
    e.counters.halted = true;
    e.counters.haltReason = 'MAX_CONSECUTIVE_LOSSES: 5';
    await e._cycle(h.indexBar());
    assert.equal(written.decisions[0].outcome, OUTCOME.HALTED);
    assert.equal(written.decisions[0].detail, 'MAX_CONSECUTIVE_LOSSES: 5');
  });
});

/* ================================================ §7.9 — the candidate delay */

test('a newly chosen strike is tracked before it can be priced, never entered blind', async () => {
  // §7.5 — the first bucket of a new series describes the subscription, not the
  // market, so the earliest an entry can be priced is one timeframe later. The
  // engine must say CANDIDATE_TRACKED rather than reach for an LTP.
  await withRepo(async (written) => {
    await withOpenSession(async () => {
      const e = engine();
      e.indexSeries = h.series(3, -100);                       // BEARISH -> wants CE
      const bar = h.indexBar({ openP: 300, highP: 350, lowP: 100, closeP: 110 });

      e.chain.snapshot = Object.freeze({
        ts: Date.now(), quotes: [h.quote({ optionType: 'CE' })],
        corrupt: false, considered: 1, discardRate: 0,
      });
      e.chain.get = () => ({ ok: true, snapshot: e.chain.snapshot });

      await e._cycle(bar);
      assert.equal(written.decisions[0].outcome, OUTCOME.CANDIDATE_TRACKED);
      assert.ok(e.candidate, 'the option series must start building');
    });
  });
});

test('a selected strike with no tradable option bar yields NO_OPTION_CANDLE', async () => {
  await withRepo(async (written) => {
    await withOpenSession(async () => {
      const e = engine();
      e.indexSeries = h.series(3, -100);
      const quote = h.quote({ optionType: 'CE' });
      e.candidate = { token: quote.token, symbol: quote.symbol, segment: 'nse_fo' };
      // A sealed but LOW-CONFIDENCE bar: present, and still not allowed to price.
      e.optionLast.set(String(quote.token), h.optionBar({
        token: quote.token, tickCount: 1, lowConfidence: true, tradable: false,
      }));

      e.chain.snapshot = Object.freeze({ ts: Date.now(), quotes: [quote], corrupt: false });
      e.chain.get = () => ({ ok: true, snapshot: e.chain.snapshot });

      await e._cycle(h.indexBar({ openP: 300, highP: 350, lowP: 100, closeP: 110 }));
      assert.equal(written.decisions[0].outcome, OUTCOME.NO_OPTION_CANDLE,
        'the engine MUST NOT substitute an LTP — this is the most violated rule in the spec');
    });
  });
});

/* ============================================ §12.3 — the idempotency contract */

test('IDEMPOTENCY: an ambiguous entry is NEVER resent, only recovered', async () => {
  // The single most expensive rule in the system. A resend after a timeout is
  // indistinguishable from a new order at Kotak, because there is no client
  // order id — so the engine must go to the book, not to the broker.
  const sent = [];
  let recovered = 0;

  await withRepo(async () => {
    const e = engine();
    e.orders.placeEntry = async () => {
      sent.push('entry');
      return { placed: false, ambiguous: true, order: { id: 7, status: 'UNKNOWN' }, reason: 'timeout' };
    };
    e.orders.recoverAmbiguous = async () => { recovered += 1; return { resolved: true, halt: false }; };

    const savedOpen = repo.oseTrades.open;
    repo.oseTrades.open = async () => 1;
    try {
      await e._enter(
        { cycleId: 'c1', candle: h.indexBar(), tradeDate: '2026-07-28', trend: 'BEARISH' },
        h.quote({ optionType: 'CE' }),
        h.optionBar());
    } finally {
      repo.oseTrades.open = savedOpen;
    }
  });

  assert.equal(sent.length, 1, 'the entry was sent exactly once');
  assert.equal(recovered, 1, 'and the ambiguity was resolved through the book, not by resending');
});

test('IDEMPOTENCY: an exit is not sent while one is already working', async () => {
  // A resend of a market buy that is already working buys the short back twice
  // and leaves the account naked LONG — the worst outcome this system produces.
  const sent = [];
  await withRepo(async () => {
    const e = engine();
    e.machine.current = STATES.POSITION_MANAGEMENT;
    e.trade = h.trade();
    e.orders.ordersLive = async () => [{ client_ref: 'OS-TEST-CE-1-SL', status: 'WORKING' }];
    e.orders.placeExit = async () => { sent.push('exit'); return { placed: true, order: { id: 9 } }; };

    await e._exit('EXIT_STOP_HIT', 'the stop was hit', {});
    assert.equal(sent.length, 0, 'an exit already working must not be duplicated');
  });
});

test('IDEMPOTENCY: a retried exit gets a NEW revision, so it is not swallowed by the key', async () => {
  // The opposite of the entry rule, and correct for the same reason: a failed
  // entry must not be duplicated, and a failed exit must not be ABANDONED.
  const attempts = [];
  await withRepo(async () => {
    const e = engine();
    e.machine.current = STATES.POSITION_MANAGEMENT;
    e.trade = h.trade();
    e.orders.ordersLive = async () => [];
    e.orders.placeExit = async (trade, reason, attempt) => {
      attempts.push(attempt);
      return { placed: true, order: { id: 10 + attempt } };
    };

    await e._exit('EXIT_STOP_HIT', 'first', {});
    e.machine.current = STATES.POSITION_MANAGEMENT;      // simulate the retry path
    await e._exit('EXIT_STOP_HIT', 'second', {});

    assert.deepEqual(attempts, [1, 2], 'each attempt must carry a distinct revision');
  });
});

/* ====================================================== §14/§15 — the ladder */

test('taking the FIRST point moves the stop to breakeven, not past it', async () => {
  // §15.2's table is indexed by the level ACHIEVED: 1 -> entry + 0 -> breakeven.
  // §14.2's pseudocode increments `targetLevel` before calling the stop module,
  // and following that literally tightens a full rung early — the first point
  // would lock +1 instead of breakeven, so a trade that came back could never
  // scratch. It shipped that way until scripts/ose-selftest.js caught it.
  await withRepo(async () => {
    const e = engine();
    e.trade = h.trade({ entryPriceP: 2010, stopPriceP: 2210, targetLevel: 1, targetPriceP: 1910 });

    await e._applyExtension({ targetLevel: 2, targetPriceP: 1810 });

    assert.equal(e.trade.stopPriceP, 2010,
      'achieving level 1 locks BREAKEVEN — entry + 0');
    assert.notEqual(e.trade.stopPriceP, 1910,
      'entry - 1 is the level TWO row, and using it here stops the trade out a rung early');
  });
});

test('the ladder walks §15.2 exactly, rung by rung', async () => {
  await withRepo(async () => {
    const e = engine();
    e.trade = h.trade({ entryPriceP: 2000, stopPriceP: 2200, targetLevel: 1, targetPriceP: 1900 });

    const expected = [2000, 1900, 1800, 1700];   // breakeven, +1, +2, +3
    for (let achieved = 1; achieved <= 4; achieved += 1) {
      await e._applyExtension({
        targetLevel: achieved + 1,
        targetPriceP: 2000 - (achieved + 1) * 100,
      });
      assert.equal(e.trade.stopPriceP, expected[achieved - 1],
        `level ${achieved} achieved should lock ${(2000 - expected[achieved - 1]) / 100} points`);
    }
  });
});

test('a target extension moves the rung AND tightens the stop, in one place', async () => {
  await withRepo(async () => {
    const e = engine();
    e.trade = h.trade();                    // entry 2000, stop 2200, target 1900, level 1
    await e._applyExtension({ targetLevel: 2, targetPriceP: 1800 });
    assert.equal(e.trade.targetLevel, 2);
    assert.equal(e.trade.targetPriceP, 1800);
    // The rung moves to 2, but the level ACHIEVED was 1, and §15.2 indexes the
    // stop by what was achieved. This assertion previously read 1900 and so
    // encoded the off-by-one rather than catching it — a test written from the
    // implementation instead of from the specification.
    assert.equal(e.trade.stopPriceP, 2000, 'achieving level 1 locks breakeven');
  });
});
