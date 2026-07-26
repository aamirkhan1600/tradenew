// Engine process — the trading tier.
//
// Run alongside the web tier (`npm start`). Separating them is deliberate: the
// web process serves pages and can be restarted, scaled or crashed by a bad
// request without touching a live position, while the engine does one thing and
// can be reasoned about on its own.
//
// Several engines may be started for redundancy. Only one trades — they compete
// for a DB-backed leader lock and the losers stand by, ready to take over
// within ENGINE_LOCK_TTL_MS if the leader dies.
//
//   APP_ROLE=engine npm run engine

process.env.APP_ROLE = process.env.APP_ROLE || 'engine';

const config = require('./config');
const logger = require('./core/logger');
const db = require('./core/db');
const repo = require('./repositories');
const { Supervisor } = require('./strategy/supervisor');
const feed = require('./market/feed');

const supervisor = new Supervisor();
let shuttingDown = false;

async function main() {
  logger.info('engine: booting', { engineId: config.engine.id, env: config.env });

  if (!await db.healthCheck()) {
    logger.error('engine: database unreachable — refusing to start');
    process.exit(1);
  }

  // Warm the feeds for everyone with a live Kite session so the first tick has
  // prices instead of an empty cache.
  const zerodhaUsers = await repo.brokers.listConnected('zerodha');
  for (const row of zerodhaUsers) {
    await feed.attach(row.user_id).catch(err =>
      logger.warn('engine: feed attach failed', { userId: row.user_id, err: err.message }));
  }
  logger.info('engine: feeds warmed', { users: zerodhaUsers.length });

  await supervisor.start();

  // Recovery probe. A broker session can be fixed outside this application —
  // by enabling an entitlement, or simply by the next day's login — and nothing
  // here would otherwise notice.
  const RECOVERY_MS = 5 * 60 * 1000;
  setInterval(async () => {
    try {
      const r = await feed.recoverFailedSessions();
      if (r.recovered) logger.info('engine: recovered market-data sessions', r);
    } catch (err) {
      logger.warn('engine: recovery probe failed', { err: err.message });
    }
  }, RECOVERY_MS).unref();

  // Retention sweep. Ticks and audit events accumulate fast at a per-second
  // cadence across a few hundred strikes.
  setInterval(async () => {
    try {
      const events = await repo.events.purge(config.retention.eventDays);
      const ticks = await repo.ticks.purge(config.retention.tickDays);
      if (events || ticks) logger.info('engine: retention sweep', { events, ticks });
    } catch (err) {
      logger.warn('engine: retention sweep failed', { err: err.message });
    }
  }, 6 * 60 * 60 * 1000).unref();

  logger.info('engine: running');
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`engine: ${signal} received, shutting down`);
  // Open positions are intentionally NOT squared off here. A restart is not a
  // reason to exit a trade at market; the next engine adopts it through
  // reconciliation, and the broker-side risk is unchanged in the meantime.
  try { await supervisor.stop(signal); } catch (_) { /* best effort */ }
  try { await db.close(); } catch (_) { /* best effort */ }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  logger.error('engine: unhandled rejection', { err: err?.message, stack: err?.stack });
});

// An uncaught exception leaves the process in an unknown state. With money in
// the market the safe move is to die and let the supervisor (systemd, pm2,
// docker) restart us into reconciliation — not to limp on.
process.on('uncaughtException', (err) => {
  logger.error('engine: uncaught exception — exiting for a clean restart', {
    err: err.message, stack: err.stack,
  });
  process.exit(1);
});

main().catch((err) => {
  logger.error('engine: boot failed', { err: err.message, stack: err.stack });
  process.exit(1);
});

module.exports = { supervisor };
