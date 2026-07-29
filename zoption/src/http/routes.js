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

module.exports = router;
