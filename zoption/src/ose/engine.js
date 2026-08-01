// §4.2 — the decision cycle, and the loop that feeds it.
//
// Every other file in src/ose/ is a pure function or a small stateless helper.
// This one holds the state, does the I/O and decides when the others are asked.
// It is deliberately the only place in the engine where those three things meet.
//
// ---------------------------------------------------------------------------
// One candle, one cycle, one row
// ---------------------------------------------------------------------------
//
// A sealed NIFTY candle triggers exactly one decision cycle, and every cycle
// writes exactly one `ose_decisions` row — including the thousands that decide
// nothing. §11.5 forbids a silent rejection, and the rows where nothing happened
// are the ones that answer "why did it not trade at 10:42:15" with a SELECT
// rather than an argument.
//
// ---------------------------------------------------------------------------
// Three clocks, not one
// ---------------------------------------------------------------------------
//
//   the INDEX candle   drives entry and position validity (§11, §13.3)
//   the OPTION candle  drives price, target and stop (§12.1, §14, §15)
//   the SAFETY timer   drives everything that must fire when the feed has
//                      stopped (§16.2 priority 0) — and it is the only one of
//                      the three that still works when the market data does not
//
// A condition on the wrong clock is a condition that cannot fire when it matters:
// a square-off that lives on the candle cycle never squares off a position whose
// feed died at 15:14.
//
// ---------------------------------------------------------------------------
// Why the engine keeps its own index series
// ---------------------------------------------------------------------------
//
// `CandleBuilder` retains only the last closed bar. §10.1 needs three, so the
// ring buffer lives here, bounded at MAX_CANDLE_HISTORY (§7.6) and allocated
// once — "memory stable" in §7.6 means the buffer does not grow, not that it is
// small.

const fs = require('fs');
const logger = require('../core/logger');
const money = require('../core/money');
const time = require('../core/time');
const config = require('../config');
const repo = require('../repositories');
const instrumentMaster = require('../market/instrumentMaster');

const C = require('./constants');
const trendEngine = require('./trend');
const entry = require('./entry');
const strikes = require('./strikes');
const ladder = require('./ladder');
const exits = require('./exits');
const risk = require('./risk');
const { StateMachine, STATES, EVENTS, newTrade } = require('./machine');
const { OrderManager } = require('./orders');
const { ChainSnapshot } = require('./snapshot');
const settingsService = require('./settings');

// Outcomes written to `ose_decisions.outcome`. Machine-readable, and the only
// vocabulary the decision log speaks.
// The flag the web tier reads the engine's state back from (§4.3 — two
// processes, one database).
const STATE_FLAG = 'ose_state';
const WATCH_FLAG = 'ose_watch';
const STATE_PUBLISH_MS = 2000;

// The operator's intent, written by the web tier and READ HERE.
//
// The reading is the whole point. `test/engineIntent.test.js` exists because the
// scalper once shipped a dashboard whose Start/Stop buttons wrote a flag nothing
// consulted: the page could read STOP while a live engine kept selling naked
// options, and neither knew. A control the engine ignores is worse than no
// control, so this flag is refreshed on the safety timer and consulted on every
// cycle.
//
//   RUN    normal operation
//   PAUSE  no NEW entries; an open position is managed and exited as usual —
//          halting entries is a risk control, abandoning a live short is not
//   STOP   no new entries AND any open position is squared off at market
//
// STOP is a SOFT stop: Start resumes it. The kill switch (§26.5) is the hard
// one — it also HALTs, and that needs a script and a restart to undo.
const INTENT_FLAG = 'ose_intent';
const INTENTS = ['RUN', 'PAUSE', 'STOP'];

// The housekeeping a process that stays up across day boundaries needs. Run on
// the safety timer at this interval — often enough to catch the session coming
// back within a minute of an operator logging in, rare enough not to poll the
// database every second for a fact that changes once a day.
const MAINTENANCE_MS = 30000;

// How often the settings row is re-read. Five seconds is "immediately" to an
// operator who has just pressed Save, and it is a single indexed row.
const SETTINGS_RELOAD_MS = 5000;

// §31.2 — market opens 09:15 and the first entry is 09:20, so a missing login
// at 09:10 is the last moment it can be fixed without losing the open.
const LOGIN_ALERT_TIME = '09:10:00';

const OUTCOME = {
  ENTRY_TAKEN: 'ENTRY_TAKEN',
  WARMING_UP: 'WARMING_UP',
  SESSION_CLOSED: 'SESSION_CLOSED',
  HALTED: 'HALTED',
  BROKER_SESSION: 'BROKER_SESSION_EXPIRED',
  NO_OPTION_CANDLE: 'NO_OPTION_CANDLE',
  NO_LIQUID_STRIKE: 'NO_LIQUID_STRIKE',
  PAUSED: 'INTENT_PAUSED',
  STOPPED: 'INTENT_STOPPED',
  CANDIDATE_TRACKED: 'CANDIDATE_TRACKED',
  MANAGING: 'MANAGING',
  COOLDOWN: 'COOLDOWN',
  CYCLE_EXCEPTION: 'CYCLE_EXCEPTION',
};

class OseEngine {
  // `broker` is the PAPER/LIVE adapter (placeOrder / cancelOrder / fetchBook /
  // status). `session` is the Kotak session itself, and the two are separate on
  // purpose: the adapter deliberately exposes no positions endpoint, because in
  // PAPER there are no broker positions to read and an adapter that pretended
  // otherwise would let the reconciliation "confirm" a simulated account.
  constructor({
    ticker, indexCandles, optionCandles, quoteSource, router, reconciler, broker, session = null,
  }) {
    this.ticker = ticker;
    this.indexCandles = indexCandles;
    this.optionCandles = optionCandles;
    this.quoteSource = quoteSource;
    this.reconciler = reconciler;
    this.broker = broker;
    this.session = session;

    this.orders = new OrderManager({ router, broker });
    this.chain = new ChainSnapshot({ quoteSource, label: 'ose' });

    this.machine = new StateMachine({
      onTransition: (rec) => this._recordTransition(rec),
      onIllegal: (rec) => this._recordTransition({ ...rec, illegal: true }),
    });

    this.cfg = null;
    this.holidays = [];
    // Refreshed on the safety timer, never inside a cycle: §23.3 keeps network
    // and database I/O out of the decision path, and the operator pressing Stop
    // does not need 5-second-candle resolution to be honoured.
    this.intent = 'RUN';
    this.counters = risk.blankCounters(time.tradeDate(Date.now()));
    this.trade = null;              // the §6.1 ActiveTrade, or null

    // The index ring buffer (§7.6) and the option series' last sealed bar.
    this.indexSeries = [];
    this.indexToken = null;
    this.optionLast = new Map();    // token -> last sealed bar
    this.liveSample = new Map();    // token -> { ltpPaise, ts }  — §16.4 only

    // Consecutive silent buckets, per §7.6. Reset by any real bar.
    this.indexGap = 0;
    this.optionGap = 0;

    // The strike chosen but not yet entered (§7.9). Tracked so its option series
    // can start building; an entry cannot be priced from a series that has not
    // sealed a tradable bar yet, and that is not an error — it is §7.5.
    this.candidate = null;

    this._cycleBusy = false;
    this._overruns = [];
    this._exceptions = [];
    this._cooldownLeft = 0;
    this._safetyTimer = null;
    this._entryDeadline = null;
    this._exitDeadline = null;
    this._stopping = false;
    this._settingsCheckedAt = null;
    this._settingsFingerprint = null;
    this._settingsErrorSaid = false;
    this._pendingCfg = null;
    this._pendingFingerprint = null;
    this._maintainedAt = null;
    this._maintainedDate = null;
    this._loginAlerted = false;
    this._feedDown = false;

    this.stats = { cycles: 0, entries: 0, exits: 0, overruns: 0, exceptions: 0 };
  }

  /* ==================================================================== boot */

  async start(cfg) {
    this.cfg = cfg;
    this._settingsFingerprint = settingsFingerprint(cfg);
    await this._loadHolidays();
    await this._loadCounters();

    this.machine.to(EVENTS.READY, { ts: Date.now() });
    await this._reconcile();

    // §7.10 — AN INDEX IS QUOTED BY NAME, NOT BY ITS TOKEN.
    //
    //     nse_cm|26000      -> HTTP 200, and an EMPTY array
    //     nse_cm|Nifty 50   -> HTTP 200, {"exchange_token":"Nifty 50","ltp":"24317.15"}
    //
    // `instrumentMaster.indexInstrument()` returns the form the quotes API
    // actually answers to; `repo.instruments.indexInstrument()` returns the raw
    // master row, whose token is the numeric one the BINARY socket uses. The two
    // transports genuinely disagree and only the REST path is proven on this
    // account class, so the master's resolver is the only correct source here.
    //
    // Getting this wrong is silent: the gateway does not refuse and does not
    // error, it answers successfully with nothing. The index series never seals
    // a bar, the trend never forms, and every entry the engine could ever make
    // disappears with no failure anywhere to explain it.
    const index = await instrumentMaster.indexInstrument(this.cfg.index || 'NIFTY');
    if (!index?.token) throw new Error('the instrument master holds no index row — run the sync first');
    this.indexToken = String(index.token);
    this.indexCandles.track(this.indexToken);
    this.ticker.subscribe?.([{ token: this.indexToken, segment: index.segment }]);

    this.ticker.on('tick', (tick) => this._onTick(tick));
    this.indexCandles.on('candle', (bar) => this._onIndexCandle(bar));
    this.optionCandles.on('candle', (bar) => this._onOptionCandle(bar));
    this.indexCandles.start();
    this.optionCandles.start();

    this._safetyTimer = setInterval(() => {
      this._onSafetyTimer().catch(err =>
        logger.error('ose: the safety timer threw', { err: err.message }));
    }, C.SAFETY_TIMER_MS);
    this._safetyTimer.unref?.();

    logger.info('ose: running', {
      state: this.machine.current,
      index: this.indexToken,
      mode: this.cfg.mode,
      liquidityMode: this.cfg.liquidityMode,
      stopGuard: this.cfg._rules.stopGuardEnabled,
    });
  }

  async stop() {
    this._stopping = true;
    if (this._safetyTimer) clearInterval(this._safetyTimer);
    this.indexCandles.stop();
    this.optionCandles.stop();
  }

  // §17.7. A missing or stale list is a refusal to start in production — trading
  // on a day the exchange is shut is not a loss, it is a series of rejected
  // orders and a support call.
  async _loadHolidays() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(config.ose.holidayFile, 'utf8'));
    } catch (err) {
      if (config.isProd) {
        throw new Error(`the holiday calendar at ${config.ose.holidayFile} could not be read: `
          + err.message);
      }
      logger.warn('ose: no holiday calendar — weekends only', { err: err.message });
      this.holidays = [];
      return;
    }
    const list = Array.isArray(raw) ? raw : (raw.holidays || []);
    const verdict = risk.validateCalendar(list, time.tradeDate(Date.now()));
    if (!verdict.ok && config.isProd) throw new Error(`the holiday calendar is unusable: ${verdict.reason}`);
    if (!verdict.ok) logger.warn('ose: the holiday calendar is questionable', { reason: verdict.reason });
    this.holidays = list;
  }

  async _loadCounters() {
    const today = time.tradeDate(Date.now());
    const row = await repo.oseStats.ensure(today);
    this.counters = {
      ...risk.blankCounters(today),
      tradesToday: row?.trades_today ?? 0,
      consecutiveLosses: row?.consecutive_losses ?? 0,
      realisedPnlPaise: row?.realised_pnl_p ?? 0,
      halted: Boolean(row?.halted),
      haltReason: row?.halt_reason ?? null,
    };
    // §17.1 — reloaded on boot so a restart mid-day does not reset limits, and
    // §17.6 — a halt is NOT cleared by a restart.
    if (this.counters.halted) {
      logger.error('ose: the engine is HALTED from earlier today and will not trade. '
        + 'Clear it with scripts/ose-reset-halt.js after confirming flat at the broker.',
      { reason: this.counters.haltReason });
    }
  }

  /* ============================================================ §20.6, boot */

  // Every boot, before any trading. The cases are §20.6's, and (c) and (d) are
  // deliberately manual: auto-closing a position the engine does not understand
  // is more dangerous than holding it under supervision.
  async _reconcile() {
    if (this.counters.halted) {
      this.machine.to(EVENTS.RECONCILE_FAILED, { reason: this.counters.haltReason });
      return;
    }

    let open;
    try {
      open = await repo.oseTrades.openTrades();
    } catch (err) {
      logger.error('ose: the reconciliation could not read its own trades', { err: err.message });
      this.machine.to(EVENTS.RECONCILE_FAILED, { reason: err.message });
      return;
    }

    if (!open.length) {
      await this.orders.cancelDangling();
      this.machine.to(EVENTS.RECONCILE_CLEAN, { ts: Date.now() });
      logger.info('ose: reconciliation clean — flat');
      return;
    }

    if (open.length > 1) {
      // §3.3 says one. More than one open row means the guard was bypassed or a
      // write half-landed, and neither is a situation to trade through.
      await this._halt(`RECONCILE: ${open.length} trades are open in the database`);
      return;
    }

    const row = open[0];
    const resumed = await this._adoptOpenTrade(row);
    if (resumed) {
      this.machine.to(EVENTS.RECONCILE_RESUMED, { positionMatches: true, tradeId: row.trade_uid });
      logger.warn('ose: resumed an open position from the database', {
        symbol: row.symbol, qty: row.filled_qty || row.qty, entry: money.formatPrice(row.entry_price_p),
      });
    }
  }

  async _adoptOpenTrade(row) {
    // Case (b): the DB says open, the broker says flat — the position closed
    // while we were down, and the order book is the record of how.
    //
    // "The broker says flat" is a claim that requires EVIDENCE. In PAPER there
    // are no broker positions, and a missing answer is not a flat account: it is
    // no answer. Booking the trade closed on that basis would silently write off
    // a position that may be live, so an unverifiable account resumes management
    // instead — fail closed (§3.8).
    let brokerFlat = false;
    if (this._canReadPositions()) {
      try {
        brokerFlat = !this._positionFor(await this.session.positions(), row.symbol);
      } catch (err) {
        await this._halt(`RECONCILE: the broker positions could not be read — ${err.message}`);
        return false;
      }
    } else {
      logger.warn('ose: positions cannot be verified in this mode — resuming the persisted '
        + 'position rather than assuming it closed', { symbol: row.symbol, mode: this.broker.mode });
    }

    if (brokerFlat) {
      logger.warn('ose: the database holds an open trade the broker does not — closing it from '
        + 'the order book', { symbol: row.symbol });
      await this.reconciler.runOnce().catch(() => {});
      const exitRow = (await repo.orders.forOseTrade(row.id))
        .filter(o => o.stage !== 'ENTRY' && o.status === 'FILLED')
        .pop();
      await this._bookTrade(row, exitRow?.filled_price_p ?? row.entry_price_p,
        exitRow ? 'EXIT_RECONSTRUCTED' : 'EXIT_UNKNOWN_RECONCILED');
      this.machine.to(EVENTS.RECONCILE_CLEAN, { ts: Date.now() });
      return false;
    }

    this.trade = newTrade({
      tradeId: row.trade_uid,
      dbId: row.id,
      symbol: row.symbol,
      token: String(row.token),
      optionType: row.option_type,
      strike: Number(row.strike),
      expiry: String(row.expiry_date).slice(0, 10),
      lotSize: row.lot_size,
      qty: row.qty,
      filledQty: row.filled_qty || row.qty,
      requestedPriceP: row.requested_price_p,
      entryPriceP: row.entry_price_p,
      entryTs: Number(row.entry_ts) || null,
      entryCandleTs: Number(row.entry_candle_ts) || null,
      entryTrend: row.entry_trend,
      targetLevel: row.target_level,
      targetPriceP: row.target_price_p,
      stopPriceP: row.stop_price_p,
      candlesHeld: row.candles_held,
      mfePoints: Number(row.mfe_points) || 0,
    });
    this._trackOption(this.trade.token);
    return true;
  }

  // The adapter's own view of whether it can reach its venue. PAPER always can;
  // LIVE reports the session's latch (§31.4), which is what turns a dead session
  // into one clear line instead of a hundred derived failures.
  _brokerConnected() {
    const status = this.broker.status?.();
    return status ? status.connected !== false : true;
  }

  _canReadPositions() {
    return this.broker.mode === 'LIVE' && typeof this.session?.positions === 'function';
  }

  _positionFor(positions, symbol) {
    const rows = Array.isArray(positions) ? positions : (positions?.data || []);
    return rows.find((p) => {
      const sym = p.trdSym ?? p.tsym ?? p.sym ?? p.tradingSymbol;
      const net = Number(p.flBuyQty ?? 0) - Number(p.flSellQty ?? 0);
      return String(sym) === String(symbol) && net !== 0;
    }) || null;
  }

  /* ============================================================ the feed in */

  _onTick(tick) {
    const token = String(tick.token);
    if (token === this.indexToken) {
      this.indexCandles.addTick(token, tick.ltpPaise, tick.ts);
      return;
    }
    this.optionCandles.addTick(token, tick.ltpPaise, tick.ts);
    // §16.4 only. Kept in its own map, apart from the candle series, so that
    // nothing which is supposed to read sealed data can reach a live price by
    // accident.
    this.liveSample.set(token, { ltpPaise: tick.ltpPaise, ts: tick.ts });
  }

  _onIndexCandle(bar) {
    if (String(bar.token) !== this.indexToken) return;

    this.indexSeries.push(bar);
    if (this.indexSeries.length > C.MAX_CANDLE_HISTORY) this.indexSeries.shift();
    this.indexGap = bar.synthetic ? this.indexGap + 1 : 0;

    // §4.2 reentrancy. A candle sealed while a cycle is running is DROPPED, not
    // queued: queueing would run a decision on a candle that is no longer the
    // latest, which is a decision on stale data wearing a fresh timestamp.
    if (this._cycleBusy) {
      this.stats.overruns += 1;
      this._overruns.push(Date.now());
      this._prune(this._overruns);
      logger.warn('ose: CYCLE_OVERRUN — a candle sealed while the previous cycle was still running',
        { candleTs: bar.bucketStart, inWindow: this._overruns.length });
      if (this._overruns.length >= C.CYCLE_OVERRUN_LIMIT) {
        this._halt('REPEATED_CYCLE_OVERRUNS').catch(() => {});
      }
      return;
    }

    this._cycle(bar).catch(err =>
      logger.error('ose: the cycle rejected outside its own handler', { err: err.message }));
  }

  _onOptionCandle(bar) {
    const token = String(bar.token);
    this.optionLast.set(token, bar);
    if (this.trade && token === this.trade.token) {
      this.optionGap = bar.synthetic ? this.optionGap + 1 : 0;
      // §13.1 — the option series drives the stop and the target on its own
      // clock, because a stop that waits for the next INDEX candle is a stop
      // evaluated on the wrong instrument's liveliness.
      this._manageOnOptionCandle(bar).catch(err =>
        logger.error('ose: option-candle management failed', { err: err.message }));
    }
  }

  /* ======================================================= §4.2, the cycle */

  async _cycle(candle) {
    this._cycleBusy = true;
    const t0 = Date.now();
    const ctx = {
      cycleId: cryptoRandomId(),
      candle,
      ts: candle.bucketStart,
      tradeDate: time.tradeDate(Date.now()),
    };
    this.stats.cycles += 1;

    try {
      await this._maybeDayReset(ctx);

      if (this.counters.halted) return await this._finish(ctx, OUTCOME.HALTED, this.counters.haltReason);
      if (!this._brokerConnected()) {
        // §4.2 — evaluating entries against a dead session produces a cycle whose
        // every step fails at the last one, burying the informative error.
        return await this._finish(ctx, OUTCOME.BROKER_SESSION,
          'the Kotak session is not active — an operator must log in');
      }

      if (this.machine.holdsPosition()) {
        return await this._manageOnIndexCandle(ctx);
      }

      if (this.machine.is(STATES.COOLDOWN)) {
        this._cooldownLeft -= 1;
        if (this._cooldownLeft <= 0) {
          this.machine.attempt(EVENTS.COOLDOWN_ELAPSED, {
            ...ctx, halted: this.counters.halted, sessionOpen: risk.isSessionOpen(Date.now()),
          });
        }
        return await this._finish(ctx, OUTCOME.COOLDOWN, `${Math.max(0, this._cooldownLeft)} candles left`);
      }

      if (this.machine.is(STATES.IDLE)) {
        if (!risk.isSessionOpen(Date.now())) {
          return await this._finish(ctx, OUTCOME.SESSION_CLOSED, 'outside the trading session');
        }
        this.machine.attempt(EVENTS.SESSION_OPEN, { ...ctx, halted: this.counters.halted });
      }

      if (!this.machine.is(STATES.SCANNING)) {
        return await this._finish(ctx, this.machine.current, 'not scanning');
      }

      // The operator's intent, consulted before anything is evaluated. Placed
      // here rather than inside the risk gate so that a paused engine does not
      // spend a chain refresh and a strike ranking to arrive at "no".
      if (this.intent !== 'RUN') {
        return await this._finish(ctx,
          this.intent === 'STOP' ? OUTCOME.STOPPED : OUTCOME.PAUSED,
          this.intent === 'STOP'
            ? 'the operator pressed Stop — no new entries, and any position is squared off'
            : 'the operator paused entries — an open position is still managed');
      }

      return await this._evaluateEntry(ctx);
    } catch (err) {
      await this._failSafe(ctx, err);
      return await this._finish(ctx, OUTCOME.CYCLE_EXCEPTION, err.message);
    } finally {
      ctx.latencyMs = Date.now() - t0;
      this._cycleBusy = false;
    }
  }

  /* --------------------------------------------------------- §9–§12, entry */

  async _evaluateEntry(ctx) {
    const verdict = trendEngine.evaluate(this.indexSeries, C.TREND_LOOKBACK);
    ctx.trend = verdict.trend;
    ctx.trendVia = verdict.via;

    if (verdict.trend === null && verdict.via === 'WARMING_UP') {
      return this._finish(ctx, OUTCOME.WARMING_UP, verdict.reason);
    }

    const decision = entry.validate(ctx.candle, verdict.trend);
    ctx.bullishMidP = decision.bullishMidP;
    ctx.bearishMidP = decision.bearishMidP;
    if (!decision.allowed) return this._finish(ctx, decision.reason, decision.detail);

    const gate = risk.canOpenTrade(this.counters, this.cfg._risk, {
      nowMs: Date.now(),
      holidays: this.holidays,
      activeTrade: this.trade,
      isExpiryDay: this.chain.isExpiryDay,
      killSwitch: await this._killSwitchPresent(),
      cooldownActive: this._cooldownLeft > 0,
    });
    if (!gate.allowed) {
      if (gate.verdict === risk.VERDICTS.MAX_CONSECUTIVE_LOSSES) {
        await this._halt(`MAX_CONSECUTIVE_LOSSES: ${this.counters.consecutiveLosses}`);
      }
      return this._finish(ctx, gate.verdict, gate.reason);
    }

    const snap = this.chain.get(Date.now(), { spotP: ctx.candle.closeP, cfg: this.cfg._gate });
    if (!snap.ok) {
      if (snap.reason === 'CHAIN_STALE' && this.chain.staleHalt()) {
        await this._halt(`CHAIN_STALE for ${C.CHAIN_STALE_HALT} consecutive cycles`);
      }
      return this._finish(ctx, snap.reason, snap.detail || this.chain._lastError);
    }

    // `spotP` is the sealed index close — the same reference price §11 decided
    // on, never a live quote — and it is what tells the selector which strikes
    // are in the money and therefore unsellable.
    const picked = strikes.select(snap.snapshot.quotes, decision.optionType,
      { ...this.cfg._gate, spotP: ctx.candle.closeP });
    if (!picked.chosen) {
      this._forgetCandidate();
      return this._finish(ctx, OUTCOME.NO_LIQUID_STRIKE, picked.reason);
    }

    // `strikes.scoreOne` returns the quote FLAT with `score` and `components`
    // added — there is no nested `.quote`. The filters that could not be run are
    // a property of the SNAPSHOT, not of the winner, so they come off the
    // selection result.
    const quote = picked.chosen;
    ctx.selectedSymbol = quote.symbol;
    ctx.selectionScore = picked.chosen.score;
    ctx.skipped = picked.unavailable || [];

    // §7.9 — the candidate's option series has to exist before it can price an
    // order. Tracking it is what starts the series; §7.5 then discards its first
    // bucket, so the earliest an entry can be priced is one full timeframe after
    // the strike is first chosen. That delay is real and logged, not a fault.
    if (!this.candidate || this.candidate.token !== quote.token) {
      this._trackCandidate(quote);
      return this._finish(ctx, OUTCOME.CANDIDATE_TRACKED,
        `${quote.symbol} selected; its 5s series starts now`);
    }

    const bar = this.optionLast.get(String(quote.token));
    if (!bar || !bar.tradable) {
      return this._finish(ctx, OUTCOME.NO_OPTION_CANDLE,
        bar ? `the last ${quote.symbol} bar measured ${bar.tickCount} samples`
          : `no sealed ${quote.symbol} bar yet`);
    }

    return this._enter(ctx, picked.chosen, bar);
  }

  // §12.1–§12.3. The order of operations here is the money-safety part.
  async _enter(ctx, candidate, bar) {
    const quote = candidate;                 // flat — see the note in _evaluateEntry
    const priceP = ladder.entryPrice(bar, this.cfg._entryOffsetP, quote.tickP || C.TICK);
    const lotSize = Number(quote.lotSize) || 0;
    if (!lotSize) {
      return this._finish(ctx, OUTCOME.NO_LIQUID_STRIKE,
        `${quote.symbol} has no lot size in the instrument master`);
    }
    const qty = lotSize * Math.max(1, Math.trunc(this.cfg.lots || 1));

    const moved = this.machine.attempt(EVENTS.ENTRY_VALIDATED, {
      ...ctx, riskAllows: true,
      guardResults: { risk: 'ALLOW', entry: ctx.trend === 'BULLISH' ? 'SELL_PE' : 'SELL_CE' },
    });
    if (!moved.ok) return this._finish(ctx, 'ENTRY_BLOCKED', moved.error);

    const tradeUid = cryptoRandomId();
    const stopP = ladder.initialStop(priceP, this.cfg.initialStopPoints);
    const targetP = ladder.targetPriceFor(priceP, 1);

    // §19.2 write #1 — SYNCHRONOUS, and BEFORE the order. If this fails no order
    // is placed, which is what guarantees no position can exist without a
    // durable record to reconcile it against.
    let dbId;
    try {
      dbId = await repo.oseTrades.open({
        tradeUid,
        tradeDate: ctx.tradeDate,
        underlying: this.cfg.index || 'NIFTY',
        expiryDate: quote.expiry,
        optionType: quote.optionType,
        token: quote.token,
        symbol: quote.symbol,
        strike: quote.strike,
        lotSize,
        qty,
        state: STATES.ORDER_PENDING,
        entryTrend: ctx.trend,
        requestedPriceP: priceP,
        entryCandleTs: ctx.candle.bucketStart,
        targetLevel: 1,
        targetPriceP: targetP,
        stopPriceP: stopP,
        selectScore: candidate.score,
        selectDetail: {
          components: candidate.components,
          componentsUsed: candidate.componentsUsed ?? [],
          // §9.2.1 — under LENIENT this names the checks that could not be made.
          // Recorded per trade because "chosen on premium alone" is a materially
          // different decision from "chosen on the full filter", and a year later
          // the row is the only place that difference survives.
          skipped: ctx.skipped ?? [],
        },
        settingsSnapshot: { mode: this.cfg.mode, liquidityMode: this.cfg.liquidityMode },
      });
    } catch (err) {
      logger.error('ose: the trade row could not be written — NO ORDER WAS PLACED', { err: err.message });
      this.machine.attempt(EVENTS.ORDER_DEAD, ctx);
      this._startCooldown();
      return this._finish(ctx, 'TRADE_WRITE_FAILED', err.message);
    }

    this.trade = newTrade({
      tradeId: tradeUid, dbId,
      token: quote.token, symbol: quote.symbol, segment: quote.segment,
      optionType: quote.optionType, strike: quote.strike, expiry: quote.expiry,
      lotSize, qty, tickP: quote.tickP || C.TICK,
      requestedPriceP: priceP,
      entryCandleTs: ctx.candle.bucketStart,
      entryTrend: ctx.trend,
      targetLevel: 1, targetPriceP: targetP, stopPriceP: stopP,
      selectScore: candidate.score,
    });

    const placed = await this.orders.placeEntry(this.trade, priceP);
    if (!placed.placed) {
      if (placed.ambiguous) {
        // §12.3.2 — the order MAY be live. It is never resent from here.
        const recovery = await this.orders.recoverAmbiguous(placed.order.id, this.reconciler);
        if (recovery.halt) {
          await this._halt('ORDER_AMBIGUOUS: the broker book cannot account for the entry');
          return this._finish(ctx, 'ORDER_AMBIGUOUS', 'halted');
        }
      }
      await repo.oseTrades.release(this.trade.dbId);
      await repo.oseTrades.markError(this.trade.dbId, placed.reason || 'the entry was not placed');
      this.trade = null;
      this.machine.attempt(EVENTS.ORDER_DEAD, ctx);
      this._startCooldown();
      return this._finish(ctx, 'ENTRY_NOT_PLACED', placed.reason);
    }

    this.trade.entryOrderId = placed.order.id;
    this._trackOption(this.trade.token);
    this.machine.attempt(EVENTS.ORDER_PLACED, { ...ctx, tradeId: tradeUid });
    this._entryDeadline = Date.now() + C.ENTRY_FILL_TIMEOUT_MS;
    this.stats.entries += 1;
    await repo.oseStats.bumpEntry(ctx.tradeDate).catch(() => {});

    logger.info('ose: entry placed', {
      symbol: quote.symbol, price: money.formatPrice(priceP), qty,
      target: money.formatPrice(targetP), stop: money.formatPrice(stopP),
      score: candidate.score, trend: ctx.trend,
    });
    return this._finish(ctx, OUTCOME.ENTRY_TAKEN, `${quote.symbol} at ${money.formatPrice(priceP)}`);
  }

  /* ------------------------------------------------------- §13, management */

  async _manageOnIndexCandle(ctx) {
    if (!this.trade) return this._finish(ctx, OUTCOME.MANAGING, 'no active trade');

    this.trade.candlesHeld += 1;
    const verdict = trendEngine.evaluate(this.indexSeries, C.TREND_LOOKBACK);
    ctx.trend = verdict.trend;
    ctx.trendVia = verdict.via;

    const optionBar = this.optionLast.get(String(this.trade.token)) || null;
    const premiumP = optionBar ? optionBar.closeP : null;
    if (premiumP != null && this.trade.entryPriceP != null) {
      this.trade.mfePoints = ladder.updateMfe(this.trade.mfePoints, this.trade.entryPriceP, premiumP);
    }

    // `get()`, not `.snapshot` — reading the field directly never triggers a
    // refresh, so while a position was open the chain quietly froze at whatever
    // it held when scanning stopped. §16.2 #3 judges EXIT_LIQUIDITY against this,
    // and judging it on a snapshot minutes old is worse than not judging it.
    const held = this.chain.get(Date.now(), { spotP: ctx.candle.closeP, cfg: this.cfg._gate });
    const snap = held.snapshot || this.chain.snapshot;
    const quote = snap ? snap.quotes.find(q => String(q.token) === String(this.trade.token)) : null;

    const res = exits.onCandle({
      trade: this.trade,
      optionCandle: optionBar,
      indexCandle: ctx.candle,
      trend: verdict.trend,
      quote,
      cfg: this.cfg._rules,
    });

    if (res.exit) {
      this._noteSoleTrigger(res.exit);
      await this._exit(res.exit.reason, res.exit.detail, ctx);
      return this._finish(ctx, res.exit.reason, res.exit.detail);
    }

    if (res.extend) await this._applyExtension(res.extend);

    return this._finish(ctx, OUTCOME.MANAGING,
      `held ${this.trade.candlesHeld} candles, premium ${money.formatPrice(premiumP)}`);
  }

  // §14.2 and §15.2. `advanceTarget` and `trailStop` are PURE — they return the
  // patch and never mutate — so this is the one place the ActiveTrade's ladder
  // fields change, which is what makes §15.3's monotonicity auditable.
  async _applyExtension(extend) {
    // The level that was ACHIEVED, captured before the rung moves out.
    //
    // §15.2 is indexed by the achieved level — "1 -> entry + 0 -> breakeven" —
    // while §14.2's pseudocode increments `targetLevel` and only then calls the
    // stop module. Read literally that increments k by one before it is used,
    // which tightens the stop a full rung early: taking the first point would
    // lock +1 instead of breakeven, so a trade that came back could never
    // scratch and would always book a winner or a loser.
    //
    // The table is the unambiguous statement of intent (its "Locked-in" column
    // reads -2, breakeven, +1, +2 against achieved levels 0,1,2,3), so the
    // achieved level is what `trailStop` is given. Caught by
    // scripts/ose-selftest.js, which asserts the breakeven row directly.
    const achievedLevel = this.trade.targetLevel;

    this.trade.targetLevel = extend.targetLevel;
    this.trade.targetPriceP = extend.targetPriceP;

    const before = this.trade.stopPriceP;
    const trail = ladder.trailStop(this.trade, achievedLevel, this.cfg._rules);
    if (trail) this.trade.stopPriceP = trail.stopPriceP;

    logger.info('ose: target extended', {
      level: this.trade.targetLevel,
      target: money.formatPrice(this.trade.targetPriceP),
      stop: trail ? `${money.formatPrice(before)} -> ${money.formatPrice(trail.stopPriceP)}`
        : `${money.formatPrice(before)} (unchanged)`,
      locked: trail ? money.formatPrice(trail.lockedPointsP) : null,
    });

    // camelCase: `oseTrades.setState` maps camelCase keys onto columns, and a
    // key it does not recognise is silently DROPPED — no error, no warning, just
    // an UPDATE that writes `state` and nothing else. Passing snake_case here
    // meant the ladder was never persisted at all.
    await repo.oseTrades.setState(this.trade.dbId, this.machine.current, {
      targetLevel: this.trade.targetLevel,
      targetPriceP: this.trade.targetPriceP,
      stopPriceP: this.trade.stopPriceP,
      candlesHeld: this.trade.candlesHeld,
      mfePoints: this.trade.mfePoints,
    }).catch(err => logger.warn('ose: the ladder patch was not persisted', { err: err.message }));
  }

  // §16.2.4 — the premium safety exit firing WITHOUT the stop also firing means
  // the stop did not evaluate. It is expected never to happen in production, so
  // it is an alert rather than a log line.
  _noteSoleTrigger(exit) {
    if (!exit.soleTrigger) return;
    logger.warn('ose: PREMIUM SAFETY fired without the stop — this indicates a stop-evaluation '
      + 'bug, not a market move', {
      symbol: this.trade?.symbol,
      stop: money.formatPrice(this.trade?.stopPriceP),
      entry: money.formatPrice(this.trade?.entryPriceP),
    });
  }

  // §13.1 — the option clock. Stop and target only; the position-validity filter
  // belongs to the index candle because it is a statement about the index.
  async _manageOnOptionCandle(bar) {
    if (!this.trade || !this.machine.holdsPosition()) return;
    if (this.machine.is(STATES.EXIT_PENDING)) return;

    const res = exits.onOptionCandle({ trade: this.trade, optionCandle: bar, cfg: this.cfg._rules });
    if (res.exit) {
      this._noteSoleTrigger(res.exit);
      await this._exit(res.exit.reason, res.exit.detail, { ts: bar.bucketStart });
      return;
    }

    // §14.2 — the target was reached, so the rung moves out and the stop
    // tightens behind it. The position is NOT closed here; only the Exit Engine
    // closes.
    if (res.extend) await this._applyExtension(res.extend);
  }

  /* ------------------------------------------------------------ §16, exits */

  async _exit(reason, detail, ctx = {}) {
    if (this.machine.is(STATES.EXIT_PENDING)) return;
    if (!this.trade) return;

    const moved = this.machine.attempt(EVENTS.EXIT_TRIGGERED, {
      ...ctx, tradeId: this.trade.tradeId, reason,
    });
    if (!moved.ok) return;

    this.trade.exitReason = reason;
    logger.warn('ose: exit triggered', { reason, detail, symbol: this.trade.symbol });

    // §12.5 — before ANY exit attempt, ask the database what is live. A resend
    // of a market buy that is already working buys the short back twice and
    // leaves the account naked LONG.
    const live = await this.orders.ordersLive(this.trade.dbId, exits.stageFor(reason));
    if (live.length) {
      logger.warn('ose: an exit order is already working — not sending another',
        { ref: live[0].client_ref });
      this._exitDeadline = Date.now() + C.EXIT_FILL_TIMEOUT_MS;
      return;
    }

    this.trade.exitAttempts += 1;
    const placed = await this.orders.placeExit(this.trade, reason, this.trade.exitAttempts);
    if (!placed.placed) {
      if (this.trade.exitAttempts >= C.EXIT_RETRY_MAX) {
        await this._halt(`EXIT_FAILED after ${this.trade.exitAttempts} attempts — THE POSITION IS `
          + 'STILL OPEN. Square off from the Kotak terminal.');
        return;
      }
      this._exitDeadline = Date.now() + C.EXIT_FILL_TIMEOUT_MS;
      return;
    }
    this.trade.exitOrderId = placed.order.id;
    this._exitDeadline = Date.now() + C.EXIT_FILL_TIMEOUT_MS;
  }

  /* ================================================ §16.2 priority 0, timer */

  // Runs every SAFETY_TIMER_MS regardless of the candle feed, and is the only
  // thing in the engine that still works when market data has stopped.
  async _onSafetyTimer() {
    if (this._stopping) return;

    await this._dailyMaintenance();
    await this._reloadSettings();
    await this._refreshIntent();
    await this._publishState();
    await this._publishWatch();
    await this._pollEntryFill();
    await this._pollExitFill();

    if (!this.machine.holdsPosition() || !this.trade) {
      // The kill switch must halt even when flat — an operator setting it is
      // saying "stop", not "close one position".
      if (await this._killSwitchPresent() && !this.counters.halted) {
        await this._halt('KILL_SWITCH');
      }
      return;
    }
    if (this.machine.is(STATES.EXIT_PENDING)) return;

    const sample = this.liveSample.get(String(this.trade.token));
    const hit = exits.onTimer({
      indexGapCandles: this.indexGap,
      optionGapCandles: this.optionGap,
      pastSquareOff: risk.isPastSquareOff(Date.now()),
      killSwitch: await this._killSwitchPresent(),
      halted: this.counters.halted,
      // The operator pressed Stop while holding a position. Flattened here, on
      // the safety timer, rather than waiting for the next sealed candle — the
      // whole reason priority 0 exists is that it must work when the feed does
      // not, and "I want to be flat" is exactly such a moment.
      operatorStop: this.intent === 'STOP',
      // §16.4 — the only live quote any decision may read, and it can only close.
      trade: this.trade,
      livePremiumP: sample?.ltpPaise ?? null,
      sampleAgeMs: sample ? Date.now() - sample.ts : null,
      maxSampleAgeMs: 2 * Math.max(1, config.neo.pollMs),
      stopGuardEnabled: this.cfg._rules.stopGuardEnabled,
    });

    if (hit) await this._exit(hit.reason, hit.detail, { ts: Date.now() });
  }

  // §12.4. Polled rather than pushed: the reconciler is what learns a fill from
  // Kotak, and reading its result from the database means the engine and the
  // reconciler cannot disagree about what happened.
  async _pollEntryFill() {
    if (!this.machine.is(STATES.ORDER_PENDING) || !this.trade?.entryOrderId) return;
    const row = await repo.orders.byId(this.trade.entryOrderId);
    if (!row) return;

    if (row.status === 'FILLED' || (row.status === 'PARTIAL' && row.filled_qty > 0)) {
      return this._onEntryFilled(row);
    }
    if (row.status === 'REJECTED' || row.status === 'CANCELLED') {
      await repo.oseTrades.release(this.trade.dbId);
      await repo.oseTrades.markError(this.trade.dbId, row.reason || row.status);
      logger.warn('ose: the entry did not survive', { status: row.status, reason: row.reason });
      this.trade = null;
      this._forgetCandidate();
      this.machine.attempt(EVENTS.ORDER_DEAD, {});
      this._startCooldown();
      return;
    }

    if (this._entryDeadline && Date.now() > this._entryDeadline) {
      const outcome = await this.orders.cancelUnfilledEntry(this.trade);
      this._entryDeadline = null;

      if (outcome.outcome === 'FILLED' || outcome.outcome === 'PARTIAL') {
        return this._onEntryFilled({
          filled_qty: outcome.filledQty, filled_price_p: outcome.filledPriceP,
        });
      }
      if (outcome.outcome === 'CANCEL_FAILED') {
        await this._halt(`CANCEL_FAILED: ${outcome.reason}`);
        return;
      }
      // §12.4 — no fill. Not a trade, not a loss, does not consume the daily
      // allowance: no position ever existed.
      await repo.oseTrades.release(this.trade.dbId);
      await repo.oseTrades.markError(this.trade.dbId, 'the entry did not fill inside the timeout');
      logger.info('ose: the entry did not fill — cooling down', { symbol: this.trade.symbol });
      this.trade = null;
      this._forgetCandidate();
      this.machine.attempt(EVENTS.ORDER_DEAD, {});
      this._startCooldown();
    }
  }

  async _onEntryFilled(row) {
    this.trade.entryPriceP = row.filled_price_p ?? this.trade.requestedPriceP;
    this.trade.filledQty = row.filled_qty || this.trade.qty;
    this.trade.entryTs = Date.now();
    this._entryDeadline = null;

    // §12.4 — every target and stop derives from the FILL, never the request.
    this.trade.stopPriceP = ladder.initialStop(this.trade.entryPriceP, this.cfg.initialStopPoints);
    this.trade.targetLevel = 1;
    this.trade.targetPriceP = ladder.targetPriceFor(this.trade.entryPriceP, 1);

    this.orders.checkSlippage(this.trade);
    this.machine.attempt(EVENTS.ORDER_FILLED, { tradeId: this.trade.tradeId });

    // THE most important write in the engine after the OPEN insert: without it
    // the row has no entry price, no stop and no target, and §20.6 would adopt a
    // position on the next boot that it cannot evaluate or exit.
    await repo.oseTrades.setState(this.trade.dbId, STATES.POSITION_OPEN, {
      entryPriceP: this.trade.entryPriceP,
      entryTs: this.trade.entryTs,
      filledQty: this.trade.filledQty,
      targetLevel: 1,
      targetPriceP: this.trade.targetPriceP,
      stopPriceP: this.trade.stopPriceP,
    }).catch(err => logger.error('ose: the fill could not be persisted', { err: err.message }));

    // `tradesToday` is NOT incremented here. `risk.foldClosedTrade` counts the
    // round trip when it closes, and `oseStats.recordTrade` writes the same
    // increment to the row this engine reloads on boot — counting at the fill as
    // well would double it, and the number that would drift is the one
    // `maxTradesPerDay` reads. Only one position can be open at a time (§3.3),
    // so counting at the close gates identically.
    this._forgetCandidate();
    this.machine.attempt(EVENTS.MANAGE, { tradeId: this.trade.tradeId });

    logger.info('ose: POSITION OPEN', {
      symbol: this.trade.symbol,
      entry: money.formatPrice(this.trade.entryPriceP),
      qty: this.trade.filledQty,
      stop: money.formatPrice(this.trade.stopPriceP),
      target: money.formatPrice(this.trade.targetPriceP),
    });
  }

  async _pollExitFill() {
    if (!this.machine.is(STATES.EXIT_PENDING) || !this.trade) return;
    if (!this.trade.exitOrderId) return;

    const row = await repo.orders.byId(this.trade.exitOrderId);
    if (row && row.status === 'FILLED') {
      await this._bookTrade(null, row.filled_price_p, this.trade.exitReason);
      return;
    }

    if (this._exitDeadline && Date.now() > this._exitDeadline) {
      if (this.trade.exitAttempts >= C.EXIT_RETRY_MAX) {
        await this._halt(`EXIT_FAILED after ${this.trade.exitAttempts} attempts — THE POSITION IS `
          + 'STILL OPEN. Square off from the Kotak terminal.');
        return;
      }
      logger.error('ose: the exit has not filled — retrying as MARKET',
        { attempt: this.trade.exitAttempts + 1, symbol: this.trade.symbol });
      this.trade.exitAttempts += 1;
      const placed = await this.orders.placeExit(this.trade, this.trade.exitReason, this.trade.exitAttempts);
      if (placed.placed) this.trade.exitOrderId = placed.order.id;
      this._exitDeadline = Date.now() + C.EXIT_FILL_TIMEOUT_MS;
    }
  }

  /* ------------------------------------------------------- §16.3, the book */

  async _bookTrade(dbRow, exitPriceP, reason) {
    const trade = this.trade;
    const dbId = dbRow?.id ?? trade?.dbId;
    const entryP = dbRow?.entry_price_p ?? trade?.entryPriceP;
    const qty = dbRow?.filled_qty || dbRow?.qty || trade?.filledQty || trade?.qty || 0;
    const tradeDate = dbRow?.trade_date ? String(dbRow.trade_date).slice(0, 10) : time.tradeDate(Date.now());

    const pnl = (entryP != null && exitPriceP != null && qty)
      ? money.shortPnl({ entryPaise: entryP, exitPaise: exitPriceP, qty })
      : { grossPaise: 0, chargesPaise: 0, netPaise: 0 };

    await repo.oseTrades.close(dbId, {
      exitP: exitPriceP ?? null,
      exitTs: Date.now(),
      exitReason: reason,
      grossPnlP: pnl.grossPaise,
      chargesP: pnl.chargesPaise,
      netPnlP: pnl.netPaise,
      finalStopP: trade?.stopPriceP ?? null,
      candlesHeld: trade?.candlesHeld ?? 0,
      mfePoints: trade?.mfePoints ?? 0,
    }).catch(err => logger.error('ose: the close could not be persisted', { err: err.message }));

    // §19.2 write #3 — synchronous. A crash here must not turn a tripped circuit
    // breaker back into a fresh day's allowance.
    await repo.oseStats.recordTrade(tradeDate, {
      grossPnlP: pnl.grossPaise, chargesP: pnl.chargesPaise, netPnlP: pnl.netPaise,
    }).catch(err => logger.error('ose: the risk counters could not be persisted', { err: err.message }));

    this.counters = risk.foldClosedTrade(this.counters, pnl.netPaise);
    this.stats.exits += 1;

    logger.warn('ose: POSITION CLOSED', {
      symbol: trade?.symbol ?? dbRow?.symbol,
      reason,
      entry: money.formatPrice(entryP),
      exit: money.formatPrice(exitPriceP),
      gross: money.formatInr(pnl.grossPaise),
      charges: money.formatInr(pnl.chargesPaise),
      net: money.formatInr(pnl.netPaise),
      consecutiveLosses: this.counters.consecutiveLosses,
    });

    if (trade) this._untrackOption(trade.token);
    this.trade = null;

    // The trade is closed, so a settings change held back for it can land now —
    // before the next cycle looks for an entry, not after.
    if (this._pendingCfg) {
      this.cfg = this._pendingCfg;
      this._settingsFingerprint = this._pendingFingerprint;
      this._pendingCfg = null;
      this._pendingFingerprint = null;
      this.chain.snapshot = null;
      logger.warn('ose: the held settings change has been applied now the position is closed', {
        band: `${(this.cfg._gate.premiumMinP / 100).toFixed(2)}–`
          + `${(this.cfg._gate.premiumMaxP / 100).toFixed(2)}`,
      });
    }
    this._exitDeadline = null;
    this.optionGap = 0;

    if (this.machine.is(STATES.EXIT_PENDING)) {
      this.machine.attempt(EVENTS.EXIT_FILLED, {});
      this._startCooldown();
    }

    if (this.counters.consecutiveLosses >= (this.cfg?._risk?.maxConsecutiveLosses ?? 5)) {
      await this._halt(`MAX_CONSECUTIVE_LOSSES: ${this.counters.consecutiveLosses} in a row`);
    }
  }

  /* ------------------------------------------------------ §17.6 / §20.5 */

  async _halt(reason) {
    if (this.counters.halted) return;
    this.counters.halted = true;
    this.counters.haltReason = reason;

    logger.error('ose: HALTED — no further entries until an operator resets it', { reason });

    // Step 1: a position must be closed before anything else. If the halt was
    // itself caused by a dead session this cannot succeed, which is §31.4's one
    // honest limit and why the log says so rather than pretending.
    if (this.trade && !this.machine.is(STATES.EXIT_PENDING)) {
      await this._exit(exits.EXIT_REASONS.RISK_HALT, reason, { ts: Date.now() })
        .catch(err => logger.error('ose: the halt could not close the position — IT IS STILL OPEN',
          { err: err.message }));
    }

    await this.orders.cancelDangling().catch(() => {});
    this.machine.attempt(EVENTS.HALT, { reason, ts: Date.now() });
    await repo.oseStats.halt(time.tradeDate(Date.now()), String(reason).slice(0, 256)).catch(() => {});
  }

  async _failSafe(ctx, err) {
    this.stats.exceptions += 1;
    this._exceptions.push(Date.now());
    this._prune(this._exceptions);
    logger.error('ose: CYCLE_EXCEPTION', { cycleId: ctx.cycleId, err: err.message, stack: err.stack });

    if (this.trade && !this.machine.is(STATES.EXIT_PENDING)) {
      await this._exit(exits.EXIT_REASONS.ENGINE_ERROR, err.message, ctx).catch(() => {});
    }
    if (this._exceptions.length >= C.CYCLE_EXCEPTION_LIMIT) {
      await this._halt('REPEATED_CYCLE_EXCEPTIONS');
    }
  }

  /* ---------------------------------------------------------------- odds */

  async _maybeDayReset(ctx) {
    if (!risk.needsDayReset(this.counters, Date.now())) return;
    logger.info('ose: a new trading day — counters reset', { from: this.counters.tradingDate });
    this.counters = risk.blankCounters(ctx.tradeDate);
    await repo.oseStats.ensure(ctx.tradeDate).catch(() => {});
  }

  // §26.5. Async on purpose: §23.3 bans `fs.*Sync` anywhere the decision path can
  // reach, and the entry gate calls this.
  async _killSwitchPresent() {
    try {
      await fs.promises.access(config.ose.killSwitchFile);
      return true;
    } catch (_) {
      return false;
    }
  }

  // The web tier runs in a DIFFERENT PROCESS and cannot see this object, so the
  // engine publishes its own state to a flag the page reads back. The `atMs`
  // stamp is the important field: without it the page cannot tell "the engine
  // says nothing is tradable" from "the engine is not running", and those need
  // completely different actions from an operator.
  //
  // Written on the safety timer rather than the candle cycle, deliberately — a
  // stopped feed is exactly when the page most needs to still be updating.
  /* ------------------------------------------- the long-running process --- */

  // Everything a process that stays up for weeks needs and a process restarted
  // each morning got for free.
  //
  // It lives on the SAFETY TIMER, not the decision cycle, and that is the whole
  // point: a decision cycle needs sealed candles, sealed candles need a live
  // feed, and the feed is one of the things this repairs. Put day-rollover on
  // the candle clock and a dead feed freezes the calendar too — the engine would
  // still think it was Tuesday a week later.
  //
  // Three jobs, each of which breaks the engine on day two if skipped:
  //
  //   1. RE-SYNC THE INSTRUMENT MASTER. Contracts expire and new ones list every
  //      day. §8.2: a stale master offers strikes that no longer exist and the
  //      selector would happily rank one.
  //   2. RECOVER THE KOTAK SESSION. It dies about 06:00 IST daily, and the
  //      ticker CLOSES itself when it does. Without this the engine stays up and
  //      permanently blind, which is worse than being down: it looks healthy.
  //   3. RESET THE DAY'S COUNTERS, so yesterday's trade count and loss streak do
  //      not gate today.
  async _dailyMaintenance() {
    const now = Date.now();
    if (this._maintainedAt && now - this._maintainedAt < MAINTENANCE_MS) return;
    this._maintainedAt = now;

    const today = time.tradeDate(now);

    if (this._maintainedDate !== today) {
      const previous = this._maintainedDate;
      this._maintainedDate = today;
      this._loginAlerted = false;

      if (previous) logger.info('ose: a new trading day', { from: previous, to: today });

      if (risk.needsDayReset(this.counters, now)) {
        this.counters = risk.blankCounters(today);
        await repo.oseStats.ensure(today).catch(() => {});
      }

      // Force §8.2's expiry to be resolved again — yesterday's may have expired.
      this.chain.expiry = null;
      this.chain.expiryDate = null;

      await this._resyncMaster();
    }

    await this._recoverSession();
    this._loginCheck(now, today);
  }

  async _resyncMaster() {
    if (!this.session?.isActive?.()) return;
    try {
      const res = await instrumentMaster.syncAll(this.session.session);
      logger.info('ose: instrument master re-synced for the new day', res);
    } catch (err) {
      // A failed sync is not fatal — the stored master is stale but usable for
      // the near expiries. It IS worth an error: selection quality degrades
      // silently from here.
      logger.error('ose: the daily instrument sync failed — the master is now stale, and a '
        + 'stale master can offer strikes that no longer exist', { err: err.message });
    }
  }

  // The session dies daily and the ticker closes itself when it notices (see
  // `auth_expired` in src/market/ticker.js). Reload it, and bring the feed back
  // up once it is valid again.
  async _recoverSession() {
    if (!this.session || typeof this.session.load !== 'function') return;
    if (this.session.isActive()) {
      if (this._feedDown) {
        this._feedDown = false;
        logger.info('ose: the Kotak session is back — resuming the feed');
        // `resume`, not `connect`: the ticker latches `authFailed` on a rejected
        // session and refuses to reconnect, deliberately, so that a dead session
        // does not produce a retry loop. Only an explicit revival with a fresh
        // session in hand clears that latch.
        try { this.ticker.resume?.(); } catch (err) {
          logger.warn('ose: the feed did not resume', { err: err.message });
        }
      }
      return;
    }

    this._feedDown = true;
    try {
      await this.session.load();
    } catch (_) { /* the next tick tries again */ }
  }

  // §31.2 / `[MUST-CONFIRM #14]`. The login is interactive and cannot be
  // automated, so an auto-started engine still cannot trade until a human has
  // logged in — and a trading day that never began looks EXACTLY like a quiet
  // market unless something says so.
  //
  // Said once per day, at error level, because it is the single point at which
  // an automated engine silently fails to start trading.
  _loginCheck(nowMs, today) {
    if (this._loginAlerted) return;
    if (!time.isAfter(nowMs, LOGIN_ALERT_TIME)) return;
    if (risk.isWeekend(nowMs) || risk.isHoliday(this.holidays, today)) return;
    if (this.session?.isActive?.()) return;

    this._loginAlerted = true;
    logger.error(`ose: NO KOTAK SESSION AT ${LOGIN_ALERT_TIME} IST — the engine is running but `
      + 'cannot trade today. The login is interactive (TOTP + MPIN) and nobody has done it. '
      + `Log in at ${config.appUrl}/brokers.`, { tradeDate: today });
  }

  /* ------------------------------------------------ §5.1, live settings --- */

  // Pick up a settings change without a restart.
  //
  // §5.1 says the configuration is "loaded once at boot and frozen", and taken
  // literally that means the premium band on the settings page does nothing
  // until someone restarts the process. The page already told the operator
  // otherwise, which is the worse of the two failures: a control that claims to
  // work and does not.
  //
  // The freeze is kept where it earns its place — WITHIN a decision. Three rules
  // make that true:
  //
  //   1. NEVER MID-CYCLE. Applied only when no cycle is running, so no decision
  //      can read one band at the start and another at the end.
  //   2. NEVER MID-TRADE. A position is managed to the rules it was OPENED
  //      under; a change is held back until it closes. Otherwise moving
  //      `premiumSafetyExitPoints` could exit a live short on a rule it was
  //      never entered on.
  //   3. The object is replaced wholesale, never mutated, so a reader that
  //      captured `this.cfg` keeps a consistent snapshot.
  async _reloadSettings() {
    const now = Date.now();
    if (this._settingsCheckedAt && now - this._settingsCheckedAt < SETTINGS_RELOAD_MS) return;
    this._settingsCheckedAt = now;
    if (this._cycleBusy) return;

    let next;
    try {
      next = await settingsService.load();
    } catch (err) {
      if (!this._settingsErrorSaid) {
        this._settingsErrorSaid = true;
        logger.error('ose: the settings could not be reloaded — carrying on with the ones in '
          + 'memory', { err: err.message });
      }
      return;
    }
    this._settingsErrorSaid = false;

    const fingerprint = settingsFingerprint(next);
    if (fingerprint === this._settingsFingerprint) return;

    if (this.trade) {
      // Held, not dropped. Said once so an operator who saved a change and sees
      // nothing happen is told why rather than left guessing.
      if (this._pendingFingerprint !== fingerprint) {
        this._pendingFingerprint = fingerprint;
        logger.warn('ose: a settings change is waiting for the open position to close — a trade '
          + 'is managed to the rules it was opened under', { symbol: this.trade.symbol });
      }
      this._pendingCfg = next;
      return;
    }

    const before = this.cfg;
    this.cfg = next;
    this._settingsFingerprint = fingerprint;
    this._pendingCfg = null;
    this._pendingFingerprint = null;

    logger.warn('ose: settings reloaded', {
      band: `${(next._gate.premiumMinP / 100).toFixed(2)}–${(next._gate.premiumMaxP / 100).toFixed(2)}`,
      was: before ? `${(before._gate.premiumMinP / 100).toFixed(2)}–`
        + `${(before._gate.premiumMaxP / 100).toFixed(2)}` : '—',
      mode: next.mode,
      liquidityMode: next.liquidityMode,
      lots: next.lots,
      stopGuard: next._rules.stopGuardEnabled,
    });

    // The chain window is centred and filtered using the band, so a change makes
    // the cached snapshot answer the old question. Drop it and let the next
    // refresh rebuild against the new one.
    this.chain.snapshot = null;
  }

  // Read the operator's intent off the flag the web tier writes. An unreadable
  // or unrecognised value leaves the previous intent in place rather than
  // defaulting to RUN: a database hiccup must not silently un-pause an engine
  // somebody deliberately paused.
  async _refreshIntent() {
    let raw;
    try {
      raw = await repo.flags.get(INTENT_FLAG, 'RUN');
    } catch (_) {
      return;
    }
    const next = String(raw || 'RUN').toUpperCase();
    if (!INTENTS.includes(next)) return;
    if (next === this.intent) return;
    logger.warn('ose: the operator intent changed', { from: this.intent, to: next });
    this.intent = next;
  }

  // What the engine is WATCHING, and what an open position is worth right now.
  //
  // Computed from the snapshot the chain already holds — `strikes.select` is a
  // pure function, so both sides cost nothing beyond the fetch that had already
  // happened. Deliberately NOT its own chain refresh: §30 gives the order path
  // first call on the rate budget, and a page is not a reason to spend it.
  //
  // Its own flag rather than more fields on `ose_state`, because that one is
  // already close to the VARCHAR(255) ceiling and silently truncating THIS
  // record would take the state record down with it.
  async _publishWatch() {
    // While the market is open, keep the snapshot current even when the engine
    // is not scanning — in COOLDOWN, or holding a position. `get()` throttles
    // itself to CHAIN_REFRESH_MS, so this adds no requests beyond the cadence
    // §8.3 already budgets for.
    // Refreshed whenever there is a spot to centre the window on — NOT only
    // while scanning.
    //
    // Gating this on `isSessionOpen` meant the box was empty exactly when it is
    // most wanted: before the open, when you want to see which strike the engine
    // has its eye on, and in COOLDOWN or a position, when scanning is not
    // running. `get()` throttles to CHAIN_REFRESH_MS, so the cost is the §8.3
    // cadence the budget already allows (~0.8 rps for a ±20 window) and the
    // engine is the only consumer of it outside market hours.
    const lastBar = this.indexSeries.length
      ? this.indexSeries[this.indexSeries.length - 1] : null;
    if (lastBar && this.cfg) {
      // Guarded, and the guard is not defensive clutter: this runs on the SAFETY
      // TIMER, which is what squares off a position when the candle feed has
      // stopped (§16.2 priority 0). Letting a chain fault propagate out of a
      // display refresh would take the square-off down with it — the one thing
      // on this timer that must never stop running.
      try {
        this.chain.get(Date.now(), { spotP: lastBar.closeP, cfg: this.cfg._gate });
      } catch (err) {
        logger.warn('ose: the watch refresh failed', { err: err.message });
      }
    }

    const snap = this.chain.snapshot;
    const cfg = this.cfg?._gate;
    const spotP = this.indexSeries.length
      ? this.indexSeries[this.indexSeries.length - 1].closeP : null;

    const side = (type) => {
      if (!snap || !snap.quotes.length || !cfg || spotP == null) return null;
      const r = strikes.select(snap.quotes, type, { ...cfg, spotP });
      return r.chosen
        ? [r.chosen.strike, r.chosen.ltpP, r.ranked.length, r.chosen.symbol] : null;
    };

    const t = this.trade;
    const bar = t ? this.optionLast.get(String(t.token)) : null;
    const premiumP = bar ? bar.closeP : null;

    const watch = {
      at: Date.now(),
      spot: spotP,
      ce: side('CE'),
      pe: side('PE'),
      // The held contract marked to the last sealed option bar — the same figure
      // the exits are being judged against, never a live quote the engine is not
      // allowed to decide on.
      pos: (t && t.entryPriceP != null && premiumP != null) ? {
        p: premiumP,
        u: money.openPnl({ entryPaise: t.entryPriceP, ltpPaise: premiumP, qty: t.filledQty || t.qty }),
      } : null,
    };

    try {
      await repo.flags.set(WATCH_FLAG, JSON.stringify(watch).slice(0, 255));
    } catch (_) { /* a stale page must never disturb the safety timer */ }
  }

  async _publishState() {
    const now = Date.now();
    if (this._statePublishedAt && now - this._statePublishedAt < STATE_PUBLISH_MS) return;
    this._statePublishedAt = now;

    // A SLIM object, deliberately — `system_flags.value` is VARCHAR(255).
    //
    // Publishing the whole of status() does not fail loudly: MySQL truncates it
    // at 255 characters, the result is JSON with no closing brace, the page's
    // parse returns null, and the page then reports "not running" forever about
    // an engine that is running perfectly. A silent, permanent lie on the one
    // field an operator uses to decide whether to intervene.
    //
    // So only what a page cannot get from the database itself goes here. The
    // position, the day's statistics and the decision tally are all queried
    // directly by /api/ose/status; this is the in-memory state that exists
    // nowhere else.
    const slim = {
      state: this.machine.current,
      intent: this.intent,
      halted: this.counters.halted,
      noLogin: this._loginAlerted,
      cfgPending: Boolean(this._pendingCfg),
      filter: this.quoteSource?.filter ?? null,
      quotes: this.snapshotQuoteCount(),
      stale: this.chain._consecutiveStale,
      bars: this.indexSeries.length,
      cycles: this.stats.cycles,
      atMs: now,
    };
    const payload = JSON.stringify(slim);
    try {
      // Slice as a backstop only. If this ever truncates, the fix is to publish
      // less — not to widen the column and keep the page guessing.
      await repo.flags.set(STATE_FLAG, payload.slice(0, 255));
    } catch (_) { /* the page going stale must never disturb a decision cycle */ }
  }

  snapshotQuoteCount() {
    return this.chain.snapshot ? this.chain.snapshot.quotes.length : 0;
  }

  _startCooldown() {
    this._cooldownLeft = Math.max(0, Math.trunc(this.cfg.reentryWaitCandles ?? 2));
  }

  _trackCandidate(quote) {
    this._forgetCandidate();
    this.candidate = { token: String(quote.token), symbol: quote.symbol, segment: quote.segment };
    this._trackOption(quote.token, quote.segment);
    logger.info('ose: candidate tracked', { symbol: quote.symbol });
  }

  _forgetCandidate() {
    if (!this.candidate) return;
    // Never untrack the HELD contract just because the candidate changed.
    if (!this.trade || this.candidate.token !== this.trade.token) {
      this._untrackOption(this.candidate.token);
    }
    this.candidate = null;
  }

  _trackOption(token, segment = 'nse_fo') {
    this.optionCandles.track(String(token));
    this.ticker.subscribe?.([{ token: String(token), segment }]);
  }

  _untrackOption(token) {
    this.optionCandles.untrack(String(token));
    this.optionLast.delete(String(token));
    this.liveSample.delete(String(token));
    this.ticker.unsubscribe?.([String(token)]);
  }

  _prune(list) {
    const cutoff = Date.now() - C.GUARD_WINDOW_MS;
    while (list.length && list[0] < cutoff) list.shift();
  }

  _recordTransition(rec) {
    repo.oseTransitions.log({
      cycleId: rec.cycleId ?? null,
      tradeUid: rec.tradeId ?? null,
      fromState: rec.from,
      toState: rec.to ?? rec.from,
      triggerEvent: rec.trigger,
      reason: rec.reason ?? null,
      illegal: Boolean(rec.illegal),
      tsMs: rec.ts ?? Date.now(),
    }).catch(() => { /* §19.2 — the audit queue never blocks a cycle */ });

    if (rec.illegal) {
      logger.error('ose: ILLEGAL_TRANSITION', { from: rec.from, trigger: rec.trigger, reason: rec.reason });
    }
  }

  // The one row every cycle writes, whatever it decided (§11.5).
  async _finish(ctx, outcome, detail = null) {
    const c = ctx.candle;
    repo.oseDecisions.log({
      cycleId: ctx.cycleId,
      tradeDate: ctx.tradeDate,
      candleTs: c.bucketStart,
      openP: c.openP, highP: c.highP, lowP: c.lowP, closeP: c.closeP,
      synthetic: Boolean(c.synthetic),
      lowConfidence: Boolean(c.lowConfidence),
      tickCount: c.tickCount ?? 0,
      trend: ctx.trend || 'NONE',
      trendVia: ctx.trendVia ?? null,
      bullishMidP: ctx.bullishMidP ?? null,
      bearishMidP: ctx.bearishMidP ?? null,
      outcome,
      detail,
      selectedSymbol: ctx.selectedSymbol ?? null,
      selectionScore: ctx.selectionScore ?? null,
      state: this.machine.current,
      latencyMs: ctx.latencyMs ?? (Date.now() - (ctx.startedAt ?? Date.now())),
    }).catch(() => { /* async queue; never blocks */ });
    return { outcome, detail };
  }

  status() {
    return {
      state: this.machine.current,
      intent: this.intent,
      mode: this.cfg?.mode ?? null,
      halted: this.counters.halted,
      haltReason: this.counters.haltReason,
      tradesToday: this.counters.tradesToday,
      consecutiveLosses: this.counters.consecutiveLosses,
      indexCandles: this.indexSeries.length,
      candidate: this.candidate?.symbol ?? null,
      position: this.trade ? {
        symbol: this.trade.symbol,
        entry: this.trade.entryPriceP,
        stop: this.trade.stopPriceP,
        target: this.trade.targetPriceP,
        level: this.trade.targetLevel,
        candlesHeld: this.trade.candlesHeld,
      } : null,
      chain: this.chain.status(),
      stats: { ...this.stats },
    };
  }
}

// uuidv7-shaped enough for correlation: time-ordered so decision rows sort the
// way they happened. Not a security token and never used as one.
// Everything a decision can read. A change to any of it is a different engine,
// so the comparison is over VALUES rather than a version column — that way an
// edit that saves the same numbers does not churn the chain cache.
function settingsFingerprint(cfg) {
  if (!cfg) return null;
  return JSON.stringify([
    cfg.mode, cfg.liquidityMode, cfg.lots, cfg.scanRange,
    cfg.indexMinTicks, cfg.optionMinTicks, cfg.reentryWaitCandles,
    cfg._gate.premiumMinP, cfg._gate.premiumMaxP, cfg._entryOffsetP,
    cfg._rules.targetExtensionPoints, cfg._rules.premiumSafetyExitPoints,
    cfg._rules.trailingStopEnabled, cfg._rules.stopGuardEnabled,
    cfg.initialTargetPoints, cfg.initialStopPoints,
    cfg._risk.maxTradesPerDay, cfg._risk.maxConsecutiveLosses, cfg._risk.tradeOnExpiryDay,
  ]);
}

function cryptoRandomId() {
  const ts = Date.now().toString(16).padStart(12, '0');
  const rand = require('crypto').randomBytes(10).toString('hex');
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${rand.slice(0, 3)}-`
    + `${rand.slice(3, 7)}-${rand.slice(7, 19)}`;
}

module.exports = { OseEngine, OUTCOME, STATE_FLAG, WATCH_FLAG, INTENT_FLAG, INTENTS };
