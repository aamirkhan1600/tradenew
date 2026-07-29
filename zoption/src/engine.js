#!/usr/bin/env node
// The trading process.
//
// `npm start` alone gives you a console where nothing ever trades. This is the
// process that holds the WebSocket, builds the candles and places the orders.
//
// It takes a leader lock before doing any of that. Two engines against one
// account would double every order, and on a naked short that is the worst
// outcome the system can produce — so the second instance refuses to start
// rather than trusting an operator to remember which terminal is which.

const config = require('./config');
const logger = require('./core/logger');
const db = require('./core/db');
const repo = require('./repositories');
const settingsService = require('./strategy/settings');
const brokerRegistry = require('./broker');
const session = require('./broker/neoSession');
const instrumentMaster = require('./market/instrumentMaster');
const { Ticker } = require('./market/ticker');
const { CandleBuilder } = require('./market/candleBuilder');
const { OrderRouter } = require('./execution/orderRouter');
const { Reconciler } = require('./execution/reconciler');
const { RiskManager } = require('./strategy/riskManager');
const { ScalperEngine } = require('./strategy/scalperEngine');

const LOCK_NAME = 'zoption-engine';

let engine = null;
let ticker = null;
let reconciler = null;
let heartbeat = null;
let shuttingDown = false;

async function boot() {
  logger.info('engine: booting', { id: config.engine.id, env: config.env });

  if (!await db.healthCheck()) throw new Error('the database is not reachable');

  const got = await repo.locks.acquire(LOCK_NAME, config.engine.id, config.engine.lockTtlMs);
  if (!got) {
    logger.error('engine: another engine holds the lock — refusing to start. '
      + 'Two engines would double every order.');
    process.exit(1);
  }
  heartbeat = setInterval(() => {
    repo.locks.acquire(LOCK_NAME, config.engine.id, config.engine.lockTtlMs)
      .then((still) => {
        if (!still) {
          logger.error('engine: lost the leader lock — shutting down to avoid double orders');
          shutdown(1);
        }
      })
      .catch(err => logger.warn('engine: heartbeat failed', { err: err.message }));
  }, Math.floor(config.engine.lockTtlMs / 3));
  heartbeat.unref?.();

  const settings = await settingsService.load('default');
  logger.info('engine: settings loaded', {
    mode: settings.mode, timeframe: settings.candleTimeframe,
    offset: settings.sellOffset, target: settings.target, stop: settings.stopLoss,
    trendFilter: settings.trendFilter
      ? `${settings.trendConfirmBars}×${settings.trendTimeframe}, score ≥ ${settings.trendMinScore}/10`
      : 'off',
  });

  await session.load();
  if (!session.isActive()) {
    logger.warn('engine: no active Kotak session — waiting. Log in on the Broker page '
      + `at ${config.appUrl}/brokers`);
    await waitForSession();
  }

  // The master changes daily as contracts are added and expire. A stale row
  // points at a contract that no longer exists and the selector would happily
  // pick it.
  try {
    await instrumentMaster.syncAll(session.session);
  } catch (err) {
    const have = await repo.instruments.count();
    if (!have) throw new Error(`the instrument master is empty and the sync failed: ${err.message}`);
    logger.warn('engine: the instrument sync failed — carrying on with the stored master',
      { err: err.message, rows: have });
  }

  const broker = brokerRegistry.adapterFor(settings.mode);
  if (broker.mode === 'PAPER') {
    logger.warn('engine: PAPER mode — orders are simulated against the live tick stream. '
      + 'Nothing reaches the exchange.');
  } else {
    logger.warn('engine: LIVE mode — orders will reach the exchange.');
    const note = settingsService.breakevenNote(settings, 75);
    if (!note.covered) {
      logger.warn('engine: the configured target does not cover the round-trip charges', {
        target: `₹${settings.target}`,
        breakeven: `₹${(note.breakevenPointsP / 100).toFixed(2)}`,
        qty: note.qty,
        note: 'every "winning" trade at this size books a realised loss',
      });
    }
  }

  ticker = new Ticker({ session, label: 'engine' });
  ticker.on('auth_expired', () => {
    logger.error('engine: market data authentication expired — waiting for a fresh login');
  });
  ticker.connect();

  const candles = new CandleBuilder({
    timeframe: settings.candleTimeframe,
    minTicks: config.candles.minTicks,
  });

  // A SECOND, separate series for the NIFTY index — doc/update-point.md. It is
  // deliberately a different builder from the one above: these bars decide
  // whether a side may trade and never what it pays, and keeping the two streams
  // in different objects means an index bar cannot be mistaken for an option bar
  // by anything downstream.
  const trendCandles = settings.trendFilter
    ? new CandleBuilder({
      timeframe: settings.trendTimeframe,
      // Its own threshold, not the option series'. A five-second index bar is a
      // different measurement from a one-minute option bar and needs its own
      // answer to "did this bar measure anything".
      minTicks: settings.trendMinTicks,
    })
    : null;

  reconciler = new Reconciler({ broker, intervalMs: Math.min(1000, config.engine.tickMs) });

  const router = new OrderRouter({
    broker,
    events: (row) => repo.events.log({ ...row, tsMs: Date.now() }),
  });

  const risk = new RiskManager();

  engine = new ScalperEngine({
    ticker, candles, trendCandles, router, reconciler, risk, broker: brokerRegistry,
  });

  reconciler.start();
  await engine.start(settings);

  // Housekeeping. Cheap, and it keeps a long-lived install from growing a
  // candles table nobody will ever read.
  setInterval(() => {
    repo.events.purgeOlderThan(config.retention.eventDays).catch(() => {});
    repo.candles.purgeOlderThan(config.retention.candleDays).catch(() => {});
  }, 6 * 60 * 60 * 1000).unref?.();

  logger.info('engine: running');
}

// Poll rather than fail. An engine that exits because nobody had logged in yet
// is an engine an operator has to babysit.
async function waitForSession() {
  for (;;) {
    await new Promise(r => setTimeout(r, 5000));
    if (shuttingDown) throw new Error('shutting down');
    await session.load();
    if (session.isActive()) {
      logger.info('engine: a Kotak session is available');
      return;
    }
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('engine: shutting down');

  try { if (heartbeat) clearInterval(heartbeat); } catch (_) { /* ignore */ }
  try { await engine?.stop(); } catch (_) { /* ignore */ }
  try { reconciler?.stop(); } catch (_) { /* ignore */ }
  try { ticker?.close(); } catch (_) { /* ignore */ }
  try { await repo.locks.release(LOCK_NAME, config.engine.id); } catch (_) { /* ignore */ }
  try { await db.close(); } catch (_) { /* ignore */ }

  // An open position is NOT closed on shutdown. Flattening on a SIGTERM would
  // turn a routine deploy into a market order at whatever the spread happens to
  // be — and the position is recorded, so the next boot adopts it.
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('unhandledRejection', (err) => {
  logger.error('engine: unhandled rejection', { err: err?.message, stack: err?.stack });
});

boot().catch((err) => {
  logger.error('engine: boot failed', { err: err.message, stack: err.stack });
  process.exit(1);
});
