#!/usr/bin/env node
// The web console.
//
// This process serves the UI and the API. It does NOT trade: `npm start` alone
// gives you a dashboard where nothing ever executes. Run `npm run engine`
// alongside it.

const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');
const logger = require('./core/logger');
const db = require('./core/db');
const money = require('./core/money');
const routes = require('./http/routes');
const socket = require('./http/socket');
const { EngineSupervisor } = require('./engineSupervisor');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(helmet({
  // The dashboard uses a couple of small inline scripts and the Socket.IO
  // client from the same origin. No CDN, no external anything.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      imgSrc: ["'self'", 'data:'],
    },
  },
}));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

// The indicator and pattern libraries are ONE implementation shared by the
// server and the browser — see the header of src/shared/indicators.js. They are
// served from src/ rather than copied into public/ so there is no build step to
// forget and no second copy to drift.
app.use('/static/shared', express.static(path.join(__dirname, 'shared'), { maxAge: '1h' }));

// TradingView Lightweight Charts, served from node_modules rather than vendored
// into the repository. The CSP below allows scripts from 'self' only — no CDN,
// which is the point: a trading terminal that stops drawing because someone
// else's CDN is down is not a terminal.
app.use('/static/vendor', express.static(
  path.join(__dirname, '..', 'node_modules', 'lightweight-charts', 'dist'),
  { maxAge: '7d', immutable: true }));

// Views format prices and money in a dozen places; giving them the helpers
// beats re-deriving the formatting in EJS.
app.locals.money = money;
app.locals.appName = 'zoption';

// Cache-buster for the stylesheet.
//
// /static is served with `maxAge: '1h'`, which is right for a file that rarely
// changes and wrong on the day it does: the browser keeps the old copy for an
// hour and a new rule simply does not exist as far as the page is concerned.
// A changed CSS rule then looks like a broken layout, and the only cure anyone
// finds is a hard refresh they should never have needed.
//
// The file's modification time is the version, so the URL changes exactly when
// the file does — cache hits stay cache hits, and an edit is picked up on the
// next restart.
app.locals.assetV = (() => {
  try {
    return String(Math.floor(
      require('fs').statSync(path.join(__dirname, '..', 'public', 'app.css')).mtimeMs));
  } catch (_) {
    return String(Date.now());
  }
})();

app.use(routes);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'not found' });
  return res.status(404).render('error', { status: 404, message: 'Page not found.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    logger.error('http: unhandled', { err: err.message, stack: err.stack, path: req.path });
  } else {
    logger.warn('http: rejected', { err: err.message, path: req.path, status });
  }
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ ok: false, error: err.message, code: err.code || 'error' });
  }
  return res.status(status).render('error', {
    status,
    message: status >= 500 ? 'Something went wrong.' : err.message,
  });
});

const server = http.createServer(app);
const sockets = socket.attach(server);

// `npm start` brings up the trading engine too — see src/engineSupervisor.js for
// what that couples together and why it is survivable.
const engineSupervisor = new EngineSupervisor();

async function boot() {
  if (!await db.healthCheck()) {
    throw new Error('the database is not reachable — check DB_* in .env and run npm run migrate');
  }
  server.listen(config.port, () => {
    logger.info(`app: listening on ${config.appUrl}`);
    // The web tier still places no orders itself. It now supervises the process
    // that does, which is a different claim from doing the trading.
    engineSupervisor.start();
    if (!config.ose.autostart) {
      logger.info('app: this process does not trade — run `npm run ose` alongside it');
    }
  });
}

async function shutdown() {
  logger.info('app: shutting down');
  // Stop the engine FIRST so it can release the leader lock and close its own
  // pool while the process is still alive to do it.
  try { engineSupervisor.stop(); } catch (_) { /* ignore */ }
  try { sockets.close(); } catch (_) { /* ignore */ }
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref?.();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

boot().catch((err) => {
  logger.error('app: boot failed', { err: err.message });
  process.exit(1);
});
