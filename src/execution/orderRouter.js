// Order routing — the only path to Kotak Neo.
//
// PLACE AT MOST ONCE is the property this module exists to guarantee. Kotak's
// place-order API carries no client reference, so a resend after a timeout
// would create a second live order with no way to tell it apart from the first.
// Three layers stop that:
//
//   1. A row is INSERTed with a UNIQUE client_order_id BEFORE anything is sent.
//      A duplicate fails at the database — the one check that survives a process
//      restart, a second engine, or a race between them.
//   2. NEW -> SENDING is a conditional UPDATE. Only one caller wins.
//   3. Failures are classified into three outcomes, and only one of them is
//      retryable:
//        rejected  — the broker said no. Nothing is live. Safe to react.
//        uncertain — the request left, no answer came back. The order MAY be
//                    live. NEVER resend; hand it to the reconciler.
//        rate-limited — refused locally before sending. Nothing left. Safe.
//
// Fill prices come from the position book differenced across the order, not
// from the pre-trade quote: the broker's day-cumulative average would otherwise
// contaminate every trade after the first.

const config = require('../config');
const logger = require('../core/logger');
const repo = require('../repositories');
const neo = require('../brokers/kotak/neoClient');
const rateLimiter = require('../core/rateLimiter');
const { round } = require('../core/money');
const {
  RateLimitedError, TradingHaltedError, BrokerUncertainError,
  BrokerAuthError, BrokerRejectedError,
} = require('../core/errors');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------- position book - */
// Cumulative buy/sell quantities and amounts for one token.
function readPosition(list, token) {
  for (const p of list) {
    if (String(p.tok ?? p.token ?? p.tk ?? '') !== String(token)) continue;
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const buyQty = num(p.flBuyQty) + num(p.cfBuyQty);
    const sellQty = num(p.flSellQty) + num(p.cfSellQty);
    const buyAmt = num(p.buyAmt ?? p.flBuyAmt) + num(p.cfBuyAmt);
    const sellAmt = num(p.sellAmt ?? p.flSellAmt) + num(p.cfSellAmt);
    return {
      net: buyQty - sellQty, buyQty, sellQty, buyAmt, sellAmt,
      avgBuy: buyQty ? round(buyAmt / buyQty) : null,
      avgSell: sellQty ? round(sellAmt / sellQty) : null,
    };
  }
  return { net: 0, buyQty: 0, sellQty: 0, buyAmt: 0, sellAmt: 0, avgBuy: null, avgSell: null };
}

async function positionFor(session, token) {
  try {
    const res = await neo.positions(session);
    const list = Array.isArray(res) ? res : (res?.data || []);
    return readPosition(list, token);
  } catch (err) {
    logger.warn('orderRouter: position read failed', { token, err: err.message });
    return null;
  }
}

// THIS order's fill price = the change in the position book across it.
function fillDelta(before, after, side) {
  if (!after) return null;
  const b = before || { buyQty: 0, buyAmt: 0, sellQty: 0, sellAmt: 0 };
  const isBuy = side === 'BUY';
  const dQty = isBuy ? after.buyQty - b.buyQty : after.sellQty - b.sellQty;
  const dAmt = isBuy ? after.buyAmt - b.buyAmt : after.sellAmt - b.sellAmt;
  return dQty > 0 ? round(dAmt / dQty) : null;
}

/* ------------------------------------------------------------------ place - */
/**
 * @param {object} args
 * @param {number} args.userId
 * @param {object} args.session       kotak session { sessionToken, sid, baseUrl }
 * @param {object} args.leg           { kToken, kSymbol, kSegment, lotSize, instrumentId }
 * @param {'BUY'|'SELL'} args.side
 * @param {number} args.qty
 * @param {string} args.clientOrderId idempotency key
 * @param {string} args.purpose       HEDGE_ENTRY | SHORT_ENTRY | SHORT_EXIT | HEDGE_EXIT
 * @param {boolean} args.reduceOnly   exits bypass the kill switch
 * @param {'live'|'paper'} args.mode
 * @param {number|null} args.referencePrice  paper fill / fallback price
 */
async function place(args) {
  const {
    userId, session, leg, side, qty, clientOrderId, purpose,
    reduceOnly = false, mode = 'paper', referencePrice = null,
    strategyId = null, tradeId = null, config: strategyConfig = {},
  } = args;

  // 1. Reserve. A duplicate here means this exact stage already ran.
  const reservation = await repo.orders.reserve({
    userId, strategyId, tradeId, clientOrderId, purpose,
    instrumentId: leg.instrumentId ?? null,
    kToken: leg.kToken, kSymbol: leg.kSymbol, kSegment: leg.kSegment,
    side, qty, product: strategyConfig.product || 'MIS', orderType: 'MKT',
    reduceOnly,
    raw: { mode, referencePrice },
  });

  if (reservation.duplicate) {
    const existing = reservation.existing;
    logger.warn('orderRouter: duplicate order suppressed', { clientOrderId, existingStatus: existing?.status });
    return {
      ok: existing?.status === 'PLACED',
      duplicate: true,
      orderId: existing?.id ?? null,
      brokerOrderId: existing?.broker_order_id ?? null,
      fillPrice: existing?.avg_fill_price != null ? Number(existing.avg_fill_price) : null,
      status: existing?.status ?? 'UNKNOWN',
      reason: 'an order for this exact stage already exists',
    };
  }

  const orderId = reservation.id;

  // 2. Claim. Losing this race means another caller is already sending.
  if (!await repo.orders.claimForSend(orderId)) {
    return { ok: false, orderId, status: 'SENDING', reason: 'already being sent elsewhere' };
  }

  // 3. Kill switch. Opening orders only — an exit must always be possible, or
  //    halting trading would trap open positions.
  if (!reduceOnly && await repo.flags.isTradingHalted()) {
    await repo.orders.markRejected(orderId, 'trading_halted');
    throw new TradingHaltedError('trading is halted — opening orders are blocked');
  }

  // 4. Paper mode stops here: a full order row is still written so the audit
  //    trail and the history screens are identical in shape to a live run.
  if (mode === 'paper') {
    const fill = referencePrice != null ? round(referencePrice) : null;
    await repo.orders.markPlaced(orderId, {
      brokerOrderId: `PAPER-${orderId}`, response: { paper: true, fill },
    });
    await repo.orders.recordFill(orderId, { avgPrice: fill, filledQty: qty });
    return { ok: true, paper: true, orderId, brokerOrderId: `PAPER-${orderId}`, fillPrice: fill, status: 'PLACED' };
  }

  // 5. Local rate limit. A refusal here happens BEFORE the request exists, so
  //    the caller may retry without any risk of a double order.
  const bucketKey = `kotak:${userId}`;
  if (!rateLimiter.tryConsume(bucketKey, config.neo.rps)) {
    await repo.orders.markRejected(orderId, 'rate_limited_locally');
    throw new RateLimitedError(rateLimiter.waitMs(bucketKey, config.neo.rps), 'kotak');
  }

  const before = await positionFor(session, leg.kToken);

  let placed;
  try {
    placed = await neo.placeOrder(session, {
      segment: leg.kSegment,
      tradingSymbol: leg.kSymbol,
      token: leg.kToken,
      side,
      qty,
      product: strategyConfig.product || 'MIS',
      orderType: 'MKT',
      // Slippage protection on opening orders only. An exit must fill even in a
      // spike, so it goes out unprotected on purpose.
      marketProtection: reduceOnly ? 0 : (strategyConfig.marketProtectionPct || 0),
      validity: 'DAY',
    });
  } catch (err) {
    if (err instanceof BrokerUncertainError) {
      // The one outcome that must never be retried.
      await repo.orders.markUnknown(orderId, err.message);
      logger.error('orderRouter: UNCERTAIN outcome — order may be live, not resending', {
        orderId, clientOrderId, err: err.message,
      });
      return { ok: false, uncertain: true, orderId, status: 'UNKNOWN', reason: err.message };
    }
    if (err instanceof BrokerAuthError) {
      await repo.orders.markRejected(orderId, `auth: ${err.message}`);
      await repo.brokers.markExpiredOnce(userId, 'kotak', err.message);
      throw err;
    }
    await repo.orders.markRejected(orderId, err.message,
      err instanceof BrokerRejectedError ? err.meta : null);
    return { ok: false, rejected: true, orderId, status: 'REJECTED', reason: err.message };
  }

  await repo.orders.markPlaced(orderId, { brokerOrderId: placed.brokerOrderId, response: placed.raw });

  // 6. Resolve the actual fill by differencing the position book. Fall back to
  //    the broker's running average, then to the reference quote — each step
  //    less precise, all of them recorded so the trade can be audited.
  const after = await positionFor(session, leg.kToken);
  let fillPrice = fillDelta(before, after, side);
  if (fillPrice == null) fillPrice = side === 'BUY' ? after?.avgBuy : after?.avgSell;
  if (fillPrice == null && referencePrice != null) fillPrice = round(referencePrice);
  await repo.orders.recordFill(orderId, { avgPrice: fillPrice, filledQty: qty });

  return {
    ok: true, orderId, brokerOrderId: placed.brokerOrderId,
    fillPrice, status: 'PLACED',
    netAfter: after?.net ?? null,
  };
}

// Wait for an order to reach a terminal state. Used after a takeover, where the
// row exists but this process did not send it.
async function waitForSettlement(orderId, timeoutMs = config.engine.orderConfirmTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await repo.orders.get(orderId);
    if (row && ['PLACED', 'REJECTED', 'UNKNOWN', 'CANCELLED'].includes(row.status)) return row;
    await sleep(config.engine.orderConfirmPollMs);
  }
  return repo.orders.get(orderId);
}

module.exports = { place, waitForSettlement, positionFor, readPosition, fillDelta };
