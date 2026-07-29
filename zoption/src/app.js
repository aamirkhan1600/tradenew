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

// Views format prices and money in a dozen places; giving them the helpers
// beats re-deriving the formatting in EJS.
app.locals.money = money;
app.locals.appName = 'zoption';

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

async function boot() {
  if (!await db.healthCheck()) {
    throw new Error('the database is not reachable — check DB_* in .env and run npm run migrate');
  }
  server.listen(config.port, () => {
    logger.info(`app: listening on ${config.appUrl}`);
    logger.info('app: this process does not trade — run `npm run engine` alongside it');
  });
}

async function shutdown() {
  logger.info('app: shutting down');
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
