// The Price-Filter Engine — where doc/new.md's pure parts meet the world.
//
// The modules beside this one decide WHAT should happen: direction.js reads the
// index structure, priceFilter.js answers "may this side trade right now",
// scanner.js chooses the contract, exitRules.js prices everything and
// machine.js sequences it. This file makes it happen and feeds the results
// back as events. Keeping them apart is what lets the whole strategy be tested
// in a millisecond without a broker, and it means the dangerous code here is
// thin: mostly plumbing, with the decisions made elsewhere.
//
// The loop:
//
//   index ticks  -> indexCandles  -> 'candle' -> direction + mids
//                                             -> CONFIRMED / FILTER_FAIL /
//                                                TREND_BREAK, and the scan
//   option ticks -> optionCandles -> 'candle' -> OPTION_CANDLE -> PLACE_SELL
//   option ticks -> TICK                      -> trailing stop, safety exit
//   clock        -> PENDING_TIMEOUT / MAX_HOLD / ARM_TIMEOUT / SQUARE_OFF
//   reconciler   -> fills, cancels, rejections
//
// ---------------------------------------------------------------------------
// Sharing the order table with the scalper
// ---------------------------------------------------------------------------
//
// `orders` and the reconciler are shared. Every order this engine sends carries
// `pfe_trade_id` and a `PF-` client_ref, and every reconciler event is ignored
// here unless it carries a pfe trade id — so a row belonging to the other
// engine can never be mistaken for one of ours. In practice only one trading
// process runs at a time (both take the same leader lock), but the filter is
// not conditional on that: a stale order left behind by a previous session must
// not be able to drive this one.

const EventEmitter = require('events');
const config = require('../config');
const logger = require('../core/logger');
const time = require('../core/time');
const money = require('../core/money');
const repo = require('../repositories');
const selectors = require('../strategy/selectors');
const instrumentMaster = require('../market/instrumentMaster');
const machine = require('./machine');
const direction = require('./direction');
const priceFilter = require('./priceFilter');
const scanner = require('./scanner');
const rules = require('./exitRules');

const { STATES, EXIT_REASONS } = machine;

// How many completed index bars to hold. The verdict reads `trendBars`; the
// rest is context for the audit log and costs nothing.
const INDEX_BUFFER = 24;

// A quote older than this is not evidence of anything.
const MAX_QUOTE_AGE_MS = 5000;

// How often a wedged EXITING trade re-sends the order that never left. Slow on
// purpose: it is an emergency path, and hammering a broker that is already
// answering ambiguously is how a bad minute becomes a bad session.
const STUCK_RETRY_MS = 5000;

// How often the engine says out loud that it is refusing every scan.
const BLOCK_REPORT_MS = 60000;

// How long the engine tolerates having no index price before it says so as an
// error rather than silently doing nothing once a second forever.
const SPOT_BLIND_MS = 45000;

// A DATETIME field out of a state patch. Absent means "do not touch the
// column"; present-but-null means "clear it".
function stamp(patch, key) {
  if (!(key in patch)) return undefined;
  return patch[key] ? time.toMysql(patch[key]) : null;
}

class PfeEngine extends EventEmitter {
  constructor({ ticker, indexCandles, optionCandles, quoteSource, router, reconciler, broker }) {
    super();
    this.ticker = ticker;
    this.indexCandles = indexCandles;     // the NIFTY series — Modules 3, 4, 7
    this.optionCandles = optionCandles;   // the selected contract — Module 5
    this.quoteSource = quoteSource;       // the rich quote filter — Module 2
    this.router = router;
    this.reconciler = reconciler;
    this.broker = broker;

    this.settings = null;
    this.trade = null;                    // the one live trade, or null
    this.spotToken = null;
    this.spotPaise = null;
    this.running = false;
    this.intent = null;
    this._clock = null;
    this._scanning = false;
    this.lastError = null;

    // The index state everything hangs off: a ring of completed bars, the
    // structure verdict derived from them, and the mids of the newest one.
    this.index = { bars: [], verdict: null, mids: null, atMs: null };

    // Module 11. Counted in completed index candles, not seconds.
    this.candlesSinceExit = Infinity;     // nothing has exited yet

    this.lastScan = null;
    this.lastScanAt = 0;
    this.quoteCache = new Map();          // token -> { quote, ts }
    this.stats = { scans: 0, arms: 0, entries: 0, exits: 0 };
  }

  /* ------------------------------------------------------------- lifecycle */

  async start(settings) {
    this.settings = settings;
    this.running = true;

    this.indexCandles.on('candle', (bar) => this._onIndexCandle(bar).catch(this._oops('index')));
    this.optionCandles.on('candle', (bar) => this._onOptionCandle(bar).catch(this._oops('option')));
    this.ticker.on('tick', (t) => this._onTick(t));
    this.reconciler.on('fill', (f) => this._onFill(f).catch(this._oops('fill')));
    this.reconciler.on('partial', (f) => this._onPartial(f).catch(this._oops('partial')));
    this.reconciler.on('cancelled', (c) => this._onCancelled(c).catch(this._oops('cancelled')));
    this.reconciler.on('rejected', (r) => this._onRejected(r).catch(this._oops('rejected')));

    this.indexCandles.start();
    this.optionCandles.start();
    await this._ensureSpot();

    this._clock = setInterval(() => this._onClock().catch(this._oops('clock')), config.engine.tickMs);
    this._clock.unref?.();

    // Adopt whatever the last process left behind before arming anything new.
    await this._resume();

    const intent = await this._readIntent();
    if (intent !== 'RUN') {
      logger.warn(`pfe: intent is ${intent} — NOTHING WILL BE SELECTED OR SOLD. `
        + `Press Start on ${config.appUrl}/pfe, or POST /api/pfe/start.`,
      { note: 'an open position is still managed, timed out and squared off' });
    }

    logger.info('pfe: started', {
      mode: this.settings.mode,
      index: `${this.settings.trendBars}×${this.settings.trendTimeframe}`,
      option: this.settings.optionTimeframe,
      premium: `₹${this.settings.premiumMin}–${this.settings.premiumMax}`,
      liquidity: this.settings.liquidityMode,
      target: `₹${this.settings.target}`, stop: `₹${this.settings.stopLoss}`,
      ladder: this.settings.dynamicTarget
        ? `+₹${this.settings.targetStep} × ${this.settings.maxTargetSteps}` : 'off',
    });
  }

  async stop() {
    this.running = false;
    if (this._clock) clearInterval(this._clock);
    this._clock = null;
    this.indexCandles.stop();
    this.optionCandles.stop();
  }

  _oops(where) {
    return (err) => {
      this.lastError = `${where}: ${err.message}`;
      logger.error('pfe: handler failed', { where, err: err.message, stack: err.stack });
    };
  }

  /* ---------------------------------------------------------------- resume */

  // A process that died holding a position comes back to a database that says
  // WORKING and a broker that may say FILLED. Reconcile FIRST, then adopt — the
  // alternative is selecting a fresh strike on top of a position we forgot
  // about, which the pfe_guard slot would refuse but only after the scan.
  async _resume() {
    await this.reconciler.runOnce();

    const row = await repo.pfeTrades.live();
    if (!row) return;

    this.trade = this._fromRow(row);
    for (const order of await repo.orders.workingForPfeTrade(row.id)) {
      if (order.stage === 'ENTRY') this.trade.sellOrderId = this.trade.sellOrderId ?? order.id;
      else if (order.stage === 'TARGET') this.trade.targetOrderId = this.trade.targetOrderId ?? order.id;
      else this.trade.exitOrderId = this.trade.exitOrderId ?? order.id;
    }
    this._watchTrade();

    logger.warn('pfe: resumed a live trade from a previous run', {
      id: row.id, symbol: row.symbol, state: row.state,
      target: this.trade.targetOrderId ? 'live' : '—',
      exit: this.trade.exitOrderId ? 'live' : '—',
    });
    await this._event({
      kind: 'PFE_RESUME', optionType: row.option_type,
      reason: `adopted ${row.symbol} in ${row.state} after a restart`,
    });
  }

  _fromRow(row) {
    return machine.blank({
      id: row.id,
      state: row.state,
      optionType: row.option_type,
      token: String(row.token),
      symbol: row.symbol,
      strike: Number(row.strike),
      qty: row.qty,
      attemptSeq: row.attempt_seq,
      requoteCount: row.requote_count,
      confirmations: row.confirmations,
      trails: row.trails,
      entryCandleId: row.entry_candle_id,
      sellPriceP: row.sell_price_p,
      filledPriceP: row.filled_price_p,
      filledQty: row.filled_qty,
      targetPriceP: row.target_price_p,
      slPriceP: row.sl_price_p,
      // The trail's high-water mark survives, so a restart cannot loosen a stop
      // that has already been tightened.
      trailPeakP: row.trail_peak_p ?? row.filled_price_p ?? null,
      trailingOnly: row.target_price_p == null && row.filled_price_p != null,
      entryVolume: row.entry_volume,
      armedAt: row.armed_at ? time.fromMysql(row.armed_at) : null,
      openedAt: row.opened_at ? time.fromMysql(row.opened_at) : null,
      exitReason: row.exit_reason,
      // Not persisted, so an adopted trade gets a FULL fresh window rather than
      // being released the instant the engine comes back.
      waitingSince: Date.now(),
    });
  }

  /* ------------------------------------------------------------- the clock */

  // The operator's intent, read fresh each clock. Three values, and note what
  // STOP does NOT do:
  //
  //   RUN    scan and select normally
  //   PAUSE  select nothing new; keep managing whatever is open
  //   STOP   select nothing new; keep managing whatever is open
  //
  // STOP does not flatten. Abandoning a live naked short because somebody
  // pressed a button is not a risk control; the square-off is what closes
  // positions.
  async _readIntent() {
    let value;
    try {
      value = String(await repo.flags.get('pfe_intent', 'STOP')).toUpperCase();
    } catch (err) {
      // A database blip must not silently start trading.
      logger.warn('pfe: could not read the operator intent', { err: err.message });
      return this.intent || 'STOP';
    }
    if (!['RUN', 'PAUSE', 'STOP'].includes(value)) value = 'STOP';

    if (value !== this.intent) {
      const from = this.intent;
      this.intent = value;
      logger.warn(`pfe: intent is ${value}`, {
        from: from || '(first read)',
        effect: value === 'RUN' ? 'scanning and selection are live'
          : 'nothing new will be selected; an open position keeps being managed',
      });
      await this._event({
        kind: 'CONTROL', fromState: from, toState: value,
        reason: `pfe observed intent ${value}`,
      }).catch(() => { /* the audit write must not stop the clock */ });
    }
    return value;
  }

  async _onClock() {
    if (!this.running) return;
    const now = Date.now();
    const s = this.settings;

    const intent = await this._readIntent();

    if (!this.spotToken) {
      await this._ensureSpot().catch(err =>
        logger.debug('pfe: the index instrument is not resolvable yet', { err: err.message }));
    }

    // Module 1's force exit outranks everything, including an engine that would
    // otherwise be selecting.
    if (this.trade && time.isAfter(now, s.squareOffAt)) {
      await this._dispatch({ type: 'SQUARE_OFF', tsMs: now });
    }

    this._reportBlocks(now);

    if (this.trade) {
      // A fresh quote for the one contract we hold — the liquidity exit and the
      // premium band both need it, and it is one instrument, once a second.
      await this._refreshTradeQuote(now);

      switch (this.trade.state) {
        case STATES.SELL_WORKING:
          await this._dispatch({ type: 'PENDING_TIMEOUT', tsMs: now });
          break;
        case STATES.ARMED:
          await this._dispatch({
            type: 'ARM_TIMEOUT', tsMs: now, reason: this.trade.lastGateReason || null,
          });
          break;
        case STATES.POSITION_OPEN:
        case STATES.TARGET_MOVING:
          await this._checkLiquidityExit(now);
          await this._dispatch({ type: 'MAX_HOLD', tsMs: now });
          break;
        case STATES.EXITING:
          await this._recoverStuck(now);
          break;
        default:
          break;
      }
      if (this.trade && this.trade.state === STATES.TARGET_MOVING && this.trade.cancelFailedAt) {
        await this._recoverStuck(now);
      }
      if (this.trade && this.trade.state === STATES.DONE) await this._finishTrade();
    } else if (intent === 'RUN') {
      await this._maybeScan(now);
    }

    await this._publish();
  }

  /* ----------------------------------------------------- stuck-trade recovery */

  // A trade mid-exit can get wedged in two ways, and nothing else moves it.
  //
  //   1. The target cancel came back ambiguous. It is not safe to exit — the
  //      target may still be working — so the only correct move is to keep
  //      asking until the broker gives a definite answer.
  //   2. The exit market order itself failed to send. The target is confirmed
  //      cancelled, so the position is completely unprotected until it goes.
  async _recoverStuck(nowMs) {
    const t = this.trade;
    if (!t) return;
    if (nowMs - (t._recoveredAt || 0) < STUCK_RETRY_MS) return;
    t._recoveredAt = nowMs;

    // Ask the DATABASE what is live, not the in-memory trade. Resending a market
    // buy that is already working buys the short back twice and leaves the
    // account naked LONG — so before sending a missing order it must first be
    // certain that it IS missing.
    const live = await repo.orders.workingForPfeTrade(t.id);
    if (live.length) {
      logger.info('pfe: not resending — an order for this trade is already live',
        { orders: live.map(o => `${o.stage}:${o.status}`).join(' ') });
      return;
    }

    if (t.targetOrderId && t.cancelFailedAt) {
      logger.warn('pfe: retrying a target cancel that came back ambiguous',
        { stuckForMs: nowMs - t.cancelFailedAt });
      await this._act({ type: 'CANCEL_TARGET', orderId: t.targetOrderId, reason: t.exitReason || 'RETRY' });
      return;
    }

    if (t.state === STATES.EXITING && !t.targetOrderId && !t.exitOrderId) {
      logger.error('pfe: a trade is EXITING with no exit order — resending the market buy',
        { reason: t.exitReason });
      await this._event({ kind: 'EXIT_RETRY', reason: t.exitReason || 'unknown' });
      await this._act({ type: 'EXIT_MARKET', reason: t.exitReason, qty: t.filledQty });
    }
  }

  /* -------------------------------------------------------- Module 2, scan */

  async _maybeScan(nowMs) {
    if (this._scanning || this.trade) return;
    const s = this.settings;

    const gate = await this._canEnter(nowMs);
    if (!gate.ok) { this._noteBlock(gate.reason); return; }

    if (nowMs - this.lastScanAt < s._scanIntervalMs) return;

    if (!this.ticker.isHealthy()) { this._noteBlock('the market feed has gone quiet'); return; }

    const spotP = this._spot();
    if (spotP == null) { this._noteBlock('no index price'); return; }

    // Module 3 — the structure filter. It says which side MAY trade.
    const v = this.index.verdict;
    if (!v) { this._noteBlock('the index trend filter has no verdict yet'); return; }
    if (v.state === direction.STATES.WARMING_UP || v.state === direction.STATES.NO_DATA
      || v.state === direction.STATES.NONE) {
      this._noteBlock(`the index is ${direction.short(v.state)}: ${v.reason}`);
      return;
    }

    // A verdict is good until the next index bar closes. Past that it describes
    // a market that has moved on, and a stale permission is worse than none.
    const ageMs = nowMs - (this.index.atMs ?? 0);
    if (ageMs > s._trendSeconds * 1000 + Math.min(1000, (s._trendSeconds * 1000) / 2)) {
      this._noteBlock(`the index verdict is ${(ageMs / 1000).toFixed(1)}s old — it expired with its bar`);
      return;
    }

    // Module 4 — the live price position filter, against the mids of the newest
    // completed index candle.
    if (!this.index.mids) { this._noteBlock('no completed index candle to take the mids from'); return; }
    const pos = priceFilter.entryVerdict({ candle: this.index.mids.candle, spotP });

    // Both filters have to agree, and the operator's tradeMode narrows it
    // further. The structure says which way the market is going; the position
    // filter says the price is still on the right side of this bar's midpoint.
    const wantCE = ['BOTH', 'CE'].includes(String(s.tradeMode).toUpperCase());
    const wantPE = ['BOTH', 'PE'].includes(String(s.tradeMode).toUpperCase());
    const allowCE = v.allowCE && pos.allowCE && wantCE;
    const allowPE = v.allowPE && pos.allowPE && wantPE;

    if (!allowCE && !allowPE) {
      this._noteBlock(pos.reason
        || `the index is ${direction.short(v.state)} but the price position filter refuses `
          + `the ${v.allowPE ? 'PE' : 'CE'} side`);
      return;
    }
    const side = allowPE ? 'PE' : 'CE';

    this._scanning = true;
    try {
      await this._scan(nowMs, side, spotP, v);
    } catch (err) {
      this.lastError = err.message;
      logger.warn('pfe: the scan failed', { err: err.message });
    } finally {
      this._scanning = false;
      this.lastScanAt = Date.now();
    }
  }

  async _scan(nowMs, side, spotP, verdict) {
    const s = this.settings;
    const tradeDate = time.tradeDate(nowMs);

    const expiries = await repo.instruments.expiries(s.symbol);
    const expiry = selectors.selectExpiry({
      mode: s.expiryMode, expiries, manualExpiry: s.manualExpiry,
    });

    const chain = await repo.instruments.chain(s.symbol, expiry);
    if (!chain.length) throw new Error(`the chain for ${s.symbol} ${expiry} is empty`);

    const step = selectors.strikeStep(chain);
    const atm = selectors.atmStrike(spotP / 100, step);
    const span = Number(s.scanRange) * step;
    const near = chain.filter(r =>
      r.option_type === side && Math.abs(Number(r.strike) - atm) <= span);

    if (!near.length) {
      this._noteBlock(`no ${side} strikes within ${s.scanRange} steps of ${atm}`);
      return;
    }

    // ONE batched request per scan, at the richest filter this account turns out
    // to be entitled to. src/market/quoteSource.js probes that once, at boot.
    const snapshot = await this.quoteSource.snapshot(
      near.map(r => ({ token: String(r.token), segment: r.segment })));
    for (const [token, quote] of snapshot) this.quoteCache.set(token, { quote, ts: Date.now() });

    const result = scanner.select(
      near.map(r => ({ row: r, quote: snapshot.get(String(r.token)) })), s._scanner);

    this.stats.scans += 1;
    this.lastScan = {
      tsMs: nowMs, side, spot: spotP / 100, expiry,
      directionState: verdict.state,
      considered: near.length,
      rejected: result.rejected.length,
      unavailable: result.unavailable,
      chosen: result.chosen
        ? { symbol: result.chosen.symbol, strike: result.chosen.strike,
          score: result.chosen.score, ltpP: result.chosen.ltpP,
          componentsUsed: result.chosen.componentsUsed }
        : null,
      top: result.ranked.slice(0, 5).map(r => ({
        symbol: r.symbol, strike: r.strike, ltpP: r.ltpP, score: r.score, parts: r.parts,
      })),
      reason: result.reason,
    };

    await repo.pfeStats.bumpScan(tradeDate).catch(() => {});
    await repo.pfeScans.log({
      tradeDate, tsMs: nowMs, underlying: s.symbol, expiryDate: expiry, side,
      spot: spotP / 100, directionState: verdict.state,
      chosenToken: result.chosen?.token ?? null,
      chosenSymbol: result.chosen?.symbol ?? null,
      chosenScore: result.chosen?.score ?? null,
      considered: near.length,
      rejected: result.rejected.length,
      unavailable: result.unavailable,
      candidates: this.lastScan.top,
      reason: result.reason,
    }).catch(err => logger.warn('pfe: scan not recorded', { err: err.message }));

    if (!result.chosen) {
      this._noteBlock(result.reason || 'no strike cleared the filters');
      return;
    }

    this._noteBlock(null);
    await this._arm(nowMs, result.chosen, { expiry, spotP, verdict, result });
  }

  // Take the single open-trade slot, then arm. The database is what enforces
  // "maximum simultaneous positions: 1" — a duplicate key here means something
  // else got there first and the right answer is to back off, not to retry.
  async _arm(nowMs, chosen, { expiry, spotP, verdict, result }) {
    const s = this.settings;
    const lotSize = Number(chosen.lotSize) || 0;
    if (!lotSize) throw new Error('the selected contract has no lot size in the master');
    const qty = lotSize * Number(s.lots);
    const tradeDate = time.tradeDate(nowMs);

    let tradeId;
    try {
      tradeId = await repo.pfeTrades.open({
        tradeDate, underlying: s.symbol, expiryDate: expiry,
        optionType: chosen.optionType, token: chosen.token, symbol: chosen.symbol,
        strike: chosen.strike, lotSize, qty, state: STATES.IDLE,
        spotAtSelect: spotP / 100,
        directionState: verdict.state,
        selectScore: chosen.score,
        selectDetail: {
          parts: chosen.parts,
          componentsUsed: chosen.componentsUsed,
          unavailable: result.unavailable,
          ltpP: chosen.ltpP,
          runnersUp: result.ranked.slice(1, 4).map(r => ({
            symbol: r.symbol, score: r.score, ltpP: r.ltpP,
          })),
        },
        settingsSnapshot: this._snapshotSettings(),
      });
    } catch (err) {
      if (/duplicate/i.test(err.message) || err.code === 'ER_DUP_ENTRY') {
        logger.warn('pfe: another opener won the race for the position slot');
        return;
      }
      throw err;
    }

    this.trade = machine.blank({
      id: tradeId,
      state: STATES.IDLE,
      optionType: chosen.optionType,
      token: String(chosen.token),
      symbol: chosen.symbol,
      strike: chosen.strike,
      segment: chosen.segment,
      qty,
      tickP: chosen.tickP || 5,
    });

    this._watchTrade();
    this.stats.arms += 1;

    logger.info('pfe: strike SELECTED', {
      symbol: chosen.symbol, side: chosen.optionType, strike: chosen.strike,
      premium: money.formatPrice(chosen.ltpP), score: chosen.score,
      on: chosen.componentsUsed.join('+') || 'nothing measurable',
      spot: (spotP / 100).toFixed(2), index: direction.short(verdict.state), qty,
    });
    await this._event({
      kind: 'STRIKE_SELECTED', optionType: chosen.optionType,
      reason: `score ${chosen.score} on ${chosen.componentsUsed.join('+') || 'premium alone'}`,
      payload: {
        symbol: chosen.symbol, strike: chosen.strike, premiumP: chosen.ltpP,
        spot: spotP / 100, expiry, qty, unavailable: result.unavailable,
      },
    });

    await this._dispatch({
      type: 'ARM', tsMs: nowMs, symbol: chosen.symbol, score: chosen.score,
    });
  }

  // Point the option candle builder and the tick subscription at exactly the
  // selected contract, plus the index. An unused subscription still costs quote
  // budget on every poll.
  _watchTrade() {
    const want = [];
    if (this.spotToken) want.push(this.spotToken);
    if (this.trade) {
      want.push({ token: this.trade.token, segment: this.trade.segment || 'nse_fo' });
    }
    this.ticker.setSubscriptions(want);
    this.optionCandles.setTokens(this.trade ? [this.trade.token] : []);
  }

  /* ------------------------------------------------- Module 12, the gates -- */

  // Every reason a new trade may not be opened. A risk control stops ENTRIES —
  // nothing here can stop a target, a stop-loss or the square-off.
  async _canEnter(nowMs) {
    const s = this.settings;
    const tradeDate = time.tradeDate(nowMs);

    if (config.tradingHalted) return { ok: false, reason: 'TRADING_HALTED is set in the environment' };

    if (!time.isWithinSession(nowMs, s.sessionStart, s.lastEntryAt)) {
      return {
        ok: false,
        reason: `outside the entry window ${s.sessionStart}–${s.lastEntryAt} IST`,
      };
    }

    // Never open a position the square-off is about to close: it would pay both
    // sides of the round trip for nothing.
    const flatAt = time.atIstTime(nowMs, s.squareOffAt);
    if (nowMs + s._maxHoldMs > flatAt) {
      return { ok: false, reason: `too close to the ${s.squareOffAt} square-off to hold a full position` };
    }

    // Module 11 — the re-entry wait, in completed index candles.
    if (!rules.reentryAllowed(this.candlesSinceExit, s.reentryCandles)) {
      return {
        ok: false,
        reason: `waiting ${s.reentryCandles} candles after the last exit `
          + `(${this.candlesSinceExit} so far)`,
      };
    }

    const stats = await repo.pfeStats.ensure(tradeDate);

    if (stats.disabled) {
      return { ok: false, reason: `trading disabled for today — ${stats.disabled_reason || 'risk limit'}` };
    }

    if (stats.cooldown_until) {
      const until = time.fromMysql(stats.cooldown_until);
      if (until && nowMs < until) {
        return { ok: false, reason: `cooling down for another ${Math.ceil((until - nowMs) / 1000)}s` };
      }
    }

    if (s.maxTradesPerDay > 0 && stats.entry_count >= s.maxTradesPerDay) {
      return { ok: false, reason: `the daily cap of ${s.maxTradesPerDay} trades is reached` };
    }

    const realized = stats.realized_pnl_p;
    if (s.maxDailyLoss > 0 && realized <= -money.toPaise(s.maxDailyLoss)) {
      await repo.pfeStats.disable(tradeDate, 'MAX_DAILY_LOSS');
      return { ok: false, reason: `daily loss limit reached (${money.formatInr(realized)})` };
    }
    if (s.maxDailyProfit > 0 && realized >= money.toPaise(s.maxDailyProfit)) {
      await repo.pfeStats.disable(tradeDate, 'MAX_DAILY_PROFIT');
      return { ok: false, reason: `daily profit target reached (${money.formatInr(realized)})` };
    }
    if (s.maxConsecutiveLosses > 0 && stats.consecutive_losses >= s.maxConsecutiveLosses) {
      const until = nowMs + s._cooldownMs;
      await repo.pfeStats.setCooldown(tradeDate, until);
      return { ok: false, reason: `${stats.consecutive_losses} consecutive losses — cooling down` };
    }

    return { ok: true, reason: null };
  }

  /* ------------------------------------------------- Modules 3, 4, 7, 8 ---- */

  // A completed NIFTY bar. This is the heartbeat of the whole strategy: it
  // re-derives the structure verdict, recomputes the mids, and then either
  // confirms an open position (extending the target) or takes it off.
  async _onIndexCandle(bar) {
    const s = this.settings;

    this.index.bars.push(bar);
    if (this.index.bars.length > INDEX_BUFFER) this.index.bars.shift();

    const before = this.index.verdict;
    const now = direction.verdict(this.index.bars, s._direction);
    this.index.verdict = now;
    this.index.atMs = bar.bucketEnd ?? Date.now();
    // Only a bar that measured something can carry the mids. A synthetic bar's
    // open, high and low are all the previous close, so its mids would sit
    // exactly on a stale price and permit whichever side happened to be near.
    if (bar.tradable !== false) this.index.mids = { candle: bar, ...priceFilter.mids(bar) };

    // Index bars are persisted like option bars: the post-mortem must be able to
    // read the exact rows the filter decided from.
    repo.candles.insert({
      token: bar.token, timeframe: bar.timeframe, bucketStart: bar.bucketStart,
      openP: bar.openP, highP: bar.highP, lowP: bar.lowP, closeP: bar.closeP,
      tickCount: bar.tickCount, synthetic: bar.synthetic,
    }).catch(err => logger.warn('pfe: index candle not stored', { err: err.message }));

    if (!this.trade) {
      if (this.candlesSinceExit !== Infinity) this.candlesSinceExit += 1;
    }

    await this._driveOnIndexCandle(bar);

    if (before?.state !== now.state) {
      logger.info('pfe: index structure', {
        state: now.state, reason: now.reason,
        bars: (now.window || []).length,
        allow: [now.allowCE ? 'CE' : null, now.allowPE ? 'PE' : null]
          .filter(Boolean).join('+') || 'none',
      });
      await this._event({
        kind: 'DIRECTION', fromState: before?.state || null, toState: now.state,
        reason: now.reason,
        payload: { allowCE: now.allowCE, allowPE: now.allowPE },
      });
    }
  }

  // Modules 7, 8 and 10, all off the same completed bar.
  async _driveOnIndexCandle(bar) {
    const t = this.trade;
    if (!t) return;
    const s = this.settings;
    const spotP = this._spot();
    if (bar.tradable === false) return;        // an unmeasured bar says nothing

    // A working SELL is withdrawn the moment the filter that justified it turns.
    // See the note on ENTRY_INVALIDATED in machine.js — the limit sits ABOVE the
    // market, so it fills precisely when the move reverses.
    if (t.state === STATES.SELL_WORKING) {
      const hold = priceFilter.holdVerdict({ candle: bar, spotP, optionType: t.optionType });
      const broke = direction.isBreak(this.index.verdict, t.optionType);
      if (!hold.ok && !hold.undecided) {
        await this._dispatch({ type: 'ENTRY_INVALIDATED', reason: hold.reason, tsMs: Date.now() });
      } else if (broke) {
        await this._dispatch({
          type: 'ENTRY_INVALIDATED',
          reason: `the index structure broke: ${this.index.verdict.reason}`,
          tsMs: Date.now(),
        });
      }
      return;
    }

    if (!machine.isOpen(t)) return;

    // Module 10, "Position Filter Fails" — the immediate exit. Checked before
    // the trend break because it is the tighter of the two and its reason is
    // the more specific one to record.
    const hold = priceFilter.holdVerdict({ candle: bar, spotP, optionType: t.optionType });
    if (!hold.ok && !hold.undecided) {
      if (s.exitOnFilterFail) {
        await this._dispatch({ type: 'FILTER_FAIL', reason: hold.reason, tsMs: Date.now() });
        return;
      }
    }

    // Module 10, "Trend Break".
    if (s.exitOnTrendBreak && direction.isBreak(this.index.verdict, t.optionType)) {
      await this._dispatch({
        type: 'TREND_BREAK',
        reason: `the ${s.trendBars}-bar structure no longer holds: ${this.index.verdict.reason}`,
        tsMs: Date.now(),
      });
      return;
    }

    // Module 8 — the filter still permits this side, so the move is still
    // running. Push the target one rung further out.
    if (hold.ok && !hold.undecided) {
      await this._dispatch({ type: 'CONFIRMED', tsMs: Date.now() });
    }
  }

  /* ----------------------------------------------- Module 5, the sell price */

  async _onOptionCandle(bar) {
    const t = this.trade;
    if (!t || String(bar.token) !== t.token) return;
    if (t.state !== STATES.ARMED) return;

    // Persist first, so the id can be recorded against the trade. Every
    // post-mortem then reads the exact row the entry was priced from.
    const candleId = await repo.candles.insert({
      token: bar.token, timeframe: bar.timeframe, bucketStart: bar.bucketStart,
      openP: bar.openP, highP: bar.highP, lowP: bar.lowP, closeP: bar.closeP,
      tickCount: bar.tickCount, synthetic: bar.synthetic,
    });

    const gate = this._entryGate();
    t.lastGateReason = gate.ok ? null : gate.reason;
    this._noteBlock(bar.tradable === false
      ? `the ${bar.timeframe} option bar is not tradable (${bar.synthetic ? 'no prints in it'
        : `only ${bar.tickCount} ticks`})`
      : gate.reason);

    await this._dispatch({
      type: 'OPTION_CANDLE',
      candle: { ...bar, id: candleId },
      entryOk: gate.ok,
      entryReason: gate.reason,
      tsMs: Date.now(),
    });
  }

  // Everything re-checked at the moment of the sell. The scan happened up to a
  // few seconds ago and the market has had time to change its mind — and a
  // verdict is a BOOLEAN by the time it reaches the machine, so no live price
  // can leak into the entry calculation.
  _entryGate() {
    const t = this.trade;
    const s = this.settings;

    const v = this.index.verdict;
    if (!v) return { ok: false, reason: 'the index trend filter has no verdict' };
    if (direction.isBreak(v, t.optionType)) {
      return { ok: false, reason: `the index is ${direction.short(v.state)}: ${v.reason}` };
    }
    if (v.state === direction.STATES.WARMING_UP || v.state === direction.STATES.NO_DATA) {
      return { ok: false, reason: `the index filter is ${direction.short(v.state)}` };
    }

    if (!this.index.mids) return { ok: false, reason: 'no completed index candle for the mids' };
    const spotP = this._spot();
    const hold = priceFilter.holdVerdict({
      candle: this.index.mids.candle, spotP, optionType: t.optionType,
    });
    if (!hold.ok) return { ok: false, reason: hold.reason || 'the price position filter refuses' };

    // The contract's own premium must still be inside the band. This is a
    // SELECTION constraint, not a price: the entry is the candle close plus the
    // offset either way.
    const q = this.ticker.quote(t.token);
    if (!q) return { ok: false, reason: 'no live quote for this strike' };
    if (q.ageMs > MAX_QUOTE_AGE_MS) {
      return { ok: false, reason: `the quote is ${Math.round(q.ageMs / 1000)}s stale` };
    }
    if (q.ltpPaise < s._scanner.premiumMinP || q.ltpPaise > s._scanner.premiumMaxP) {
      return {
        ok: false,
        reason: `the premium ${money.formatPrice(q.ltpPaise)} has left the band `
          + `${money.formatPrice(s._scanner.premiumMinP)}–${money.formatPrice(s._scanner.premiumMaxP)}`,
      };
    }

    // And the liquidity gates, on whatever the broker actually sends.
    const cached = this.quoteCache.get(t.token);
    if (cached) {
      const g = scanner.gate(
        scanner.measure({
          token: t.token, symbol: t.symbol, strike: t.strike,
          option_type: t.optionType, lot_size: 1, tick_size: (t.tickP || 5) / 100,
        }, cached.quote),
        s._scanner);
      if (!g.ok) return { ok: false, reason: g.reason };
    }

    return { ok: true, reason: null };
  }

  /* ------------------------------------------------- Module 10, liquidity -- */

  async _refreshTradeQuote(nowMs) {
    const t = this.trade;
    if (!t) return;
    if (nowMs - (this._quoteAt || 0) < 1000) return;
    this._quoteAt = nowMs;
    try {
      const snap = await this.quoteSource.snapshot([
        { token: t.token, segment: t.segment || 'nse_fo' }]);
      const q = snap.get(t.token);
      if (q) this.quoteCache.set(t.token, { quote: q, ts: nowMs });
    } catch (err) {
      // A failed quote is not evidence that liquidity has gone. Say so once.
      if (!this._quoteWarned) {
        this._quoteWarned = true;
        logger.warn('pfe: could not refresh the position\'s quote — the liquidity exit is blind',
          { err: err.message });
      }
    }
  }

  async _checkLiquidityExit(nowMs) {
    const t = this.trade;
    const s = this.settings;
    if (!t || !s.exitOnLiquidity) return;
    const cached = this.quoteCache.get(t.token);
    if (!cached || nowMs - cached.ts > 5000) return;

    const verdict = rules.liquidityBroken(cached.quote, {
      ...s._liquidityExit, entryVolume: t.entryVolume,
    });
    if (verdict.blind) {
      // Said once per session, not once a second: on a `ltp`-only account this
      // check can never fire, and an operator who configured a liquidity exit
      // deserves to know it is not running.
      if (!this._liquidityBlindWarned) {
        this._liquidityBlindWarned = true;
        logger.warn('pfe: the liquidity exit has nothing to measure — this account\'s quote '
          + 'filter sends no bid, ask or volume. The exit is configured but cannot fire.');
      }
      return;
    }
    if (verdict.broken) {
      await this._dispatch({ type: 'LIQUIDITY_FAIL', reason: verdict.reason, tsMs: nowMs });
    }
  }

  /* ---------------------------------------------------------------- ticks -- */

  _onTick(tick) {
    // Paper mode is driven by the same tick stream the candles are, so a paper
    // fill happens exactly where a live one would.
    if (this.settings?.mode === 'PAPER') {
      this.broker.paper.onTick(tick.token, tick.ltpPaise);
    }

    if (this.spotToken && String(tick.token) === String(this.spotToken.token)) {
      this.spotPaise = tick.ltpPaise;
      this._blindSince = null;
      // The index feeds the structure filter and the mids, and NOTHING else. It
      // never reaches optionCandles, so no index bar can ever price an entry.
      this.indexCandles.addTick(tick.token, tick.ltpPaise, tick.ts);
      return;
    }

    this.optionCandles.addTick(tick.token, tick.ltpPaise, tick.ts);

    const t = this.trade;
    if (!t || String(tick.token) !== t.token) return;
    if (!machine.isOpen(t)) return;
    // The trailing stop and the premium safety exit are the two decisions that
    // react at tick speed.
    this._dispatch({ type: 'TICK', ltpPaise: tick.ltpPaise, tsMs: tick.ts })
      .catch(this._oops('tick'));
  }

  /* -------------------------------------------------------- order outcomes -- */

  // Everything from the reconciler is filtered on `pfeTradeId` first: the
  // scalper shares this table and its rows must never drive this engine.
  _mine(evt) {
    if (evt.pfeTradeId == null) return false;
    return this.trade != null && Number(evt.pfeTradeId) === Number(this.trade.id);
  }

  async _onFill(fill) {
    if (!this._mine(fill)) return;
    const now = Date.now();

    if (fill.stage === 'ENTRY') {
      const cached = this.quoteCache.get(this.trade.token);
      await this._dispatch({
        type: 'SELL_FILLED',
        filledPriceP: fill.filledPriceP,
        filledQty: fill.filledQty,
        volume: cached?.quote?.volume ?? null,
        tsMs: now,
      });
      this.stats.entries += 1;
      await repo.pfeStats.bumpEntry(time.tradeDate(now)).catch(() => {});
      return;
    }

    if (fill.stage === 'TARGET') {
      await this._dispatch({ type: 'TARGET_FILLED', filledPriceP: fill.filledPriceP, tsMs: now });
      return;
    }

    await this._dispatch({ type: 'EXIT_FILLED', filledPriceP: fill.filledPriceP, tsMs: now });
  }

  // A partial entry fill is a real position of the filled size. Cancel the
  // remainder and size the target and stop to what actually filled — the
  // alternative is a stop that covers more than the position and an exit that
  // opens a naked long.
  async _onPartial(fill) {
    if (!this._mine(fill) || fill.stage !== 'ENTRY') return;
    logger.warn('pfe: partial entry fill — cancelling the remainder and sizing to what filled',
      { filled: fill.filledQty, of: fill.totalQty });
    await this.router.cancel(fill.orderId, 'partial fill — cancelling the balance');
    await this._dispatch({
      type: 'SELL_FILLED', filledPriceP: fill.filledPriceP, filledQty: fill.filledQty,
      tsMs: Date.now(),
    });
  }

  async _onCancelled(evt) {
    if (!this._mine(evt)) return;
    const now = Date.now();
    if (evt.stage === 'ENTRY') {
      const next = machine.afterSellCancel(this.trade, now);
      await this._apply(next, { type: 'SELL_CANCELLED' });
      return;
    }
    if (evt.stage === 'TARGET') {
      await this._dispatch({ type: 'TARGET_CANCELLED', tsMs: now });
    }
  }

  async _onRejected(evt) {
    if (!this._mine(evt)) return;
    if (evt.stage === 'ENTRY') {
      await this._dispatch({ type: 'SELL_REJECTED', reason: evt.reason, tsMs: Date.now() });
    }
  }

  /* ---------------------------------------------------- dispatch and apply -- */

  async _dispatch(event) {
    if (!this.trade) return;
    const next = machine.reduce(this.trade, event, this.settings._machine);
    await this._apply(next, event);
  }

  async _apply(next, event) {
    const t = this.trade;
    if (!t) return;
    const from = t.state;

    Object.assign(t, next.patch);
    t.state = next.state;

    if (from !== next.state || Object.keys(next.patch).length) {
      await repo.pfeTrades.setState(t.id, next.state, {
        attemptSeq: next.patch.attemptSeq,
        requoteCount: next.patch.requoteCount,
        confirmations: next.patch.confirmations,
        trails: next.patch.trails,
        entryCandleId: next.patch.entryCandleId,
        sellPriceP: next.patch.sellPriceP,
        filledPriceP: next.patch.filledPriceP,
        filledQty: next.patch.filledQty,
        targetPriceP: next.patch.targetPriceP,
        slPriceP: next.patch.slPriceP,
        trailPeakP: next.patch.trailPeakP,
        entryVolume: next.patch.entryVolume,
        // `in`, not truthiness: an explicit null has to reach the column.
        openedAt: stamp(next.patch, 'openedAt'),
        closedAt: stamp(next.patch, 'closedAt'),
        exitReason: next.patch.exitReason,
      });
    }

    if (from !== next.state) {
      await this._event({
        kind: 'STATE', optionType: t.optionType,
        fromState: from, toState: next.state, reason: event.type,
      });
      this.emit('trade', { ...t });
    }

    for (const action of next.actions) await this._act(action);

    if (this.trade && this.trade.state === STATES.DONE && !this.trade.filledPriceP) {
      // Armed and released without ever opening. Nothing to book — just give the
      // position slot back so the next scan can run.
      await this._finishTrade();
    }
  }

  async _act(action) {
    const t = this.trade;
    if (!t) return;

    switch (action.type) {
      case 'LOG':
        await this._event({
          optionType: t.optionType, kind: action.kind,
          reason: action.reason || action.note || null, payload: action,
        });
        return;

      case 'PLACE_SELL': {
        const order = await this.router.place({
          prefix: 'pf', pfeTradeId: t.id, optionType: t.optionType,
          attemptSeq: action.attemptSeq, stage: 'ENTRY',
          token: t.token, segment: t.segment || 'nse_fo', symbol: t.symbol,
          side: 'SELL', orderType: 'L', qty: t.qty,
          limitPriceP: action.pricePaise, tickP: t.tickP || 5,
        }).catch(async (err) => {
          // A pre-send rate limit leaves the order PENDING. Step the trade back
          // so the next candle prices a fresh one rather than stranding it.
          logger.warn('pfe: sell deferred', { err: err.message });
          await this._dispatch({ type: 'SELL_REJECTED', reason: err.message, tsMs: Date.now() });
          return null;
        });
        if (order && order.status === 'WORKING') {
          await this._dispatch({ type: 'SELL_PLACED', orderId: order.id, tsMs: Date.now() });
        }
        return;
      }

      case 'CANCEL_SELL': {
        if (!t.sellOrderId) return;
        const res = await this.router.cancel(t.sellOrderId, 'pending timeout');
        if (res.outcome === 'CANCELLED') {
          const next = machine.afterSellCancel(t, Date.now());
          await this._apply(next, { type: 'SELL_CANCELLED' });
        }
        // ALREADY_FILLED needs no action: the reconciler reports the fill, and
        // SELL_FILLED is handled from SELL_CANCELLING for exactly this case.
        return;
      }

      case 'PLACE_TARGET': {
        const order = await this.router.place({
          prefix: 'pf', pfeTradeId: t.id, optionType: t.optionType,
          attemptSeq: t.attemptSeq, stage: 'TARGET',
          // The ladder rung. Each rung is a genuinely different order and needs
          // its own idempotency key, but a RETRY of the same rung must reuse it
          // — so the revision is the confirmation count, not a placement count.
          revision: t.confirmations || 0,
          token: t.token, segment: t.segment || 'nse_fo', symbol: t.symbol,
          side: 'BUY', orderType: 'L', qty: action.qty,
          limitPriceP: action.pricePaise, tickP: t.tickP || 5,
        }).catch((err) => {
          logger.error('pfe: THE TARGET ORDER FAILED — the position is running on its stop, '
            + 'the filter and the clock alone', { err: err.message });
          return null;
        });
        if (order && order.status === 'WORKING') {
          await this._dispatch({ type: 'TARGET_PLACED', orderId: order.id, tsMs: Date.now() });
        }
        return;
      }

      case 'CANCEL_TARGET': {
        // The OCO door. Nothing may be sent until this cancel is confirmed.
        if (!t.targetOrderId) {
          await this._dispatch({ type: 'TARGET_CANCELLED', tsMs: Date.now() });
          return;
        }
        const res = await this.router.cancel(t.targetOrderId, `exit: ${action.reason}`);
        if (res.outcome === 'CANCELLED' || res.outcome === 'GONE') {
          t.cancelFailedAt = null;
          await this._dispatch({ type: 'TARGET_CANCELLED', tsMs: Date.now() });
        } else if (res.outcome === 'ALREADY_FILLED') {
          t.cancelFailedAt = null;
          await this._dispatch({
            type: 'TARGET_CANCEL_FAILED_FILLED',
            filledPriceP: t.targetPriceP, tsMs: Date.now(),
          });
        } else {
          // FAILED — genuinely ambiguous. Do NOT send an exit: the target may
          // still be working, and two exits on one short opens a naked long.
          // Stamping the trade is what makes the clock retry.
          t.cancelFailedAt = Date.now();
          logger.error('pfe: the target cancel failed — will retry, NOT exiting',
            { reason: res.reason });
        }
        return;
      }

      case 'EXIT_MARKET': {
        const order = await this.router.place({
          prefix: 'pf', pfeTradeId: t.id, optionType: t.optionType,
          attemptSeq: t.attemptSeq, stage: stageFor(action.reason),
          token: t.token, segment: t.segment || 'nse_fo', symbol: t.symbol,
          side: 'BUY', orderType: 'MKT', qty: action.qty || t.qty,
          limitPriceP: 0, tickP: t.tickP || 5,
        }).catch((err) => {
          logger.error('pfe: THE EXIT ORDER FAILED — the position is still open',
            { reason: action.reason, err: err.message });
          return null;
        });
        if (order && order.status === 'WORKING') {
          await this._dispatch({ type: 'EXIT_PLACED', orderId: order.id, tsMs: Date.now() });
        }
        return;
      }

      case 'CLOSE_TRADE':
        await this._bookTrade(action.reason, action.exitPriceP);
        return;

      default:
        logger.warn('pfe: unknown action from the state machine', { type: action.type });
    }
  }

  /* --------------------------------------------------------------- booking -- */

  // Net, not gross. On a one-point first rung most of the gross is charges, and
  // the risk limits must see the number the account actually moved by.
  async _bookTrade(reason, exitPriceP) {
    const t = this.trade;
    if (!t) return;

    if (t.filledPriceP == null) {
      await this._finishTrade();
      return;
    }

    const qty = t.filledQty || t.qty;
    const pnl = money.shortPnl({ entryPaise: t.filledPriceP, exitPaise: exitPriceP, qty });

    await repo.pfeTrades.close(t.id, {
      exitP: exitPriceP,
      grossPnlP: pnl.grossPaise,
      chargesP: pnl.chargesPaise,
      netPnlP: pnl.netPaise,
      exitReason: reason,
    });

    const tradeDate = time.tradeDate();
    const stats = await repo.pfeStats.recordTrade(tradeDate, {
      grossPnlP: pnl.grossPaise, chargesP: pnl.chargesPaise, netPnlP: pnl.netPaise,
    });

    const s = this.settings;
    if ((reason === EXIT_REASONS.STOPLOSS || reason === EXIT_REASONS.PREMIUM_SAFETY)
      && s._cooldownMs > 0) {
      await repo.pfeStats.setCooldown(tradeDate, Date.now() + s._cooldownMs);
    }
    if (s.maxDailyLoss > 0 && stats.realized_pnl_p <= -money.toPaise(s.maxDailyLoss)) {
      await repo.pfeStats.disable(tradeDate, 'MAX_DAILY_LOSS');
      logger.warn('pfe: daily loss limit hit — trading disabled for the day',
        { realized: money.formatInr(stats.realized_pnl_p) });
    } else if (s.maxDailyProfit > 0 && stats.realized_pnl_p >= money.toPaise(s.maxDailyProfit)) {
      await repo.pfeStats.disable(tradeDate, 'MAX_DAILY_PROFIT');
      logger.info('pfe: daily profit target hit — trading disabled for the day',
        { realized: money.formatInr(stats.realized_pnl_p) });
    }

    this.stats.exits += 1;
    logger.info('pfe: trade closed', {
      symbol: t.symbol, reason,
      entry: money.formatPrice(t.filledPriceP), exit: money.formatPrice(exitPriceP),
      confirmations: t.confirmations, trails: t.trails,
      gross: money.formatInr(pnl.grossPaise), charges: money.formatInr(pnl.chargesPaise),
      net: money.formatInr(pnl.netPaise),
    });
    await this._event({
      optionType: t.optionType, kind: 'TRADE_CLOSED', reason,
      payload: {
        symbol: t.symbol, entryP: t.filledPriceP, exitP: exitPriceP, qty,
        confirmations: t.confirmations, trails: t.trails,
        grossP: pnl.grossPaise, chargesP: pnl.chargesPaise, netP: pnl.netPaise,
      },
    });

    this.emit('closed', { id: t.id, reason, ...pnl });
    await this._finishTrade();
  }

  // Give the position slot back and start Module 11's re-entry wait. Called for
  // a booked round trip AND for a trade that was released without ever opening.
  async _finishTrade() {
    const t = this.trade;
    if (!t) return;
    await repo.pfeTrades.release(t.id).catch(err =>
      logger.warn('pfe: could not release the position slot', { err: err.message }));
    if (t.state !== STATES.DONE) {
      await repo.pfeTrades.setState(t.id, STATES.DONE, { closedAt: time.toMysql(Date.now()) })
        .catch(() => {});
    }
    this.trade = null;
    this.candlesSinceExit = 0;
    this.optionCandles.setTokens([]);
    this._watchTrade();
    this.emit('trade', null);
  }

  /* ------------------------------------------------------- block telemetry -- */

  // WHY IS NOTHING TRADING? — answered without reading the source.
  //
  // Every refusal in this engine is individually reasonable and individually
  // silent, and put together a configuration that can never select looks exactly
  // like a market that never offered anything. That is the most expensive
  // ambiguity this platform can have. So refusals are tallied and the tally is
  // published on an interval — a count, not a line per refusal.
  _noteBlock(reason) {
    if (!reason) {
      this._blocks = null;
      this._blocksSince = 0;
      return;
    }
    if (!this._blocks) { this._blocks = new Map(); this._blocksSince = Date.now(); }
    const key = String(reason).replace(/\d+(\.\d+)?/g, 'N').slice(0, 140);
    this._blocks.set(key, (this._blocks.get(key) || 0) + 1);
    this.lastBlockReason = reason;
  }

  _reportBlocks(now) {
    if (!this._blocks || !this._blocks.size) return;
    if (now - (this._blocksReportedAt || 0) < BLOCK_REPORT_MS) return;
    this._blocksReportedAt = now;

    const ranked = [...this._blocks.entries()].sort((a, b) => b[1] - a[1]);
    logger.warn('pfe: nothing has been selected', {
      forSeconds: Math.round((now - this._blocksSince) / 1000),
      refusals: ranked.reduce((n, [, c]) => n + c, 0),
      reasons: ranked.slice(0, 4).map(([reason, count]) => `${count}× ${reason}`),
      hint: `the scan detail is on ${config.appUrl}/pfe`,
    });
  }

  /* ------------------------------------------------------------------ spot -- */

  async _ensureSpot() {
    if (this.spotToken) return this.spotToken;
    this.spotToken = await instrumentMaster.indexInstrument(this.settings.symbol);
    if (!this.spotToken) return null;
    this.ticker.subscribe([this.spotToken]);
    this.indexCandles.setTokens([this.spotToken.token]);
    logger.info('pfe: watching the index', {
      symbol: this.settings.symbol, token: this.spotToken.token,
      timeframe: this.settings.trendTimeframe,
    });
    return this.spotToken;
  }

  // The CURRENT index price in paise, or null. An index that never quotes is an
  // ERROR that names the instrument, not a silent early return once a second
  // forever — that failure mode cost a whole session once already.
  _spot() {
    if (!this.spotToken) return null;
    const p = this.ticker.ltpPaise(this.spotToken.token);
    if (p == null) {
      this._blindSince = this._blindSince || Date.now();
      const blindMs = Date.now() - this._blindSince;
      if (blindMs > SPOT_BLIND_MS && Date.now() - (this._blindReportedAt || 0) > SPOT_BLIND_MS) {
        this._blindReportedAt = Date.now();
        logger.error('pfe: NO INDEX PRICE — nothing can be selected', {
          instrument: `${this.spotToken.segment}|${this.spotToken.token}`,
          blindForSeconds: Math.round(blindMs / 1000),
          note: 'an index is quoted by NAME, not by its numeric token — run '
            + '`node scripts/diagnose-spot.js`',
        });
      }
      return null;
    }
    this._blindSince = null;
    return p;
  }

  /* ---------------------------------------------------------------- output -- */

  _snapshotSettings() {
    const s = this.settings;
    const keep = ['symbol', 'expiryMode', 'tradeMode', 'lots', 'mode',
      'optionTimeframe', 'trendTimeframe', 'trendBars', 'trendCloseRule',
      'premiumMin', 'premiumMax', 'premiumIdealMin', 'premiumIdealMax',
      'liquidityMode', 'minOpenInterest', 'minVolume', 'minBidQty', 'minAskQty', 'maxSpread',
      'sellOffset', 'pendingTimeout', 'target', 'stopLoss',
      'dynamicTarget', 'targetStep', 'maxTargetSteps',
      'trailStart', 'trailGap', 'trailTighten', 'trailMinGap',
      'maxHoldSeconds', 'premiumSafetyExit', 'liquidityExitSpread', 'reentryCandles'];
    return Object.fromEntries(keep.map(k => [k, s[k]]));
  }

  // The engine holds all of this in memory and the web tier is a different
  // process, so the headline goes through the one channel both tiers share.
  async _publish() {
    const v = this.index.verdict;
    const payload = {
      atMs: Date.now(),
      running: this.running,
      mode: this.settings?.mode ?? null,
      spot: this.spotPaise == null ? null : this.spotPaise / 100,
      directionState: v?.state ?? 'WARMING_UP',
      directionReason: v?.reason ?? null,
      allowCE: v?.allowCE ?? false,
      allowPE: v?.allowPE ?? false,
      bullishMidP: this.index.mids?.bullishMidP ?? null,
      bearishMidP: this.index.mids?.bearishMidP ?? null,
      indexBars: this.index.bars.length,
      candlesSinceExit: this.candlesSinceExit === Infinity ? null : this.candlesSinceExit,
      blocked: this._blocks && this._blocks.size ? this.lastBlockReason : null,
      lastScan: this.lastScan,
      quoteFilter: this.quoteSource?.filter ?? null,
      quoteCoverage: this.quoteSource?.coverage ?? null,
      stats: { ...this.stats },
      lastError: this.lastError,
    };
    // Truncated hard: `system_flags.value` is a VARCHAR(255) and the ranked
    // candidate list would not fit. The full scan lives in `pfe_scans`; this is
    // only the headline the page needs between polls.
    const slim = { ...payload, lastScan: undefined };
    await repo.flags.set('pfe_state', JSON.stringify(slim).slice(0, 255)).catch(() => {});
    this.emit('state', payload);
  }

  async _event(row) {
    try {
      await repo.events.log({ ...row, kind: `PFE_${row.kind}`.slice(0, 32), tsMs: row.tsMs ?? Date.now() });
    } catch (err) {
      logger.warn('pfe: event log failed', { err: err.message });
    }
  }

  status() {
    const t = this.trade;
    return {
      running: this.running,
      intent: this.intent,
      mode: this.settings?.mode ?? null,
      lastError: this.lastError,
      spot: this.spotPaise == null ? null : this.spotPaise / 100,
      index: {
        bars: this.index.bars.length,
        state: this.index.verdict?.state ?? 'WARMING_UP',
        reason: this.index.verdict?.reason ?? null,
        allowCE: this.index.verdict?.allowCE ?? false,
        allowPE: this.index.verdict?.allowPE ?? false,
        bullishMidP: this.index.mids?.bullishMidP ?? null,
        bearishMidP: this.index.mids?.bearishMidP ?? null,
      },
      trade: t && {
        id: t.id, state: t.state, symbol: t.symbol, optionType: t.optionType,
        strike: t.strike, qty: t.qty,
        sellP: t.sellPriceP, filledP: t.filledPriceP,
        targetP: t.targetPriceP, slP: t.slPriceP,
        confirmations: t.confirmations, trails: t.trails,
        ltpPaise: this.ticker.ltpPaise(t.token),
        openPnlP: t.filledPriceP != null
          ? money.openPnl({
            entryPaise: t.filledPriceP,
            ltpPaise: this.ticker.ltpPaise(t.token) ?? t.filledPriceP,
            qty: t.filledQty || t.qty,
          })
          : null,
      },
      lastScan: this.lastScan,
      blocked: this.lastBlockReason,
      stats: { ...this.stats },
    };
  }
}

// The `orders.stage` an exit is recorded under. It is what the trades page and
// the broker's order book both read, so an exit reason that does not map to one
// of these would show up as a mystery order.
function stageFor(reason) {
  switch (reason) {
    case EXIT_REASONS.STOPLOSS:
    case EXIT_REASONS.PREMIUM_SAFETY:
      return 'SL';
    case EXIT_REASONS.MAX_HOLD:
      return 'TIMEOUT';
    case EXIT_REASONS.SQUAREOFF:
      return 'SQUAREOFF';
    default:
      return 'EXIT';
  }
}

module.exports = { PfeEngine, stageFor };
