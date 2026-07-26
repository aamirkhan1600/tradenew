// Strategy CRUD, live status, and reporting.
//
// The web tier does not talk to the engine directly — it reads and writes the
// database, and the engine picks changes up on its next tick. That keeps the
// two processes independently restartable and means a wedged web request can
// never stall a live position.

const repo = require('../../repositories');
const strategyConfig = require('../../strategy/config');
const { EXPOSED_STATES } = require('../../strategy/stateMachine');
const { LOCK_NAME } = require('../../strategy/supervisor');
const config = require('../../config');
const money = require('../../core/money');
const { ValidationError, NotFoundError, ConflictError } = require('../../core/errors');

const parseConfig = (raw) => {
  try { return strategyConfig.normalise(JSON.parse(raw || '{}')); }
  catch (_) { return strategyConfig.defaults(); }
};

function present(row) {
  return {
    id: Number(row.id),
    name: row.name,
    enabled: !!row.enabled,
    state: row.status,
    queuePriority: Number(row.queue_priority),
    config: parseConfig(row.config),
    runtime: safeParse(row.state, {}),
    lastDecision: row.last_decision,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function safeParse(raw, fallback) {
  try { return JSON.parse(raw || 'null') ?? fallback; } catch (_) { return fallback; }
}

/* ---------------------------------------------------------------- pages -- */
async function dashboardPage(req, res) {
  res.render('dashboard', { title: 'Live', user: req.user });
}

async function strategiesPage(req, res) {
  res.render('strategies', {
    title: 'Strategies', user: req.user,
    defaults: strategyConfig.defaults(),
    options: {
      underlyings: strategyConfig.UNDERLYINGS,
      optionTypes: strategyConfig.OPTION_TYPES,
      hedgeModes: strategyConfig.HEDGE_MODES,
      offsetFrom: strategyConfig.OFFSET_FROM,
      modes: strategyConfig.MODES,
      products: strategyConfig.PRODUCTS,
    },
  });
}

async function tradesPage(req, res) {
  res.render('trades', { title: 'Trades', user: req.user });
}

async function eventsPage(req, res) {
  res.render('events', { title: 'Audit trail', user: req.user });
}

/* -------------------------------------------------------------- live ---- */
// One call powering the dashboard: engine health, every strategy, open trades.
async function liveStatus(req, res) {
  const userId = req.user.id;
  const [rows, openTrades, lock, halted, zerodha, kotak] = await Promise.all([
    repo.strategies.listByUser(userId),
    repo.trades.listOpen(userId),
    repo.locks.status(LOCK_NAME),
    repo.flags.isTradingHalted(),
    repo.brokers.get(userId, 'zerodha'),
    repo.brokers.get(userId, 'kotak'),
  ]);

  const today = new Date();
  const tradeByStrategy = new Map();
  for (const t of openTrades) tradeByStrategy.set(Number(t.strategy_id), t);

  const strategies = [];
  for (const row of rows) {
    const stats = await repo.dailyStats.get(row.id);
    const openTrade = tradeByStrategy.get(Number(row.id)) || null;
    strategies.push({
      ...present(row),
      exposed: EXPOSED_STATES.has(row.status),
      today: stats || { trades: 0, wins: 0, losses: 0, netPnl: 0, grossPnl: 0, charges: 0 },
      trade: openTrade ? presentTrade(openTrade) : null,
    });
  }

  // The engine heartbeats every tick; a stale lock means it is not running.
  const lockAge = lock ? Number(lock.age) : null;
  const engineAlive = lockAge != null && lockAge * 1000 < config.engine.lockTtlMs;

  const netToday = strategies.reduce((a, s) => a + Number(s.today.netPnl || 0), 0);

  res.json({
    engine: {
      alive: engineAlive,
      owner: lock?.owner || null,
      heartbeatAgeSec: lockAge,
      tickMs: config.engine.tickMs,
      halted,
    },
    brokers: {
      zerodha: zerodha?.accessToken ? zerodha.status : 'DISCONNECTED',
      kotak: kotak?.sessionToken ? kotak.status : 'DISCONNECTED',
    },
    strategies,
    openTrades: openTrades.map(presentTrade),
    totals: { netToday: money.round(netToday), openCount: openTrades.length },
    serverTime: today.toISOString(),
  });
}

function presentTrade(t) {
  return {
    id: Number(t.id), strategyId: Number(t.strategy_id), status: t.status,
    underlying: t.underlying, optionType: t.option_type,
    sellStrike: numOrNull(t.sell_strike), sellPrice: numOrNull(t.sell_price),
    sellExitPrice: numOrNull(t.sell_exit_price),
    hedgeStrike: numOrNull(t.hedge_strike), hedgePrice: numOrNull(t.hedge_price),
    hedgeExitPrice: numOrNull(t.hedge_exit_price),
    qty: Number(t.qty), lots: t.lots,
    targetPrice: numOrNull(t.target_price), targetPoints: numOrNull(t.target_points),
    slPrice: numOrNull(t.sl_price),
    exitReason: t.exit_reason, mode: t.mode,
    grossPnl: numOrNull(t.gross_pnl), charges: numOrNull(t.charges), netPnl: numOrNull(t.net_pnl),
    tradeDate: t.trade_date, openedAt: t.opened_at, closedAt: t.closed_at,
  };
}

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ----------------------------------------------------------------- CRUD -- */
async function list(req, res) {
  const rows = await repo.strategies.listByUser(req.user.id);
  res.json({ strategies: rows.map(present), defaults: strategyConfig.defaults() });
}

async function get(req, res) {
  const row = await repo.strategies.get(req.params.id, req.user.id);
  if (!row) throw new NotFoundError('strategy not found');
  res.json(present(row));
}

async function create(req, res) {
  const cfg = strategyConfig.normalise(req.body || {});
  const lotSize = await repo.instruments.lotSize(cfg.underlying);
  const errors = strategyConfig.validate(cfg, { lotSize });
  if (errors.length) throw new ValidationError(errors[0], { errors });

  const name = String(req.body?.name || 'Premium selling').slice(0, 100);
  const id = await repo.strategies.create(req.user.id, {
    name, config: cfg, queuePriority: clampPriority(req.body?.queuePriority),
  });
  await repo.events.record({
    userId: req.user.id, strategyId: id, eventType: 'CONFIG',
    message: `strategy "${name}" created`, meta: { config: cfg },
  });
  res.status(201).json({ ok: true, id });
}

async function update(req, res) {
  const row = await repo.strategies.get(req.params.id, req.user.id);
  if (!row) throw new NotFoundError('strategy not found');
  // A live trade was opened under the old config — its target, stop and sizing
  // all derive from it. Editing mid-flight would silently re-aim an open
  // position, so it is refused rather than merged.
  if (EXPOSED_STATES.has(row.status)) {
    throw new ConflictError(`strategy is ${row.status} — square off before editing it`);
  }

  const cfg = strategyConfig.normalise(req.body || {}, parseConfig(row.config));
  const lotSize = await repo.instruments.lotSize(cfg.underlying);
  const errors = strategyConfig.validate(cfg, { lotSize });
  if (errors.length) throw new ValidationError(errors[0], { errors });

  const name = req.body?.name !== undefined ? String(req.body.name).slice(0, 100) : row.name;
  await repo.strategies.update(row.id, req.user.id, {
    name, config: cfg,
    queuePriority: req.body?.queuePriority !== undefined
      ? clampPriority(req.body.queuePriority) : row.queue_priority,
  });
  await repo.events.record({
    userId: req.user.id, strategyId: row.id, eventType: 'CONFIG',
    message: `strategy "${name}" updated`, meta: { config: cfg },
  });
  res.json({ ok: true, config: cfg });
}

async function remove(req, res) {
  const row = await repo.strategies.get(req.params.id, req.user.id);
  if (!row) throw new NotFoundError('strategy not found');
  if (EXPOSED_STATES.has(row.status)) {
    throw new ConflictError(`strategy is ${row.status} — square off before deleting it`);
  }
  await repo.strategies.remove(row.id, req.user.id);
  res.json({ ok: true });
}

async function toggle(req, res) {
  const row = await repo.strategies.get(req.params.id, req.user.id);
  if (!row) throw new NotFoundError('strategy not found');
  const enabled = req.body?.enabled === undefined ? !row.enabled : !!req.body.enabled;

  if (!enabled && EXPOSED_STATES.has(row.status)) {
    // Disabling does not abandon a position — the engine keeps managing it to
    // its exit and simply takes no new entry. Say so, rather than implying the
    // trade has been dropped.
    await repo.strategies.setEnabled(row.id, req.user.id, false);
    return res.json({
      ok: true, enabled: false,
      notice: 'Disabled. The open position will still be managed to its exit.',
    });
  }

  await repo.strategies.setEnabled(row.id, req.user.id, enabled);
  await repo.events.record({
    userId: req.user.id, strategyId: row.id, eventType: 'CONFIG',
    message: `strategy ${enabled ? 'enabled' : 'disabled'}`,
  });
  return res.json({ ok: true, enabled });
}

// Ask the engine to flatten. Setting the flag is the web tier's whole job here;
// the engine performs the exit in the correct leg order on its next tick.
async function squareOff(req, res) {
  const row = await repo.strategies.get(req.params.id, req.user.id);
  if (!row) throw new NotFoundError('strategy not found');
  const trade = await repo.trades.openForStrategy(row.id);
  if (!trade) throw new ConflictError('this strategy has no open trade');

  // Written to its own columns, NOT into `state` — the engine rewrites `state`
  // every tick and would overwrite the request before ever reading it.
  const accepted = await repo.strategies.requestSquareOff(row.id, req.user.id, req.user.email);
  await repo.events.record({
    userId: req.user.id, strategyId: row.id, tradeId: trade.id,
    eventType: 'SQUARE_OFF', level: 'WARN',
    message: accepted
      ? `square-off requested by ${req.user.email}`
      : `square-off re-requested by ${req.user.email} (one is already pending)`,
  });
  res.json({
    ok: true,
    notice: accepted
      ? 'Square-off requested — the engine will exit on its next tick.'
      : 'A square-off is already pending for this strategy.',
  });
}

/* ------------------------------------------------------------ economics -- */
// Live cost preview for the strategy form: what four legs cost at this size and
// the smallest target that clears them.
async function economics(req, res) {
  const cfg = strategyConfig.normalise(req.query || {});
  const lotSize = await repo.instruments.lotSize(cfg.underlying);
  res.json(strategyConfig.economics(cfg, lotSize));
}

/* ------------------------------------------------------------ reporting -- */
async function trades(req, res) {
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 200);
  const strategyId = req.query.strategyId ? Number(req.query.strategyId) : null;
  const rows = await repo.trades.listByUser(req.user.id, { limit, strategyId });
  res.json({ trades: rows.map(presentTrade) });
}

async function events(req, res) {
  const limit = Math.min(1000, parseInt(req.query.limit, 10) || 200);
  const rows = await repo.events.list(req.user.id, {
    limit,
    strategyId: req.query.strategyId ? Number(req.query.strategyId) : null,
    tradeId: req.query.tradeId ? Number(req.query.tradeId) : null,
  });
  res.json({ events: rows });
}

async function orders(req, res) {
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 200);
  res.json({ orders: await repo.orders.listByUser(req.user.id, limit) });
}

async function report(req, res) {
  const daily = await repo.trades.dailyReport(req.user.id, 60);
  res.json({
    daily: daily.map(d => ({
      ...d,
      winRate: Number(d.total) ? Math.round((Number(d.wins) / Number(d.total)) * 100) : 0,
    })),
  });
}

/* ----------------------------------------------------------- kill switch -- */
async function setHalt(req, res) {
  const halted = req.body?.halted === true || req.body?.halted === 'true';
  await repo.flags.set('trading_halted', halted, `set by ${req.user.email}`);
  await repo.events.record({
    userId: req.user.id, eventType: 'HALT', level: 'WARN',
    message: `trading ${halted ? 'HALTED' : 'resumed'} by ${req.user.email}`,
  });
  res.json({ ok: true, halted });
}

function clampPriority(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(99, n));
}

module.exports = {
  dashboardPage, strategiesPage, tradesPage, eventsPage,
  liveStatus, list, get, create, update, remove, toggle, squareOff,
  economics, trades, events, orders, report, setHalt,
};
