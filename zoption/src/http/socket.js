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
const terminal = require('../market/terminal');
const auth = require('./middleware/auth');

const PUSH_MS = 1000;

// The terminal's own room. Its traffic is a tick stream and a 40-row table once
// a second — pushing that to a dashboard tab that is not showing a chart would
// be pure waste, so a client opts in by joining and the feed only runs while
// somebody is in here.
const TERMINAL_ROOM = 'terminal';

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

  attachTerminal(io);

  io.on('connection', (socket) => {
    logger.debug('socket: connected', { id: socket.id });
    push(io).catch(() => {});          // do not make a fresh tab wait a second

    // --- terminal ---------------------------------------------------------
    // Joining starts the feed if it is not already running; leaving (or closing
    // the tab) releases it. Every handler answers on `terminal_error` rather
    // than throwing, because a rejected subscribe must leave the page usable
    // and saying why.
    socket.on('terminal:join', async (req = {}, ack) => {
      socket.join(TERMINAL_ROOM);
      try {
        const ok = await terminal.ensure({
          viewer: socket.id,
          underlying: req.symbol || undefined,
          expiry: req.expiry || null,
          range: req.range || undefined,
          timeoutMs: 6000,
        });
        socket.emit('terminal_status', terminal.status());
        if (ok) socket.emit('option_chain_update', terminal.buildChain());
        if (typeof ack === 'function') ack({ ok, status: terminal.status() });
      } catch (err) {
        socket.emit('terminal_error', { message: err.message });
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
      }
    });

    socket.on('terminal:chain', async (req = {}, ack) => {
      try {
        await terminal.setChain({
          underlying: req.symbol || undefined,
          expiry: req.expiry || null,
          range: req.range || undefined,
        });
        socket.emit('terminal_status', terminal.status());
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
        socket.emit('terminal_error', { message: err.message });
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
      }
    });

    // Module 3 follows one contract at a time. Passing null detaches it, which
    // is what closing the premium chart should do — otherwise a session spent
    // clicking through strikes ends up subscribed to all of them.
    socket.on('terminal:option', (req = {}) => {
      try { terminal.setOption(req.token || null); } catch (err) {
        socket.emit('terminal_error', { message: err.message });
      }
    });

    socket.on('terminal:leave', () => {
      socket.leave(TERMINAL_ROOM);
      terminal.removeViewer(socket.id);
    });

    socket.on('disconnect', () => {
      logger.debug('socket: disconnected', { id: socket.id });
      terminal.removeViewer(socket.id);
    });
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
    close() {
      running = false;
      // The feed holds a market-data socket and a poll timer; leaving it up
      // after the HTTP server has gone would keep the process alive and keep
      // spending the account's rate limit on a terminal nobody can see.
      try { terminal.stop(); } catch (_) { /* already stopped */ }
      io.close();
    },
  };
}

// Wire the feed's events into the room. Bound ONCE per server rather than per
// connection: a listener added on every connect would fan a single tick out
// once per open tab and leak a listener on every reload.
function attachTerminal(io) {
  const room = () => io.to(TERMINAL_ROOM);
  terminal.on('index_tick', (t) => room().emit('index_tick', t));
  terminal.on('option_tick', (t) => room().emit('option_tick', t));
  terminal.on('option_chain_update', (c) => room().emit('option_chain_update', c));
  terminal.on('status', (s) => room().emit('terminal_status', s));
  // The feed is an EventEmitter with no error listener by default, and an
  // unhandled 'error' would take the web process down with it.
  terminal.on('error', (err) => {
    logger.warn('terminalFeed: error', { err: err?.message });
    room().emit('terminal_error', { message: err?.message || 'market data error' });
  });
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
