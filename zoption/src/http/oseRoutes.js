// The Option Selling Engine's own route surface — newdoc/update.md.
//
// ---------------------------------------------------------------------------
// This page deliberately overrides §27
// ---------------------------------------------------------------------------
//
// §27 forbids "a web dashboard or any HTTP UI beyond /health and /metrics", and
// that rule was written for a standalone single-purpose process. This is not
// that: it is one of three engines sharing an account, a database and an
// operator, and the other two both have a page. An engine whose settings can
// only be changed with SQL, and whose refusals can only be read in a log file,
// is less safe in this platform than one with a page — not more.
//
// What is NOT overridden is the layering rule: THE WEB TIER WRITES INTENT AND
// READS STATE. Nothing here places an order, cancels one, or talks to Kotak.
//
// ---------------------------------------------------------------------------
// Start / Pause / Stop, and the rule they had to satisfy first
// ---------------------------------------------------------------------------
//
// These buttons write `ose_intent`. They were only added once the ENGINE was
// made to read it — `src/ose/engine.js` refreshes the flag on its safety timer
// and consults it on every cycle. That order matters: `test/engineIntent.test.js`
// exists because the scalper once shipped buttons whose flag nothing consulted,
// and the dashboard could read STOP while a live engine kept selling naked
// options. `test/oseIntent.test.js` holds this engine to the same standard.
//
//   Start  RUN   — entries allowed
//   Pause  PAUSE — no NEW entries; an open position is still managed and exited.
//                  Halting entries is a risk control; abandoning a live short is
//                  not.
//   Stop   STOP  — no new entries AND any open position is squared off at market
//                  by the engine's priority-0 timer, within about a second
//
// Stop is SOFT and Start resumes it. The kill switch (§26.5) remains the hard
// one: it also HALTs, and that needs a script and a restart to undo. Two levers
// with different costs to reverse, so an operator who wants ten minutes off does
// not have to run a reset script to come back.
//
// Three controls are still NOT owned by this page, and it reports rather than
// offers them:
//
//   the process itself   `npm run ose` runs it; stopping it stops it
//   the kill switch      a file, polled on the priority-0 timer, so it works
//                        when market data has stopped and an HTTP call would not
//   HALT                 §17.6/§26.6, cleared only by scripts/ose-reset-halt.js

const express = require('express');
const config = require('../config');
const money = require('../core/money');
const time = require('../core/time');
const repo = require('../repositories');
const settingsService = require('../ose/settings');
const oseEntry = require('../ose/entry');
const C = require('../ose/constants');
const auth = require('./middleware/auth');
const { ValidationError } = require('../core/errors');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const STATE_FLAG = 'ose_state';
const INTENT_FLAG = 'ose_intent';
const WATCH_FLAG = 'ose_watch';

// Numbers arrive from a form as strings. Coerced here rather than stored as
// "1.0" and left for every reader to parse the same way — which they would not.
const NUMERIC = [
  'premiumMin', 'premiumMax', 'entryOffset',
  'initialTargetPoints', 'initialStopPoints', 'targetExtensionPoints',
  'premiumSafetyExitPoints', 'maxHoldCandles', 'reentryWaitCandles',
  'maxOpenTrades', 'maxTradesPerDay', 'maxConsecutiveLosses',
  'lots', 'scanRange', 'indexMinTicks', 'optionMinTicks',
  // newdoc/ema.md `[MUST-CONFIRM #18]`.
  'emaFlatPoints', 'emaChopLookback', 'emaChopFlips', 'emaCrossCooldownCandles',
  // The index-feed sanity check — src/ose/spotGuard.js.
  'spotCheckMaxDivergencePoints', 'spotCheckMinPairs',
  // The synthetic index — src/ose/syntheticIndex.js.
  'syntheticIndexStrikes',
];

// An unchecked checkbox is simply absent from a form body, so the page posts
// every one of these explicitly — otherwise they could be turned on but never
// off.
const BOOLEAN = [
  'trailingStopEnabled', 'tradeOnExpiryDay', 'stopGuardEnabled',
  // Both ship ON and both are MANDATORY in ema.md, which is exactly why they
  // have to be in this list: a checkbox that can be ticked and never unticked
  // is not a control, and one that silently unticks itself on an unrelated save
  // would turn the strategy's first trend filter off without anyone deciding to.
  'emaFilterEnabled', 'emaExitOnCrossover',
  'spotCheckEnabled',
  // §13.3 as an exit. In this list for the same reason as the two above: it
  // ships ON, and a checkbox that can be ticked but never unticked is not a
  // control. Turning it off is a risk decision — see the warning in settings.js.
  'trendBreakExitEnabled', 'filterFailExitEnabled',
];

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
  // §22's sign-off register. Checkboxes named `confirm_<id>` become the id list
  // the LIVE gate reads; anything unticked is simply absent, so an item can be
  // UN-signed by clearing its box. That is intentional — a sign-off that could
  // only ever be added would be a ratchet, and a desk must be able to withdraw
  // one when a rule changes under it.
  //
  // BUT an absent box and an unticked box look identical in a form post, and the
  // register lives on its own form. Without the `confirm_form` marker, saving
  // `lots` on the OTHER form would arrive with no boxes at all and silently
  // withdraw all seventeen sign-offs — the settings page quietly undoing the
  // desk's approvals as a side effect of an unrelated edit.
  //
  // So `confirmed` is only rebuilt by the form that OWNS it. Every other form
  // leaves the key absent, and `save()` merges over the stored value.
  const ownsRegister = out.confirm_form !== undefined;
  delete out.confirm_form;

  const confirmed = [];
  for (const id of C.MUST_CONFIRM_IDS) {
    const field = out[`confirm_${id}`];
    if (field === true || field === 'true' || field === 'on') confirmed.push(id);
    delete out[`confirm_${id}`];
  }
  if (ownsRegister) out.confirmed = confirmed;
  return out;
}

function readState(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}

/* ------------------------------------------------------------------ pages -- */

router.get('/ose', auth.requirePage, wrap(async (req, res) => {
  res.render('ose', { page: 'ose', appUrl: config.appUrl });
}));

router.get('/ose/settings', auth.requirePage, wrap(async (req, res) => {
  // withDefaults, not the raw row: a profile written before a key existed must
  // still render a value rather than a blank input that saves as invalid.
  const settings = settingsService.withDefaults(await repo.settings.get(settingsService.PROFILE));
  const { warnings } = settingsService.validate(settings);
  const note = settingsService.breakevenNote(settings, await settingsService.lotSizeFor(settings.index));
  res.render('oseSettings', {
    page: 'ose',
    settings,
    warnings,
    note,
    mustConfirm: C.MUST_CONFIRM,
    unsigned: settingsService.unsignedItems(settings).map(m => m.id),
    saved: null,
    error: null,
  });
}));

router.post('/ose/settings', auth.requirePage, wrap(async (req, res) => {
  // The contract size the exchange is actually using — resolved ONCE, and used
  // for both the validation warnings and the break-even panel. Hardcoding 75
  // here meant every figure on this page was computed on 15% more quantity than
  // the engine would ever send.
  const lotSize = await settingsService.lotSizeFor(
    settingsService.withDefaults(req.body).index);

  const render = (extra) => {
    const settings = settingsService.withDefaults({ ...req.body, ...coerce(req.body) });
    return res.render('oseSettings', {
      page: 'ose',
      settings,
      warnings: settingsService.validate(settings, { lotSize }).warnings,
      note: settingsService.breakevenNote(settings, lotSize),
      mustConfirm: C.MUST_CONFIRM,
      unsigned: settingsService.unsignedItems(settings).map(m => m.id),
      saved: null,
      error: null,
      ...extra,
    });
  };

  try {
    const { warnings } = await settingsService.save(settingsService.PROFILE, coerce(req.body));
    const settings = settingsService.withDefaults(
      await repo.settings.get(settingsService.PROFILE));
    return res.render('oseSettings', {
      page: 'ose',
      settings,
      warnings,
      note: settingsService.breakevenNote(settings, lotSize),
      mustConfirm: C.MUST_CONFIRM,
      unsigned: settingsService.unsignedItems(settings).map(m => m.id),
      // The engine reads settings at cycle start and never mid-cycle, so a save
      // takes effect on the next candle — not on the position already open.
      saved: 'Saved. The engine picks these up on its next cycle; an open '
        + 'position keeps the numbers it was opened with.',
      error: null,
    });
  } catch (err) {
    if (err instanceof ValidationError) return render({ error: err.message });
    throw err;
  }
}));

/* -------------------------------------------------------------------- API -- */

const api = express.Router();
api.use(auth.requireAuth);

/* --- control -------------------------------------------------------------- */

// Start / Pause / Stop. These write a flag; `src/ose/engine.js` reads it on its
// safety timer and consults it on every cycle — see the note above INTENT_FLAG
// there. THE READING IS THE POINT: a button whose flag nothing consults is how a
// dashboard comes to read STOP while a live engine keeps selling.
//
// The web tier still writes intent and never places an order. Stop does not send
// an exit from here; it records that the operator wants to be flat, and the
// engine's own priority-0 timer flattens on its next tick (within a second),
// through the same Exit Engine every other exit goes through.
for (const [path, intent, note] of [
  ['/start', 'RUN', null],
  ['/pause', 'PAUSE', 'an open position continues to be managed and exited normally'],
  ['/stop', 'STOP', 'an open position is squared off at market within about a second'],
]) {
  api.post(path, wrap(async (req, res) => {
    await repo.flags.set(INTENT_FLAG, intent);
    await repo.events.log({
      kind: 'OSE_CONTROL', reason: `${intent.toLowerCase()} requested`, tsMs: Date.now(),
    });
    res.json({ ok: true, intent, note: note || undefined });
  }));
}

api.get('/status', wrap(async (req, res) => {
  const tradeDate = time.tradeDate();

  // Read the state flag FIRST, on its own, because the tally depends on it.
  //
  // The tally is scoped to the engine's CURRENT RUN — see the note on
  // `oseDecisions.outcomeTally`. `up` is the run's start, published by the
  // engine; when it is absent (engine down, or a build from before this
  // existed) the tally falls back to the whole day rather than showing nothing.
  //
  // Deliberately not a module-level variable feeding the batch below: two
  // concurrent requests would then scope each other's tally.
  const stateFlag = await repo.flags.get(STATE_FLAG, null);
  const engine = readState(stateFlag);
  const runStartedMs = Number.isFinite(Number(engine?.up)) ? Number(engine.up) : null;

  const [stats, intent, account, trade, tally, settingsRow, latest, watchFlag] =
    await Promise.all([
    repo.oseStats.ensure(tradeDate),
    repo.flags.get(INTENT_FLAG, 'RUN'),
    repo.broker.get('primary'),
    repo.oseTrades.live(),
    repo.oseDecisions.outcomeTally(tradeDate, { sinceMs: runStartedMs }),
    repo.settings.get(settingsService.PROFILE),
    repo.oseDecisions.recent(1),
    repo.flags.get(WATCH_FLAG, null),
  ]);

  // How stale the engine's own heartbeat is. Without this the page cannot tell
  // "the engine says nothing is tradable" from "the engine is not running".
  const ageMs = engine?.atMs ? Date.now() - Number(engine.atMs) : null;
  const settings = settingsService.withDefaults(settingsRow);

  res.json({
    ok: true,
    tradeDate,
    engine: engine && { ...engine, ageMs, live: ageMs != null && ageMs < 15000 },
    running: ageMs != null && ageMs < 15000,
    // What was last CLICKED, and what the engine has actually PICKED UP. They
    // differ for up to one safety-timer tick, and showing only the first is how
    // a page comes to claim a state the engine is not in.
    intent,
    engineIntent: engine ? (engine.intent ?? null) : null,
    mode: settings.mode,
    liquidityMode: settings.liquidityMode,
    bandMinP: money.toPaise(settings.premiumMin),
    bandMaxP: money.toPaise(settings.premiumMax),
    unsigned: settingsService.unsignedItems(settings).map(m => ({ id: m.id, item: m.item })),
    broker: {
      status: account?.status || 'DISCONNECTED',
      ucc: account?.ucc || null,
      lastError: account?.last_error || null,
    },
    stats: {
      tradesToday: stats?.trades_today ?? 0,
      consecutiveLosses: stats?.consecutive_losses ?? 0,
      wins: stats?.win_count ?? 0,
      losses: stats?.loss_count ?? 0,
      scratches: stats?.scratch_count ?? 0,
      cycles: stats?.cycles ?? 0,
      entries: stats?.entries ?? 0,
      grossP: stats?.gross_pnl_p ?? 0,
      chargesP: stats?.charges_p ?? 0,
      netP: stats?.realised_pnl_p ?? 0,
      halted: Boolean(stats?.halted),
      haltReason: stats?.halt_reason ?? null,
      haltedAt: stats?.halted_at ?? null,
    },
    position: trade && {
      id: trade.id,
      symbol: trade.symbol,
      optionType: trade.option_type,
      strike: Number(trade.strike),
      state: trade.state,
      qty: trade.filled_qty || trade.qty,
      entryP: trade.entry_price_p,
      requestedP: trade.requested_price_p,
      targetP: trade.target_price_p,
      stopP: trade.stop_price_p,
      targetLevel: trade.target_level,
      candlesHeld: trade.candles_held,
      mfePoints: trade.mfe_points == null ? null : Number(trade.mfe_points),
      trend: trade.entry_trend,
    },
    // What the engine is watching on each side right now, and the mark on an
    // open position. Published by the engine from the chain it already holds.
    watch: (() => {
      const w = readState(watchFlag);
      if (!w) return null;
      const side = (a) => (Array.isArray(a)
        ? { strike: a[0], ltpP: a[1], candidates: a[2], symbol: a[3] || null } : null);
      return {
        ageMs: w.at ? Date.now() - w.at : null,
        spotP: w.spot ?? null,
        // Present ONLY while the index feed disagrees with the chain. The page
        // leads with this one when it is set, because it is the level the
        // options are actually priced against — see src/ose/spotGuard.js.
        impliedSpotP: w.is ?? null,
        feedStale: w.is != null,
        atmStrike: w.spot ? Math.round((w.spot / 100) / 50) * 50 : null,
        ce: side(w.ce),
        pe: side(w.pe),
        position: w.pos ? { premiumP: w.pos.p, unrealisedP: w.pos.u } : null,
      };
    })(),

    // §11.5's payoff: the tally of WHY the engine did or did not act.
    //
    // Scoped to this engine RUN and to LIVE rows only. The replay and the self
    // test drive the same engine and write real decision rows, and counting
    // those alongside a live session made this panel report 18 entries on a day
    // the engine had taken none.
    outcomes: tally.map(r => ({ outcome: r.outcome, n: Number(r.n) })),
    outcomesScope: {
      sinceMs: runStartedMs,
      // What the page should say above the numbers.
      label: runStartedMs ? 'since the engine started' : 'today',
    },

    // The four numbers §11 actually decides on, from the most recent sealed
    // candle. Without these the page can say the engine is scanning but not
    // what it is scanning — and "close 24383.60, bear mid 24381.05" is the
    // difference between "nothing is happening" and "it is two points away".
    market: latest && latest[0] ? {
      at: time.bucketLabel(Number(latest[0].candle_ts)),
      closeP: latest[0].nifty_close_p,
      // The stored mids are null on any cycle that returned BEFORE the entry
      // validator ran — outside the session, halted, paused. The midpoints are
      // a pure function of the candle's own OHLC though (§11.2), and the row
      // stores all four, so they are derived here through the SAME function the
      // engine uses rather than left blank on the one tile that explains the
      // strategy.
      ...midsFor(latest[0]),
      trend: latest[0].trend,
      trendVia: latest[0].trend_via,
      // newdoc/ema.md — the first filter every entry has to clear. Surfaced on
      // the status tile because "the engine is scanning" and "the engine is
      // scanning but the EMAs are 0.1 points apart" call for very different
      // reactions from an operator watching an idle session.
      ...emaFor(latest[0]),
      tickCount: latest[0].tick_count,
      lowConfidence: Boolean(latest[0].low_confidence),
      synthetic: Boolean(latest[0].synthetic),
    } : null,
  });
}));

// The decision log — one row per sealed candle, including every non-trade.
// This is the endpoint that answers "why did it not trade at 10:42:15" without
// anyone reading a log file.
api.get('/decisions', wrap(async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 120));
  const rows = await repo.oseDecisions.recent(limit);
  res.json({
    ok: true,
    decisions: rows.map(r => ({
      id: r.id,
      candleTs: Number(r.candle_ts),
      at: time.bucketLabel(Number(r.candle_ts)),
      outcome: r.outcome,
      detail: r.detail,
      trend: r.trend,
      trendVia: r.trend_via,
      // The full bar, not just the close. §11.2 derives both midpoints from the
      // open, high and low, so without them a row states a verdict whose inputs
      // cannot be checked — and "why was the bullish mid there" is exactly the
      // question the decision log exists to answer.
      openP: r.nifty_open_p,
      highP: r.nifty_high_p,
      lowP: r.nifty_low_p,
      closeP: r.nifty_close_p,
      // Derived from the row's own OHLC when the cycle returned before the entry
      // validator ran — outside the session, halted, paused. Same function the
      // engine used, so the log can never disagree with the decision, and the
      // midpoints stay readable next to the bar they come from.
      ...midsFor(r),
      // newdoc/ema.md. Null on rows written before the filter existed, and that
      // null is left as null — a zero EMA is a price, not a missing reading.
      ...emaFor(r),
      synthetic: Boolean(r.synthetic),
      lowConfidence: Boolean(r.low_confidence),
      tickCount: r.tick_count,
      symbol: r.selected_symbol,
      score: r.selection_score == null ? null : Number(r.selection_score),
      state: r.state,
      latencyMs: r.latency_ms == null ? null : Number(r.latency_ms),
    })),
  });
}));

api.get('/trades', wrap(async (req, res) => {
  const rows = await repo.oseTrades.recent(Math.min(200, Number(req.query.limit) || 50));
  res.json({
    ok: true,
    trades: rows.map(t => ({
      id: t.id,
      uid: t.trade_uid,
      date: String(t.trade_date).slice(0, 10),
      symbol: t.symbol,
      optionType: t.option_type,
      strike: Number(t.strike),
      qty: t.filled_qty || t.qty,
      trend: t.entry_trend,
      requestedP: t.requested_price_p,
      entryP: t.entry_price_p,
      exitP: t.exit_price_p,
      exitReason: t.exit_reason,
      targetLevel: t.target_level,
      finalStopP: t.final_stop_p,
      candlesHeld: t.candles_held,
      mfePoints: t.mfe_points == null ? null : Number(t.mfe_points),
      grossP: t.gross_pnl_p,
      chargesP: t.charges_p,
      netP: t.net_pnl_p,
      status: t.status,
      score: t.select_score == null ? null : Number(t.select_score),
      // §9.2.1 — which filters could not be run when this strike was chosen.
      // Kept on the trade rather than only in a log because "chosen on premium
      // alone" is a materially different decision from "chosen on the full
      // filter", and a year later this row is where that survives.
      select: safeJson(t.select_detail),
    })),
  });
}));

// §23.1's budget, measured rather than assumed, plus the §7.8 sample
// distribution that decides whether indexMinTicks is set right.
api.get('/health', wrap(async (req, res) => {
  const tradeDate = time.tradeDate();
  const [latency, stateFlag] = await Promise.all([
    repo.oseDecisions.latency(tradeDate),
    repo.flags.get(STATE_FLAG, null),
  ]);
  const engine = readState(stateFlag);
  const ageMs = engine?.atMs ? Date.now() - Number(engine.atMs) : null;

  res.json({
    ok: true,
    status: engine?.halted ? 'HALTED' : (ageMs != null && ageMs < 15000 ? 'OK' : 'DEGRADED'),
    state: engine?.state ?? null,
    ageMs,
    latency: latency || null,
    filter: engine?.filter ?? null,
    quotes: engine?.quotes ?? null,
    staleChainCycles: engine?.stale ?? null,
    budgetMs: 100,
  });
}));

// §11.2, via the engine's own implementation so the page can never disagree
// with the decision about where the midpoints were.
function midsFor(row) {
  const stored = { bullishMidP: row.bullish_mid_p, bearishMidP: row.bearish_mid_p };
  if (stored.bullishMidP != null && stored.bearishMidP != null) return stored;
  try {
    const { bullishMidP, bearishMidP } = oseEntry.midpoints({
      openP: row.nifty_open_p, highP: row.nifty_high_p, lowP: row.nifty_low_p,
    });
    return { bullishMidP, bearishMidP, derived: true };
  } catch (_) {
    return stored;
  }
}

// newdoc/ema.md, off a stored decision row.
//
// The SEPARATION is computed here rather than being another column, because it
// is exactly `ema9 - ema20` and a stored copy could disagree with the pair it
// was derived from after a schema change. It is also the number an operator
// actually reads: "0.08 apart" says why the filter refused, where two averages
// quoted to four decimals do not.
//
// mysql2 returns DECIMAL as a STRING to preserve precision, so both come through
// `Number()` before any arithmetic. Without that, `ema9 - ema20` is still a
// number but `ema9 + ema20` would be string concatenation — the kind of bug that
// surfaces only once somebody adds a midpoint.
function emaFor(row) {
  const ema9P = row.ema9_p == null ? null : Number(row.ema9_p);
  const ema20P = row.ema20_p == null ? null : Number(row.ema20_p);
  return {
    ema9P,
    ema20P,
    emaSeparationP: (ema9P == null || ema20P == null) ? null : ema9P - ema20P,
    emaTrend: row.ema_trend ?? null,
    emaVia: row.ema_via ?? null,
    indexSource: row.index_source ?? null,
  };
}

function safeJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
}

router.use('/api/ose', api);

module.exports = router;
module.exports.money = money;
// Exported for the unit suite. `coerce` decides what a form POST means, and it
// is the only path by which a §22 sign-off can be recorded or withdrawn — a bug
// here silently changes what LIVE mode is willing to start with.
module.exports.coerce = coerce;
