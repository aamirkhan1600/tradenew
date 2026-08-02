// The Price-Filter Engine's own route surface — doc/new.md.
//
// A separate file rather than another two hundred lines in routes.js, because
// it is a separate engine: its own pages, its own control flags, its own
// settings profile and its own daily statistics. Nothing here is reachable from
// the scalper's endpoints and nothing here can change the scalper's
// configuration.
//
// The layering rule is unchanged: THE WEB TIER WRITES INTENT AND READS STATE.
// It never places an order and never talks to a trading endpoint. Start, Pause
// and Stop write a flag; `npm run pfe` reads it on its next clock.

const express = require('express');
const config = require('../config');
const logger = require('../core/logger');
const money = require('../core/money');
const time = require('../core/time');
const repo = require('../repositories');
const settingsService = require('../pfe/settings');
const machine = require('../pfe/machine');
const auth = require('./middleware/auth');
const { ValidationError } = require('../core/errors');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const INTENT_FLAG = 'pfe_intent';
const STATE_FLAG = 'pfe_state';

// Numbers arrive from a form as strings. Coerced here rather than stored as
// "1.0" and left for every reader to parse the same way — which they would not.
const NUMERIC = [
  'lots',
  'premiumMin', 'premiumMax', 'premiumIdealMin', 'premiumIdealMax',
  'minOpenInterest', 'minVolume', 'minBidQty', 'minAskQty', 'maxSpread',
  'weightPremium', 'weightSpread', 'weightOi', 'weightVolume', 'weightDepth',
  'scanRange', 'scanIntervalSec',
  'trendBars', 'trendMinTicks', 'optionMinTicks',
  'sellOffset', 'pendingTimeout', 'armTimeout',
  'target', 'stopLoss', 'targetStep', 'maxTargetSteps',
  'trailStart', 'trailGap', 'trailTighten', 'trailMinGap',
  'maxHoldSeconds', 'premiumSafetyExit', 'liquidityExitSpread',
  'reentryCandles', 'maxTradesPerDay', 'maxConsecutiveLosses',
  'maxDailyLoss', 'maxDailyProfit', 'cooldownAfterSL',
];

// An unchecked checkbox is simply absent from a form body, so the page sends
// every one of these explicitly — otherwise they could be turned on but never
// off.
const BOOLEAN = ['dynamicTarget', 'exitOnFilterFail', 'exitOnTrendBreak', 'exitOnLiquidity'];

function coerce(patch) {
  const out = { ...patch };
  for (const key of NUMERIC) {
    if (out[key] !== undefined && out[key] !== '') out[key] = Number(out[key]);
  }
  for (const key of BOOLEAN) {
    if (out[key] !== undefined) {
      out[key] = out[key] === true || out[key] === 'true' || out[key] === 'on';
    }
  }
  return out;
}

function readState(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}

/* ------------------------------------------------------------------ pages -- */

router.get('/pfe', auth.requirePage, wrap(async (req, res) => {
  res.render('pfe', { page: 'pfe', appUrl: config.appUrl });
}));

router.get('/pfe/settings', auth.requirePage, wrap(async (req, res) => {
  // withDefaults, not the raw row: a profile written before a key existed must
  // still render a value rather than a blank input that saves as invalid.
  const settings = settingsService.withDefaults(await repo.settings.get(settingsService.PROFILE));
  const lotSize = await settingsService.lotSizeFor(settings.symbol);
  const { warnings } = settingsService.validate(settings, { lotSize });
  const note = settingsService.breakevenNote(settings, lotSize);
  res.render('pfeSettings', { page: 'pfe', settings, warnings, note });
}));

/* -------------------------------------------------------------------- API -- */

const api = express.Router();
api.use(auth.requireAuth);

/* --- control -------------------------------------------------------------- */

for (const [path, intent, note] of [
  ['/start', 'RUN', null],
  ['/pause', 'PAUSE', 'an open position continues to be managed'],
  ['/stop', 'STOP', 'an open position continues to be managed and squared off'],
]) {
  api.post(path, wrap(async (req, res) => {
    await repo.flags.set(INTENT_FLAG, intent);
    await repo.events.log({
      kind: 'PFE_CONTROL', reason: `${intent.toLowerCase()} requested`, tsMs: Date.now(),
    });
    res.json({ ok: true, intent, note: note || undefined });
  }));
}

/* --- state ---------------------------------------------------------------- */

api.get('/status', wrap(async (req, res) => {
  const tradeDate = time.tradeDate();
  const [trade, stats, intent, account, stateFlag, scan] = await Promise.all([
    repo.pfeTrades.live(),
    repo.pfeStats.ensure(tradeDate),
    repo.flags.get(INTENT_FLAG, 'STOP'),
    repo.broker.get('primary'),
    // The engine holds its index state in memory and this is a different
    // process, so it is read from the flag the engine writes on every clock.
    repo.flags.get(STATE_FLAG, null),
    repo.pfeScans.latest(),
  ]);

  const engine = readState(stateFlag);
  // How stale the engine's own heartbeat is. Without this the page cannot tell
  // "the engine says nothing is tradable" from "the engine is not running", and
  // those need completely different actions.
  const engineAgeMs = engine?.atMs ? Date.now() - Number(engine.atMs) : null;

  res.json({
    ok: true,
    tradeDate,
    intent,
    engine: engine && { ...engine, ageMs: engineAgeMs, live: engineAgeMs != null && engineAgeMs < 15000 },
    broker: {
      status: account?.status || 'DISCONNECTED',
      ucc: account?.ucc || null,
      lastError: account?.last_error || null,
    },
    trade: trade && {
      id: trade.id,
      state: trade.state,
      symbol: trade.symbol,
      optionType: trade.option_type,
      strike: Number(trade.strike),
      qty: trade.qty,
      score: trade.select_score == null ? null : Number(trade.select_score),
      sellP: trade.sell_price_p,
      filledP: trade.filled_price_p,
      targetP: trade.target_price_p,
      slP: trade.sl_price_p,
      trailPeakP: trade.trail_peak_p,
      confirmations: trade.confirmations,
      trails: trade.trails,
      armedAt: trade.armed_at,
      openedAt: trade.opened_at,
    },
    // The last scan, straight from its own table rather than from the flag —
    // the ranked candidate list does not fit in a VARCHAR(255).
    scan: scan && {
      tsMs: Number(scan.ts_ms),
      side: scan.side,
      spot: scan.spot == null ? null : Number(scan.spot),
      direction: scan.direction_state,
      considered: scan.considered,
      rejected: scan.rejected,
      unavailable: scan.unavailable,
      chosen: scan.chosen_symbol,
      score: scan.chosen_score == null ? null : Number(scan.chosen_score),
      reason: scan.reason,
      candidates: typeof scan.candidates === 'string' ? JSON.parse(scan.candidates) : scan.candidates,
    },
    risk: {
      netPnlP: stats.realized_pnl_p,
      grossPnlP: stats.gross_pnl_p,
      chargesP: stats.charges_p,
      trades: stats.trade_count,
      entries: stats.entry_count,
      scans: stats.scan_count,
      wins: stats.win_count,
      losses: stats.loss_count,
      consecutiveLosses: stats.consecutive_losses,
      cooldownUntil: stats.cooldown_until,
      disabled: Boolean(stats.disabled),
      disabledReason: stats.disabled_reason,
    },
  });
}));

api.get('/trades', wrap(async (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 100);
  const rows = req.query.date
    ? await repo.pfeTrades.forDate(String(req.query.date), limit)
    : await repo.pfeTrades.recent(limit);
  res.json({
    ok: true,
    trades: rows.map(t => ({
      id: t.id,
      tradeDate: t.trade_date,
      symbol: t.symbol,
      optionType: t.option_type,
      strike: Number(t.strike),
      state: t.state,
      qty: t.qty,
      score: t.select_score == null ? null : Number(t.select_score),
      direction: t.direction_state,
      sellP: t.sell_price_p,
      entryP: t.filled_price_p,
      exitP: t.exit_price_p,
      targetP: t.target_price_p,
      slP: t.sl_price_p,
      confirmations: t.confirmations,
      trails: t.trails,
      grossP: t.gross_pnl_p,
      chargesP: t.charges_p,
      netP: t.net_pnl_p,
      exitReason: t.exit_reason,
      armedAt: t.armed_at,
      openedAt: t.opened_at,
      closedAt: t.closed_at,
    })),
  });
}));

// The full detail of one trade, including why its strike was chosen and every
// order it sent. "Why this strike" is the first question of any post-mortem and
// it should not need a SQL client.
api.get('/trades/:id', wrap(async (req, res) => {
  const trade = await repo.pfeTrades.byId(Number(req.params.id));
  if (!trade) throw new ValidationError(`no pfe trade ${req.params.id}`);
  const orders = await repo.orders.workingForPfeTrade(trade.id);
  res.json({
    ok: true,
    trade: {
      ...trade,
      select_detail: typeof trade.select_detail === 'string'
        ? JSON.parse(trade.select_detail) : trade.select_detail,
      settings_snapshot: typeof trade.settings_snapshot === 'string'
        ? JSON.parse(trade.settings_snapshot) : trade.settings_snapshot,
    },
    workingOrders: orders,
  });
}));

api.get('/scans', wrap(async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 30);
  const rows = await repo.pfeScans.recent(limit);
  res.json({
    ok: true,
    scans: rows.map(s => ({
      id: s.id,
      tsMs: Number(s.ts_ms),
      side: s.side,
      spot: s.spot == null ? null : Number(s.spot),
      direction: s.direction_state,
      considered: s.considered,
      rejected: s.rejected,
      unavailable: s.unavailable,
      chosen: s.chosen_symbol,
      score: s.chosen_score == null ? null : Number(s.chosen_score),
      reason: s.reason,
      candidates: typeof s.candidates === 'string' ? JSON.parse(s.candidates) : s.candidates,
    })),
  });
}));

api.get('/orders', wrap(async (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 100);
  res.json({ ok: true, orders: await repo.orders.recentForPfe(limit) });
}));

api.get('/pnl', wrap(async (req, res) => {
  const tradeDate = String(req.query.date || time.tradeDate());
  const stats = await repo.pfeStats.ensure(tradeDate);
  const trades = await repo.pfeTrades.forDate(tradeDate, 500);
  res.json({
    ok: true,
    tradeDate,
    // Net, not gross. On a one-point first rung most of the gross is charges,
    // and reporting gross would make a losing day look like a winning one.
    netPnlP: stats.realized_pnl_p,
    grossPnlP: stats.gross_pnl_p,
    chargesP: stats.charges_p,
    net: money.formatInr(stats.realized_pnl_p),
    gross: money.formatInr(stats.gross_pnl_p),
    charges: money.formatInr(stats.charges_p),
    trades: stats.trade_count,
    wins: stats.win_count,
    losses: stats.loss_count,
    byTrade: trades.filter(t => t.net_pnl_p != null).map(t => ({
      id: t.id, symbol: t.symbol, entryP: t.filled_price_p, exitP: t.exit_price_p,
      netP: t.net_pnl_p, reason: t.exit_reason, closedAt: t.closed_at,
    })),
  });
}));

/* --- settings ------------------------------------------------------------- */

api.get('/settings', wrap(async (req, res) => {
  const raw = settingsService.withDefaults(await repo.settings.get(settingsService.PROFILE));
  const lotSize = await settingsService.lotSizeFor(raw.symbol);
  const { errors, warnings } = settingsService.validate(raw, { lotSize });
  res.json({
    ok: true, settings: raw, errors, warnings,
    breakeven: settingsService.breakevenNote(raw, lotSize),
  });
}));

api.post('/settings', wrap(async (req, res) => {
  const patch = coerce(req.body || {});

  const live = await repo.pfeTrades.live();
  if (live) {
    // The engine snapshots settings when it selects a contract. Editing them
    // mid-trade would produce a round trip neither the old nor the new
    // configuration describes, so the write is refused rather than silently
    // deferred.
    throw new ValidationError(
      `a trade is live (${live.symbol}, ${live.state}) — the Price Filter settings can only be `
      + 'changed between trades');
  }

  const { settings, warnings } = await settingsService.save(settingsService.PROFILE, patch);
  await repo.events.log({
    kind: 'PFE_SETTINGS', reason: Object.keys(patch).join(',').slice(0, 255), tsMs: Date.now(),
  });
  logger.info('pfe: settings updated', { fields: Object.keys(patch).length });
  res.json({
    ok: true,
    settings,
    warnings,
    breakeven: settingsService.breakevenNote(settings, await settingsService.lotSizeFor(settings.symbol)),
  });
}));

/* --- audit ---------------------------------------------------------------- */

// Only this engine's events. They all carry a `PFE_` prefix, written by
// PfeEngine._event, so one query separates the two engines' audit trails
// without a second table.
api.get('/events', wrap(async (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 120);
  const rows = await repo.events.recent(600);
  res.json({
    ok: true,
    events: rows.filter(e => String(e.kind).startsWith('PFE_')).slice(0, limit),
  });
}));

api.get('/states', (req, res) => {
  res.json({ ok: true, states: machine.STATES, exitReasons: machine.EXIT_REASONS });
});

router.use('/api/pfe', api);

module.exports = router;
