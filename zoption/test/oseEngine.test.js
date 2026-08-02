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
    indexCandles: { on() {}, start() {}, stop() {}, track() {}, untrack() {}, addTick() {} },
    optionCandles: { on() {}, start() {}, stop() {}, track() {}, untrack() {}, addTick() {} },
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
    e.indexSeries = h.warmSeries(100);
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
    e.indexSeries = h.warmSeries(100);
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
    e.indexSeries = h.warmSeries(100);
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
      e.indexSeries = h.warmSeries(-100);                       // BEARISH -> wants CE
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
      e.indexSeries = h.warmSeries(-100);
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

/* ================================== newdoc/ema.md — the EMA confirmation gate */

// The pure rules live in oseEma.test.js. What is tested here is whether the
// ENGINE consults them, and whether it does so BEFORE it spends a chain refresh
// and a strike ranking to arrive at the same "no". A filter the cycle computes
// and then ignores is the defect these three exist to catch.

// A market that fell for 24 candles and then turned up over the last three: the
// 3-candle trend engine reads BULLISH while EMA9 is still a long way below
// EMA20. Exactly the disagreement §Reject Trade exists for.
function conflictSeries() {
  const closes = Array.from({ length: 24 }, (_, i) => 2450000 - i * 100);
  for (let k = 1; k <= 3; k += 1) closes.push(closes[23] + k * 50);
  return closes.map((closeP, i) => h.indexBar({
    bucketStart: h.BASE_TS + i * 5000,
    openP: closeP, highP: closeP + 50, lowP: closeP - 50, closeP,
  }));
}

test('the EMA filter refuses BEFORE the chain is touched, not after', async () => {
  await withRepo(async (written) => {
    await withOpenSession(async () => {
      const e = engine();
      // Three candles is enough for the trend engine and nowhere near enough for
      // EMA20, so the cycle must stop on the EMA verdict.
      e.indexSeries = h.series(4, 100);
      e.chain.get = () => { throw new Error('the EMA filter was not consulted before the chain'); };

      await e._cycle(h.indexBar({ bucketStart: h.BASE_TS + 20000 }));

      assert.equal(written.decisions[0].outcome, OUTCOME.EMA_WARMING_UP);
      assert.equal(e.stats.exceptions, 0, 'nothing downstream may run once the filter refuses');
    });
  });
});

test('an EMA verdict that contradicts the 3-candle trend blocks the entry', async () => {
  await withRepo(async (written) => {
    await withOpenSession(async () => {
      const e = engine();
      e.indexSeries = conflictSeries();
      e.chain.get = () => { throw new Error('a conflicted cycle must never reach the chain'); };

      const last = e.indexSeries[e.indexSeries.length - 1];
      await e._cycle(last);

      const row = written.decisions[0];
      assert.equal(row.outcome, OUTCOME.EMA_TREND_CONFLICT);
      assert.equal(row.trend, 'BULLISH', 'the 3-candle engine did want to sell a PE');
      assert.equal(row.emaTrend, 'BEARISH', 'and the EMA filter is what stopped it');
    });
  });
});

test('the EMA verdict is recorded on EVERY decision row, including the ones it did not decide',
  async () => {
    // A column only written on refusals cannot answer "what were the averages
    // doing when it DID trade", which is the more expensive question.
    await withRepo(async (written) => {
      await withOpenSession(async () => {
        const e = engine();
        e.indexSeries = h.warmSeries(100);
        e.chain.get = () => ({ ok: false, reason: 'CHAIN_STALE', detail: 'stubbed' });

        await e._cycle(h.indexBar({ bucketStart: h.BASE_TS + 200000 }));

        const row = written.decisions[0];
        assert.equal(row.outcome, 'CHAIN_STALE', 'the cycle got past the EMA filter');
        assert.equal(row.emaTrend, 'BULLISH');
        assert.equal(row.emaVia, 'EMA_ALIGNED');
        assert.ok(Number.isFinite(row.ema9P) && Number.isFinite(row.ema20P));
        assert.ok(row.ema9P > row.ema20P);
      });
    });
  });

test('emaFilterEnabled OFF restores the pre-filter behaviour exactly', async () => {
  // The mirror image of the two tests above, and the reason they mean anything:
  // if the engine rejected these cycles for some other reason, they would pass
  // while the filter did nothing.
  await withRepo(async (written) => {
    await withOpenSession(async () => {
      const e = engine();
      e.cfg = settingsService.derive(settingsService.withDefaults({
        mode: 'PAPER', emaFilterEnabled: false,
      }));
      e.indexSeries = conflictSeries();
      e.chain.snapshot = Object.freeze({
        ts: Date.now(), quotes: [h.quote({ optionType: 'PE' })], corrupt: false,
      });
      e.chain.get = () => ({ ok: true, snapshot: e.chain.snapshot });

      const last = e.indexSeries[e.indexSeries.length - 1];
      await e._cycle(last);

      assert.notEqual(written.decisions[0].outcome, OUTCOME.EMA_TREND_CONFLICT);
      assert.equal(written.decisions[0].emaTrend, 'BEARISH',
        'the verdict is still COMPUTED and recorded — only the gate is off');
    });
  });
});

/* ============== newdoc/ema.md §Position Exit Rule — the ENGINE half */

// `exits.onCandle` is covered directly in oseEma.test.js. What was missing, and
// what this covers, is whether `_manageOnIndexCandle` actually COMPUTES the EMA
// verdict and hands it over — the same class of defect as a Start button whose
// flag nothing reads. Without this, the exit could be deleted from the engine
// and every EMA test in the suite would still pass.

function holdingPE(e) {
  e.trade = h.trade({ optionType: 'PE', entryTrend: 'BULLISH', entryPriceP: 2000,
    stopPriceP: 2200, targetPriceP: 1900 });
  e.machine.current = STATES.POSITION_MANAGEMENT;
  return e;
}

test('the engine computes the EMA verdict and lets it close a position', async () => {
  await withRepo(async (written) => {
    await withOpenSession(async () => {
      const e = holdingPE(engine());
      // A falling index: EMA9 below EMA20, which is the wrong structure for a
      // short PE. The §13.3 validity filter would ALSO fail here — the exit
      // reason recorded is what proves the crossover is evaluated ahead of it.
      e.indexSeries = h.warmSeries(-100);
      e.chain.get = () => ({ ok: true, snapshot: { ts: Date.now(), quotes: [] } });

      const fired = [];
      e._exit = async (reason, detail) => { fired.push({ reason, detail }); };

      await e._cycle(h.indexBar({ bucketStart: h.BASE_TS + 500000 }));

      assert.equal(fired.length, 1, 'the position must be closed');
      assert.equal(fired[0].reason, 'EXIT_EMA_CROSS');
      assert.equal(written.decisions[0].outcome, 'EXIT_EMA_CROSS');
      assert.equal(written.decisions[0].emaTrend, 'BEARISH',
        'the verdict that closed the trade must be on the row that records it');
    });
  });
});

test('emaExitOnCrossover OFF leaves the position to the other exits', async () => {
  await withRepo(async (written) => {
    await withOpenSession(async () => {
      const e = holdingPE(engine());
      e.cfg = settingsService.derive(settingsService.withDefaults({
        mode: 'PAPER', emaExitOnCrossover: false,
      }));
      e.indexSeries = h.warmSeries(-100);
      e.chain.get = () => ({ ok: true, snapshot: { ts: Date.now(), quotes: [] } });

      const fired = [];
      e._exit = async (reason, detail) => { fired.push({ reason, detail }); };

      await e._cycle(h.indexBar({ bucketStart: h.BASE_TS + 500000 }));

      // It still exits — the trend break and the validity filter are both live —
      // but NOT on the crossover. That distinction is the whole switch.
      assert.notEqual(fired[0]?.reason, 'EXIT_EMA_CROSS');
      assert.equal(written.decisions[0].emaTrend, 'BEARISH',
        'the verdict is still computed and recorded — only the exit is off');
    });
  });
});

test('an EMA structure that still supports the position does NOT close it', async () => {
  // The mirror image. Without it the two tests above would pass on an engine
  // that closed every position on every candle.
  await withRepo(async () => {
    await withOpenSession(async () => {
      const e = holdingPE(engine());
      e.indexSeries = h.warmSeries(100);          // rising — correct for a short PE
      e.chain.get = () => ({ ok: true, snapshot: { ts: Date.now(), quotes: [] } });

      const fired = [];
      e._exit = async (reason) => { fired.push(reason); };

      // A candle that also keeps the §13.3 filter happy: closes above its own
      // bullish midpoint.
      const last = e.indexSeries[e.indexSeries.length - 1].closeP;
      await e._cycle(h.indexBar({
        bucketStart: h.BASE_TS + 500000,
        openP: last, highP: last + 500, lowP: last - 100, closeP: last + 450,
      }));

      assert.ok(!fired.includes('EXIT_EMA_CROSS'),
        'a bullish EMA structure is exactly what a short PE wants');
    });
  });
});

/* ======================== the index-feed check — src/ose/spotGuard.js */

// The pure rules live in oseSpotGuard.test.js. What is tested here is that the
// ENGINE consults them, and that it does so BEFORE a strike is selected — the
// whole point being that a divergent feed must not be allowed to choose.

// A rising index series that ENDS at `endP`.
//
// It has to rise: a flat series is EMA_SIDEWAYS by newdoc/ema.md's flat rule, and
// the cycle would stop at the EMA gate without ever reaching the chain — which
// is what the first draft of these tests did, and it looked like the spot guard
// was broken rather than the fixture.
function rampTo(endP, bars = h.EMA_WARMUP + 3, step = 100) {
  const startP = endP - (bars - 1) * step;
  return Array.from({ length: bars }, (_, i) => {
    const closeP = startP + i * step;
    return h.indexBar({
      bucketStart: h.BASE_TS + i * 5000,
      openP: closeP - step, highP: closeP + 200, lowP: closeP - step - 200, closeP,
    });
  });
}

// The candle the cycle runs on: continues the ramp and closes above its own
// bullish midpoint, so §11 offers SELL PE and the cycle reaches the chain.
function nextBar(series) {
  const prev = series[series.length - 1].closeP;
  return h.indexBar({
    bucketStart: h.BASE_TS + series.length * 5000,
    openP: prev, highP: prev + 500, lowP: prev - 100, closeP: prev + 450,
  });
}

// Both legs of a strike, priced so K + (C − P) lands exactly on `spotP`.
function pricedChain(spotP, step = 50) {
  const atm = Math.round((spotP / 100) / step) * step;
  const out = [];
  for (let i = -4; i <= 4; i += 1) {
    const strike = atm + i * step;
    const intrinsicP = spotP - strike * 100;
    const ceP = Math.max(5, 5000 + Math.max(0, intrinsicP));
    out.push(h.quote({ strike, optionType: 'CE', token: `${strike}CE`, ltpP: ceP }));
    out.push(h.quote({ strike, optionType: 'PE', token: `${strike}PE`, ltpP: ceP - intrinsicP }));
  }
  return out;
}

test('a divergent index feed blocks the entry before any strike is selected', async () => {
  // The 2026-08-02 failure, end to end: the gateway answers 25117.55 while the
  // chain prices the index at 24383.60.
  await withRepo(async (written) => {
    await withOpenSession(async () => {
      const e = engine();
      e.indexSeries = rampTo(2511755);
      const bar = nextBar(e.indexSeries);
      e.indexSeries.push(bar);

      // The chain prices the index 735 points below where the feed says it is.
      e.chain.snapshot = Object.freeze({
        ts: Date.now(), quotes: pricedChain(2438360), corrupt: false, considered: 18,
      });
      e.chain.get = () => ({ ok: true, snapshot: e.chain.snapshot });

      await e._cycle(bar);

      assert.equal(written.decisions[0].outcome, OUTCOME.SPOT_DIVERGENCE);
      assert.equal(e.candidate, null, 'nothing may be selected against a feed that is wrong');
      assert.match(written.decisions[0].detail, /the FEED is what is wrong/);
    });
  });
});

test('an agreeing feed passes the check and reaches strike selection', async () => {
  // The mirror image, and the reason the test above means anything: if the
  // engine rejected the cycle for some other reason, it would pass while the
  // guard did nothing.
  await withRepo(async (written) => {
    await withOpenSession(async () => {
      const e = engine();
      e.indexSeries = rampTo(2438360);
      const bar = nextBar(e.indexSeries);
      e.indexSeries.push(bar);

      e.chain.snapshot = Object.freeze({
        ts: Date.now(), quotes: pricedChain(bar.closeP), corrupt: false, considered: 18,
      });
      e.chain.get = () => ({ ok: true, snapshot: e.chain.snapshot });

      await e._cycle(bar);

      assert.notEqual(written.decisions[0].outcome, OUTCOME.SPOT_DIVERGENCE);
    });
  });
});

test('spotCheckEnabled OFF restores the pre-guard behaviour', async () => {
  await withRepo(async (written) => {
    await withOpenSession(async () => {
      const e = engine();
      e.cfg = settingsService.derive(settingsService.withDefaults({
        mode: 'PAPER', spotCheckEnabled: false,
      }));
      e.indexSeries = rampTo(2511755);
      const bar = nextBar(e.indexSeries);
      e.indexSeries.push(bar);
      e.chain.snapshot = Object.freeze({
        ts: Date.now(), quotes: pricedChain(2438360), corrupt: false, considered: 18,
      });
      e.chain.get = () => ({ ok: true, snapshot: e.chain.snapshot });

      await e._cycle(bar);

      assert.notEqual(written.decisions[0].outcome, OUTCOME.SPOT_DIVERGENCE,
        'with the guard off the same divergent feed must get through');
    });
  });
});

/* ====================== the synthetic index — src/ose/syntheticIndex.js */

// A chain priced to satisfy parity exactly at `spotP`, in the shape the chain
// snapshot holds.
function parityChain(spotP, step = 50) {
  const spotGuard = require('../src/ose/spotGuard');
  // A FUTURE expiry, and the discount taken against the same clock the engine
  // will use. `h.quote`'s default expiry is in the past relative to the real
  // `Date.now()` the engine calls `compute` with, so `yearsToExpiry` clamps and
  // the fixture bakes in a different discount from the one applied — worth ~9
  // index points, which reads as a broken synthesiser rather than a broken
  // fixture. Production never has a past expiry; this is a test-only trap.
  //
  // `snapshotTs` matters as much as the expiry: with no explicit `nowMs`,
  // `discountFor` falls back to it, and `h.quote`'s default is BASE_TS — days
  // away from the `Date.now()` the engine computes against. Both ends are pinned
  // to the same clock here so the fixture and the engine agree on T.
  const now = Date.now();
  const expiry = new Date(now + 4 * 86400000).toISOString().slice(0, 10);
  // Parity gives the FORWARD: F = K + (C − P). Built at 1 so the chain's forward
  // is exactly `spotP`.
  const discount = 1;
  const atm = Math.round((spotP / 100) / step) * step;
  const out = [];
  for (let i = -10; i <= 10; i += 1) {
    const strike = atm + i * step;
    const parityP = spotP - strike * 100 * discount;
    const ceP = Math.max(5, 5000 + Math.max(0, parityP));
    const common = { expiry, snapshotTs: now };
    out.push(h.quote({ strike, optionType: 'CE', token: `${strike}CE`, ltpP: ceP, ...common }));
    out.push(h.quote({ strike, optionType: 'PE', token: `${strike}PE`, ltpP: ceP - parityP, ...common }));
  }
  return out;
}

function withChain(e, spotP) {
  const quotes = parityChain(spotP);
  e.chain.snapshot = Object.freeze({ ts: Date.now(), quotes, corrupt: false, considered: quotes.length });
  e.chain.get = () => ({ ok: true, snapshot: e.chain.snapshot });
  return quotes;
}

test('AUTO switches to the chain when the quoted index disagrees, and back when it agrees',
  async () => {
    await withRepo(async () => {
      const e = engine();
      const quotes = withChain(e, 2438360);              // the chain says 24383.60
      e._feedSample = { ltpPaise: 2511755, ts: Date.now() };   // the feed says 25117.55

      assert.equal(e.indexSource, 'FEED', 'it starts trusting the feed');
      await e._maintainIndexSource();
      assert.equal(e.indexSource, 'CHAIN', 'a 734-point disagreement must move the source');

      // The feed comes good.
      e._feedSample = { ltpPaise: 2438360, ts: Date.now() };
      await e._maintainIndexSource();
      assert.equal(e.indexSource, 'FEED', 'agreement must hand the source back');
      assert.ok(quotes.length > 0);
    });
  });

test('a source switch CLEARS the candle buffer — a 734-point step is not a market move',
  async () => {
    // Splicing one source onto the other would put a 734-point jump in the middle
    // of the series, and the trend engine and the EMA would both read it as the
    // most violent move of the session and act on it.
    await withRepo(async () => {
      const e = engine();
      const untracked = [];
      const tracked = [];
      e.indexCandles.untrack = (t) => untracked.push(String(t));
      e.indexCandles.track = (t) => tracked.push(String(t));

      e.indexSeries = h.warmSeries(100);
      assert.ok(e.indexSeries.length > 20, 'the buffer starts warm');

      withChain(e, 2438360);
      e._feedSample = { ltpPaise: 2511755, ts: Date.now() };
      await e._maintainIndexSource();

      assert.equal(e.indexSource, 'CHAIN');
      assert.equal(e.indexSeries.length, 0, 'the buffer must be thrown away, not spliced');
      assert.deepEqual(untracked, ['Nifty 50']);
      assert.deepEqual(tracked, ['Nifty 50'], 'and restarted clean');
    });
  });

test('AUTO still derives when the SPOT CHECK is disabled — the two are independent',
  async () => {
    // `spotCheckEnabled` governs whether a divergence blocks ENTRIES. Whether the
    // index is derived from the chain is a different question. Tying them
    // together made AUTO silently inert: with the check off, `check()` returns
    // SPOT_CHECK_DISABLED, neither branch matched, and the engine sat on a
    // 734-point-wrong feed while the settings page still said AUTO.
    await withRepo(async () => {
      const e = engine();
      e.cfg = settingsService.derive(settingsService.withDefaults({
        mode: 'PAPER', spotCheckEnabled: false, syntheticIndexMode: 'AUTO',
      }));
      assert.equal(e.cfg._spotCheck.enabled, false, 'the fixture must actually have it off');

      withChain(e, 2438360);
      e._feedSample = { ltpPaise: 2511755, ts: Date.now() };
      await e._maintainIndexSource();

      assert.equal(e.indexSource, 'CHAIN',
        'a disabled spot CHECK must not disable the synthetic SOURCE');
    });
  });

test('OFF never leaves the feed, and FORCE never uses it', async () => {
  await withRepo(async () => {
    const off = engine();
    off.cfg = settingsService.derive(settingsService.withDefaults({
      mode: 'PAPER', syntheticIndexMode: 'OFF',
    }));
    withChain(off, 2438360);
    off._feedSample = { ltpPaise: 2511755, ts: Date.now() };
    await off._maintainIndexSource();
    assert.equal(off.indexSource, 'FEED', 'OFF means the engine sits idle instead');

    const force = engine();
    force.cfg = settingsService.derive(settingsService.withDefaults({
      mode: 'PAPER', syntheticIndexMode: 'FORCE',
    }));
    withChain(force, 2438360);
    force._feedSample = { ltpPaise: 2438360, ts: Date.now() };   // a perfectly good feed
    await force._maintainIndexSource();
    assert.equal(force.indexSource, 'CHAIN', 'FORCE derives even from a healthy feed');
  });
});

test('a parity leg tick feeds the index series, and the quoted feed does not', async () => {
  await withRepo(async () => {
    const e = engine();
    const fed = [];
    e.indexCandles.addTick = (token, price, ts) => fed.push({ token, price, ts });

    withChain(e, 2438360);
    e._feedSample = { ltpPaise: 2511755, ts: Date.now() };
    await e._maintainIndexSource();
    assert.equal(e.indexSource, 'CHAIN');
    assert.ok(e.parityTokens.size >= 6, 'legs must have been selected and subscribed');

    // The quoted index arrives and must be RECORDED but not fed.
    fed.length = 0;
    e._onTick({ token: 'Nifty 50', ltpPaise: 2511755, ts: Date.now() });
    assert.equal(fed.length, 0, 'a disbelieved feed must not reach the candle series');
    assert.equal(e._feedSample.ltpPaise, 2511755, 'but it is still recorded for the check');

    // A parity leg arrives and must produce an index sample near the true level.
    const q = e.chain.snapshot.quotes.find(x => e.parityTokens.has(String(x.token)));
    for (const tok of e.parityTokens) {
      const row = e.chain.snapshot.quotes.find(x => String(x.token) === tok);
      e.paritySamples.set(tok, { ltpPaise: row.ltpP, ts: Date.now() });
    }
    e._onTick({ token: String(q.token), ltpPaise: q.ltpP, ts: Date.now() });

    assert.equal(fed.length, 1, 'a parity tick must produce exactly one index sample');
    assert.equal(fed[0].token, 'Nifty 50');
    assert.ok(Math.abs(fed[0].price - 2438360) < 200,
      `the synthesised level was ${(fed[0].price / 100).toFixed(2)}, not ~24383.60`);
  });
});

test('an unchanged synthetic level is not fed twice', async () => {
  // Twelve legs arrive in one poll and most move the median by nothing. Feeding
  // each would inflate tickCount — the number §7.8 uses to judge whether a bar
  // had enough evidence to price an order.
  await withRepo(async () => {
    const e = engine();
    const fed = [];
    e.indexCandles.addTick = (token, price) => fed.push(price);
    withChain(e, 2438360);
    e._feedSample = { ltpPaise: 2511755, ts: Date.now() };
    await e._maintainIndexSource();

    for (const tok of e.parityTokens) {
      const row = e.chain.snapshot.quotes.find(x => String(x.token) === tok);
      e.paritySamples.set(tok, { ltpPaise: row.ltpP, ts: Date.now() });
    }
    fed.length = 0;
    for (const tok of e.parityTokens) e._feedSyntheticIndex(Date.now());

    assert.equal(fed.length, 1, `the same level was fed ${fed.length} times`);
  });
});

test('an unchanged level is still fed once per poll interval — silence is not stillness',
  async () => {
    // Suppressing an unchanged level INDEFINITELY starves the candle builder the
    // moment the market goes quiet: no ticks, no bucket ever seals, and the
    // engine goes silent while looking healthy. Seen exactly that on a closed
    // market — one decision row, then nothing.
    await withRepo(async () => {
      const config = require('../src/config');
      const e = engine();
      const fed = [];
      e.indexCandles.addTick = (token, price) => fed.push(price);
      withChain(e, 2438360);
      e._feedSample = { ltpPaise: 2511755, ts: Date.now() };
      await e._maintainIndexSource();

      for (const tok of e.parityTokens) {
        const row = e.chain.snapshot.quotes.find(x => String(x.token) === tok);
        e.paritySamples.set(tok, { ltpPaise: row.ltpP, ts: Date.now() });
      }

      e._feedSyntheticIndex(Date.now());
      assert.equal(fed.length, 1);

      // Same level, but a poll interval later: it must land again.
      e._lastSyntheticAt = Date.now() - (config.neo.pollMs + 50);
      for (const tok of e.parityTokens) {
        e.paritySamples.set(tok, { ...e.paritySamples.get(tok), ts: Date.now() });
      }
      e._feedSyntheticIndex(Date.now());

      assert.equal(fed.length, 2, 'an unchanged level must still land once per interval');
      assert.equal(fed[0], fed[1], 'and it is the same level, not a fabricated move');
    });
  });

test('the decision row records which source the index came from', async () => {
  await withRepo(async (written) => {
    await withOpenSession(async () => {
      const e = engine();
      e.indexSeries = h.warmSeries(100);
      e.chain.get = () => ({ ok: false, reason: 'CHAIN_STALE', detail: 'stubbed' });
      await e._cycle(h.indexBar({ bucketStart: h.BASE_TS + 900000 }));
      assert.equal(written.decisions[0].indexSource, 'FEED');

      e.indexSource = 'CHAIN';
      await e._cycle(h.indexBar({ bucketStart: h.BASE_TS + 905000 }));
      assert.equal(written.decisions[1].indexSource, 'CHAIN');
    });
  });
});

test('the spot check is skipped while the index IS the chain', async () => {
  // Comparing a chain-derived level against the chain it came from can only ever
  // agree. Running it would be a check that always passes wearing the name of one
  // that means something.
  await withRepo(async (written) => {
    await withOpenSession(async () => {
      const e = engine();
      e.indexSource = 'CHAIN';
      e.indexSeries = rampTo(2438360);
      const bar = nextBar(e.indexSeries);
      e.indexSeries.push(bar);
      // A chain that disagrees violently with the candle — under FEED this would
      // be SPOT_DIVERGENCE.
      e.chain.snapshot = Object.freeze({
        ts: Date.now(), quotes: pricedChain(2000000), corrupt: false, considered: 18,
      });
      e.chain.get = () => ({ ok: true, snapshot: e.chain.snapshot });

      await e._cycle(bar);
      assert.notEqual(written.decisions[0].outcome, OUTCOME.SPOT_DIVERGENCE);
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
