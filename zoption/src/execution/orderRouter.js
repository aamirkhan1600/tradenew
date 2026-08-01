// The only place in the codebase that sends an order.
//
// Kotak's place-order carries no client order id, so a retry after a network
// error is indistinguishable from a new order. Two mechanisms stand between
// that and a duplicate position:
//
//   1. `orders.client_ref` is UNIQUE. The reference is derived from the cycle,
//      leg, attempt, stage and target revision — `zo-<cycle>-<leg>-<attempt>-
//      <stage>[-R<n>]` — so the same logical order can only ever be inserted
//      once.
//
//   2. `claimForPlacement` atomically moves that row PENDING -> PLACING. Only
//      the first caller wins. A second run, whatever caused it, sees a
//      non-PENDING row and refuses.
//
// And then the three-way failure rule, which is the part that is easy to get
// wrong and expensive to get wrong:
//
//   PRE-SEND failure   the rate limiter refused; nothing left the process.
//                      -> reset to PENDING, safe to place again.
//
//   REJECTED           the broker answered "no" with a reason.
//                      -> mark REJECTED. Retrying unchanged fails identically.
//
//   UNCERTAIN          timeout, reset socket, 5xx after send. The order MAY be
//                      live at the exchange.
//                      -> mark UNKNOWN. NEVER resend. NEVER retry. The
//                         reconciler resolves it against the broker's book.
//
// The third case is the one that costs money. A resend of an order that did
// reach the exchange doubles the position, and on a naked short that is the
// worst outcome the system can produce.

const logger = require('../core/logger');
const money = require('../core/money');
const repo = require('../repositories');
const {
  BrokerRejectedError, BrokerUncertainError, RateLimitedError,
} = require('../core/errors');

// `zo-<cycleId>-<CE|PE>-<attempt>-<stage>[-R<revision>]`. Stable, human-readable
// in the order book, and unique per logical order.
//
// `revision` exists for the dynamic target ladder (R9). A laddered target is
// cancelled and re-placed several times within ONE attempt, and every one of
// those is a genuinely different order — without a revision they would all
// collide on this key, `place()` would find the cancelled predecessor and return
// it, and the leg would end up believing it held a target that does not exist at
// the broker. The revision must be derived from something stable (the
// confirmation count), so a RETRY of the same rung still collapses onto one
// order, which is the whole point of the key.
// `prefix` names the ENGINE that owns the order — `zo` for the offset scalper,
// `pf` for the Price-Filter Engine (doc/new.md), `os` for the Option Selling
// Engine (newdoc/update.md). All three share this table and this router, and
// their id spaces are independent: cycle 7, pfe trade 7 and ose trade 7 all
// exist, and without the prefix `ZO-7-CE-1-ENTRY` would be the same key for
// each. It is also the first thing a human reads in the broker's order book when
// asking which strategy sent something.
function clientRef({ prefix = 'zo', cycleId, scopeId, optionType, attemptSeq, stage, revision = 0 }) {
  const rev = Number(revision) > 0 ? `-R${Math.trunc(Number(revision))}` : '';
  const scope = scopeId ?? cycleId;
  return `${prefix}-${scope}-${optionType}-${attemptSeq}-${stage}${rev}`.toUpperCase();
}

class OrderRouter {
  constructor({ broker, events }) {
    this.broker = broker;              // adapter: placeOrder / cancelOrder / fetchBook
    this.events = events;              // (row) => Promise, for the audit trail
  }

  setBroker(broker) { this.broker = broker; }

  /* ----------------------------------------------------------- placement -- */

  // Create the row, claim it, send it. Returns the order row as it now stands.
  //
  // `limitPriceP` is paise; the conversion to the rupees Kotak's wire format
  // wants happens once, here, at the edge.
  async place({
    cycleId, legId, pfeTradeId = null, oseTradeId = null, prefix = 'zo',
    optionType, attemptSeq, stage, revision = 0,
    token, segment, symbol, side, orderType, qty, limitPriceP = 0, product = 'NRML', tickP = 5,
  }) {
    const ref = clientRef({
      prefix, scopeId: cycleId ?? pfeTradeId ?? oseTradeId, optionType, attemptSeq, stage, revision,
    });

    // The one rounding boundary between a computed price and an order. An
    // off-tick limit is rejected by the exchange, and rejections are the noisy
    // way to discover a rounding bug.
    const priceP = orderType === 'L' ? money.roundToTickPaise(limitPriceP, tickP) : 0;

    const existing = await repo.orders.byClientRef(ref);
    if (existing) {
      // The same logical order already exists. Whether it is working, filled or
      // dead, creating a second one is never the right answer.
      logger.warn('orderRouter: refusing to duplicate an order that already exists',
        { ref, status: existing.status });
      return existing;
    }

    const orderId = await repo.orders.create({
      clientRef: ref, cycleId, legId, pfeTradeId, oseTradeId, stage, token, segment, symbol,
      side, orderType, product, limitPriceP: priceP, qty,
    });

    const claimed = await repo.orders.claimForPlacement(orderId);
    if (!claimed) {
      logger.warn('orderRouter: the claim was lost — another path is placing this order', { ref });
      return repo.orders.byId(orderId);
    }

    const payload = {
      token: String(token),
      segment,
      tradingSymbol: symbol,
      side,
      orderType,
      product,
      qty,
      limitPrice: money.toRupees(priceP),
      validity: 'DAY',
    };

    try {
      const { brokerOrderId } = await this.broker.placeOrder(payload);
      await repo.orders.markWorking(orderId, brokerOrderId);
      await this._log({
        cycleId, legId, optionType, kind: 'ORDER_PLACED',
        reason: stage,
        payload: { ref, brokerOrderId, side, orderType, priceP, qty },
      });
      logger.info('orderRouter: placed',
        { ref, brokerOrderId, side, type: orderType, price: money.formatPrice(priceP), qty });
      return repo.orders.byId(orderId);
    } catch (err) {
      return this._handlePlacementFailure(err, { orderId, ref, cycleId, legId, optionType, stage });
    }
  }

  async _handlePlacementFailure(err, { orderId, ref, cycleId, legId, optionType, stage }) {
    // Pre-send: the limiter refused before anything left. Safe to retry.
    if (err instanceof RateLimitedError) {
      await repo.orders.resetToPending(orderId, `rate limited, retry in ${err.waitMs}ms`);
      await this._log({
        cycleId, legId, optionType, kind: 'ORDER_DEFERRED',
        reason: 'rate_limited', payload: { ref, waitMs: err.waitMs },
      });
      logger.warn('orderRouter: rate limited before send — the order stays PENDING',
        { ref, waitMs: err.waitMs });
      throw err;
    }

    // Uncertain: the order MAY be live. Never resent, never retried.
    if (err instanceof BrokerUncertainError || err.uncertain) {
      await repo.orders.markUnknown(orderId, err.message);
      await this._log({
        cycleId, legId, optionType, kind: 'ORDER_UNKNOWN',
        reason: err.message, payload: { ref, stage },
      });
      logger.error('orderRouter: the outcome is unknown — the order may be live at the exchange. '
        + 'It will NOT be resent; the reconciler will resolve it.', { ref, err: err.message });
      return repo.orders.byId(orderId);
    }

    // Rejected: the broker said no, with a reason.
    if (err instanceof BrokerRejectedError || err.status === 422) {
      await repo.orders.markRejected(orderId, err.message);
      await this._log({
        cycleId, legId, optionType, kind: 'ORDER_REJECTED',
        reason: err.message, payload: { ref, stage },
      });
      logger.warn('orderRouter: rejected', { ref, err: err.message });
      return repo.orders.byId(orderId);
    }

    // Anything else — an auth failure, a bug. Treat as uncertain: the
    // conservative reading is always "it might be live".
    await repo.orders.markUnknown(orderId, err.message);
    await this._log({
      cycleId, legId, optionType, kind: 'ORDER_UNKNOWN',
      reason: err.message, payload: { ref, stage, unexpected: true },
    });
    logger.error('orderRouter: unexpected placement failure, treated as UNKNOWN',
      { ref, err: err.message });
    return repo.orders.byId(orderId);
  }

  /* ---------------------------------------------------------------- cancel -- */

  // Cancel and report what actually happened. The caller — the OCO path — needs
  // to distinguish "cancelled, the target will not fill" from "too late, it
  // already filled", because sending an exit order in the second case opens a
  // naked long.
  //
  // Returns { outcome: 'CANCELLED' | 'ALREADY_FILLED' | 'GONE' | 'FAILED', ... }
  async cancel(orderId, reason = 'cancel') {
    const order = await repo.orders.byId(orderId);
    if (!order) return { outcome: 'GONE', reason: 'no such order' };

    if (order.status === 'FILLED') return { outcome: 'ALREADY_FILLED', order };
    if (order.status === 'CANCELLED' || order.status === 'REJECTED') {
      return { outcome: 'CANCELLED', order };
    }
    if (!order.broker_order_id) {
      // Never reached the broker. Marking it cancelled locally is correct and
      // there is nothing to cancel remotely.
      await repo.orders.markCancelled(orderId, reason);
      return { outcome: 'CANCELLED', order: await repo.orders.byId(orderId) };
    }

    try {
      const res = await this.broker.cancelOrder({ brokerOrderId: order.broker_order_id });
      const message = String(res?.emsg || '').toLowerCase();
      // A broker that refuses the cancel because the order executed is telling
      // us the position is flat. That is not a failure.
      if (res?.stat === 'Not_Ok' && /execut|complet|filled|traded/.test(message)) {
        logger.info('orderRouter: cancel refused — the order had already filled',
          { ref: order.client_ref });
        return { outcome: 'ALREADY_FILLED', order, raw: res };
      }
      if (res?.stat === 'Not_Ok') {
        logger.warn('orderRouter: cancel refused', { ref: order.client_ref, emsg: res?.emsg });
        return { outcome: 'FAILED', order, reason: res?.emsg || 'cancel refused', raw: res };
      }

      await repo.orders.markCancelled(orderId, reason);
      await this._log({
        cycleId: order.cycle_id, legId: order.leg_id, kind: 'ORDER_CANCELLED',
        reason, payload: { ref: order.client_ref, stage: order.stage },
      });
      return { outcome: 'CANCELLED', order: await repo.orders.byId(orderId) };
    } catch (err) {
      // A cancel that timed out is genuinely ambiguous: the order may or may not
      // still be working. The caller must NOT proceed to an exit market order on
      // this, so it is reported as a failure and retried.
      logger.error('orderRouter: cancel failed', { ref: order.client_ref, err: err.message });
      return { outcome: 'FAILED', order, reason: err.message };
    }
  }

  async _log(row) {
    try {
      if (this.events) await this.events(row);
    } catch (err) {
      logger.warn('orderRouter: event log failed', { err: err.message });
    }
  }
}

module.exports = { OrderRouter, clientRef };
