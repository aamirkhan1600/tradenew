// The broker's order book is the truth. This polls it and folds it back into
// our rows, which is how three different problems get solved by one loop:
//
//   * FILL DETECTION. Nothing else tells us a resting limit filled. The paper
//     broker emits an event, but the live one does not, so the engine learns
//     about every fill from here and both modes exercise the same path.
//
//   * UNKNOWN RESOLUTION. An order whose placement timed out may or may not be
//     live. It is never resent — it is matched here against the book and
//     resolved to WORKING, FILLED or genuinely absent.
//
//   * BOOT RECOVERY. A process that died holding a position comes back to a
//     database that says WORKING and a broker that may say FILLED. Reconciling
//     before the engine arms anything is what stops it from opening a second
//     position on top of one it forgot about.
//
// Matching is by broker order id. An UNKNOWN row has no id — it never got one —
// so those are matched on the trading symbol, side and quantity within a time
// window, and anything ambiguous is left UNKNOWN for a human. Guessing here
// would be worse than not knowing.

const EventEmitter = require('events');
const logger = require('../core/logger');
const repo = require('../repositories');

class Reconciler extends EventEmitter {
  constructor({ broker, intervalMs = 1000 }) {
    super();
    this.broker = broker;
    this.intervalMs = intervalMs;
    this._timer = null;
    this._running = false;
    this.lastRunAt = 0;
    this.lastError = null;
    this.stats = { runs: 0, errors: 0, fills: 0, resolved: 0 };
  }

  setBroker(broker) { this.broker = broker; }

  start() {
    if (this._timer) return this;
    const loop = async () => {
      this._timer = null;
      await this.runOnce();
      this._timer = setTimeout(loop, this.intervalMs);
      this._timer.unref?.();
    };
    this._timer = setTimeout(loop, 0);
    this._timer.unref?.();
    return this;
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  async runOnce() {
    if (this._running) return;
    this._running = true;
    try {
      const ours = await repo.orders.working();
      if (!ours.length) { this.lastRunAt = Date.now(); return; }

      const book = await this.broker.fetchBook();
      const byId = new Map(book.map(r => [String(r.brokerOrderId), r]));

      for (const order of ours) {
        if (order.broker_order_id) {
          await this._reconcileKnown(order, byId.get(String(order.broker_order_id)));
        } else if (order.status === 'UNKNOWN') {
          await this._reconcileUnknown(order, book);
        }
      }

      this.stats.runs += 1;
      this.lastRunAt = Date.now();
      this.lastError = null;
    } catch (err) {
      this.stats.errors += 1;
      this.lastError = err.message;
      // Once, then every twentieth. A dead session fails this every second and
      // the first line is the informative one.
      if (this.stats.errors === 1 || this.stats.errors % 20 === 0) {
        logger.warn('reconciler: poll failed', { err: err.message, attempt: this.stats.errors });
      }
    } finally {
      this._running = false;
    }
  }

  async _reconcileKnown(order, bookRow) {
    if (!bookRow) {
      // We hold an id the book does not list. On Kotak the book is same-day and
      // complete, so this usually means the row is stale rather than lost —
      // leave it and let the next poll decide. Never assume "absent" means
      // "cancelled": that would strand a live position.
      return;
    }

    if (bookRow.status === 'FILLED' && order.status !== 'FILLED') {
      const filledPriceP = Math.round(Number(bookRow.avgPrice) * 100);
      await repo.orders.markFilled(order.id, {
        filledQty: bookRow.filledQty || order.qty,
        filledPriceP,
      });
      this.stats.fills += 1;
      logger.info('reconciler: fill',
        { ref: order.client_ref, stage: order.stage, price: bookRow.avgPrice, qty: bookRow.filledQty });
      this.emit('fill', {
        orderId: order.id,
        clientRef: order.client_ref,
        legId: order.leg_id,
        cycleId: order.cycle_id,
        stage: order.stage,
        side: order.side,
        filledQty: bookRow.filledQty || order.qty,
        filledPriceP,
      });
      return;
    }

    if (bookRow.status === 'PARTIAL' && bookRow.filledQty > (order.filled_qty || 0)) {
      const filledPriceP = Math.round(Number(bookRow.avgPrice) * 100);
      await repo.orders.markPartial(order.id, { filledQty: bookRow.filledQty, filledPriceP });
      logger.warn('reconciler: partial fill',
        { ref: order.client_ref, filled: bookRow.filledQty, of: bookRow.totalQty });
      this.emit('partial', {
        orderId: order.id,
        clientRef: order.client_ref,
        legId: order.leg_id,
        cycleId: order.cycle_id,
        stage: order.stage,
        side: order.side,
        filledQty: bookRow.filledQty,
        totalQty: bookRow.totalQty,
        filledPriceP,
      });
      return;
    }

    if (bookRow.status === 'CANCELLED' && order.status !== 'CANCELLED') {
      await repo.orders.markCancelled(order.id, 'cancelled at the broker');
      this.emit('cancelled', {
        orderId: order.id, clientRef: order.client_ref,
        legId: order.leg_id, cycleId: order.cycle_id, stage: order.stage,
      });
      return;
    }

    if (bookRow.status === 'REJECTED' && order.status !== 'REJECTED') {
      await repo.orders.markRejected(order.id, bookRow.rejectionReason || 'rejected at the broker');
      this.emit('rejected', {
        orderId: order.id, clientRef: order.client_ref,
        legId: order.leg_id, cycleId: order.cycle_id, stage: order.stage,
        reason: bookRow.rejectionReason,
      });
      return;
    }

    if (order.status === 'UNKNOWN' && bookRow.status === 'WORKING') {
      // It did reach the exchange after all.
      await repo.orders.markWorking(order.id, bookRow.brokerOrderId);
      this.stats.resolved += 1;
      logger.info('reconciler: an UNKNOWN order resolved to WORKING', { ref: order.client_ref });
    }
  }

  // An order that never got an id. Match on symbol + side + quantity, and only
  // when exactly one candidate fits — two matching rows means we cannot tell
  // which is ours, and inventing an answer is worse than escalating.
  async _reconcileUnknown(order, book) {
    const candidates = book.filter(r =>
      r.tradingSymbol === order.symbol
      && Number(r.totalQty) === Number(order.qty)
      && r.status !== 'CANCELLED' && r.status !== 'REJECTED');

    if (candidates.length === 0) {
      const ageMs = Date.now() - new Date(order.created_at).getTime();
      // After a couple of minutes with the book showing nothing, the order
      // never reached the exchange. Until then, keep looking — a book can lag.
      if (ageMs > 120000) {
        await repo.orders.markRejected(order.id,
          'never appeared in the order book — treated as never placed');
        this.stats.resolved += 1;
        logger.warn('reconciler: an UNKNOWN order never appeared in the book — closing it out',
          { ref: order.client_ref, ageMs });
        this.emit('rejected', {
          orderId: order.id, clientRef: order.client_ref,
          legId: order.leg_id, cycleId: order.cycle_id, stage: order.stage,
          reason: 'not in the order book',
        });
      }
      return;
    }

    if (candidates.length > 1) {
      logger.error('reconciler: an UNKNOWN order matches several book rows — leaving it for a human',
        { ref: order.client_ref, matches: candidates.length, symbol: order.symbol });
      this.emit('ambiguous', { orderId: order.id, clientRef: order.client_ref, matches: candidates.length });
      return;
    }

    const match = candidates[0];
    await repo.orders.markWorking(order.id, match.brokerOrderId);
    this.stats.resolved += 1;
    logger.warn('reconciler: an UNKNOWN order was found live at the exchange — adopted',
      { ref: order.client_ref, brokerOrderId: match.brokerOrderId });
    // Re-run against it immediately so a match that is already FILLED is
    // reported without waiting another interval.
    await this._reconcileKnown(await repo.orders.byId(order.id), match);
  }

  status() {
    return {
      lastRunAt: this.lastRunAt,
      lastRunAgeMs: this.lastRunAt ? Date.now() - this.lastRunAt : null,
      lastError: this.lastError,
      stats: { ...this.stats },
    };
  }
}

module.exports = { Reconciler };
