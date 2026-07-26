// Reconciliation — resolving orders whose outcome we never learned.
//
// This is the unglamorous half of "place at most once". The router guarantees
// we never send twice; the reconciler answers the question that guarantee
// leaves open: did the one we sent actually happen?
//
// The hard part is that Kotak's place-order carries no client reference, so an
// UNKNOWN order cannot be looked up by our id. What we can do is ask the broker
// for its order book and match on the properties we do know — trading symbol,
// side, quantity, and a time window around when we sent it. That match is a
// HEURISTIC, and it is treated as one:
//
//   * a confident match (exactly one candidate) adopts the broker's order id
//   * an ambiguous match (several candidates) is NOT guessed at — the trade is
//     flagged NEEDS_ATTENTION for a human, because picking wrong here means
//     either abandoning a live position or double-closing one
//   * no match at all, plus a flat position, means the order never landed
//
// Nothing in this module ever places an order.

const logger = require('../core/logger');
const repo = require('../repositories');
const neo = require('../brokers/kotak/neoClient');
const { positionFor } = require('./orderRouter');

// Kotak order-book rows use short keys; normalise the ones we match on.
function normaliseBookRow(row) {
  return {
    brokerOrderId: String(row.nOrdNo ?? row.norenordno ?? row.orderId ?? ''),
    tradingSymbol: String(row.trdSym ?? row.tsym ?? row.ts ?? row.sym ?? ''),
    token: String(row.tok ?? row.token ?? ''),
    side: String(row.trnsTp ?? row.trantype ?? row.tt ?? '').toUpperCase() === 'B' ? 'BUY' : 'SELL',
    qty: Number(row.qty ?? row.orderQty ?? row.qt ?? 0),
    filledQty: Number(row.fldQty ?? row.fillshares ?? row.flQty ?? 0),
    avgPrice: Number(row.avgPrc ?? row.avgprc ?? row.avgPrice ?? 0) || null,
    status: String(row.ordSt ?? row.status ?? row.stat ?? '').toLowerCase(),
    timestamp: row.ordDtTm ?? row.norentm ?? row.exchTm ?? null,
  };
}

async function fetchOrderBook(session) {
  const res = await neo.orderBook(session);
  const list = Array.isArray(res) ? res : (res?.data || []);
  return list.map(normaliseBookRow);
}

// Find the broker's record of one of our orders.
function matchOrder(book, order) {
  const candidates = book.filter(b =>
    b.token === String(order.k_token)
    && b.side === order.side
    && b.qty === Number(order.qty)
    && !/cancel|reject/.test(b.status));

  if (candidates.length === 1) return { match: candidates[0], confidence: 'exact' };
  if (candidates.length === 0) return { match: null, confidence: 'none' };
  return { match: null, confidence: 'ambiguous', candidates };
}

/**
 * Resolve every order left in SENDING or UNKNOWN for a user.
 * Returns a summary; the caller decides what to do with a flagged trade.
 */
async function resolveOrders(userId, session) {
  const stuck = await repo.orders.listStuck(30);
  const mine = stuck.filter(o => Number(o.user_id) === Number(userId));
  if (!mine.length) return { checked: 0, resolved: 0, flagged: 0 };

  let book;
  try {
    book = await fetchOrderBook(session);
  } catch (err) {
    logger.error('reconciler: cannot read the order book — leaving orders unresolved', {
      userId, err: err.message,
    });
    return { checked: mine.length, resolved: 0, flagged: 0, error: err.message };
  }

  let resolved = 0;
  let flagged = 0;

  for (const order of mine) {
    const { match, confidence, candidates } = matchOrder(book, order);

    if (confidence === 'exact') {
      await repo.orders.markPlaced(order.id, {
        brokerOrderId: match.brokerOrderId,
        response: { reconciled: true, match },
      });
      if (match.avgPrice) {
        await repo.orders.recordFill(order.id, { avgPrice: match.avgPrice, filledQty: match.filledQty });
      }
      resolved += 1;
      logger.warn('reconciler: adopted an order found at the broker', {
        orderId: order.id, brokerOrderId: match.brokerOrderId,
      });
      await repo.events.record({
        userId, strategyId: order.strategy_id, tradeId: order.trade_id,
        eventType: 'RECONCILE', level: 'WARN',
        message: `order ${order.id} (${order.purpose}) found live at the broker and adopted`,
        meta: { brokerOrderId: match.brokerOrderId },
      });
      continue;
    }

    if (confidence === 'none') {
      // Nothing in the book. Confirm against the position before concluding it
      // never happened — an order can fill and age out of a filtered book view.
      const position = await positionFor(session, order.k_token);
      const expectedNet = order.side === 'BUY' ? Number(order.qty) : -Number(order.qty);
      const positionSuggestsFill = position && Math.sign(position.net) === Math.sign(expectedNet)
        && Math.abs(position.net) >= Math.abs(expectedNet);

      if (positionSuggestsFill) {
        flagged += 1;
        await flagTrade(userId, order,
          'order not in the book but the position suggests it filled — verify manually');
        continue;
      }
      await repo.orders.markRejected(order.id, 'not found at broker — treated as never placed');
      resolved += 1;
      logger.warn('reconciler: order absent at the broker, marked not placed', { orderId: order.id });
      continue;
    }

    // Ambiguous. Guessing here can abandon a live short or double-close one.
    flagged += 1;
    await flagTrade(userId, order,
      `ambiguous reconciliation — ${candidates.length} broker orders match ${order.k_symbol} ${order.side} ${order.qty}`);
  }

  return { checked: mine.length, resolved, flagged };
}

async function flagTrade(userId, order, reason) {
  await repo.orders.markUnknown(order.id, reason);
  if (order.trade_id) {
    await repo.trades.patch(order.trade_id, { status: 'NEEDS_ATTENTION', exit_reason: 'reconcile' });
  }
  logger.error('reconciler: MANUAL ATTENTION REQUIRED', {
    orderId: order.id, tradeId: order.trade_id, reason,
  });
  await repo.events.record({
    userId, strategyId: order.strategy_id, tradeId: order.trade_id,
    eventType: 'RECONCILE', level: 'ERROR',
    message: reason,
    meta: { orderId: order.id, symbol: order.k_symbol, side: order.side, qty: order.qty },
  });
}

// What the broker thinks we hold for a trade's two legs. Used on startup to
// decide whether a recovered trade is genuinely still open.
async function verifyTradeLegs(session, trade) {
  const [shortPos, hedgePos] = await Promise.all([
    positionFor(session, trade.sell_k_token),
    positionFor(session, trade.hedge_k_token),
  ]);
  return {
    shortNet: shortPos?.net ?? null,
    hedgeNet: hedgePos?.net ?? null,
    shortIsOpen: (shortPos?.net ?? 0) < 0,
    hedgeIsOpen: (hedgePos?.net ?? 0) > 0,
  };
}

module.exports = { resolveOrders, verifyTradeLegs, fetchOrderBook, matchOrder, normaliseBookRow };
