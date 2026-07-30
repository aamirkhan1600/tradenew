// Where the pure parts meet the world.
//
// The state machine in legMachine.js decides WHAT should happen; this file makes
// it happen and feeds the results back as events. Keeping the two apart is what
// lets the strategy be tested exhaustively without a broker, and it means the
// dangerous code here is thin: mostly plumbing, with the decisions made
// elsewhere.
//
// The loop:
//
//   ticks     -> candleBuilder -> 'candle' -> CANDLE_CLOSED  -> PLACE_SELL
//   ticks     -> TICK events                                 -> stop-loss
//   clock     -> PENDING_TIMEOUT / POSITION_TIMEOUT / SQUARE_OFF
//   reconciler-> fills, cancels, rejections                  -> the rest
//
// Every action the machine returns is executed here and every outcome is logged
// to `events`. A state transition that is not in that table did not happen.

const EventEmitter = require('events');
const config = require('../config');
const logger = require('../core/logger');
const time = require('../core/time');
const money = require('../core/money');
const repo = require('../repositories');
const legMachine = require('./legMachine');
const selectors = require('./selectors');
const trendFilter = require('./trendFilter');
const { STATES } = legMachine;

// A quote older than this is not evidence of anything. The premium gate refuses
// rather than trusting it.
const MAX_QUOTE_AGE_MS = 5000;

// A trend verdict is good until the next index bar closes — doc/update-point.md:
// "a signal is valid only until the next 5-second candle closes". The grace
// covers the two candle builders sweeping on independent 250ms timers, so an
// option close landing a moment before the index close of the same instant is
// not treated as stale. It scales with the bar: a flat two seconds would be 40%
// of a five-second validity window, which is not a grace, it is an extension.
const trendGraceMs = (trendSeconds) => Math.min(1000, (trendSeconds * 1000) / 2);

// How many index bars to hold. The verdict reads `confirmBars + 1`; the rest is
// context for the audit log and costs nothing.
const TREND_BUFFER = 12;

// How often a wedged EXITING leg re-sends the order that never left. Slow on
// purpose: it is an emergency path, and hammering a broker that is already
// answering ambiguously is how a bad minute becomes a bad session.
const STUCK_RETRY_MS = 5000;

// How often the engine says out loud that it is refusing every bar. One line
// a minute is enough to notice a wedged configuration and rare enough that a
// normally quiet market does not fill the log.
const BLOCK_REPORT_MS = 60000;

// How long the engine tolerates having no spot price before it says so as an
// error. Long enough to cover a boot and a reconnect, short enough that a
// misconfigured instrument is named within the first minute of a session
// rather than discovered at the end of one.
const SPOT_BLIND_MS = 45000;

// A DATETIME field out of a state patch. Absent means "do not touch the column";
// present-but-null means "clear it". Collapsing the two would make a cleared
// field silently keep its old value.
function stamp(patch, key) {
  if (!(key in patch)) return undefined;
  return patch[key] ? time.toMysql(patch[key]) : null;
}

class ScalperEngine extends EventEmitter {
  constructor({ ticker, candles, router, reconciler, risk, broker, trendCandles = null }) {
    super();
    this.ticker = ticker;
    this.candles = candles;
    this.trendCandles = trendCandles;   // the NIFTY index series, or null if off
    this.router = router;
    this.reconciler = reconciler;
    this.risk = risk;
    this.broker = broker;

    this.settings = null;
    this.cycle = null;                  // the open cycle row
    this.legs = new Map();              // 'CE' | 'PE' -> in-memory leg state
    this.spotToken = null;
    this.running = false;
    this._clock = null;
    this._openingCycle = false;
    this.lastError = null;

    // RUN / PAUSE / STOP, written by the web tier into `system_flags` and read
    // here on every clock. `this.running` is a different thing entirely: it
    // means the process's clock is ticking. The OPERATOR's intent is this.
    //
    // It starts as null rather than as a value, so the first clock is always a
    // transition and always logs what it found.
    this.intent = null;

    // The index trend filter's whole state: a ring of completed index bars and
    // the verdict derived from them.
    this.trend = { bars: [], verdict: null };
  }

  /* ------------------------------------------------------------- lifecycle */

  async start(settings) {
    this.settings = settings;
    this.running = true;

    this.candles.on('candle', (bar) => this._onCandle(bar).catch(this._oops('candle')));
    this.ticker.on('tick', (t) => this._onTick(t));
    this.reconciler.on('fill', (f) => this._onFill(f).catch(this._oops('fill')));
    this.reconciler.on('partial', (f) => this._onPartial(f).catch(this._oops('partial')));
    this.reconciler.on('cancelled', (c) => this._onCancelled(c).catch(this._oops('cancelled')));
    this.reconciler.on('rejected', (r) => this._onRejected(r).catch(this._oops('rejected')));

    this.candles.start();

    // The index series runs from boot, not from the first cycle: the filter
    // needs `confirmBars` completed bars before it can say anything, and
    // warming that up while the engine is idle costs nothing.
    if (this.trendCandles && settings.trendFilter) {
      this.trendCandles.on('candle', (bar) => this._onTrendCandle(bar).catch(this._oops('trend')));
      this.trendCandles.start();
      await this._ensureSpot();
    }

    this._clock = setInterval(() => this._onClock().catch(this._oops('clock')), config.engine.tickMs);
    this._clock.unref?.();

    // Adopt whatever the last process left behind before arming anything new.
    await this._resume();

    // Said at boot, not left for the first clock to discover. An operator who
    // starts the engine and sees nothing happen deserves to be told why on the
    // line above, rather than reading it out of the dashboard.
    const intent = await this._readIntent();
    if (intent !== 'RUN') {
      logger.warn(`engine: intent is ${intent} — NO NEW CYCLES WILL OPEN. `
        + `Press Start on the dashboard (${config.appUrl}) or POST /api/start.`,
      { note: 'open positions are still managed, timed out and squared off' });
    }

    logger.info('engine: started', {
      mode: this.settings.mode, timeframe: this.settings.candleTimeframe,
      tradeMode: this.settings.tradeMode,
      trendFilter: this.settings.trendFilter
        ? `${this.settings.trendConfirmBars}×${this.settings.trendTimeframe} NIFTY bars`
        : 'off',
    });
  }

  async stop() {
    this.running = false;
    if (this._clock) clearInterval(this._clock);
    this._clock = null;
    this.candles.stop();
    this.trendCandles?.stop();
  }

  _oops(where) {
    return (err) => {
      this.lastError = `${where}: ${err.message}`;
      logger.error('engine: handler failed', { where, err: err.message, stack: err.stack });
    };
  }

  /* ---------------------------------------------------------------- resume */

  // A process that died holding a position comes back to a database that says
  // WORKING and a broker that may say FILLED. Reconcile FIRST, then adopt — the
  // alternative is arming a fresh leg on top of a position we forgot about.
  async _resume() {
    await this.reconciler.runOnce();

    const open = await repo.cycles.openCycle();
    if (!open) return;

    this.cycle = open;
    const rows = await repo.legs.byCycle(open.id);
    for (const row of rows) {
      const leg = this._legFromRow(row);
      // Re-attach the leg to whatever it still has live at the broker. Without
      // this an adopted leg believes it holds no orders, so the OCO logic has
      // nothing to cancel before an exit — and the stuck-leg recovery would
      // resend an order that is already working.
      for (const order of await repo.orders.workingForLeg(row.id)) {
        if (order.stage === 'ENTRY') leg.sellOrderId = leg.sellOrderId ?? order.id;
        else if (order.stage === 'TARGET') leg.targetOrderId = leg.targetOrderId ?? order.id;
        else leg.exitOrderId = leg.exitOrderId ?? order.id;
      }
      this.legs.set(row.option_type, leg);
    }
    this._subscribeCycle();

    logger.warn('engine: resumed an open cycle from a previous run', {
      cycleId: open.id,
      legs: [...this.legs.values()]
        .map(l => `${l.optionType}:${l.state}`
          + (l.targetOrderId ? ' target-live' : '')
          + (l.exitOrderId ? ' exit-live' : '')).join(' '),
    });
    await this._event({
      cycleId: open.id, kind: 'ENGINE_RESUME',
      reason: 'adopted an open cycle after a restart',
      payload: { legs: rows.map(r => ({ type: r.option_type, state: r.state })) },
    });
  }

  _legFromRow(row) {
    return {
      id: row.id,
      optionType: row.option_type,
      token: String(row.token),
      symbol: row.symbol,
      strike: Number(row.strike),
      state: row.state,
      attemptSeq: row.attempt_seq,
      sellPriceP: row.sell_price_p,
      filledPriceP: row.filled_price_p,
      targetPriceP: row.target_price_p,
      slPriceP: row.sl_price_p,
      filledQty: row.filled_qty,
      entryCandleId: row.entry_candle_id,
      openedAt: row.opened_at ? time.fromMysql(row.opened_at) : null,
      sellPlacedAt: null,
      sellOrderId: null,
      targetOrderId: null,
      exitOrderId: null,
      exitReason: row.exit_reason,
      haltAfterCancel: false,
      // Not persisted, so an adopted leg gets a FULL fresh entry window rather
      // than being stood down the instant the engine comes back. Erring the
      // other way would let a restart retire a leg that had barely waited.
      waitingSince: Date.now(),
      lastGateReason: null,
      // The ladder count survives a restart; the trail's high-water mark does
      // not, so it restarts from the fill. That can only ever LOOSEN a trailed
      // stop back toward the one already stored in sl_price_p — and since the
      // trail refuses to widen, the stored stop stands.
      confirmations: row.confirmations || 0,
      trailPeakP: row.filled_price_p ?? null,
      trailingOnly: row.target_price_p == null && row.filled_price_p != null,
      pendingExit: null,
      pendingTargetP: null,
      cancelFailedAt: null,
      _recoveredAt: 0,
    };
  }

  /* ------------------------------------------------------------- the clock */

  // The operator's intent, read fresh each clock.
  //
  // THIS WAS MISSING, and it was the whole reason the dashboard's Start, Pause
  // and Stop buttons did nothing: the web tier wrote the flag, `/api/status`
  // read it back for display, and no process in between ever acted on it. A
  // screen reading STOP while a live engine kept selling naked options is the
  // worst failure this platform could have, and it was the shipped behaviour.
  //
  // Three values, and note what STOP does NOT do:
  //
  //   RUN    open new cycles normally
  //   PAUSE  open nothing new; keep managing whatever is open
  //   STOP   open nothing new; keep managing whatever is open
  //
  // STOP does not flatten. Abandoning a live short because someone pressed a
  // button is not a risk control — it is the same rule `riskManager.canEnter`
  // is built on, and the square-off is what closes positions. The difference
  // between STOP and PAUSE is what the operator MEANT, and it is recorded in
  // the audit trail; the engine treats both as "no new exposure".
  async _readIntent() {
    let value;
    try {
      // Default STOP, matching what `/api/status` and the dashboard already
      // show for an unset flag. The alternative — defaulting to RUN — is how
      // the screen and the engine came to disagree in the first place.
      value = String(await repo.flags.get('engine_intent', 'STOP')).toUpperCase();
    } catch (err) {
      // A database blip must not silently start trading. Hold the last known
      // intent instead, and if there is none yet, refuse.
      logger.warn('engine: could not read the operator intent', { err: err.message });
      return this.intent || 'STOP';
    }
    if (!['RUN', 'PAUSE', 'STOP'].includes(value)) value = 'STOP';

    if (value !== this.intent) {
      const from = this.intent;
      this.intent = value;
      logger.warn(`engine: intent is ${value}`, {
        from: from || '(first read)',
        effect: value === 'RUN'
          ? 'new cycles may open'
          : 'no new cycles will open; open positions keep being managed and squared off',
      });
      await this._event({
        kind: 'CONTROL', fromState: from, toState: value,
        reason: `engine observed intent ${value}`,
      }).catch(() => { /* the audit write must not stop the clock */ });
    }
    return value;
  }

  async _onClock() {
    if (!this.running) return;
    const now = Date.now();

    const intent = await this._readIntent();

    // The instrument master can be empty at boot and populated a minute later,
    // so the trend filter's subscription is retried rather than resolved once.
    if (this.trendCandles && this.settings.trendFilter && !this.spotToken) {
      await this._ensureSpot().catch(err =>
        logger.debug('engine: the index instrument is not resolvable yet', { err: err.message }));
    }

    // Square-off first. It outranks every other consideration, including an
    // engine that would otherwise be opening a cycle.
    if (this.cycle && time.isAfter(now, this.settings.squareOffAt)) {
      await this._dispatchAll({ type: 'SQUARE_OFF', tsMs: now });
    }

    this._reportBlocks(now);

    if (this.cycle) {
      for (const leg of this.legs.values()) {
        if (leg.state === STATES.SELL_WORKING) {
          await this._dispatch(leg, { type: 'PENDING_TIMEOUT', tsMs: now });
        } else if (leg.state === STATES.POSITION_OPEN || leg.state === STATES.TARGET_MOVING) {
          // The maximum hold applies while a target is being moved too — a
          // trailing winner does not get to run past the clock.
          await this._dispatch(leg, { type: 'POSITION_TIMEOUT', tsMs: now });
        } else if (leg.state === STATES.WAIT_CANDLE) {
          // A leg that can never get permission would otherwise hold the strike
          // lock until the square-off. The reason carried here is the last one
          // it was refused with, so the audit log says WHY it stood down.
          await this._dispatch(leg, {
            type: 'ENTRY_TIMEOUT', tsMs: now, reason: leg.lastGateReason || null,
          });
        } else if (leg.state === STATES.EXITING) {
          await this._recoverStuck(leg, now);
        }
        if (leg.state === STATES.TARGET_MOVING && leg.cancelFailedAt) {
          await this._recoverStuck(leg, now);
        }
      }
      await this._maybeCloseCycle();
    } else if (intent === 'RUN') {
      await this._maybeOpenCycle(now);
    }
    // Not RUN and no cycle: nothing to do. Note that everything ABOVE this
    // branch — the square-off, the timeouts, the stuck-leg recovery — runs
    // whatever the intent is. Pressing Stop must never strand an open leg.
  }

  /* ----------------------------------------------------- stuck-leg recovery */

  // A leg mid-exit can get wedged in two ways, and NOTHING else moves it — the
  // clock dispatches no event to EXITING, and SQUARE_OFF from EXITING is a
  // no-op, so a wedged leg holds a live naked short past the close.
  //
  //   1. The target cancel came back ambiguous. It is not safe to exit (the
  //      target may still be working), so the only correct move is to keep
  //      asking until the broker gives a definite answer.
  //   2. The exit market order itself failed to send. The target is confirmed
  //      cancelled, so the position is completely unprotected until it goes.
  //
  // Both are re-driven here, slowly. The retry is deliberately I/O and not a
  // state-machine event: nothing about the leg's STATE is wrong, only that an
  // order the state implies never reached the broker.
  async _recoverStuck(leg, nowMs) {
    if (nowMs - (leg._recoveredAt || 0) < STUCK_RETRY_MS) return;
    leg._recoveredAt = nowMs;

    // Ask the DATABASE what is live, not the in-memory leg. After a restart the
    // adopted leg's order ids are rebuilt from the orders table, but any gap
    // between the two would be catastrophic here specifically: resending a
    // market buy that is already working buys the short back twice and leaves
    // the account naked LONG. The whole point of this path is to send an order
    // that is missing, so it must first be certain that it IS missing.
    const live = await repo.orders.workingForLeg(leg.id);
    if (live.length) {
      logger.info('engine: not resending — an order for this leg is already live', {
        leg: leg.optionType, orders: live.map(o => `${o.stage}:${o.status}`).join(' '),
      });
      return;
    }

    if (leg.targetOrderId && leg.cancelFailedAt) {
      logger.warn('engine: retrying a target cancel that came back ambiguous', {
        leg: leg.optionType, stuckForMs: nowMs - leg.cancelFailedAt,
      });
      await this._act(leg, {
        type: 'CANCEL_TARGET', orderId: leg.targetOrderId,
        reason: leg.exitReason || 'RETRY',
      });
      return;
    }

    // EXITING, the target is gone, and no exit order exists: the market buy
    // never made it out. This is the dangerous one — the short is naked with
    // nothing pending against it.
    if (leg.state === STATES.EXITING && !leg.targetOrderId && !leg.exitOrderId) {
      logger.error('engine: a leg is EXITING with no exit order — resending the market buy', {
        leg: leg.optionType, reason: leg.exitReason,
      });
      await this._event({
        cycleId: this.cycle?.id, legId: leg.id, optionType: leg.optionType,
        kind: 'EXIT_RETRY', reason: leg.exitReason || 'unknown',
      });
      await this._act(leg, {
        type: 'EXIT_MARKET', reason: leg.exitReason, qty: leg.filledQty,
      });
    }
  }

  /* --------------------------------------------------------- cycle opening */

  async _maybeOpenCycle(nowMs) {
    if (this._openingCycle) return;

    const gate = await this.risk.canEnter(this.settings, nowMs);
    if (!gate.ok) return;

    if (!this.ticker.isHealthy()) return;         // blind; do not select a strike

    this._openingCycle = true;
    try {
      await this._openCycle(nowMs);
    } catch (err) {
      this.lastError = err.message;
      logger.warn('engine: could not open a cycle', { err: err.message });
    } finally {
      this._openingCycle = false;
    }
  }

  async _openCycle(nowMs) {
    const s = this.settings;

    const expiries = await repo.instruments.expiries(s.symbol);
    const expiry = selectors.selectExpiry({
      mode: s.expiryMode, expiries, manualExpiry: s.manualExpiry,
    });

    const chain = await repo.instruments.chain(s.symbol, expiry);
    if (!chain.length) throw new Error(`the chain for ${s.symbol} ${expiry} is empty`);

    const spot = await this._spot();
    if (spot == null) return;                     // no spot, no ATM, no cycle

    // PREMIUM mode needs live premiums to CHOOSE a contract. That is selection,
    // not pricing — the entry price still comes from a closed candle. The two
    // are kept apart deliberately: see doc/PROJECT_PLAN.md §2 R3.
    const premiumPaise = (token) => this.ticker.ltpPaise(token);

    // The premium mode can only see strikes the ticker has a price for, and it
    // only has prices for what it is subscribed to. Widen the subscription
    // across the near ladder first so the selection has something to work with.
    if (String(s.strikeMode).toUpperCase() === 'PREMIUM') {
      await this._warmChain(chain, spot);
    }

    const picked = selectors.selectStrikes({
      chain, spot,
      mode: s.strikeMode,
      atmOffset: s.atmOffset,
      targetPremium: s.targetPremium,
      premiumTolerance: s.premiumTolerance,
      tradeMode: s.tradeMode,
      premiumPaise,
    });

    const wantCE = s.tradeMode === 'BOTH' || s.tradeMode === 'CE';
    const wantPE = s.tradeMode === 'BOTH' || s.tradeMode === 'PE';
    if ((wantCE && !picked.ce) || (wantPE && !picked.pe)) {
      // No trade. Not a nearest-guess: the configured band is a constraint.
      logger.debug('engine: no strike selected', { reason: picked.reason });
      return;
    }

    const lotSize = Number((picked.ce || picked.pe).lot_size) || 0;
    if (!lotSize) throw new Error('the selected contract has no lot size in the master');
    const qty = lotSize * Number(s.lots);

    const tradeDate = time.tradeDate(nowMs);
    let cycleId;
    try {
      cycleId = await repo.cycles.open({
        tradeDate, underlying: s.symbol, expiryDate: expiry,
        ceToken: picked.ce?.token ?? null, ceSymbol: picked.ce?.symbol ?? null,
        ceStrike: picked.ce?.strike ?? null,
        peToken: picked.pe?.token ?? null, peSymbol: picked.pe?.symbol ?? null,
        peStrike: picked.pe?.strike ?? null,
        spotAtLock: spot, lotSize, qty,
        settingsSnapshot: this._snapshotSettings(),
      });
    } catch (err) {
      // The UNIQUE index on cycle_guard.open_key did its job: something else
      // opened a cycle first. Back off and pick it up on the next clock.
      if (/duplicate/i.test(err.message) || err.code === 'ER_DUP_ENTRY') {
        logger.warn('engine: another opener won the race for the cycle slot');
        return;
      }
      throw err;
    }

    this.cycle = await repo.cycles.byId(cycleId);
    this.legs.clear();

    for (const [type, row] of [['CE', picked.ce], ['PE', picked.pe]]) {
      if (!row) continue;
      const legId = await repo.legs.create({
        cycleId, optionType: type, token: row.token, symbol: row.symbol,
        strike: row.strike, state: STATES.IDLE,
      });
      this.legs.set(type, {
        id: legId, optionType: type, token: String(row.token), symbol: row.symbol,
        strike: Number(row.strike), state: STATES.IDLE, attemptSeq: 0,
        tickP: Math.round(Number(row.tick_size || 0.05) * 100) || 5,
        sellPriceP: null, filledPriceP: null, targetPriceP: null, slPriceP: null,
        filledQty: 0, entryCandleId: null, openedAt: null, sellPlacedAt: null,
        sellOrderId: null, targetOrderId: null, exitOrderId: null,
        exitReason: null, haltAfterCancel: false,
        waitingSince: null, lastGateReason: null,
        confirmations: 0, trailPeakP: null, trailingOnly: false,
        pendingExit: null, pendingTargetP: null,
        cancelFailedAt: null, _recoveredAt: 0,
      });
    }

    await repo.stats.bumpCycle(tradeDate);
    this._subscribeCycle();

    logger.info('engine: strike LOCKED', {
      cycleId, expiry, spot,
      ce: picked.ce ? `${picked.ce.strike}CE` : '—',
      pe: picked.pe ? `${picked.pe.strike}PE` : '—',
      qty, mode: s.strikeMode,
    });
    await this._event({
      cycleId, kind: 'STRIKE_LOCKED',
      reason: `${s.strikeMode} on a spot of ${spot}`,
      payload: {
        expiry, spot, atm: picked.atm, step: picked.step, qty, lotSize,
        ce: picked.ce ? { strike: picked.ce.strike, token: picked.ce.token, symbol: picked.ce.symbol } : null,
        pe: picked.pe ? { strike: picked.pe.strike, token: picked.pe.token, symbol: picked.pe.symbol } : null,
      },
    });

    // Arm both legs. From here the strike does not change until both are flat.
    for (const leg of this.legs.values()) {
      await this._dispatch(leg, { type: 'ARM', tsMs: nowMs });
    }
    this.emit('cycle', this.cycle);
  }

  // PREMIUM selection needs live prices across the near ladder. Subscribe to a
  // window around the money, give the poller a moment, and select from what
  // arrives. Bounded on purpose: subscribing to the whole chain would blow past
  // the gateway's cap and cost a second of quote budget per poll.
  async _warmChain(chain, spot) {
    const step = selectors.strikeStep(chain);
    const atm = selectors.atmStrike(spot, step);
    const span = 12 * step;
    const near = chain.filter(r => Math.abs(Number(r.strike) - atm) <= span);
    if (!near.length) return;
    this.ticker.subscribe(near.map(r => ({ token: r.token, segment: r.segment })));
    await new Promise(r => setTimeout(r, Math.max(600, config.neo.pollMs + 200)));
  }

  // Subscribe to exactly the locked pair plus spot, and point the candle builder
  // at the same two tokens. Dropping the wider ladder here matters: an unused
  // subscription still costs quote budget every poll.
  _subscribeCycle() {
    const want = [];
    if (this.spotToken) want.push(this.spotToken);
    for (const leg of this.legs.values()) {
      want.push({ token: leg.token, segment: 'nse_fo' });
    }
    this.ticker.setSubscriptions(want);
    this.candles.setTokens([...this.legs.values()].map(l => l.token));
  }

  _snapshotSettings() {
    const s = this.settings;
    return {
      candleTimeframe: s.candleTimeframe, sellOffset: s.sellOffset, target: s.target,
      stopLoss: s.stopLoss, pendingTimeout: s.pendingTimeout, positionTimeout: s.positionTimeout,
      legEntryTimeout: s.legEntryTimeout,
      dynamicTarget: s.dynamicTarget, dynamicTargetStep: s.dynamicTargetStep,
      dynamicTargetMax: s.dynamicTargetMax, trailStart: s.trailStart,
      trailGap: s.trailGap, exitOnReversal: s.exitOnReversal,
      strikeMode: s.strikeMode, expiryMode: s.expiryMode, tradeMode: s.tradeMode,
      lots: s.lots, mode: s.mode,
      trendFilter: s.trendFilter, trendTimeframe: s.trendTimeframe,
      trendConfirmBars: s.trendConfirmBars, trendMinTicks: s.trendMinTicks,
      trendBodyPct: s.trendBodyPct, trendCloseNearPct: s.trendCloseNearPct,
      trendMaxRangePoints: s.trendMaxRangePoints, trendMomentum: s.trendMomentum,
      trendStrongBodyPct: s.trendStrongBodyPct, trendWickPct: s.trendWickPct,
      trendMinScore: s.trendMinScore,
    };
  }

  /* --------------------------------------------------------- cycle closing */

  // The strike unlocks only when BOTH legs are flat. A leg that finished early
  // waits in DONE rather than re-entering on the locked strike — that is
  // doc/PROJECT_PLAN.md §2 R6, and it is what keeps "the strike is selected
  // once per cycle" literally true.
  async _maybeCloseCycle() {
    if (!this.cycle) return;
    const legs = [...this.legs.values()];
    if (!legs.length) return;
    if (!legs.every(l => l.state === STATES.DONE)) return;

    // A leg that stood down without ever entering is the least interesting thing
    // that happened, so it is the last reason considered. A cycle where the PE
    // took its target and the CE was never permitted to trade unlocks as TARGET,
    // not as NO_ENTRY.
    const reason = legs.find(l => l.exitReason && l.exitReason !== legMachine.EXIT_REASONS.NO_ENTRY)
      ?.exitReason
      || legs.find(l => l.exitReason)?.exitReason
      || 'COMPLETE';
    await repo.cycles.close(this.cycle.id, reason);
    logger.info('engine: strike UNLOCKED', { cycleId: this.cycle.id, reason });
    await this._event({ cycleId: this.cycle.id, kind: 'STRIKE_UNLOCKED', reason });

    this.cycle = null;
    this.legs.clear();
    this.candles.setTokens([]);
    this.emit('cycle', null);
  }

  /* ---------------------------------------------------------------- inputs */

  async _onCandle(bar) {
    if (!this.cycle) return;
    const leg = [...this.legs.values()].find(l => l.token === String(bar.token));
    if (!leg) return;

    // Persist first, so the id can be recorded against the leg. The chart and
    // every post-mortem then read the exact row the entry was priced from.
    const candleId = await repo.candles.insert({
      token: bar.token, timeframe: bar.timeframe, bucketStart: bar.bucketStart,
      openP: bar.openP, highP: bar.highP, lowP: bar.lowP, closeP: bar.closeP,
      tickCount: bar.tickCount, synthetic: bar.synthetic,
    });

    const gate = this._premiumGate(leg);
    const trend = this._trendGate(leg);
    // Remembered so the entry timeout can say what kept refusing this leg.
    leg.lastGateReason = gate.ok === false ? gate.reason : (trend.ok === false ? trend.reason : null);
    this._noteBlock(bar.tradable === false
      ? `the ${bar.timeframe} bar is not tradable (${bar.synthetic ? 'no prints in it'
        : `only ${bar.tickCount} ticks`})`
      : leg.lastGateReason);
    await this._dispatch(leg, {
      type: 'CANDLE_CLOSED',
      candle: { ...bar, id: candleId },
      gateOk: gate.ok,
      gateReason: gate.reason,
      trendOk: trend.ok,
      trendReason: trend.reason,
      trendState: trend.state,
      tsMs: Date.now(),
    });
    this.emit('candle', { ...bar, id: candleId });
  }

  /* -------------------------------------------------------- block telemetry */

  // WHY IS NOTHING TRADING? — answered without reading the source.
  //
  // Every refusal in this engine is individually reasonable and individually
  // silent. The trend verdict logs only when it CHANGES, so a filter stuck at
  // NO_DATA says so once and then never again. The premium gate logs at DEBUG.
  // A bar under `minTicks` is simply not tradable and nothing mentions it. Put
  // together, a configuration that can never enter looks exactly like a market
  // that never offered anything — which is the single most expensive ambiguity
  // this platform can have, because an operator watching a flat P&L has no way
  // to tell "waiting patiently" from "wedged since 09:25".
  //
  // So every refusal is tallied and the tally is published on an interval. It
  // is a count, not a log line per refusal: at a 15-second candle across two
  // legs that would be 240 lines an hour saying the same thing.
  _noteBlock(reason) {
    if (!reason) {
      // A bar that passed every gate. The window resets so the summary
      // describes the recent past rather than the whole session.
      this._blocks = null;
      this._blocksSince = 0;
      return;
    }
    if (!this._blocks) { this._blocks = new Map(); this._blocksSince = Date.now(); }
    // Reasons carry numbers ("the quote is 7s stale"); grouping on the shape
    // rather than the text keeps the summary to a handful of rows.
    const key = String(reason).replace(/\d+(\.\d+)?/g, 'N').slice(0, 120);
    this._blocks.set(key, (this._blocks.get(key) || 0) + 1);
  }

  // Called from the clock. Emits at most one line per BLOCK_REPORT_MS, and only
  // while something is actually being refused.
  _reportBlocks(now) {
    if (!this._blocks || !this._blocks.size) return;
    if (now - (this._blocksReportedAt || 0) < BLOCK_REPORT_MS) return;
    this._blocksReportedAt = now;

    const ranked = [...this._blocks.entries()].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((n, [, c]) => n + c, 0);
    logger.warn('engine: entries have been refused on every bar', {
      forSeconds: Math.round((now - this._blocksSince) / 1000),
      refusals: total,
      reasons: ranked.slice(0, 4).map(([reason, count]) => `${count}× ${reason}`),
      hint: 'run `node scripts/diagnose-engine.js`, or `node scripts/dry-run.js` for the '
        + 'selection path',
    });
  }

  /* ------------------------------------------------- the index trend filter */

  // A completed NIFTY bar. Store it, re-derive the verdict, and log the verdict
  // only when it CHANGES — at 15 seconds a bar this runs 1560 times a session
  // and an unconditional write would drown the audit trail it is meant to serve.
  async _onTrendCandle(bar) {
    if (!this.settings?.trendFilter) return;

    this.trend.bars.push(bar);
    if (this.trend.bars.length > TREND_BUFFER) this.trend.bars.shift();

    const before = this.trend.verdict;
    const now = trendFilter.verdict(this.trend.bars, this.settings._trend);
    this.trend.verdict = now;

    // Index bars are persisted like option bars: the post-mortem must be able to
    // read the exact rows the filter decided from, not a chart drawn later from
    // a second source.
    repo.candles.insert({
      token: bar.token, timeframe: bar.timeframe, bucketStart: bar.bucketStart,
      openP: bar.openP, highP: bar.highP, lowP: bar.lowP, closeP: bar.closeP,
      tickCount: bar.tickCount, synthetic: bar.synthetic,
    }).catch(err => logger.warn('engine: index candle not stored', { err: err.message }));

    // Feed the verdict to any OPEN position before logging it. This is the loop
    // the dynamic target rides on: every completed index bar either confirms the
    // trend that justified the entry — and pushes the target one step further —
    // or turns against it and takes the trade off.
    await this._driveOpenPositions(now);
    // ...and to any leg that stood down waiting for exactly this verdict.
    await this._reviveStoodDownLegs(now);

    if (before?.state === now.state) return;

    logger.info('engine: index trend', {
      state: now.state, reason: now.reason,
      bars: now.window.map(w => trendFilter.arrow(w.state)).join(' ') || '—',
      allow: [now.allowCE ? 'CE' : null, now.allowPE ? 'PE' : null].filter(Boolean).join('+') || 'none',
    });
    await this._event({
      cycleId: this.cycle?.id, kind: 'TREND_STATE',
      fromState: before?.state || null, toState: now.state,
      reason: now.reason,
      payload: {
        allowCE: now.allowCE, allowPE: now.allowPE,
        scores: now.scores?.map(s => s.total) ?? null,
        window: now.window,
      },
    });
    // The web tier is a separate process and cannot read this object, so the
    // headline goes through the one channel both tiers share.
    repo.flags.set('trend_state', JSON.stringify({
      state: now.state, allowCE: now.allowCE, allowPE: now.allowPE, atMs: now.atMs,
    })).catch(() => {});
  }

  // Every completed index bar is an opinion on a position already open:
  // doc/traling-traget -stoploss.md, "read the last 3 completed 5s NIFTY candles
  // → trend same? → increase target / exit".
  //
  // Note what is NOT a reversal. A verdict of WARMING_UP or NO_DATA means the
  // filter has nothing to say — the feed went quiet, the bars were thin. That is
  // an absence of information, not a change of direction, and closing a live
  // short on it would hand the market a free exit every time a bar goes silent.
  // Such a bar neither confirms nor reverses; the position holds, protected by
  // the trailing stop and the maximum hold as it always was.
  async _driveOpenPositions(verdict) {
    if (!this.cycle) return;

    const undecided = verdict.state === trendFilter.VERDICT_STATES.WARMING_UP
      || verdict.state === trendFilter.VERDICT_STATES.NO_DATA;
    if (undecided) return;

    // A working SELL is withdrawn the moment the trend that justified it turns,
    // whatever `dynamicTarget` and `exitOnReversal` say — those govern open
    // positions. A resting limit is an entry decision, and the entry gate has
    // just changed its mind.
    for (const leg of [...this.legs.values()]) {
      if (leg.state !== STATES.SELL_WORKING) continue;
      const stillOurs = leg.optionType === 'CE' ? verdict.allowCE : verdict.allowPE;
      if (stillOurs) continue;
      await this._dispatch(leg, {
        type: 'TREND_REVERSED',
        reason: `the index is ${trendFilter.short(verdict.state)}: ${verdict.reason}`,
        tsMs: Date.now(),
      });
    }

    if (!this.settings.dynamicTarget && !this.settings.exitOnReversal) return;

    for (const leg of [...this.legs.values()]) {
      if (leg.state !== STATES.POSITION_OPEN && leg.state !== STATES.TARGET_MOVING) continue;

      const stillOurs = leg.optionType === 'CE' ? verdict.allowCE : verdict.allowPE;
      if (stillOurs) {
        await this._dispatch(leg, { type: 'TREND_CONFIRMED', tsMs: Date.now() });
      } else {
        await this._dispatch(leg, {
          type: 'TREND_REVERSED',
          reason: `the index is ${trendFilter.short(verdict.state)}: ${verdict.reason}`,
          tsMs: Date.now(),
        });
      }
    }
  }

  // "May this leg sell right now?" — a VERDICT, never a number. Index prices are
  // as forbidden in the entry calculation as option LTP is; the machine is
  // handed a boolean and cannot reach the bars.
  _trendGate(leg) {
    const s = this.settings;
    if (!s.trendFilter) return { ok: true, reason: null, state: null };

    const v = this.trend.verdict;
    if (!v) {
      return { ok: false, state: 'WARMING_UP', reason: 'the index trend filter has no verdict yet' };
    }

    // doc/update-point.md: a bullish bar is valid for the next bar's width only.
    // Past that the answer describes a market that has moved on, and a stale
    // permission is worse than none.
    const ageMs = Date.now() - (v.atMs ?? 0);
    if (ageMs > s._trendSeconds * 1000 + trendGraceMs(s._trendSeconds)) {
      return {
        ok: false, state: v.state,
        reason: `the index verdict is ${(ageMs / 1000).toFixed(1)}s old — `
          + 'it expired with its bar',
      };
    }

    const allowed = leg.optionType === 'CE' ? v.allowCE : v.allowPE;
    if (allowed) return { ok: true, reason: null, state: v.state };

    return {
      ok: false, state: v.state,
      reason: v.state === trendFilter.BAR_STATES.STRONG_BULLISH
        || v.state === trendFilter.BAR_STATES.STRONG_BEARISH
        ? `the index is ${trendFilter.short(v.state)} — only the `
          + `${v.allowCE ? 'CE' : 'PE'} side may sell`
        : `the index is ${trendFilter.short(v.state)}: ${v.reason}`,
    };
  }

  // "Is this contract sane to trade right now." Looks at the live price — and
  // returns a VERDICT, never a number. The state machine is handed a boolean, so
  // no live price can leak into the entry calculation.
  _premiumGate(leg) {
    const s = this.settings;
    const quote = this.ticker.quote(leg.token);
    if (!quote) return { ok: false, reason: 'no live quote for this strike' };
    if (quote.ageMs > MAX_QUOTE_AGE_MS) {
      return { ok: false, reason: `the quote is ${Math.round(quote.ageMs / 1000)}s stale` };
    }
    if (String(s.strikeMode).toUpperCase() === 'PREMIUM') {
      const lo = s._targetPremiumP - s._premiumToleranceP;
      const hi = s._targetPremiumP + s._premiumToleranceP;
      if (quote.ltpPaise < lo || quote.ltpPaise > hi) {
        return {
          ok: false,
          reason: `the premium ${money.formatPrice(quote.ltpPaise)} has left the band `
            + `${money.formatPrice(lo)}–${money.formatPrice(hi)}`,
        };
      }
    }
    return { ok: true, reason: null };
  }

  _onTick(tick) {
    // Paper mode is driven by the same tick stream the candles are, so a paper
    // fill happens exactly where a live one would.
    if (this.settings?.mode === 'PAPER') {
      this.broker.paper.onTick(tick.token, tick.ltpPaise);
    }

    if (this.spotToken && String(tick.token) === String(this.spotToken.token)) {
      this.risk.recordSpot(tick.ltpPaise / 100, tick.ts);
      // The index feeds the trend filter and NOTHING else. It never reaches
      // this.candles, so no index bar can ever price an entry.
      this.trendCandles?.addTick(tick.token, tick.ltpPaise, tick.ts);
      return;
    }

    this.candles.addTick(tick.token, tick.ltpPaise, tick.ts);

    if (!this.cycle) return;
    const leg = [...this.legs.values()].find(l => l.token === String(tick.token));
    if (!leg || leg.state !== STATES.POSITION_OPEN) return;
    // The stop-loss is the one decision that reacts at tick speed.
    this._dispatch(leg, { type: 'TICK', ltpPaise: tick.ltpPaise, tsMs: tick.ts })
      .catch(this._oops('tick'));
  }

  async _onFill(fill) {
    const leg = this._legById(fill.legId);
    if (!leg) return;
    const now = Date.now();

    if (fill.stage === 'ENTRY') {
      await this._dispatch(leg, {
        type: 'SELL_FILLED', filledPriceP: fill.filledPriceP, filledQty: fill.filledQty, tsMs: now,
      });
      await repo.positions.open({
        cycleId: this.cycle.id, legId: leg.id, tradeDate: time.tradeDate(now),
        optionType: leg.optionType, symbol: leg.symbol, strike: leg.strike,
        qty: fill.filledQty, entryP: fill.filledPriceP,
        targetP: leg.targetPriceP, slP: leg.slPriceP,
      });
      return;
    }

    if (fill.stage === 'TARGET') {
      await this._dispatch(leg, { type: 'TARGET_FILLED', filledPriceP: fill.filledPriceP, tsMs: now });
      return;
    }

    if (fill.stage === 'SL' || fill.stage === 'TIMEOUT' || fill.stage === 'SQUAREOFF') {
      await this._dispatch(leg, { type: 'EXIT_FILLED', filledPriceP: fill.filledPriceP, tsMs: now });
    }
  }

  // A partial fill on the entry is a real position of the filled size. Cancel
  // the remainder and size the target and stop to what actually filled — the
  // alternative is a stop that covers more than the position and an exit that
  // opens a naked long.
  async _onPartial(fill) {
    const leg = this._legById(fill.legId);
    if (!leg || fill.stage !== 'ENTRY') return;
    logger.warn('engine: partial entry fill — cancelling the remainder and sizing to what filled',
      { leg: leg.optionType, filled: fill.filledQty, of: fill.totalQty });
    await this.router.cancel(fill.orderId, 'partial fill — cancelling the balance');
    await this._dispatch(leg, {
      type: 'SELL_FILLED', filledPriceP: fill.filledPriceP, filledQty: fill.filledQty, tsMs: Date.now(),
    });
  }

  async _onCancelled(evt) {
    const leg = this._legById(evt.legId);
    if (!leg) return;
    const now = Date.now();

    if (evt.stage === 'ENTRY') {
      const next = legMachine.afterSellCancel(leg, now);
      await this._apply(leg, next, { type: 'SELL_CANCELLED' });
      return;
    }
    if (evt.stage === 'TARGET') {
      await this._dispatch(leg, { type: 'TARGET_CANCELLED', tsMs: now });
    }
  }

  async _onRejected(evt) {
    const leg = this._legById(evt.legId);
    if (!leg) return;
    if (evt.stage === 'ENTRY') {
      await this._dispatch(leg, { type: 'SELL_REJECTED', reason: evt.reason, tsMs: Date.now() });
    }
  }

  _legById(legId) {
    if (legId == null) return null;
    return [...this.legs.values()].find(l => l.id === legId) || null;
  }

  async _dispatchAll(event) {
    for (const leg of [...this.legs.values()]) await this._dispatch(leg, event);
  }

  /* ---------------------------------------------------- dispatch and apply */

  async _dispatch(leg, event) {
    const cfg = {
      sellOffsetP: this.settings._sellOffsetP,
      targetP: this.settings._targetP,
      stopLossP: this.settings._stopLossP,
      pendingTimeoutMs: this.settings._pendingTimeoutMs,
      positionTimeoutMs: this.settings._positionTimeoutMs,
      legEntryTimeoutMs: this.settings._legEntryTimeoutMs,
      dynamicTarget: this.settings.dynamicTarget,
      dynamicStepP: this.settings._dynamicStepP,
      dynamicMax: this.settings.dynamicTargetMax,
      trailStartP: this.settings._trailStartP,
      trailGapP: this.settings._trailGapP,
      exitOnReversal: this.settings.exitOnReversal,
    };
    const next = legMachine.reduce(leg, event, cfg);
    await this._apply(leg, next, event);
  }

  async _apply(leg, next, event) {
    const from = leg.state;
    Object.assign(leg, next.patch);
    leg.state = next.state;

    if (from !== next.state || Object.keys(next.patch).length) {
      await repo.legs.setState(leg.id, next.state, {
        attemptSeq: next.patch.attemptSeq,
        entryCandleId: next.patch.entryCandleId,
        sellPriceP: next.patch.sellPriceP,
        filledPriceP: next.patch.filledPriceP,
        targetPriceP: next.patch.targetPriceP,
        slPriceP: next.patch.slPriceP,
        filledQty: next.patch.filledQty,
        confirmations: next.patch.confirmations,
        // `in` rather than truthiness: a re-arm CLEARS these, and an explicit
        // null has to reach the column. The old ternary turned null into
        // undefined, which the repository reads as "leave it alone" — so a
        // re-armed leg would have kept the previous round trip's timestamps.
        openedAt: stamp(next.patch, 'openedAt'),
        closedAt: stamp(next.patch, 'closedAt'),
        exitReason: next.patch.exitReason,
      });
    }

    if (from !== next.state) {
      await this._event({
        cycleId: this.cycle?.id, legId: leg.id, optionType: leg.optionType,
        kind: 'STATE', fromState: from, toState: next.state, reason: event.type,
      });
      this.emit('leg', { ...leg });
    }

    for (const action of next.actions) await this._act(leg, action);
  }

  async _act(leg, action) {
    switch (action.type) {
      case 'LOG':
        await this._event({
          cycleId: this.cycle?.id, legId: leg.id, optionType: leg.optionType,
          kind: action.kind, reason: action.reason || action.note || null, payload: action,
        });
        return;

      case 'PLACE_SELL': {
        const order = await this.router.place({
          cycleId: this.cycle.id, legId: leg.id, optionType: leg.optionType,
          attemptSeq: action.attemptSeq, stage: 'ENTRY',
          token: leg.token, segment: 'nse_fo', symbol: leg.symbol,
          side: 'SELL', orderType: 'L', qty: this.cycle.qty,
          limitPriceP: action.pricePaise, tickP: leg.tickP || 5,
        }).catch(async (err) => {
          // A pre-send rate limit leaves the order PENDING. Step the leg back so
          // the next candle prices a fresh one rather than leaving it stranded.
          logger.warn('engine: sell deferred', { leg: leg.optionType, err: err.message });
          await this._dispatch(leg, { type: 'SELL_REJECTED', reason: err.message, tsMs: Date.now() });
          return null;
        });
        if (order && order.status === 'WORKING') {
          await this._dispatch(leg, { type: 'SELL_PLACED', orderId: order.id, tsMs: Date.now() });
        }
        return;
      }

      case 'CANCEL_SELL': {
        if (!leg.sellOrderId) return;
        const res = await this.router.cancel(leg.sellOrderId, 'pending timeout');
        if (res.outcome === 'CANCELLED') {
          const next = legMachine.afterSellCancel(leg, Date.now());
          await this._apply(leg, next, { type: 'SELL_CANCELLED' });
        }
        // ALREADY_FILLED needs no action: the reconciler will report the fill
        // and SELL_FILLED is handled from SELL_CANCELLING for exactly this case.
        return;
      }

      case 'PLACE_TARGET': {
        const order = await this.router.place({
          cycleId: this.cycle.id, legId: leg.id, optionType: leg.optionType,
          attemptSeq: leg.attemptSeq, stage: 'TARGET',
          // The ladder rung. Each one is a different order and needs a different
          // idempotency key, but a RETRY of the same rung must reuse it — so it
          // is keyed on the confirmation count, not on a counter of placements.
          revision: leg.confirmations || 0,
          token: leg.token, segment: 'nse_fo', symbol: leg.symbol,
          side: 'BUY', orderType: 'L', qty: action.qty,
          limitPriceP: action.pricePaise, tickP: leg.tickP || 5,
        }).catch((err) => {
          // A target that could not be placed is not fatal — the stop and the
          // timeout still protect the position — but it must be loud.
          logger.error('engine: THE TARGET ORDER FAILED — the position is running on '
            + 'its stop and timeout alone', { leg: leg.optionType, err: err.message });
          return null;
        });
        if (order && order.status === 'WORKING') {
          await this._dispatch(leg, { type: 'TARGET_PLACED', orderId: order.id, tsMs: Date.now() });
          // Keep the position row honest about the levels it is actually
          // working. Written here rather than on every trailing tick: the target
          // moves a handful of times a trade, and the stop is carried alongside
          // it for free.
          await repo.positions.updateBrackets(leg.id, {
            targetP: action.pricePaise, slP: leg.slPriceP,
          }).catch(err => logger.warn('engine: position brackets not updated', { err: err.message }));
        }
        return;
      }

      case 'CANCEL_TARGET': {
        // The OCO door. Nothing may be sent until this cancel is confirmed.
        if (!leg.targetOrderId) {
          await this._dispatch(leg, { type: 'TARGET_CANCELLED', tsMs: Date.now() });
          return;
        }
        const res = await this.router.cancel(leg.targetOrderId, `exit: ${action.reason}`);
        if (res.outcome === 'CANCELLED' || res.outcome === 'GONE') {
          leg.cancelFailedAt = null;
          await this._dispatch(leg, { type: 'TARGET_CANCELLED', tsMs: Date.now() });
        } else if (res.outcome === 'ALREADY_FILLED') {
          leg.cancelFailedAt = null;
          await this._dispatch(leg, {
            type: 'TARGET_CANCEL_FAILED_FILLED',
            filledPriceP: leg.targetPriceP, tsMs: Date.now(),
          });
        } else {
          // FAILED — genuinely ambiguous. Do NOT send an exit order: the target
          // may still be working, and two exits on one short opens a naked long.
          // Stamping the leg is what makes the clock retry — see _recoverStuck.
          // Without it the leg would sit here holding a live short with no exit
          // in flight and nothing to move it, not even the square-off.
          leg.cancelFailedAt = Date.now();
          logger.error('engine: the target cancel failed — will retry, NOT exiting',
            { leg: leg.optionType, reason: res.reason });
        }
        return;
      }

      case 'EXIT_MARKET': {
        const order = await this.router.place({
          cycleId: this.cycle.id, legId: leg.id, optionType: leg.optionType,
          attemptSeq: leg.attemptSeq, stage: action.reason === 'STOPLOSS' ? 'SL'
            : action.reason === 'TIMEOUT' ? 'TIMEOUT' : 'SQUAREOFF',
          token: leg.token, segment: 'nse_fo', symbol: leg.symbol,
          side: 'BUY', orderType: 'MKT', qty: action.qty || this.cycle.qty,
          limitPriceP: 0, tickP: leg.tickP || 5,
        }).catch((err) => {
          logger.error('engine: THE EXIT ORDER FAILED — the position is still open',
            { leg: leg.optionType, reason: action.reason, err: err.message });
          return null;
        });
        if (order && order.status === 'WORKING') {
          await this._dispatch(leg, { type: 'EXIT_PLACED', orderId: order.id, tsMs: Date.now() });
        }
        return;
      }

      case 'CLOSE_LEG':
        await this._closeLeg(leg, action.reason, action.exitPriceP);
        return;

      default:
        logger.warn('engine: unknown action from the state machine', { type: action.type });
    }
  }

  // Book the trade. Net, not gross — a one-point target on one lot is mostly
  // charges, and the risk manager must see the number the account actually
  // moved by.
  async _closeLeg(leg, reason, exitPriceP) {
    const position = await repo.positions.openByLeg(leg.id);
    if (!position) {
      logger.warn('engine: no open position row for a leg that closed', { legId: leg.id });
      await this._maybeCloseCycle();
      return;
    }

    const qty = position.qty;
    const pnl = money.shortPnl({
      entryPaise: position.entry_p, exitPaise: exitPriceP, qty,
    });

    await repo.positions.close(position.id, {
      exitP: exitPriceP,
      grossPnlP: pnl.grossPaise,
      chargesP: pnl.chargesPaise,
      netPnlP: pnl.netPaise,
      exitReason: reason,
    });

    await this.risk.recordTrade(this.settings, {
      grossPnlP: pnl.grossPaise,
      chargesP: pnl.chargesPaise,
      netPnlP: pnl.netPaise,
      exitReason: reason,
    });

    logger.info('engine: trade closed', {
      leg: leg.optionType, reason,
      entry: money.formatPrice(position.entry_p), exit: money.formatPrice(exitPriceP),
      gross: money.formatInr(pnl.grossPaise), charges: money.formatInr(pnl.chargesPaise),
      net: money.formatInr(pnl.netPaise),
    });
    await this._event({
      cycleId: this.cycle?.id, legId: leg.id, optionType: leg.optionType,
      kind: 'TRADE_CLOSED', reason,
      payload: {
        entryP: position.entry_p, exitP: exitPriceP, qty,
        grossP: pnl.grossPaise, chargesP: pnl.chargesPaise, netP: pnl.netPaise,
      },
    });

    this.emit('trade', { legId: leg.id, reason, ...pnl });

    // PER_LEG: this leg goes straight back to work rather than waiting in DONE
    // for its partner. If it re-arms, the cycle is still busy and must not close.
    if (await this._maybeRearm(leg)) return;
    await this._maybeCloseCycle();
  }

  /* ------------------------------------------------------- per-leg re-entry */

  // `cycleScope: PER_LEG` — R6's documented alternative. Higher trade frequency,
  // at the cost of a strike that ages against a moving spot; `cycleMaxAge` is
  // what stops that ageing from being unbounded.
  //
  // The risk gate is consulted on EVERY re-arm, not just at cycle open. Without
  // that, PER_LEG would be a hole straight through the daily loss limit, the
  // cooldown and the session window: a leg could keep re-entering all afternoon
  // on a cycle that passed the gate once, hours earlier. riskManager.js says as
  // much in its own header — "canEnter() is consulted before a cycle opens and
  // before a leg arms".
  async _maybeRearm(leg, why = 'round trip complete') {
    if (String(this.settings.cycleScope).toUpperCase() !== 'PER_LEG') return false;
    if (!this.running || !this.cycle) return false;

    const now = Date.now();
    const note = async (reason) => {
      logger.info('engine: leg not re-armed', { leg: leg.optionType, why, reason });
      await this._event({
        cycleId: this.cycle?.id, legId: leg.id, optionType: leg.optionType,
        kind: 'REARM_DECLINED', reason, payload: { why },
      });
    };

    if (time.isAfter(now, this.settings.squareOffAt)) {
      await note('past the square-off');
      return false;
    }

    // The strike was chosen against a spot that has since moved. Beyond this age
    // the honest thing is to let the cycle close and select a fresh one rather
    // than keep selling a strike the selector would no longer pick.
    const maxAgeMs = Number(this.settings.cycleMaxAge || 0) * 1000;
    if (maxAgeMs > 0) {
      const lockedAt = time.fromMysql(this.cycle.locked_at) ?? now;
      if (now - lockedAt > maxAgeMs) {
        await note(`the strike has been locked for ${Math.round((now - lockedAt) / 1000)}s `
          + `(cycleMaxAge ${this.settings.cycleMaxAge}s) — re-selecting`);
        return false;
      }
    }

    const gate = await this.risk.canEnter(this.settings, now);
    if (!gate.ok) {
      await note(gate.reason);
      return false;
    }

    await this._dispatch(leg, { type: 'REARM', tsMs: now, why });
    return leg.state === STATES.WAIT_CANDLE;
  }

  // A leg that stood down with NO_ENTRY did so because the index would not
  // permit its side. When the index turns, that reason has expired — and under
  // PER_LEG nothing else would bring it back, because a leg only re-arms after a
  // completed ROUND TRIP and this one never had one. It would sit out the rest
  // of the cycle trading nothing while the market ran its way.
  //
  // Only under PER_LEG. Under BOTH_LEGS the recovery is the cycle itself: the
  // stood-down leg lets the cycle close in seconds and the next one arms both
  // legs on a freshly selected strike, which is strictly better than reviving a
  // leg onto a strike chosen for the opposite trend.
  async _reviveStoodDownLegs(verdict) {
    if (String(this.settings.cycleScope).toUpperCase() !== 'PER_LEG') return;
    if (!this.cycle) return;

    for (const leg of [...this.legs.values()]) {
      if (leg.state !== STATES.DONE) continue;
      if (leg.exitReason !== legMachine.EXIT_REASONS.NO_ENTRY) continue;

      const permitted = leg.optionType === 'CE' ? verdict.allowCE : verdict.allowPE;
      if (!permitted) continue;

      const revived = await this._maybeRearm(leg, 'the index turned in this leg\'s favour');
      if (revived) {
        logger.info('engine: a stood-down leg is back in play', {
          leg: leg.optionType, trend: verdict.state,
        });
        await this._event({
          cycleId: this.cycle.id, legId: leg.id, optionType: leg.optionType,
          kind: 'LEG_REVIVED', reason: `the index is now ${trendFilter.short(verdict.state)}`,
        });
      }
    }
  }

  /* ----------------------------------------------------------------- spot -- */

  // Resolve the index instrument, subscribe to it, and point the trend series at
  // it. Idempotent and cheap once resolved, so it is safe to call from the clock
  // — the instrument master can be empty at boot and populated a minute later.
  async _ensureSpot() {
    if (this.spotToken) return this.spotToken;
    const instrumentMaster = require('../market/instrumentMaster');
    this.spotToken = await instrumentMaster.indexInstrument(this.settings.symbol);
    if (!this.spotToken) return null;

    this.ticker.subscribe([this.spotToken]);
    if (this.trendCandles && this.settings.trendFilter) {
      this.trendCandles.setTokens([this.spotToken.token]);
      logger.info('engine: the index trend filter is watching the spot series', {
        symbol: this.settings.symbol, token: this.spotToken.token,
        timeframe: this.settings.trendTimeframe,
      });
    }
    return this.spotToken;
  }

  // No spot means no ATM, which means `_openCycle` returns before it selects
  // anything — and it does that silently, once a second, forever.
  //
  // That is not hypothetical. The index was resolved to the numeric token its
  // own master publishes, which Kotak answers with an empty array rather than a
  // price, and the engine sat there for a whole session selecting nothing while
  // every other check on the dashboard read green. So a spot that never arrives
  // is now an ERROR that names the instrument, not an early return.
  async _spot() {
    await this._ensureSpot();
    if (!this.spotToken) return null;
    const paise = this.ticker.ltpPaise(this.spotToken.token);

    if (paise == null) {
      this._blindSince = this._blindSince || Date.now();
      const blindMs = Date.now() - this._blindSince;
      if (blindMs > SPOT_BLIND_MS && Date.now() - (this._blindReportedAt || 0) > SPOT_BLIND_MS) {
        this._blindReportedAt = Date.now();
        logger.error('engine: NO SPOT PRICE — no cycle can open', {
          instrument: `${this.spotToken.segment}|${this.spotToken.token}`,
          blindForSeconds: Math.round(blindMs / 1000),
          note: 'the feed has never returned a price for this instrument. An index is '
            + 'quoted by NAME, not by its numeric token — run `node scripts/diagnose-spot.js`.',
        });
      }
      return null;
    }

    this._blindSince = null;
    return paise / 100;
  }

  async _event(row) {
    try {
      await repo.events.log({ ...row, tsMs: row.tsMs ?? Date.now() });
    } catch (err) {
      logger.warn('engine: event log failed', { err: err.message });
    }
  }

  /* --------------------------------------------------------------- status -- */

  status() {
    return {
      running: this.running,
      mode: this.settings?.mode ?? null,
      lastError: this.lastError,
      trend: this.settings?.trendFilter
        ? {
          enabled: true,
          timeframe: this.settings.trendTimeframe,
          bars: this.trend.bars.length,
          state: this.trend.verdict?.state ?? 'WARMING_UP',
          allowCE: this.trend.verdict?.allowCE ?? false,
          allowPE: this.trend.verdict?.allowPE ?? false,
          reason: this.trend.verdict?.reason ?? null,
          scores: this.trend.verdict?.scores?.map(s => s.total) ?? null,
          atMs: this.trend.verdict?.atMs ?? null,
        }
        : { enabled: false },
      cycle: this.cycle
        ? {
          id: this.cycle.id,
          expiry: this.cycle.expiry_date,
          spotAtLock: this.cycle.spot_at_lock,
          qty: this.cycle.qty,
          ce: this.cycle.ce_symbol,
          pe: this.cycle.pe_symbol,
          lockedAt: this.cycle.locked_at,
        }
        : null,
      legs: [...this.legs.values()].map(l => ({
        optionType: l.optionType,
        symbol: l.symbol,
        strike: l.strike,
        state: l.state,
        attemptSeq: l.attemptSeq,
        confirmations: l.confirmations || 0,
        trailingOnly: Boolean(l.trailingOnly),
        trailPeakP: l.trailPeakP ?? null,
        sellPriceP: l.sellPriceP,
        filledPriceP: l.filledPriceP,
        targetPriceP: l.targetPriceP,
        slPriceP: l.slPriceP,
        ltpPaise: this.ticker.ltpPaise(l.token),
        openPnlP: l.filledPriceP != null && this.cycle
          ? money.openPnl({
            entryPaise: l.filledPriceP,
            ltpPaise: this.ticker.ltpPaise(l.token) ?? l.filledPriceP,
            qty: l.filledQty || this.cycle.qty,
          })
          : null,
        candle: this.candles.lastClosed(l.token),
      })),
    };
  }
}

module.exports = { ScalperEngine };
