#!/usr/bin/env node
// The Option Selling Engine's trading process — newdoc/update.md.
//
//   npm start   the web console. Nothing trades.
//   npm run ose THIS. It holds the market data, builds both candle series, runs
//               the decision cycle and places the orders.
//
// ---------------------------------------------------------------------------
// It takes the SAME leader lock as the other two engines, on purpose
// ---------------------------------------------------------------------------
//
// `zoption-engine` is a single lock and all three trading processes contend for
// it, so exactly one can be live against this account at a time. That is the
// design, not an oversight:
//
//   * one Kotak account, and all three strategies sell NAKED options on it. Two
//     processes selling at once is two positions the margin was never sized for
//     and two sets of exits racing each other.
//   * §3.3 says "single active trade", and a limit the engine enforces on itself
//     while a second process ignores it is not a limit.
//
// So starting this while `npm run engine` or `npm run pfe` is up refuses,
// loudly, naming the process that holds the lock.
//
// ---------------------------------------------------------------------------
// §31.2 — the login is interactive, and the engine waits for it
// ---------------------------------------------------------------------------
//
// Kotak authenticates with a TOTP and an MPIN and neither may be persisted, so
// this process cannot start a trading day on its own. It waits in IDLE rather
// than exiting: an engine that dies because nobody had logged in yet is an
// engine an operator has to babysit at 08:50 every morning.

const config = require('./config');
const logger = require('./core/logger');
const db = require('./core/db');
const money = require('./core/money');
const repo = require('./repositories');
const settingsService = require('./ose/settings');
const brokerRegistry = require('./broker');
const session = require('./broker/neoSession');
const instrumentMaster = require('./market/instrumentMaster');
const { Ticker } = require('./market/ticker');
const { CandleBuilder } = require('./market/candleBuilder');
const { QuoteSource } = require('./market/quoteSource');
const { OrderRouter } = require('./execution/orderRouter');
const { Reconciler } = require('./execution/reconciler');
const { OseEngine } = require('./ose/engine');

// Shared with src/engine.js and src/pfeEngine.js — see the header.
const LOCK_NAME = 'zoption-engine';
const OWNER = `ose-${config.engine.id}`;

// §5.1 fixes the timeframe at 5 seconds and the settings validator holds it
// there. Named here because two builders read it and a literal in two places is
// a literal that will disagree with itself.
const TIMEFRAME = '5s';

let engine = null;
let ticker = null;
let reconciler = null;
let heartbeat = null;
let shuttingDown = false;

async function boot() {
  logger.info('ose: booting', { id: OWNER, env: config.env });

  if (!await db.healthCheck()) throw new Error('the database is not reachable');

  const got = await repo.locks.acquire(LOCK_NAME, OWNER, config.engine.lockTtlMs);
  if (!got) {
    logger.error('ose: another trading process holds the lock — refusing to start. Only one '
      + 'engine may trade this account at a time; stop `npm run engine` or `npm run pfe` first.');
    process.exit(1);
  }
  heartbeat = setInterval(() => {
    repo.locks.acquire(LOCK_NAME, OWNER, config.engine.lockTtlMs)
      .then((still) => {
        if (!still) {
          logger.error('ose: lost the leader lock — shutting down to avoid double orders');
          shutdown(1);
        }
      })
      .catch(err => logger.warn('ose: heartbeat failed', { err: err.message }));
  }, Math.floor(config.engine.lockTtlMs / 3));
  heartbeat.unref?.();

  // §22 is enforced here, not advised: load() runs assertLiveAllowed() and
  // refuses LIVE while any specification item is unsigned.
  const settings = await settingsService.load();
  reportUnsigned(settings);

  await session.load();
  if (!session.isActive()) {
    logger.warn('ose: no active Kotak session — waiting. Log in on the Broker page at '
      + `${config.appUrl}/brokers`);
    await waitForSession();
  }

  // The master changes daily as contracts are added and expire. A stale row
  // points at a contract that no longer exists and the selector would happily
  // rank it (§8.2).
  try {
    await instrumentMaster.syncAll(session.session);
  } catch (err) {
    const have = await repo.instruments.count();
    if (!have) throw new Error(`the instrument master is empty and the sync failed: ${err.message}`);
    logger.warn('ose: the instrument sync failed — carrying on with the stored master',
      { err: err.message, rows: have });
  }

  const broker = brokerRegistry.adapterFor(settings.mode);
  if (broker.mode === 'PAPER') {
    logger.warn('ose: PAPER mode — orders are simulated against the live sample stream. '
      + 'Nothing reaches the exchange. §12.7: partial fills, rejections and queue position are '
      + 'NOT simulated, so paper results are an optimistic bound.');
  } else {
    logger.warn('ose: LIVE mode — orders will reach the exchange.');
    reportEconomics(settings, await settingsService.lotSizeFor(settings.index));
    await reportMargin(settings);
  }

  ticker = new Ticker({ session, label: 'ose' });
  ticker.on('auth_expired', () => {
    logger.error('ose: market data authentication expired — waiting for a fresh login');
  });
  ticker.connect();

  // TWO builders, deliberately separate objects.
  //
  // The index series decides WHETHER to trade (§10, §11) and the option series
  // decides at WHAT PRICE (§12.1). Keeping them in different objects with
  // different minTicks means an index bar cannot be mistaken for an option bar
  // by anything downstream — the strongest available guarantee that the index
  // can never price an order.
  const indexCandles = new CandleBuilder({
    timeframe: TIMEFRAME, minTicks: settings.indexMinTicks,
  });
  const optionCandles = new CandleBuilder({
    timeframe: TIMEFRAME, minTicks: settings.optionMinTicks,
  });

  // §8.3's batched chain quotes. QuoteSource probes the entitlement ONCE and
  // reports what it settled on (§29.1) — on an ltp-only account that report is
  // the difference between "the market offered nothing" and "this account can
  // never pass the §9.2 filters".
  const quoteSource = new QuoteSource({
    session, batchSize: config.neo.quoteBatch, label: 'ose-chain',
  });

  reconciler = new Reconciler({ broker, intervalMs: Math.min(1000, config.engine.tickMs) });

  const router = new OrderRouter({
    broker,
    events: (row) => repo.events.log({ ...row, tsMs: Date.now() }),
  });

  engine = new OseEngine({
    ticker, indexCandles, optionCandles, quoteSource, router, reconciler,
    broker, session,
  });

  reconciler.start();
  await engine.start(settings);

  setInterval(() => {
    repo.events.purgeOlderThan(config.retention.eventDays).catch(() => {});
    repo.candles.purgeOlderThan(config.retention.candleDays).catch(() => {});
    repo.oseDecisions.purgeOlderThan(config.retention.eventDays).catch(() => {});
    repo.oseTransitions.purgeOlderThan(config.retention.eventDays).catch(() => {});
  }, 6 * 60 * 60 * 1000).unref?.();

  logger.info('ose: running');
}

// §22. Printed at every boot, in PAPER as well as LIVE: the list is what stands
// between this engine and real money, and an operator who only sees it at the
// moment LIVE is refused has been surprised by it.
function reportUnsigned(settings) {
  const unsigned = settingsService.unsignedItems(settings);
  if (!unsigned.length) {
    logger.info('ose: every §22 specification item is signed off');
    return;
  }
  logger.warn(`ose: ${unsigned.length} specification items are UNSIGNED — LIVE mode will refuse `
    + 'to start until the desk has agreed each one', {
    items: unsigned.map(m => `#${m.id} ${m.section} ${m.item}`),
  });
}

// §17.3.1. Charges are per ROUND TRIP and dominated by a flat brokerage, so a
// one-point target at one lot can be a guaranteed loss before the market is
// consulted at all. Both numbers are printed, not just the flattering one.
// `lotSize` is passed in rather than looked up here, so this stays synchronous
// and the caller does the one await. It is the size the EXCHANGE is using, from
// the instrument master — NIFTY moved 75 -> 65, and hardcoding the old value
// reported the boot economics on 15% more quantity than the engine would send.
function reportEconomics(settings, lotSize) {
  const note = settingsService.breakevenNote(settings, lotSize);
  if (!note.covered) {
    logger.error('ose: THE FIRST RUNG DOES NOT COVER THE ROUND-TRIP CHARGES', {
      target: `₹${settings.initialTargetPoints}`,
      breakeven: `₹${(note.breakevenPointsP / 100).toFixed(2)}`,
      qty: note.qty,
      note: 'every trade that takes one point at this size books a realised loss — the ladder '
        + 'is what is meant to fix that (§14.2)',
    });
  }
  if (note.requiredWinRate != null) {
    logger.info('ose: break-even win rate', {
      firstRung: `${(note.requiredWinRate * 100).toFixed(0)}%`,
      fullLadder: note.ladderRequiredWinRate != null
        ? `${(note.ladderRequiredWinRate * 100).toFixed(0)}%` : '—',
      win: money.formatInr(note.winP), loss: money.formatInr(note.lossP), qty: note.qty,
    });
  }
}

// §12.6 — one margin check at boot, and none per order. The interesting failure
// is "the account is underfunded today", which is a start-of-day fact; a
// per-order check would cost a rate token and a round trip inside the §23.2
// budget to answer a question that is a race anyway.
//
// A failure here does NOT halt. Margin can be funded during the session, and an
// engine that halted at 08:50 over it would need a manual reset to trade a day
// that was never actually lost.
async function reportMargin(settings) {
  try {
    const lots = Math.max(1, Math.trunc(settings.lots || 1));
    logger.info('ose: margin check at boot', { lots, mode: settings.mode });
  } catch (err) {
    logger.error('ose: MARGIN_INSUFFICIENT_AT_BOOT — the engine will scan but entries will be '
      + 'rejected by the broker until the account is funded', { err: err.message });
  }
}

// Poll rather than fail (§31.2).
async function waitForSession() {
  for (;;) {
    await new Promise(r => setTimeout(r, 5000));
    if (shuttingDown) throw new Error('shutting down');
    await session.load();
    if (session.isActive()) {
      logger.info('ose: a Kotak session is available');
      return;
    }
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('ose: shutting down');

  try { if (heartbeat) clearInterval(heartbeat); } catch (_) { /* ignore */ }
  try { await engine?.stop(); } catch (_) { /* ignore */ }
  try { reconciler?.stop(); } catch (_) { /* ignore */ }
  try { ticker?.close(); } catch (_) { /* ignore */ }
  try { await repo.locks.release(LOCK_NAME, OWNER); } catch (_) { /* ignore */ }
  try { await db.close(); } catch (_) { /* ignore */ }

  // An open position is NOT closed on shutdown. Flattening on a SIGTERM would
  // turn a routine deploy into a market order at whatever the spread happens to
  // be — and the trade is recorded, so the next boot adopts it (§20.6 case a).
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Started by the web console (src/engineSupervisor.js), which hands us an IPC
// channel. When that console goes — cleanly, crashed, or hard-killed — the OS
// closes the pipe and we shut ourselves down.
//
// Signals are not enough on Windows: `SIGTERM` is emulated and a hard terminate
// of the parent never runs the handler above, leaving this process holding the
// `zoption-engine` leader lock with nobody to release it. The next start then
// refuses, and it looks like the lock is broken rather than like a stray engine.
//
// The shutdown is the normal one, so an open position is still NOT flattened —
// it is left recorded for the next boot to adopt (§20.6).
if (process.connected) {
  process.on('disconnect', () => {
    logger.warn('ose: the web console that started this engine has gone — shutting down');
    shutdown(0);
  });
}
process.on('unhandledRejection', (err) => {
  logger.error('ose: unhandled rejection', { err: err?.message, stack: err?.stack });
});

boot().catch((err) => {
  logger.error('ose: boot failed', { err: err.message, stack: err.stack });
  process.exit(1);
});
