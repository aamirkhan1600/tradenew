#!/usr/bin/env node
// The Price-Filter Engine's trading process — doc/new.md.
//
//   npm start   the web console. Nothing trades.
//   npm run pfe THIS. It holds the WebSocket, builds both candle series, runs
//               the scan and places the orders.
//
// ---------------------------------------------------------------------------
// It takes the SAME leader lock as the offset scalper, on purpose
// ---------------------------------------------------------------------------
//
// `zoption-engine` is a single lock and both engines contend for it, so exactly
// one trading process can be live against this account at a time. That is not
// an oversight to be tidied up later — it is the design:
//
//   * one Kotak account, and both strategies sell NAKED options on it. Two
//     processes selling at once is two positions the margin was never sized for
//     and two sets of exits racing each other.
//   * doc/new.md §12 says "maximum simultaneous positions: 1", and a limit the
//     engine enforces on itself while a second process ignores it is not a
//     limit.
//
// So starting this while `npm run engine` is up refuses, loudly, with the name
// of the process that holds the lock. Stop one to run the other.

const config = require('./config');
const logger = require('./core/logger');
const db = require('./core/db');
const money = require('./core/money');
const repo = require('./repositories');
const settingsService = require('./pfe/settings');
const brokerRegistry = require('./broker');
const session = require('./broker/neoSession');
const instrumentMaster = require('./market/instrumentMaster');
const { Ticker } = require('./market/ticker');
const { CandleBuilder } = require('./market/candleBuilder');
const { QuoteSource } = require('./market/quoteSource');
const { OrderRouter } = require('./execution/orderRouter');
const { Reconciler } = require('./execution/reconciler');
const { PfeEngine } = require('./pfe/engine');

// Shared with src/engine.js — see the header.
const LOCK_NAME = 'zoption-engine';
const OWNER = `pfe-${config.engine.id}`;

let engine = null;
let ticker = null;
let reconciler = null;
let heartbeat = null;
let shuttingDown = false;

async function boot() {
  logger.info('pfe: booting', { id: OWNER, env: config.env });

  if (!await db.healthCheck()) throw new Error('the database is not reachable');

  const got = await repo.locks.acquire(LOCK_NAME, OWNER, config.engine.lockTtlMs);
  if (!got) {
    logger.error('pfe: another trading process holds the lock — refusing to start. '
      + 'Only one engine may trade this account at a time; stop `npm run engine` first.');
    process.exit(1);
  }
  heartbeat = setInterval(() => {
    repo.locks.acquire(LOCK_NAME, OWNER, config.engine.lockTtlMs)
      .then((still) => {
        if (!still) {
          logger.error('pfe: lost the leader lock — shutting down to avoid double orders');
          shutdown(1);
        }
      })
      .catch(err => logger.warn('pfe: heartbeat failed', { err: err.message }));
  }, Math.floor(config.engine.lockTtlMs / 3));
  heartbeat.unref?.();

  const settings = await settingsService.load();

  await session.load();
  if (!session.isActive()) {
    logger.warn('pfe: no active Kotak session — waiting. Log in on the Broker page at '
      + `${config.appUrl}/brokers`);
    await waitForSession();
  }

  // The master changes daily as contracts are added and expire. A stale row
  // points at a contract that no longer exists and the scanner would happily
  // rank it.
  try {
    await instrumentMaster.syncAll(session.session);
  } catch (err) {
    const have = await repo.instruments.count();
    if (!have) throw new Error(`the instrument master is empty and the sync failed: ${err.message}`);
    logger.warn('pfe: the instrument sync failed — carrying on with the stored master',
      { err: err.message, rows: have });
  }

  const broker = brokerRegistry.adapterFor(settings.mode);
  if (broker.mode === 'PAPER') {
    logger.warn('pfe: PAPER mode — orders are simulated against the live tick stream. '
      + 'Nothing reaches the exchange.');
  } else {
    logger.warn('pfe: LIVE mode — orders will reach the exchange.');
    reportEconomics(settings);
  }

  ticker = new Ticker({ session, label: 'pfe' });
  ticker.on('auth_expired', () => {
    logger.error('pfe: market data authentication expired — waiting for a fresh login');
  });
  ticker.connect();

  // TWO builders, deliberately separate objects.
  //
  // The index series decides WHETHER a side may trade (Modules 3, 4, 7). The
  // option series decides at WHAT PRICE (Module 5). Keeping them in different
  // objects means an index bar cannot be mistaken for an option bar by anything
  // downstream — the strongest available guarantee that the index can never
  // price an order.
  const indexCandles = new CandleBuilder({
    timeframe: settings.trendTimeframe,
    minTicks: settings.trendMinTicks,
  });
  const optionCandles = new CandleBuilder({
    timeframe: settings.optionTimeframe,
    minTicks: settings.optionMinTicks,
  });

  // The chain scan needs open interest, volume and the book, which live behind
  // quote filters this account may or may not be entitled to. QuoteSource
  // probes that ONCE, at the first snapshot, and reports what it settled on.
  const quoteSource = new QuoteSource({
    session, batchSize: config.neo.quoteBatch, label: 'pfe-scan',
  });

  reconciler = new Reconciler({ broker, intervalMs: Math.min(1000, config.engine.tickMs) });

  const router = new OrderRouter({
    broker,
    events: (row) => repo.events.log({ ...row, tsMs: Date.now() }),
  });

  engine = new PfeEngine({
    ticker, indexCandles, optionCandles, quoteSource, router, reconciler,
    broker: brokerRegistry,
  });

  reconciler.start();
  await engine.start(settings);

  setInterval(() => {
    repo.events.purgeOlderThan(config.retention.eventDays).catch(() => {});
    repo.candles.purgeOlderThan(config.retention.candleDays).catch(() => {});
    repo.pfeScans.purgeOlderThan(config.retention.eventDays).catch(() => {});
  }, 6 * 60 * 60 * 1000).unref?.();

  logger.info('pfe: running');
}

// Said at every live boot. doc/new.md's shipped 1.0 target against a 2.0 stop is
// the losing side of a risk/reward before charges are considered at all, and the
// whole strategy rests on the ladder making that back — so both numbers are
// printed, not just the flattering one.
function reportEconomics(settings) {
  const note = settingsService.breakevenNote(settings, 75);
  if (!note.covered) {
    logger.warn('pfe: the first rung does not cover the round-trip charges', {
      target: `₹${settings.target}`,
      breakeven: `₹${(note.breakevenPointsP / 100).toFixed(2)}`,
      qty: note.qty,
      note: 'every trade that takes one point at this size books a realised loss',
    });
  }
  if (note.requiredWinRate != null) {
    const first = `${(note.requiredWinRate * 100).toFixed(0)}%`;
    const full = note.ladderRequiredWinRate != null
      ? `${(note.ladderRequiredWinRate * 100).toFixed(0)}%` : '—';
    const line = {
      firstRung: first,
      fullLadder: `${full} at ₹${(note.ladderTargetP / 100).toFixed(2)}`,
      win: money.formatInr(note.winP), loss: money.formatInr(note.lossP), qty: note.qty,
    };
    if (note.requiredWinRate >= 0.6) {
      logger.warn(`pfe: taking one point needs a ${first} win rate to break even — the target `
        + 'ladder is what is meant to fix that', line);
    } else {
      logger.info(`pfe: break-even win rate ${first} on the first rung`, line);
    }
  }
}

// Poll rather than fail. An engine that exits because nobody had logged in yet
// is an engine an operator has to babysit.
async function waitForSession() {
  for (;;) {
    await new Promise(r => setTimeout(r, 5000));
    if (shuttingDown) throw new Error('shutting down');
    await session.load();
    if (session.isActive()) {
      logger.info('pfe: a Kotak session is available');
      return;
    }
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('pfe: shutting down');

  try { if (heartbeat) clearInterval(heartbeat); } catch (_) { /* ignore */ }
  try { await engine?.stop(); } catch (_) { /* ignore */ }
  try { reconciler?.stop(); } catch (_) { /* ignore */ }
  try { ticker?.close(); } catch (_) { /* ignore */ }
  try { await repo.locks.release(LOCK_NAME, OWNER); } catch (_) { /* ignore */ }
  try { await db.close(); } catch (_) { /* ignore */ }

  // An open position is NOT closed on shutdown. Flattening on a SIGTERM would
  // turn a routine deploy into a market order at whatever the spread happens to
  // be — and the trade is recorded, so the next boot adopts it.
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('unhandledRejection', (err) => {
  logger.error('pfe: unhandled rejection', { err: err?.message, stack: err?.stack });
});

boot().catch((err) => {
  logger.error('pfe: boot failed', { err: err.message, stack: err.stack });
  process.exit(1);
});
