// A paper broker driven by the real tick stream.
//
// The v2.0 SDD files paper trading under "future enhancements". It is here in
// the first release instead, because a strategy whose entry depends on candle
// boundaries and whose exits depend on a 60-second clock cannot be validated by
// reading the code — and validating it with real money at a one-rupee target is
// the expensive way to find the bugs.
//
// Fill model, deliberately pessimistic:
//
//   SELL LIMIT p  fills when a tick prints at or ABOVE p
//   BUY  LIMIT p  fills when a tick prints at or BELOW p
//   MARKET        fills at the next tick, not the last one
//
// A limit fills at its own price, never better. Real fills sometimes improve;
// assuming they do would flatter every backtest by a tick, which on a one-point
// target is five percent of the edge. Market orders fill at the *next* tick
// rather than the last seen one, which is the honest model of a round trip to
// the exchange — and it is the only place this simulation lets slippage in, so
// paper results should still be read as an optimistic bound.

const EventEmitter = require('events');
const logger = require('../core/logger');

class PaperBroker extends EventEmitter {
  constructor() {
    super();
    this.orders = new Map();               // brokerOrderId -> order
    this.seq = 0;
    this.lastPrice = new Map();            // token -> paise
  }

  _nextId() {
    this.seq += 1;
    return `PAPER-${String(this.seq).padStart(6, '0')}`;
  }

  /* --------------------------------------------------------- order interface */

  // `limitPrice` arrives in RUPEES, matching the live client's wire format, so
  // both adapters can be handed the identical order object.
  async placeOrder(order) {
    const id = this._nextId();
    const limitPaise = Math.round(Number(order.limitPrice || 0) * 100);
    const row = {
      brokerOrderId: id,
      token: String(order.token),
      tradingSymbol: order.tradingSymbol,
      side: order.side,
      orderType: order.orderType,
      limitPaise,
      totalQty: Number(order.qty),
      filledQty: 0,
      avgPaise: 0,
      status: 'WORKING',
      rejectionReason: null,
      placedAt: Date.now(),
      // A market order must not fill on a price that arrived before it was sent.
      marketArmedAt: Date.now(),
    };
    this.orders.set(id, row);
    logger.debug('paperBroker: order accepted',
      { id, side: row.side, type: row.orderType, limit: limitPaise, qty: row.totalQty });
    return { brokerOrderId: id, raw: { paper: true } };
  }

  async cancelOrder({ brokerOrderId }) {
    const row = this.orders.get(String(brokerOrderId));
    if (!row) return { stat: 'Not_Ok', emsg: 'unknown order' };
    // A filled order cannot be cancelled — which is exactly the race the OCO
    // path has to survive, so the paper broker reproduces it rather than
    // smoothing it over.
    if (row.status === 'FILLED') return { stat: 'Not_Ok', emsg: 'order already executed' };
    if (row.status === 'CANCELLED') return { stat: 'Ok', emsg: 'already cancelled' };
    row.status = 'CANCELLED';
    row.closedAt = Date.now();
    return { stat: 'Ok' };
  }

  async fetchBook() {
    return [...this.orders.values()].map(r => ({
      brokerOrderId: r.brokerOrderId,
      status: r.status,
      rawStatus: r.status.toLowerCase(),
      filledQty: r.filledQty,
      totalQty: r.totalQty,
      avgPrice: r.avgPaise / 100,
      rejectionReason: r.rejectionReason,
      tradingSymbol: r.tradingSymbol,
    }));
  }

  /* ------------------------------------------------------------- tick driver */

  // Called by the engine for every tick on every subscribed token. This is the
  // whole simulation.
  onTick(token, ltpPaise) {
    const key = String(token);
    const price = Math.round(Number(ltpPaise));
    if (!Number.isFinite(price) || price <= 0) return;
    this.lastPrice.set(key, price);

    for (const row of this.orders.values()) {
      if (row.status !== 'WORKING' || row.token !== key) continue;

      let fillPaise = null;
      if (row.orderType === 'MKT' || row.orderType === 'SL-M') {
        // Next tick, not the last one — a market order pays for the round trip.
        if (Date.now() >= row.marketArmedAt) fillPaise = price;
      } else if (row.side === 'SELL') {
        if (price >= row.limitPaise) fillPaise = row.limitPaise;
      } else if (row.side === 'BUY') {
        if (price <= row.limitPaise) fillPaise = row.limitPaise;
      }

      if (fillPaise == null) continue;

      row.filledQty = row.totalQty;
      row.avgPaise = fillPaise;
      row.status = 'FILLED';
      row.closedAt = Date.now();
      logger.info('paperBroker: filled',
        { id: row.brokerOrderId, side: row.side, at: fillPaise, tick: price });
      this.emit('fill', { brokerOrderId: row.brokerOrderId, filledQty: row.filledQty, avgPaise: fillPaise });
    }
  }

  // Wipe simulated state. Used between test cases; never called in a session.
  reset() {
    this.orders.clear();
    this.lastPrice.clear();
    this.seq = 0;
  }

  status() {
    const working = [...this.orders.values()].filter(o => o.status === 'WORKING').length;
    return { mode: 'PAPER', connected: true, orders: this.orders.size, working };
  }
}

module.exports = { PaperBroker };
