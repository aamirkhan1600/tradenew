// The runner: one instance per strategy row.
//
// It is deliberately thin. Every rule lives in the pure modules — stateMachine
// decides, scanner selects, riskManager gates, money prices. The runner's job
// is only to gather the facts, hand them over, carry out the single action that
// comes back, and write down what happened.
//
// Order of operations inside a tick:
//     load facts -> decide -> act -> persist -> audit
//
// One action per tick, except where a sequence must not be interrupted: an exit
// buys back the short and sells the hedge in the same pass, because leaving a
// tick's gap between them is exactly the window where the position is exposed.

const logger = require('../core/logger');
const repo = require('../repositories');
const money = require('../core/money');
const time = require('../core/time');
const scanner = require('./scanner');
const riskManager = require('./riskManager');
const strategyConfig = require('./config');
const { decide, STATES: S, ACTIONS: A, EXPOSED_STATES } = require('./stateMachine');
const orderRouter = require('../execution/orderRouter');
const reconciler = require('../execution/reconciler');
const instrumentStore = require('../market/instrumentStore');
const { TradingHaltedError, RateLimitedError } = require('../core/errors');

const CHAIN_CACHE_MS = 60000;

function emptyRuntime() {
  return { armed: false, armedLow: null, armedAt: null, cooldownUntil: 0, attemptSeq: 0 };
}

class StrategyRunner {
  constructor({ row, ticker, kotakSession }) {
    this.id = Number(row.id);
    this.userId = Number(row.user_id);
    this.name = row.name;
    this.state = row.status || S.IDLE;
    this.queuePriority = Number(row.queue_priority ?? 5);
    this.enabled = !!row.enabled;

    this.config = strategyConfig.normalise(safeParse(row.config, {}));
    this.runtime = { ...emptyRuntime(), ...safeParse(row.state, {}) };

    this.ticker = ticker;
    this.kotakSession = kotakSession;

    this.trade = null;
    this.stats = null;
    this.candidate = null;
    this.lastDecision = row.last_decision || 'idle';
    this.lastError = row.last_error || null;
    this.spot = null;
    this.shortQuote = null;

    this._chainCache = { key: null, at: 0, data: null };
    this._busy = false;
  }

  // Adopt operator edits without disturbing anything live.
  refresh(row) {
    this.name = row.name;
    this.enabled = !!row.enabled;
    this.queuePriority = Number(row.queue_priority ?? 5);
    if (!EXPOSED_STATES.has(this.state)) {
      this.config = strategyConfig.normalise(safeParse(row.config, {}));
    }
  }

  updateSession({ ticker, kotakSession }) {
    if (ticker) this.ticker = ticker;
    if (kotakSession) this.kotakSession = kotakSession;
  }

  /* =============================================================== tick === */
  async tick({ hasPositionSlot, halted, now = Date.now() }) {
    if (this._busy) return;             // a slow order must not overlap the next tick
    this._busy = true;
    try {
      await this._tickBody({ hasPositionSlot, halted, now });
    } catch (err) {
      this.lastError = err.message;
      logger.error('strategyRunner: tick failed', { strategyId: this.id, err: err.message, stack: err.stack });
      await this.audit('ERROR', err.message, { level: 'ERROR' });
      await this.persist();
    } finally {
      this._busy = false;
    }
  }

  async _tickBody({ hasPositionSlot, halted, now }) {
    await this.loadFacts(now);

    // An operator square-off. Claimed atomically from its own columns — it is
    // deliberately NOT carried in `runtime`, because this method rewrites the
    // `state` column every tick and would overwrite a request written there by
    // the web tier before ever seeing it. Handled ahead of the state machine
    // because it is an override, not a market condition, but it still goes
    // through the same exit path so leg ordering and accounting are identical.
    const squareOffBy = await repo.strategies.claimSquareOff(this.id);
    if (squareOffBy) {
      if (!this.trade) {
        logger.info('strategyRunner: square-off requested but nothing is open',
          { strategyId: this.id, by: squareOffBy });
      } else {
        logger.warn('strategyRunner: operator square-off', { strategyId: this.id, by: squareOffBy });
        await this.audit('SQUARE_OFF', 'square-off requested by ' + squareOffBy, { level: 'WARN' });
        if (this.trade.sell_price == null) await this.unwindLoneHedge('manual', now);
        else await this.exitPosition('manual', now);
        await this.persist();
        return;
      }
    }

    let context = this.buildContext({ hasPositionSlot, halted, now });
    let outcome = decide(context);

    // SCAN is the one action that only produces more facts, so it resolves
    // in-tick and the decision is retaken with the answer.
    if (outcome.action === A.SCAN) {
      this.candidate = await this.runScan();
      context = this.buildContext({ hasPositionSlot, halted, now });
      outcome = decide(context);
    }

    await this.applyOutcome(outcome, now);
  }

  /* ------------------------------------------------------------- 1. facts */
  async loadFacts(now) {
    const today = time.istDateString(now);

    this.trade = await repo.trades.openForStrategy(this.id);
    this.stats = await repo.dailyStats.get(this.id, today) || riskManager.emptyStats(today);

    // Counters and the re-entry block are per trading day.
    if (this.runtime.dayKey !== today) {
      this.runtime = { ...emptyRuntime(), dayKey: today };
    }

    this.spot = await this.readSpot();
    this.shortQuote = this.trade?.sell_z_token != null
      ? this.ticker?.quote(String(this.trade.sell_z_token)) ?? null
      : null;
  }

  async readSpot() {
    if (!this.ticker) return null;
    const token = await instrumentStore.indexToken(this.config.underlying);
    if (!token) return null;
    this.ticker.subscribe([token]);
    return this.ticker.ltp(token);
  }

  buildContext({ hasPositionSlot, halted, now }) {
    return {
      state: this.state,
      config: this.config,
      session: {
        minutes: time.istMinutes(now),
        isTradingDay: time.isTradingDay(now, this.config.holidays),
        marketOpen: time.isMarketOpen(now, this.config.holidays),
      },
      market: {
        spot: this.spot,
        shortLtp: this.shortQuote?.ltp ?? null,
        shortAgeMs: this.shortQuote?.ageMs ?? null,
        feedHealthy: !!this.ticker?.isHealthy(),
      },
      candidate: this.candidate,
      trade: this.tradeSnapshot(),
      runtime: this.runtime,
      risk: { blockedReason: riskManager.checkEntryGates({ config: this.config, stats: this.stats }) },
      halted,
      hasPositionSlot,
      now,
    };
  }

  // The state machine sees a trade as plain numbers, never a database row.
  tradeSnapshot() {
    const t = this.trade;
    if (!t) return null;
    return {
      id: Number(t.id),
      optionType: t.option_type,
      sellStrike: numOrNull(t.sell_strike),
      sellPrice: numOrNull(t.sell_price),
      hedgeStrike: numOrNull(t.hedge_strike),
      hedgePrice: numOrNull(t.hedge_price),
      qty: Number(t.qty),
      targetPrice: numOrNull(t.target_price),
      slPrice: numOrNull(t.sl_price),
      hedgeOpenedAt: t.opened_at ? new Date(t.opened_at).getTime() : null,
    };
  }

  /* -------------------------------------------------------------- 2. scan */
  async runScan() {
    const expiry = this.config.expiry
      || (await repo.instruments.listExpiries(this.config.underlying))[0];
    if (!expiry) {
      return { ok: false, reason: `no expiry for ${this.config.underlying} — sync the instrument master` };
    }

    const chainData = await this.getChain(expiry);
    if (!chainData.chain.length) {
      return { ok: false, reason: `no chain for ${this.config.underlying} ${expiry}` };
    }

    // Keep the feed centred on the tradable window as spot drifts.
    if (this.ticker) {
      this.ticker.subscribe(
        scanner.subscriptionWindow({ chain: chainData.chain, spot: this.spot, config: this.config }));
    }

    const priceOf = (zToken) => this.ticker?.quote(zToken) ?? null;
    const found = scanner.findCandidate({
      chain: chainData.chain, priceOf, spot: this.spot, config: this.config,
    });
    return { ...found, expiry, lotSize: chainData.lotSize };
  }

  async getChain(expiry) {
    const key = `${this.config.underlying}:${expiry}`;
    if (this._chainCache.key === key && Date.now() - this._chainCache.at < CHAIN_CACHE_MS) {
      return this._chainCache.data;
    }
    const data = await repo.instruments.chain(this.config.underlying, expiry);
    this._chainCache = { key, at: Date.now(), data };
    return data;
  }

  /* --------------------------------------------------------------- 3. act */
  async applyOutcome(outcome, now) {
    const from = this.state;
    if (outcome.patch) this.runtime = { ...this.runtime, ...outcome.patch };
    this.lastDecision = outcome.reason;

    switch (outcome.action) {
      case A.PLACE_HEDGE:
        await this.buyHedge(outcome, now);
        break;
      case A.PLACE_SHORT:
        await this.sellShort(outcome, now);
        break;
      case A.EXIT_SHORT:
        await this.exitPosition(outcome.patch?.exitReason || 'manual', now);
        break;
      case A.EXIT_HEDGE:
        await this.unwindLoneHedge(outcome.patch?.exitReason || 'time', now);
        break;
      case A.RECONCILE:
        await this.reconcile();
        break;
      default:
        this.state = outcome.next;
        break;
    }

    if (from !== this.state) {
      logger.flow(`${this.name}: ${from} -> ${this.state}`, { strategyId: this.id, reason: this.lastDecision });
      await this.audit('STATE', this.lastDecision, { fromState: from, toState: this.state });
    }
    await this.persist();
  }

  /* ------------------------------------------- INVARIANT 1: hedge goes on first */
  async buyHedge(outcome, now) {
    const c = this.candidate;
    if (!c?.ok) { this.state = S.SCANNING; return; }

    this.state = S.HEDGE_PENDING;
    this.runtime.attemptSeq = (this.runtime.attemptSeq || 0) + 1;
    const lotSize = c.hedge.cell.lotSize || c.lotSize || 1;
    const qty = Math.max(1, this.config.lots) * lotSize;

    const result = await this.placeLeg({
      leg: c.hedge.cell, side: 'BUY', qty, purpose: 'HEDGE_ENTRY',
      stage: 'hedge', reduceOnly: false, referencePrice: c.hedge.premium, now,
    });

    await this.audit('HEDGE', result.ok
      ? `hedge BUY confirmed at ${result.fillPrice ?? c.hedge.premium}`
      : `hedge BUY failed: ${result.reason}`,
    { level: result.ok ? 'INFO' : 'WARN', meta: { strike: c.hedge.strike, qty, orderId: result.orderId } });

    if (!result.ok) {
      // Nothing is live. Stand down and let the cooldown throttle a retry storm.
      this.lastError = `hedge not placed: ${result.reason}`;
      this.lastDecision = this.lastError;
      this.candidate = null;
      this.runtime.cooldownUntil = now + Math.max(30, this.config.reentryCooldownSec) * 1000;
      this.state = S.IDLE;
      return;
    }

    const hedgeFill = result.fillPrice ?? c.hedge.premium;
    const tradeId = await repo.trades.open({
      userId: this.userId, strategyId: this.id, tradeDate: time.istDateString(now),
      underlying: this.config.underlying, expiryDate: c.expiry, optionType: c.short.optionType,
      sellSymbol: c.short.cell.kSymbol, sellKToken: c.short.cell.kToken, sellZToken: c.short.cell.zToken,
      sellStrike: c.short.strike,
      hedgeSymbol: c.hedge.cell.kSymbol, hedgeKToken: c.hedge.cell.kToken, hedgeZToken: c.hedge.cell.zToken,
      hedgeStrike: c.hedge.strike, hedgePrice: hedgeFill,
      lots: this.config.lots, lotSize, qty,
      armPrice: this.config.armPrice, offsetValue: this.config.offset,
      mode: this.config.mode,
    });

    await linkOrderToTrade(result.orderId, tradeId);

    this.trade = await repo.trades.get(tradeId);
    this.runtime.armed = false;
    this.runtime.armedLow = null;
    if (this.trade?.sell_z_token) this.ticker?.subscribe([String(this.trade.sell_z_token)]);
    this.state = S.HEDGE_OPEN;
    this.lastDecision = `hedge filled at ${hedgeFill} — waiting for the arm price ${this.config.armPrice}`;
  }

  /* ----------------------------------------------------- sell the short leg */
  async sellShort(outcome, now) {
    this.state = S.SHORT_PENDING;
    const t = this.trade;
    const leg = shortLeg(t);
    const reference = this.shortQuote?.ltp ?? null;

    const result = await this.placeLeg({
      leg, side: 'SELL', qty: Number(t.qty), purpose: 'SHORT_ENTRY',
      stage: 'short', reduceOnly: false, referencePrice: reference, now,
    });

    await this.audit('SHORT', result.ok
      ? `short SELL confirmed at ${result.fillPrice ?? reference}`
      : `short SELL failed: ${result.reason}`,
    { level: result.ok ? 'INFO' : 'ERROR', tradeId: t.id, meta: { orderId: result.orderId } });

    if (!result.ok) {
      // INVARIANT 1: a hedge with no short is not a position we hold.
      this.lastError = `short not placed: ${result.reason}`;
      await repo.trades.patch(t.id, { exit_reason: 'short_failed' });
      await this.unwindLoneHedge('short_failed', now);
      return;
    }

    const fill = result.fillPrice ?? reference;
    // The target is set from the REAL fills and is never allowed below what the
    // four-leg round trip costs — a target inside the charge band books a "win"
    // that is a realised loss.
    const resolved = money.resolveTargetPoints({
      configuredTarget: this.config.target,
      sellPrice: fill,
      hedgePrice: Number(t.hedge_price),
      qty: Number(t.qty),
      coverCharges: this.config.coverCharges,
      bufferPct: this.config.chargeBufferPct,
    });

    const targetPrice = money.round(fill - resolved.points);
    const slPrice = money.round(fill + this.config.stoploss);

    await repo.trades.patch(t.id, {
      sell_price: fill, target_points: resolved.points,
      target_price: targetPrice, sl_price: slPrice,
      armed_at: this.runtime.armedAt ? new Date(this.runtime.armedAt) : null,
      armed_low: this.runtime.armedLow ?? null,
      status: 'OPEN',
    });
    await linkOrderToTrade(result.orderId, t.id);

    if (resolved.lifted) {
      await this.audit('TARGET',
        `target lifted from ${this.config.target} to ${resolved.points} points to clear `
        + `${money.formatInr(resolved.charges)} of charges (breakeven ${resolved.breakeven})`,
        { level: 'WARN', tradeId: t.id, meta: resolved });
    }

    this.trade = await repo.trades.get(t.id);
    this.state = S.POSITION_OPEN;
    this.lastDecision = `SHORT ${t.option_type} ${t.sell_strike} at ${fill}`
      + ` · target ${targetPrice} / stop ${slPrice} (${resolved.points} pts)`;
    logger.flow(`${this.name}: position open`, { strategyId: this.id, fill, targetPrice, slPrice });
  }

  /* ------------------------------- INVARIANT 2: short comes off before hedge */
  async exitPosition(reason, now) {
    const t = this.trade;
    this.state = S.EXIT_SHORT;
    await repo.trades.patch(t.id, { status: 'EXITING', exit_reason: reason });

    const buyBack = await this.placeLeg({
      leg: shortLeg(t), side: 'BUY', qty: Number(t.qty), purpose: 'SHORT_EXIT',
      stage: 'exit-short', reduceOnly: true, referencePrice: this.shortQuote?.ltp ?? null, now,
    });

    await this.audit('EXIT', buyBack.ok
      ? `short bought back at ${buyBack.fillPrice}`
      : `short buy-back FAILED: ${buyBack.reason}`,
    { level: buyBack.ok ? 'INFO' : 'ERROR', tradeId: t.id, meta: { reason, orderId: buyBack.orderId } });

    if (!buyBack.ok) {
      // The hedge is NOT touched either way — it is the only thing capping the
      // loss on a short that may still be live.
      if (buyBack.uncertain) {
        // We do not know whether the short was closed. Retrying could leave a
        // naked long if it did fill; not retrying leaves a short if it did not.
        // Neither is safe to automate, so stop and escalate to a human.
        this.lastError = `exit outcome UNKNOWN (${buyBack.reason}) — halted for manual review`;
        this.lastDecision = this.lastError;
        await repo.trades.patch(t.id, { status: 'NEEDS_ATTENTION' });
        await this.audit('EXIT', this.lastError, { level: 'ERROR', tradeId: t.id });
        logger.error('strategyRunner: exit outcome unknown — HALTED', {
          strategyId: this.id, tradeId: t.id, reason: buyBack.reason,
        });
        this.state = S.HALTED;
        this.trade = await repo.trades.get(t.id);
        return;
      }
      // A clean rejection: nothing was placed. Back to monitoring, retry next tick.
      this.lastError = `exit failed (${buyBack.reason}) — short still open, hedge retained`;
      this.lastDecision = this.lastError;
      await repo.trades.patch(t.id, { status: 'OPEN' });
      this.state = S.POSITION_OPEN;
      this.trade = await repo.trades.get(t.id);
      return;
    }

    // Only now may the hedge come off.
    this.state = S.EXIT_HEDGE;
    const hedgeQuote = this.ticker?.quote(String(t.hedge_z_token));
    const hedgeExit = await this.placeLeg({
      leg: hedgeLeg(t), side: 'SELL', qty: Number(t.qty), purpose: 'HEDGE_EXIT',
      stage: 'exit-hedge', reduceOnly: true, referencePrice: hedgeQuote?.ltp ?? null, now,
    });

    await this.audit('EXIT', hedgeExit.ok
      ? `hedge sold at ${hedgeExit.fillPrice}`
      : `hedge exit FAILED: ${hedgeExit.reason}`,
    { level: hedgeExit.ok ? 'INFO' : 'ERROR', tradeId: t.id, meta: { orderId: hedgeExit.orderId } });

    const sellExit = buyBack.fillPrice ?? this.shortQuote?.ltp ?? Number(t.sell_price);
    const hedgeExitPrice = hedgeExit.fillPrice ?? hedgeQuote?.ltp ?? Number(t.hedge_price);

    const pnl = money.tradePnl({
      sellPrice: Number(t.sell_price), sellExitPrice: sellExit,
      hedgePrice: Number(t.hedge_price), hedgeExitPrice: hedgeExitPrice,
      qty: Number(t.qty),
    });

    await repo.trades.patch(t.id, {
      sell_exit_price: sellExit, hedge_exit_price: hedgeExitPrice,
      exit_reason: reason, gross_pnl: pnl.gross, charges: pnl.charges, net_pnl: pnl.net,
      status: hedgeExit.ok ? 'CLOSED' : 'NEEDS_ATTENTION',
      closed_at: new Date(),
    });

    this.stats = riskManager.applyTradeResult(this.stats, pnl);
    await repo.dailyStats.save(this.id, this.userId, this.stats, time.istDateString(now));
    this.runtime.cooldownUntil = riskManager.nextEntryAllowedAt({
      config: this.config, exitReason: reason, now,
    });

    this.lastDecision = `EXIT ${reason} · short ${t.sell_price} → ${sellExit}, `
      + `hedge ${t.hedge_price} → ${hedgeExitPrice} · net ${money.formatInr(pnl.net)}`;
    await this.audit('CLOSED', this.lastDecision, { tradeId: t.id, meta: pnl });
    logger.flow(`${this.name}: trade closed`, { strategyId: this.id, reason, net: pnl.net });

    this.trade = null;
    this.candidate = null;
    this.runtime.armed = false;
    this.runtime.armedLow = null;
    this.state = S.COMPLETE;
  }

  // A hedge that never got paired with a short.
  async unwindLoneHedge(reason, now) {
    const t = this.trade;
    if (!t) { this.state = S.IDLE; return; }
    this.state = S.EXIT_HEDGE;

    const hedgeQuote = this.ticker?.quote(String(t.hedge_z_token));
    const result = await this.placeLeg({
      leg: hedgeLeg(t), side: 'SELL', qty: Number(t.qty), purpose: 'HEDGE_EXIT',
      stage: 'hedge-unwind', reduceOnly: true, referencePrice: hedgeQuote?.ltp ?? null, now,
    });

    const exitPrice = result.fillPrice ?? hedgeQuote?.ltp ?? Number(t.hedge_price);
    const pnl = money.hedgeOnlyPnl({
      hedgePrice: Number(t.hedge_price), hedgeExitPrice: exitPrice, qty: Number(t.qty),
    });

    await repo.trades.patch(t.id, {
      hedge_exit_price: exitPrice, exit_reason: reason,
      gross_pnl: pnl.gross, charges: pnl.charges, net_pnl: pnl.net,
      status: result.ok ? 'ABORTED' : 'NEEDS_ATTENTION',
      closed_at: new Date(),
    });

    // Costs count, but this is not a "trade" for maxTradesPerDay — no position
    // was taken, and counting it would let a run of missed arms exhaust the
    // day's allowance without ever having been in the market.
    this.stats = riskManager.applyAbortResult(this.stats, pnl);
    await repo.dailyStats.save(this.id, this.userId, this.stats, time.istDateString(now));
    this.runtime.cooldownUntil = now + Math.max(30, this.config.reentryCooldownSec) * 1000;

    this.lastDecision = `hedge unwound (${reason}) at ${exitPrice} · net ${money.formatInr(pnl.net)}`;
    await this.audit('ABORTED', this.lastDecision, {
      level: 'WARN', tradeId: t.id, meta: { reason, ...pnl },
    });

    this.trade = null;
    this.candidate = null;
    this.runtime.armed = false;
    this.runtime.armedLow = null;
    this.state = S.COMPLETE;
  }

  /* ------------------------------------------------------------- recovery */
  async reconcile() {
    if (this.config.mode === 'paper') {
      // Paper orders never leave the process, so an in-flight paper state can
      // only be a crash artefact.
      this.state = this.trade ? (this.trade.sell_price ? S.POSITION_OPEN : S.ARM_WAIT) : S.IDLE;
      this.lastDecision = 'recovered a paper strategy after a restart';
      return;
    }
    if (!this.kotakSession?.sessionToken) {
      this.lastDecision = 'cannot reconcile — no Kotak session';
      return;
    }

    const summary = await reconciler.resolveOrders(this.userId, this.kotakSession);
    logger.warn('strategyRunner: reconciliation run', { strategyId: this.id, ...summary });

    this.trade = await repo.trades.openForStrategy(this.id);
    if (!this.trade) {
      // No trade row — but did we leave an order live at the broker? A crash
      // between placing the hedge and writing the trade row lands exactly here,
      // and going quietly IDLE would orphan a real position that nothing is
      // watching.
      const orphans = await repo.orders.placedWithoutTrade(this.id);
      if (orphans.length) {
        this.state = S.HALTED;
        this.lastError = orphans.length
          + ' order(s) placed with no trade record — halted for manual review';
        this.lastDecision = this.lastError;
        logger.error('strategyRunner: orphaned order(s) at the broker', {
          strategyId: this.id, orderIds: orphans.map(o => o.id),
        });
        await this.audit('RECONCILE', this.lastError, {
          level: 'ERROR',
          meta: { orders: orphans.map(o => ({ id: o.id, purpose: o.purpose, symbol: o.k_symbol })) },
        });
        return;
      }
      this.state = S.IDLE;
      this.lastDecision = 'no open trade after reconciliation';
      return;
    }
    if (this.trade.status === 'NEEDS_ATTENTION') {
      this.state = S.HALTED;
      this.lastError = 'reconciliation was ambiguous — halted for manual review';
      this.lastDecision = this.lastError;
      return;
    }

    // Believe the broker, not our own last written state.
    const legs = await reconciler.verifyTradeLegs(this.kotakSession, this.trade);
    if (legs.shortIsOpen) {
      this.state = S.POSITION_OPEN;
      this.lastDecision = 'recovered an open short after a restart';
    } else if (legs.hedgeIsOpen) {
      this.state = S.ARM_WAIT;
      this.lastDecision = 'recovered a hedge-only position after a restart';
    } else {
      await repo.trades.patch(this.trade.id, { status: 'NEEDS_ATTENTION', exit_reason: 'reconcile' });
      this.state = S.HALTED;
      this.lastError = 'the broker shows no position for an open trade — halted for review';
      this.lastDecision = this.lastError;
    }
    await this.audit('RECONCILE', this.lastDecision, { level: 'WARN', tradeId: this.trade?.id, meta: legs });
  }

  /* ------------------------------------------------------------- plumbing */
  // The idempotency key. Same strategy, same day, same attempt, same stage =>
  // the same key => the database refuses a second order, whatever went wrong.
  clientOrderId(stage, now) {
    return `s${this.id}-${time.istDateString(now)}-a${this.runtime.attemptSeq || 0}-${stage}`;
  }

  async placeLeg({ leg, side, qty, purpose, stage, reduceOnly, referencePrice, now }) {
    try {
      return await orderRouter.place({
        userId: this.userId,
        session: this.kotakSession,
        leg,
        side,
        qty,
        clientOrderId: this.clientOrderId(stage, now),
        purpose,
        reduceOnly,
        mode: this.config.mode,
        referencePrice,
        strategyId: this.id,
        tradeId: this.trade?.id ?? null,
        config: this.config,
      });
    } catch (err) {
      if (err instanceof TradingHaltedError) {
        return { ok: false, orderId: null, reason: 'trading halted', halted: true };
      }
      if (err instanceof RateLimitedError) {
        return { ok: false, orderId: null, reason: `rate limited (${err.waitMs}ms)`, retryable: true };
      }
      return { ok: false, orderId: null, reason: err.message };
    }
  }

  async persist() {
    await repo.strategies.saveRuntime(this.id, {
      status: this.state,
      state: this.runtime,
      lastDecision: this.lastDecision,
      lastError: this.lastError,
    });
  }

  async audit(eventType, message, { level = 'INFO', tradeId = null, meta = null, fromState = null, toState = null } = {}) {
    await repo.events.record({
      userId: this.userId, strategyId: this.id,
      tradeId: tradeId ?? this.trade?.id ?? null,
      eventType, level, fromState, toState, message,
      ltp: this.shortQuote?.ltp ?? null,
      spot: this.spot ?? null,
      meta,
    });
  }

  /* --------------------------------------------------------------- status */
  status() {
    const t = this.trade;
    const unrealised = (t?.sell_price != null && this.shortQuote?.ltp != null)
      ? money.round((Number(t.sell_price) - this.shortQuote.ltp) * Number(t.qty))
      : null;
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      state: this.state,
      mode: this.config.mode,
      underlying: this.config.underlying,
      optionType: this.config.optionType,
      premiumRange: [this.config.premiumMin, this.config.premiumMax],
      armPrice: this.config.armPrice,
      offset: this.config.offset,
      queuePriority: this.queuePriority,
      spot: this.spot,
      shortLtp: this.shortQuote?.ltp ?? null,
      quoteAgeMs: this.shortQuote?.ageMs ?? null,
      armed: !!this.runtime.armed,
      armedLow: this.runtime.armedLow,
      cooldownUntil: this.runtime.cooldownUntil || 0,
      trade: t ? {
        id: Number(t.id),
        optionType: t.option_type,
        sellStrike: numOrNull(t.sell_strike),
        sellSymbol: t.sell_symbol,
        sellPrice: numOrNull(t.sell_price),
        hedgeStrike: numOrNull(t.hedge_strike),
        hedgePrice: numOrNull(t.hedge_price),
        qty: Number(t.qty),
        targetPrice: numOrNull(t.target_price),
        targetPoints: numOrNull(t.target_points),
        slPrice: numOrNull(t.sl_price),
        status: t.status,
        unrealisedPnl: unrealised,
      } : null,
      today: riskManager.summarise(this.stats),
      lastDecision: this.lastDecision,
      lastError: this.lastError,
    };
  }
}

/* ------------------------------------------------------------------ utils */
function safeParse(raw, fallback) {
  try { return JSON.parse(raw || 'null') ?? fallback; }
  catch (_) { return fallback; }
}

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function shortLeg(t) {
  return {
    kToken: t.sell_k_token, kSymbol: t.sell_symbol, kSegment: 'nse_fo',
    zToken: t.sell_z_token != null ? String(t.sell_z_token) : null,
    lotSize: t.lot_size, instrumentId: null,
  };
}

function hedgeLeg(t) {
  return {
    kToken: t.hedge_k_token, kSymbol: t.hedge_symbol, kSegment: 'nse_fo',
    zToken: t.hedge_z_token != null ? String(t.hedge_z_token) : null,
    lotSize: t.lot_size, instrumentId: null,
  };
}

async function linkOrderToTrade(orderId, tradeId) {
  if (!orderId || !tradeId) return;
  try {
    const { query } = require('../core/db');
    await query('UPDATE orders SET trade_id = ? WHERE id = ? AND trade_id IS NULL',
      [Number(tradeId), Number(orderId)]);
  } catch (_) { /* the order row is still complete without the link */ }
}

module.exports = { StrategyRunner };
