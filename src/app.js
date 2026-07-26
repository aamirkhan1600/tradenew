// Web tier — the operator's console.
//
// Serves the UI and the JSON API. It does NOT trade: the engine process
// (src/engine.js) owns every order. The two communicate only through the
// database, which is what lets this process be restarted, scaled or crashed by
// a bad request without any risk to a live position.
//
//   npm start        # this process
//   npm run engine   # the trading process — required for anything to execute

process.env.APP_ROLE = process.env.APP_ROLE || 'app';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const config = require('./config');
const logger = require('./core/logger');
const db = require('./core/db');
const repo = require('./repositories');
const routes = require('./http/routes');
const auth = require('./http/middleware/auth');
const { notFound, errorHandler } = require('./http/middleware/errors');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');
if (config.isProd) app.set('trust proxy', 1);

// The pages carry small inline scripts, so 'unsafe-inline' is required for
// them; everything else stays locked to self. No external CDN is used, which
// is what makes that acceptable.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(cookieParser());
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

app.use(auth.loadUser);
app.use(routes);
app.use(notFound);
app.use(errorHandler);

let server;

async function main() {
  if (!await db.healthCheck()) {
    logger.error('app: database unreachable — run `npm run migrate` first');
    process.exit(1);
  }

  // The audit trail grows at roughly one row per state evaluation. Trim it here
  // as well as in the engine so retention holds even if the engine is down.
  setInterval(async () => {
    try {
      const purged = await repo.events.purge(config.retention.eventDays);
      if (purged) logger.info('app: purged old events', { purged });
    } catch (err) {
      logger.warn('app: event purge failed', { err: err.message });
    }
  }, 6 * 60 * 60 * 1000).unref();

  server = app.listen(config.port, () => {
    logger.info('app: listening', { port: config.port, env: config.env, url: config.appUrl });
  });
}

async function shutdown(signal) {
  logger.info(`app: ${signal} received, shutting down`);
  if (server) server.close();
  try { await db.close(); } catch (_) { /* best effort */ }
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  logger.error('app: unhandled rejection', { err: err?.message, stack: err?.stack });
});

if (require.main === module) {
  main().catch((err) => {
    logger.error('app: boot failed', { err: err.message, stack: err.stack });
    process.exit(1);
  });
}

module.exports = app;
