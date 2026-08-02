// What a process that stays up for weeks needs, and a process restarted each
// morning got for free.
//
// The auto-start decision (24/7 on boot, rather than a scheduled 08:45 start)
// is what makes these load-bearing. Each one breaks the engine on day TWO if it
// is missing, and none of them is visible from a single session's testing:
//
//   * the instrument master goes stale — §8.2, a stale master offers strikes
//     that no longer exist and the selector would happily rank one
//   * the Kotak session dies around 06:00 IST and the ticker closes itself, so
//     without a resume the engine stays up and permanently BLIND — worse than
//     being down, because it still looks healthy
//   * the day's counters never reset, so yesterday's trade count and loss
//     streak gate today
//
// The maintenance loop lives on the safety timer rather than the decision cycle
// precisely because a dead feed means no candles: put the calendar on the candle
// clock and a dead feed freezes the calendar too.

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./oseHelpers');
const repo = require('../src/repositories');
const risk = require('../src/ose/risk');
const time = require('../src/core/time');
const instrumentMaster = require('../src/market/instrumentMaster');
const { OseEngine } = require('../src/ose/engine');
const { STATES } = require('../src/ose/machine');
const settingsService = require('../src/ose/settings');

function withRepo(fn) {
  const saved = {
    ensure: repo.oseStats.ensure,
    get: repo.flags.get,
    set: repo.flags.set,
    decisions: repo.oseDecisions.log,
    transitions: repo.oseTransitions.log,
    orderById: repo.orders.byId,
    sync: instrumentMaster.syncAll,
  };
  const seen = { synced: 0, ensured: [] };
  repo.oseStats.ensure = async (d) => { seen.ensured.push(d); return { trades_today: 0 }; };
  repo.flags.get = async (n, f) => f;
  repo.flags.set = async () => {};
  repo.oseDecisions.log = async () => {};
  repo.oseTransitions.log = async () => {};
  repo.orders.byId = async () => null;
  instrumentMaster.syncAll = async () => { seen.synced += 1; return { options: 1, indices: 1 }; };

  return Promise.resolve(fn(seen)).finally(() => Object.assign(repo.oseStats, { ensure: saved.ensure })
    && Object.assign(repo.flags, { get: saved.get, set: saved.set })
    && Object.assign(repo.oseDecisions, { log: saved.decisions })
    && Object.assign(repo.oseTransitions, { log: saved.transitions })
    && Object.assign(repo.orders, { byId: saved.orderById })
    && Object.assign(instrumentMaster, { syncAll: saved.sync }));
}

// A session that can be flipped between active and dead, and a ticker that
// records whether it was resumed.
function fakeSession(active = true) {
  return {
    active,
    session: { sessionToken: 't', sid: 's' },
    isActive() { return this.active; },
    loads: 0,
    async load() { this.loads += 1; return this.active ? this.session : null; },
  };
}

function engine(session, ticker) {
  const e = new OseEngine({
    ticker: ticker || { on() {}, subscribe() {}, unsubscribe() {}, resume() {}, connect() {} },
    indexCandles: { on() {}, start() {}, stop() {}, track() {}, untrack() {} },
    optionCandles: { on() {}, start() {}, stop() {}, track() {}, untrack() {} },
    quoteSource: { snapshot: async () => new Map() },
    router: {},
    reconciler: { runOnce: async () => {} },
    broker: { mode: 'PAPER', status: () => ({ connected: true }) },
    session,
  });
  e.cfg = settingsService.derive(settingsService.withDefaults({ mode: 'PAPER' }));
  e.machine.current = STATES.IDLE;
  return e;
}

test('a day rollover re-syncs the instrument master', async () => {
  await withRepo(async (seen) => {
    const e = engine(fakeSession(true));

    await e._dailyMaintenance();                       // first run: adopts today
    assert.equal(seen.synced, 1, 'the first maintenance pass syncs');

    e._maintainedAt = null;                            // allow an immediate re-run
    await e._dailyMaintenance();
    assert.equal(seen.synced, 1, 'the same day must NOT re-sync every 30 seconds');

    // Pretend yesterday.
    e._maintainedDate = '2020-01-01';
    e._maintainedAt = null;
    await e._dailyMaintenance();
    assert.equal(seen.synced, 2, 'a new trading day re-syncs — §8.2');
  });
});

test('a day rollover clears the cached expiry so it is resolved again', async () => {
  await withRepo(async () => {
    const e = engine(fakeSession(true));
    await e._dailyMaintenance();

    e.chain.expiry = '2020-01-02';
    e.chain.expiryDate = '2020-01-01';
    e._maintainedDate = '2020-01-01';
    e._maintainedAt = null;
    await e._dailyMaintenance();

    assert.equal(e.chain.expiry, null, "yesterday's expiry may have expired overnight");
  });
});

test('a day rollover resets the counters that gate trading', async () => {
  await withRepo(async (seen) => {
    const e = engine(fakeSession(true));
    e.counters = { ...risk.blankCounters('2020-01-01'), tradesToday: 30, consecutiveLosses: 5 };
    e._maintainedDate = '2020-01-01';

    await e._dailyMaintenance();

    assert.equal(e.counters.tradesToday, 0, "yesterday's count must not gate today");
    assert.equal(e.counters.consecutiveLosses, 0);
    assert.equal(e.counters.tradingDate, time.tradeDate(Date.now()));
    assert.ok(seen.ensured.includes(time.tradeDate(Date.now())));
  });
});

test('a failed instrument sync degrades, it does not throw', async () => {
  // The stored master is stale but still usable for the near expiries. Throwing
  // here would take the safety timer down with it — and the safety timer is what
  // squares off a position when the feed has stopped.
  await withRepo(async () => {
    const saved = instrumentMaster.syncAll;
    instrumentMaster.syncAll = async () => { throw new Error('gateway down'); };
    try {
      const e = engine(fakeSession(true));
      await e._dailyMaintenance();                 // must not reject
    } finally {
      instrumentMaster.syncAll = saved;
    }
  });
});

test('a dead session is reloaded, and the feed RESUMED once it is back', async () => {
  // The token expires about 06:00 IST daily and the ticker closes itself. If
  // nothing resumes it the engine stays up and blind — running, reporting
  // healthy, and seeing no market at all.
  await withRepo(async () => {
    const session = fakeSession(false);
    let resumed = 0;
    const ticker = { on() {}, subscribe() {}, unsubscribe() {}, resume() { resumed += 1; } };
    const e = engine(session, ticker);

    await e._dailyMaintenance();
    assert.ok(session.loads >= 1, 'a dead session must be reloaded');
    assert.equal(resumed, 0, 'nothing to resume while it is still dead');
    assert.equal(e._feedDown, true);

    // The operator logs in.
    session.active = true;
    e._maintainedAt = null;
    await e._dailyMaintenance();
    assert.equal(resumed, 1, 'the feed must come back on its own');
    assert.equal(e._feedDown, false);

    // ...and not be resumed again on every subsequent tick.
    e._maintainedAt = null;
    await e._dailyMaintenance();
    assert.equal(resumed, 1);
  });
});

test('the 09:10 login alert fires once, and only on a trading day', async () => {
  await withRepo(async () => {
    const e = engine(fakeSession(false));
    e.holidays = [];

    const savedAfter = time.isAfter;
    const savedWeekend = risk.isWeekend;
    time.isAfter = () => true;          // pretend it is past 09:10
    risk.isWeekend = () => false;
    try {
      e._loginCheck(Date.now(), '2026-08-03');
      assert.equal(e._loginAlerted, true, 'a trading day with no login must complain');

      e._loginAlerted = false;
      risk.isWeekend = () => true;
      e._loginCheck(Date.now(), '2026-08-02');
      assert.equal(e._loginAlerted, false, 'nobody logs in on a Saturday');

      // A holiday is equally not a failure.
      risk.isWeekend = () => false;
      e.holidays = ['2026-08-03'];
      e._loginCheck(Date.now(), '2026-08-03');
      assert.equal(e._loginAlerted, false, 'the exchange is shut — not a missed login');
    } finally {
      time.isAfter = savedAfter;
      risk.isWeekend = savedWeekend;
    }
  });
});

test('an active session never triggers the login alert', async () => {
  await withRepo(async () => {
    const e = engine(fakeSession(true));
    const saved = time.isAfter;
    time.isAfter = () => true;
    try {
      e._loginCheck(Date.now(), '2026-08-03');
      assert.equal(e._loginAlerted, false);
    } finally {
      time.isAfter = saved;
    }
  });
});

/* ------------------------------------- §17.7, the calendar FILE is readable -- */

// The shipped `config/holidays.json` declared its list under `dates` while every
// reader took `raw.holidays`. A calendar filled in exactly as the file's own note
// instructed therefore parsed as EMPTY — a refusal to start in production, and a
// silent "no holidays this year" everywhere else. The failure the file exists to
// prevent, living inside the file.
//
// This asserts the real file, not a fixture: a fixture would have agreed with
// whichever key the test author happened to pick.
test('the shipped holiday calendar is actually readable by the engine', () => {
  const fs = require('fs');
  const config = require('../src/config');
  const raw = JSON.parse(fs.readFileSync(config.ose.holidayFile, 'utf8'));

  const list = risk.readCalendar(raw);
  assert.ok(list.length > 0,
    `config/holidays.json parsed to ${list.length} entries — the engine reads `
    + `\`holidays\`; check the key`);

  const today = require('../src/core/time').tradeDate(Date.now());
  const verdict = risk.validateCalendar(list, today);
  assert.equal(verdict.ok, true,
    `the shipped calendar does not validate: ${verdict.reason}. In production this `
    + 'is a refusal to start.');
});

test('readCalendar accepts every spelling that has ever been shipped', () => {
  assert.equal(risk.readCalendar({ holidays: ['2026-12-25'] }).length, 1);
  assert.equal(risk.readCalendar({ dates: ['2026-12-25'] }).length, 1, 'the legacy key');
  assert.equal(risk.readCalendar(['2026-12-25']).length, 1, 'a bare array');
  for (const junk of [null, undefined, 42, 'nope', {}, { holidays: 'no' }]) {
    assert.deepEqual(risk.readCalendar(junk), [], `${JSON.stringify(junk)} must be empty, not throw`);
  }
});
