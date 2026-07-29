// Every reason the engine is not allowed to open a new position.
//
// One rule shapes the whole file: a risk control stops ENTRIES, it does not
// abandon an open position. `canEnter()` is consulted before a cycle opens and
// before a leg arms; nothing here can stop a target, a stop-loss or a
// square-off. Halting entries is a risk control; walking away from a live naked
// short is not.

const config = require('../config');
const time = require('../core/time');
const money = require('../core/money');
const repo = require('../repositories');
const logger = require('../core/logger');

// A NIFTY move of `marketMovePause` points inside `marketMoveWindow` seconds
// pauses new entries. Implemented as a ring of recent spot samples rather than
// a first-vs-last comparison, so a round trip (up 40, back down) inside the
// window still trips it — that is a volatile market, which is the thing being
// detected.
class SpotMonitor {
  constructor() {
    this.samples = [];                 // { ts, spot }
  }

  record(spot, tsMs = Date.now()) {
    if (!Number.isFinite(spot) || spot <= 0) return;
    this.samples.push({ ts: tsMs, spot });
    // Keep a generous window; trimming happens by time, not by count.
    const cutoff = tsMs - 5 * 60 * 1000;
    while (this.samples.length && this.samples[0].ts < cutoff) this.samples.shift();
  }

  // The largest peak-to-trough excursion inside the trailing window.
  excursion(windowSec, nowMs = Date.now()) {
    const cutoff = nowMs - windowSec * 1000;
    let hi = -Infinity;
    let lo = Infinity;
    for (const s of this.samples) {
      if (s.ts < cutoff) continue;
      if (s.spot > hi) hi = s.spot;
      if (s.spot < lo) lo = s.spot;
    }
    if (hi === -Infinity) return 0;
    return hi - lo;
  }

  latest() {
    return this.samples.length ? this.samples[this.samples.length - 1].spot : null;
  }
}

class RiskManager {
  constructor() {
    this.spot = new SpotMonitor();
    this.lastBlockReason = null;
  }

  recordSpot(spot, tsMs) { this.spot.record(spot, tsMs); }

  /* --------------------------------------------------------------- gates -- */

  // May a NEW cycle open right now? Returns { ok, reason }.
  async canEnter(settings, nowMs = Date.now()) {
    const tradeDate = time.tradeDate(nowMs);

    if (config.tradingHalted) {
      return this._block('TRADING_HALTED is set in the environment');
    }

    if (!time.isWithinSession(nowMs, settings.sessionStart, settings.sessionEnd)) {
      return this._block(`outside the trading window ${settings.sessionStart}–${settings.sessionEnd} IST`);
    }

    // Never open a position that the square-off is about to close. Without this
    // the engine can enter at 15:14:50 and flatten it ten seconds later, paying
    // both sides of the round trip for nothing.
    const squareOffAt = time.atIstTime(nowMs, settings.squareOffAt);
    const minHoldMs = Number(settings.positionTimeout || 60) * 1000;
    if (nowMs + minHoldMs > squareOffAt) {
      return this._block(`too close to the ${settings.squareOffAt} square-off to hold a full position`);
    }

    const stats = await repo.stats.ensure(tradeDate);

    if (stats.disabled) {
      return this._block(`trading disabled for today — ${stats.disabled_reason || 'risk limit'}`);
    }

    if (stats.cooldown_until) {
      const until = time.fromMysql(stats.cooldown_until);
      if (until && nowMs < until) {
        const left = Math.ceil((until - nowMs) / 1000);
        return this._block(`cooling down for another ${left}s after a stop-loss`);
      }
    }

    const realized = stats.realized_pnl_p;

    if (settings.maxDailyLoss > 0 && realized <= -money.toPaise(settings.maxDailyLoss)) {
      await repo.stats.disable(tradeDate, 'MAX_DAILY_LOSS');
      return this._block(`daily loss limit reached (${money.formatInr(realized)})`);
    }

    if (settings.maxDailyProfit > 0 && realized >= money.toPaise(settings.maxDailyProfit)) {
      await repo.stats.disable(tradeDate, 'MAX_DAILY_PROFIT');
      return this._block(`daily profit target reached (${money.formatInr(realized)})`);
    }

    if (settings.maxConsecutiveLoss > 0 && stats.consecutive_losses >= settings.maxConsecutiveLoss) {
      // Not a hard disable — a cooldown. Three losses is a signal that the
      // market is not offering what the strategy needs right now, not proof the
      // day is over.
      const until = nowMs + Number(settings.cooldownAfterSL || 300) * 1000;
      await repo.stats.setCooldown(tradeDate, until);
      return this._block(`${stats.consecutive_losses} consecutive losses — cooling down`);
    }

    if (settings.maxCyclesPerDay > 0 && stats.cycle_count >= settings.maxCyclesPerDay) {
      return this._block(`the daily cycle cap of ${settings.maxCyclesPerDay} is reached`);
    }

    const move = this.spot.excursion(Number(settings.marketMoveWindow || 30), nowMs);
    if (settings.marketMovePause > 0 && move >= Number(settings.marketMovePause)) {
      return this._block(
        `NIFTY moved ${move.toFixed(0)} points inside ${settings.marketMoveWindow}s — new entries paused`);
    }

    this.lastBlockReason = null;
    return { ok: true, reason: null };
  }

  _block(reason) {
    // Log a transition into a block, not every poll. A reason that repeats once
    // a second for twenty minutes tells an operator nothing they did not learn
    // from the first line.
    if (this.lastBlockReason !== reason) {
      logger.info('risk: entries blocked', { reason });
      this.lastBlockReason = reason;
    }
    return { ok: false, reason };
  }

  /* -------------------------------------------------------------- outcome -- */

  // Fold a closed trade into the day and apply anything it triggers.
  async recordTrade(settings, { grossPnlP, chargesP, netPnlP, exitReason }, nowMs = Date.now()) {
    const tradeDate = time.tradeDate(nowMs);
    const stats = await repo.stats.recordTrade(tradeDate, { grossPnlP, chargesP, netPnlP });

    if (exitReason === 'STOPLOSS' && Number(settings.cooldownAfterSL) > 0) {
      const until = nowMs + Number(settings.cooldownAfterSL) * 1000;
      await repo.stats.setCooldown(tradeDate, until);
      logger.info('risk: cooling down after a stop-loss',
        { seconds: settings.cooldownAfterSL, until: new Date(until).toISOString() });
    }

    const realized = stats.realized_pnl_p;
    if (settings.maxDailyLoss > 0 && realized <= -money.toPaise(settings.maxDailyLoss)) {
      await repo.stats.disable(tradeDate, 'MAX_DAILY_LOSS');
      logger.warn('risk: daily loss limit hit — trading disabled for the day',
        { realized: money.formatInr(realized) });
    } else if (settings.maxDailyProfit > 0 && realized >= money.toPaise(settings.maxDailyProfit)) {
      await repo.stats.disable(tradeDate, 'MAX_DAILY_PROFIT');
      logger.info('risk: daily profit target hit — trading disabled for the day',
        { realized: money.formatInr(realized) });
    }

    return stats;
  }

  async snapshot(nowMs = Date.now()) {
    const tradeDate = time.tradeDate(nowMs);
    const stats = await repo.stats.ensure(tradeDate);
    return {
      tradeDate,
      realizedPnlP: stats.realized_pnl_p,
      grossPnlP: stats.gross_pnl_p,
      chargesP: stats.charges_p,
      trades: stats.trade_count,
      cycles: stats.cycle_count,
      wins: stats.win_count,
      losses: stats.loss_count,
      consecutiveLosses: stats.consecutive_losses,
      cooldownUntil: stats.cooldown_until ? time.fromMysql(stats.cooldown_until) : null,
      disabled: Boolean(stats.disabled),
      disabledReason: stats.disabled_reason,
      spot: this.spot.latest(),
      blockedReason: this.lastBlockReason,
    };
  }
}

module.exports = { RiskManager, SpotMonitor };
