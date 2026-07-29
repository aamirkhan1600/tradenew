// Socket.IO push, replacing what a Redis channel would do in a bigger system.
//
// The engine and the web app are separate processes, so the app cannot receive
// the engine's in-process events. It polls the database on a short interval and
// pushes what changed. At one operator and a one-second cadence that is a
// handful of indexed queries a second — cheaper than any broker, and it means
// the browser sees exactly what is committed rather than what the engine
// believes.

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../core/logger');
const time = require('../core/time');
const repo = require('../repositories');
const auth = require('./middleware/auth');

const PUSH_MS = 1000;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function attach(httpServer) {
  const io = new Server(httpServer, { cors: { origin: false } });

  // Same cookie as the pages. An unauthenticated socket is refused rather than
  // connected and starved.
  io.use((socket, next) => {
    const token = parseCookies(socket.handshake.headers.cookie)[auth.COOKIE];
    if (!token) return next(new Error('unauthorized'));
    try {
      socket.data.user = jwt.verify(token, config.jwt.secret);
      return next();
    } catch (_) {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    logger.debug('socket: connected', { id: socket.id });
    push(io).catch(() => {});          // do not make a fresh tab wait a second
    socket.on('disconnect', () => logger.debug('socket: disconnected', { id: socket.id }));
  });

  let lastEventId = 0;
  let running = true;

  const loop = async () => {
    if (!running) return;
    try {
      if (io.engine.clientsCount > 0) lastEventId = await push(io, lastEventId);
    } catch (err) {
      logger.warn('socket: push failed', { err: err.message });
    }
    setTimeout(loop, PUSH_MS).unref?.();
  };
  setTimeout(loop, PUSH_MS).unref?.();

  return {
    io,
    close() { running = false; io.close(); },
  };
}

async function push(io, sinceEventId = 0) {
  const tradeDate = time.tradeDate();
  const [cycle, stats, intent, account, events, trendFlag] = await Promise.all([
    repo.cycles.openCycle(),
    repo.stats.ensure(tradeDate),
    repo.flags.get('engine_intent', 'STOP'),
    repo.broker.get('primary'),
    repo.events.recent(25),
    repo.flags.get('trend_state', null),
  ]);

  const legs = cycle ? await repo.legs.byCycle(cycle.id) : [];

  // The engine writes this flag whenever the index verdict changes; the web tier
  // cannot read the engine's memory, so this is the whole channel.
  let trend = null;
  try { trend = trendFlag ? JSON.parse(trendFlag) : null; } catch (_) { trend = null; }

  io.emit('state', {
    tradeDate,
    intent,
    trend,
    broker: { status: account?.status || 'DISCONNECTED', ucc: account?.ucc || null },
    cycle: cycle && {
      id: cycle.id,
      expiry: cycle.expiry_date,
      ce: cycle.ce_symbol, ceStrike: cycle.ce_strike,
      pe: cycle.pe_symbol, peStrike: cycle.pe_strike,
      spotAtLock: cycle.spot_at_lock, qty: cycle.qty, lockedAt: cycle.locked_at,
    },
    legs: legs.map(l => ({
      optionType: l.option_type, symbol: l.symbol, strike: l.strike, state: l.state,
      attemptSeq: l.attempt_seq, requotes: l.requote_count,
      confirmations: l.confirmations,
      sellP: l.sell_price_p, filledP: l.filled_price_p,
      targetP: l.target_price_p, slP: l.sl_price_p,
    })),
    risk: {
      netPnlP: stats.realized_pnl_p,
      grossPnlP: stats.gross_pnl_p,
      chargesP: stats.charges_p,
      trades: stats.trade_count,
      wins: stats.win_count,
      losses: stats.loss_count,
      consecutiveLosses: stats.consecutive_losses,
      disabled: Boolean(stats.disabled),
      disabledReason: stats.disabled_reason,
    },
  });

  // Only what is new, newest first from the query and reversed for the reader.
  const fresh = events.filter(e => e.id > sinceEventId).reverse();
  if (fresh.length) io.emit('events', fresh);

  return events.length ? Math.max(sinceEventId, events[0].id) : sinceEventId;
}

module.exports = { attach };
