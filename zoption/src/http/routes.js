// The API surface from SDD §20, plus the pages.
//
// The web tier writes INTENT and reads STATE. It never places an order and never
// talks to the broker's trading endpoints — that is the engine's job, and
// keeping the boundary sharp is what makes "how many processes can place an
// order?" answerable by reading one file.
//
// The one exception is broker login, which is interactive by nature: a TOTP has
// to be typed by a human. The session it produces is written to the database and
// the engine picks it up.

const express = require('express');
const config = require('../config');
const logger = require('../core/logger');
const money = require('../core/money');
const time = require('../core/time');
const repo = require('../repositories');
const db = require('../core/db');
const session = require('../broker/neoSession');
const instrumentMaster = require('../market/instrumentMaster');
const history = require('../market/history');
const terminal = require('../market/terminal');
const yahoo = require('../market/yahoo');
const backfill = require('../market/backfill');
const settingsService = require('../strategy/settings');
const auth = require('./middleware/auth');
const { ValidationError } = require('../core/errors');

const router = express.Router();

// Async handlers without a try/catch in every one.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ pages -- */

router.get('/login', (req, res) => {
  if (auth.readUser(req)) return res.redirect('/');
  return res.render('login', { error: null });
});

router.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.render('login', { error: 'Email and password are required.' });

  const user = await auth.findOrCreateUser(String(email).trim().toLowerCase(), password);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    return res.render('login', { error: 'Those credentials were not accepted.' });
  }
  auth.issue(res, user);
  return res.redirect('/');
}));

router.post('/logout', (req, res) => {
  auth.clear(res);
  res.redirect('/login');
});

router.get('/', auth.requirePage, wrap(async (req, res) => {
  res.render('dashboard', { page: 'dashboard', appUrl: config.appUrl });
}));

router.get('/settings', auth.requirePage, wrap(async (req, res) => {
  // withDefaults, not the raw row: a profile written before a config key existed
  // must still render a value rather than a blank input that saves as invalid.
  const raw = settingsService.withDefaults(await repo.settings.get('default'));
  const { warnings } = settingsService.validate(raw);
  res.render('settings', { page: 'settings', settings: raw, warnings, saved: null, error: null });
}));

router.get('/brokers', auth.requirePage, wrap(async (req, res) => {
  const account = await repo.broker.get('primary');
  res.render('brokers', {
    page: 'brokers',
    account,
    status: session.status(),
    step: session._pending ? 'mpin' : 'totp',
    error: null,
    notice: null,
  });
}));

router.get('/trades', auth.requirePage, wrap(async (req, res) => {
  const tradeDate = time.tradeDate();
  const [positions, orders] = await Promise.all([
    repo.positions.forDate(tradeDate),
    repo.orders.recent(100),
  ]);
  res.render('trades', { page: 'trades', positions, orders, money, tradeDate });
}));

router.get('/events', auth.requirePage, wrap(async (req, res) => {
  const events = await repo.events.recent(300);
  res.render('events', { page: 'events', events });
}));

// The read-only market terminal — doc/index-option-chaine.md. It reads quotes
// and draws them; it has no control over the engine and no path to an order.
router.get('/terminal', auth.requirePage, wrap(async (req, res) => {
  res.render('terminal', {
    page: 'terminal',
    defaults: {
      underlying: 'NIFTY',
      range: config.terminal.defaultRange,
      maxRange: config.terminal.maxRange,
      chainRefreshMs: config.terminal.chainRefreshMs,
      timeframes: Object.keys(time.CHART_TIMEFRAMES),
    },
  });
}));

/* -------------------------------------------------------------------- API -- */

const api = express.Router();
api.use(auth.requireAuth);

// --- control ---------------------------------------------------------------
// These write a flag. The engine reads it on its next clock; the web tier does
// not reach into the engine's memory, because they are different processes.

api.post('/start', wrap(async (req, res) => {
  await repo.flags.set('engine_intent', 'RUN');
  await repo.events.log({ kind: 'CONTROL', reason: 'start requested', tsMs: Date.now() });
  res.json({ ok: true, intent: 'RUN' });
}));

api.post('/stop', wrap(async (req, res) => {
  await repo.flags.set('engine_intent', 'STOP');
  await repo.events.log({ kind: 'CONTROL', reason: 'stop requested', tsMs: Date.now() });
  res.json({ ok: true, intent: 'STOP' });
}));

api.post('/pause', wrap(async (req, res) => {
  // Pause stops NEW entries. Open positions keep being managed — abandoning a
  // live short is not a risk control.
  await repo.flags.set('engine_intent', 'PAUSE');
  await repo.events.log({ kind: 'CONTROL', reason: 'pause requested', tsMs: Date.now() });
  res.json({ ok: true, intent: 'PAUSE', note: 'open positions continue to be managed' });
}));

api.get('/status', wrap(async (req, res) => {
  const tradeDate = time.tradeDate();
  const [cycle, stats, intent, account, trendFlag] = await Promise.all([
    repo.cycles.openCycle(),
    repo.stats.ensure(tradeDate),
    repo.flags.get('engine_intent', 'STOP'),
    repo.broker.get('primary'),
    // The engine holds the trend state in memory and this is a different
    // process, so it is read from the flag the engine writes on every change.
    repo.flags.get('trend_state', null),
  ]);

  let legs = [];
  if (cycle) legs = await repo.legs.byCycle(cycle.id);

  let trend = null;
  try { trend = trendFlag ? JSON.parse(trendFlag) : null; } catch (_) { trend = null; }

  res.json({
    ok: true,
    tradeDate,
    intent,
    broker: {
      status: account?.status || 'DISCONNECTED',
      ucc: account?.ucc || null,
      user: account?.user_name || null,
      lastError: account?.last_error || null,
    },
    cycle: cycle
      ? {
        id: cycle.id,
        expiry: cycle.expiry_date,
        ce: cycle.ce_symbol, ceStrike: cycle.ce_strike,
        pe: cycle.pe_symbol, peStrike: cycle.pe_strike,
        spotAtLock: cycle.spot_at_lock,
        qty: cycle.qty,
        lockedAt: cycle.locked_at,
      }
      : null,
    trend,
    legs: legs.map(l => ({
      optionType: l.option_type, symbol: l.symbol, strike: l.strike, state: l.state,
      attemptSeq: l.attempt_seq, requotes: l.requote_count,
      sellP: l.sell_price_p, filledP: l.filled_price_p,
      targetP: l.target_price_p, slP: l.sl_price_p,
    })),
    risk: {
      realizedPnlP: stats.realized_pnl_p,
      grossPnlP: stats.gross_pnl_p,
      chargesP: stats.charges_p,
      trades: stats.trade_count,
      cycles: stats.cycle_count,
      wins: stats.win_count,
      losses: stats.loss_count,
      consecutiveLosses: stats.consecutive_losses,
      cooldownUntil: stats.cooldown_until,
      disabled: Boolean(stats.disabled),
      disabledReason: stats.disabled_reason,
    },
  });
}));

// --- settings --------------------------------------------------------------

api.get('/settings', wrap(async (req, res) => {
  const raw = settingsService.withDefaults(await repo.settings.get('default'));
  const { errors, warnings } = settingsService.validate(raw);
  res.json({ ok: true, settings: raw, errors, warnings });
}));

api.post('/settings', wrap(async (req, res) => {
  const patch = req.body || {};
  // Numbers arrive from a form as strings; coerce the known-numeric fields
  // rather than storing "1.0" and hoping every reader parses it the same way.
  const numeric = ['atmOffset', 'targetPremium', 'premiumTolerance', 'sellOffset', 'target',
    'stopLoss', 'pendingTimeout', 'positionTimeout', 'legEntryTimeout', 'cycleMaxAge', 'lots',
    'marketMovePause', 'marketMoveWindow', 'cooldownAfterSL', 'maxDailyLoss',
    'maxDailyProfit', 'maxConsecutiveLoss', 'maxCyclesPerDay',
    'trendConfirmBars', 'trendBodyPct', 'trendCloseNearPct', 'trendMaxRangePoints',
    'trendMinScore', 'trendStrongBodyPct', 'trendWickPct', 'trendMinTicks',
    'dynamicTargetStep', 'dynamicTargetMax', 'trailStart', 'trailGap'];
  for (const key of numeric) {
    if (patch[key] !== undefined && patch[key] !== '') patch[key] = Number(patch[key]);
  }
  // An unchecked checkbox is absent from a form body, so the trend filter's
  // on/off flag is sent explicitly by the page rather than inferred from
  // presence — otherwise it could never be turned off.
  const boolean = ['useLiveAsk', 'useLiveBid', 'useLTP', 'lockStrike', 'reQuoteOnNextCandle',
    'trendFilter', 'trendMomentum', 'dynamicTarget', 'exitOnReversal'];
  for (const key of boolean) {
    if (patch[key] !== undefined) patch[key] = patch[key] === true || patch[key] === 'true' || patch[key] === 'on';
  }

  const open = await repo.cycles.openCycle();
  if (open) {
    // The engine snapshots settings at cycle start. Editing them mid-cycle
    // would produce a trade neither the old nor the new configuration
    // describes, so the write is refused rather than silently deferred.
    throw new ValidationError('a cycle is open — settings can only be changed between cycles');
  }

  const { settings, warnings } = await settingsService.save('default', patch);
  await repo.events.log({ kind: 'SETTINGS_CHANGED', reason: Object.keys(patch).join(','), tsMs: Date.now() });
  logger.info('settings updated', { fields: Object.keys(patch) });
  res.json({ ok: true, settings, warnings });
}));

// --- data ------------------------------------------------------------------

api.get('/orders', wrap(async (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 100);
  res.json({ ok: true, orders: await repo.orders.recent(limit) });
}));

api.get('/positions', wrap(async (req, res) => {
  const tradeDate = String(req.query.date || time.tradeDate());
  res.json({ ok: true, tradeDate, positions: await repo.positions.forDate(tradeDate) });
}));

api.get('/logs', wrap(async (req, res) => {
  const limit = Math.min(1000, Number(req.query.limit) || 200);
  res.json({ ok: true, events: await repo.events.recent(limit) });
}));

api.get('/pnl', wrap(async (req, res) => {
  const tradeDate = String(req.query.date || time.tradeDate());
  const stats = await repo.stats.ensure(tradeDate);
  const positions = await repo.positions.forDate(tradeDate);
  res.json({
    ok: true,
    tradeDate,
    // Net, not gross. On a one-point target most of the gross is charges, and
    // reporting gross would make a losing day look like a winning one.
    netPnlP: stats.realized_pnl_p,
    grossPnlP: stats.gross_pnl_p,
    chargesP: stats.charges_p,
    net: money.formatInr(stats.realized_pnl_p),
    gross: money.formatInr(stats.gross_pnl_p),
    charges: money.formatInr(stats.charges_p),
    trades: stats.trade_count,
    wins: stats.win_count,
    losses: stats.loss_count,
    byLeg: positions.map(p => ({
      id: p.id, optionType: p.option_type, symbol: p.symbol,
      entryP: p.entry_p, exitP: p.exit_p, netP: p.net_pnl_p,
      reason: p.exit_reason, closedAt: p.closed_at,
    })),
  });
}));

api.get('/candles', wrap(async (req, res) => {
  const { token, timeframe = '1m' } = req.query;
  if (!token) throw new ValidationError('token is required');
  const limit = Math.min(500, Number(req.query.limit) || 120);
  res.json({ ok: true, candles: await repo.candles.recent(token, timeframe, limit) });
}));

// --- terminal --------------------------------------------------------------
// The three modules of doc/index-option-chaine.md. Every one of these is a
// READ: the terminal has no write path, and the layering rule that keeps broker
// mutation out of the web tier is untouched by it.

// Resolve what a caller means by "symbol" to the one token the feed can quote.
// A bare token is accepted too, so a chart can be pointed at any contract the
// instrument master knows without the caller having to spell out the contract.
async function resolveChartToken(query) {
  if (query.token) return { token: String(query.token), label: String(query.token) };

  const symbol = String(query.symbol || 'NIFTY').toUpperCase();
  const type = query.type ? String(query.type).toUpperCase() : null;

  if (!type || type === 'IDX' || type === 'INDEX') {
    const idx = await instrumentMaster.indexInstrument(symbol);
    if (!idx?.token) {
      throw new ValidationError(`no index instrument for ${symbol} — sync the instrument master`);
    }
    // An index is addressed by NAME, which is also the key its candles are
    // stored under — see instrumentMaster.indexInstrument. There is nothing
    // degraded about that and nothing to refuse.
    return { token: String(idx.token), label: symbol };
  }

  if (type !== 'CE' && type !== 'PE') throw new ValidationError('type must be CE, PE or IDX');
  const expiry = String(query.expiry || '').slice(0, 10);
  const strike = Number(query.strike);
  if (!expiry) throw new ValidationError('expiry is required for an option chart');
  if (!Number.isFinite(strike)) throw new ValidationError('strike is required for an option chart');

  const chain = await repo.instruments.chain(symbol, expiry);
  const row = chain.find(r => Number(r.strike) === strike && r.option_type === type);
  if (!row) throw new ValidationError(`no ${symbol} ${strike} ${type} for ${expiry} in the master`);
  return { token: String(row.token), label: row.symbol, instrument: row };
}

// Bars leave here in RUPEES and in SECONDS, which is what a chart library reads.
// Paise and milliseconds are an internal convention and converting at the edge
// means exactly one place can get it wrong.
const toChartBar = (b) => ({
  time: Math.floor(b.time / 1000),
  open: b.openP / 100,
  high: b.highP / 100,
  low: b.lowP / 100,
  close: b.closeP / 100,
  volume: b.tickCount,
  synthetic: b.synthetic,
});

async function chartHistory(req, res) {
  const timeframe = String(req.query.timeframe || '1m').toLowerCase();
  if (!time.isChartTimeframe(timeframe)) {
    throw new ValidationError(
      `timeframe must be one of ${Object.keys(time.CHART_TIMEFRAMES).join(', ')}`);
  }
  const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 500));
  const from = req.query.from ? Number(req.query.from) : null;
  const to = req.query.to ? Number(req.query.to) : null;
  if ((from !== null && !Number.isFinite(from)) || (to !== null && !Number.isFinite(to))) {
    throw new ValidationError('from and to must be epoch milliseconds');
  }

  const target = await resolveChartToken(req.query);
  const bars = await history.series(target.token, timeframe, { from, to, limit });

  res.json({
    ok: true,
    token: target.token,
    symbol: target.label,
    timeframe,
    candles: bars.map(toChartBar),
    // Said out loud on every response, because an empty chart on a fresh
    // install is the single most confusing thing about this terminal and the
    // reason is not guessable: there is no history endpoint to backfill from.
    note: bars.length ? undefined
      : 'no stored bars yet — Kotak\'s Trade API has no historical-candles endpoint, '
        + 'so this series is recorded live and fills in while the terminal is open',
  });
}

api.get('/chart/history', wrap(chartHistory));
api.get('/option/chart/history', wrap(chartHistory));

api.get('/options/expiries', wrap(async (req, res) => {
  const symbol = String(req.query.symbol || 'NIFTY').toUpperCase();
  res.json({ ok: true, symbol, expiries: await repo.instruments.expiries(symbol) });
}));

api.get('/options/chain', wrap(async (req, res) => {
  const symbol = String(req.query.symbol || 'NIFTY').toUpperCase();
  const expiry = req.query.expiry ? String(req.query.expiry).slice(0, 10) : null;
  const range = req.query.range ? Number(req.query.range) : null;

  // Starts the feed if it is not already running and waits for one real
  // snapshot, so this endpoint answers on its own rather than only while the
  // page is open. The caller is registered as a viewer, so the feed stops again
  // on the normal idle timer.
  let ready = false;
  try {
    ready = await terminal.ensure({
      viewer: `http:${req.ip}`,
      underlying: symbol,
      expiry,
      range: range || undefined,
    });
  } catch (err) {
    // "No Kotak session" is a precondition the caller can fix, not a server
    // fault. A 500 here would read as a bug in the terminal.
    const wrapped = new Error(err.message);
    wrapped.status = 412;
    wrapped.code = 'feed_unavailable';
    throw wrapped;
  }
  const payload = terminal.buildChain();
  res.json({
    ok: true,
    ready,
    ...payload,
    status: ready ? undefined : terminal.status(),
  });
}));

api.get('/terminal/status', wrap(async (req, res) => {
  res.json({ ok: true, terminal: terminal.status() });
}));

// --- external history (Yahoo) ----------------------------------------------
// doc/hisotry.md asks for these three as a standalone Express service. They are
// mounted here instead: a second server would need its own auth, its own port
// and its own deployment to expose data this one already has a database for.
//
// The endpoint paths are the ones the document specifies, under /api.
//
// Yahoo is the INDEX history source only — it carries no NSE option contracts
// at all. See doc/history.md before planning a backtest on it.

api.get('/quote/:symbol', wrap(async (req, res) => {
  res.json({ ok: true, quote: await yahoo.service.getQuote(req.params.symbol) });
}));

api.get('/history/:symbol', wrap(async (req, res) => {
  const { interval = '1d', start = null, end = null } = req.query;
  const result = await yahoo.service.getHistoricalData(req.params.symbol, interval, start, end);
  res.json({ ok: true, ...result });
}));

api.get('/search', wrap(async (req, res) => {
  const query = req.query.q ?? req.query.query;
  const limit = Math.min(25, Math.max(1, Number(req.query.limit) || 10));
  res.json({ ok: true, results: await yahoo.service.searchStocks(query, { limit }) });
}));

// Download index history into `candles`. A POST because it writes, and it can
// take a minute over the full plan — the CLI (scripts/backfill-history.js) is
// the better tool for a first import.
api.post('/history/backfill', wrap(async (req, res) => {
  const { symbol = 'NIFTY', timeframe = null, days = null } = req.body || {};
  const result = timeframe
    ? await backfill.importTimeframe({
      underlying: symbol, timeframe, days: days ? Number(days) : 30,
    })
    : await backfill.importAll({ underlying: symbol });
  res.json({ ok: true, ...result });
}));

// --- broker ----------------------------------------------------------------

api.post('/broker/login', wrap(async (req, res) => {
  const { mobile, ucc, totp } = req.body || {};
  const out = await session.beginLogin({ mobile, ucc, totp });
  res.json({ ok: true, step: 'mpin', ...out });
}));

api.post('/broker/validate', wrap(async (req, res) => {
  const { mpin } = req.body || {};
  const out = await session.completeLogin({ mpin });
  res.json({ ok: true, ...out });
}));

api.post('/broker/sync-instruments', wrap(async (req, res) => {
  await session.load();
  const result = await instrumentMaster.syncAll(session.session);
  res.json({ ok: true, ...result });
}));

api.get('/broker/status', wrap(async (req, res) => {
  const account = await repo.broker.get('primary');
  res.json({
    ok: true,
    session: session.status(),
    instruments: await repo.instruments.count(),
    account: account
      ? { status: account.status, ucc: account.ucc, lastLoginAt: account.last_login_at }
      : null,
  });
}));

// --- health ----------------------------------------------------------------

api.get('/health', wrap(async (req, res) => {
  res.json({ ok: await db.healthCheck(), env: config.env, time: new Date().toISOString() });
}));

router.use('/api', api);

// doc/index-option-chaine.md spells module 3's endpoint without the `/api`
// prefix every other route in this file uses. Both are served rather than
// picking one and having the document be wrong.
router.get('/option/chart/history', auth.requireAuth, wrap(chartHistory));

module.exports = router;
