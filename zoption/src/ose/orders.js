// §12 — the Order Management Module.
//
// The engine decides; this sends. Everything dangerous about this strategy is
// concentrated in the four functions below, so they are kept apart from the
// decision cycle where they can be read on their own.
//
// ---------------------------------------------------------------------------
// The asymmetry, stated once
// ---------------------------------------------------------------------------
//
//   ENTRY  is a LIMIT at floorToTick(sealed option close + offset). An entry
//          that does not fill costs nothing — the cycle simply produced no
//          trade. §12.4 cancels it after 3 seconds and enters the cooldown
//          WITHOUT counting it against maxTradesPerDay, because no position ever
//          existed.
//
//   EXIT   is a MARKET order, always. §12.5 is explicit that this is deliberate:
//          "a limit exit can go unfilled, which breaks the guarantee that a
//          stop-loss actually stops loss". An unhedged unclosable short is the
//          highest-severity incident this system can produce, so the exit trades
//          price certainty for fill certainty every single time.
//
// ---------------------------------------------------------------------------
// Idempotency, and the one rule that costs money to get wrong
// ---------------------------------------------------------------------------
//
// Kotak's place-order carries no client order id, so a retry after a network
// error is indistinguishable from a new order. Three mechanisms stand between
// that and a duplicate naked short, and none of them is optional:
//
//   1. `orders.client_ref` is UNIQUE and derived from the trade id — `OS-<uid>-
//      <CE|PE>-<attempt>-<stage>[-R<n>]`. The same logical order can only be
//      inserted once. (§12.3's `clientOrderId = tradeId`, and `-X` for the exit,
//      expressed in this platform's existing key format.)
//   2. `claimForPlacement` atomically moves that row PENDING -> PLACING. Only
//      the first caller wins.
//   3. Before resending ANYTHING the caller asks the DATABASE what is live
//      (`ordersLive`), never the in-memory trade. A resend of a market buy that
//      is already working buys the short back twice and leaves the account naked
//      LONG — the worst outcome this system can produce.
//
// §12.3's recovery protocol (wait, query the book, adopt, retry once, halt) is
// implemented by `recoverAmbiguous` and is the ONLY retry path for a placement.
// There is no exponential backoff on an order: §20.4 exempts placement from its
// own retry policy for exactly this reason.

const logger = require('../core/logger');
const money = require('../core/money');
const repo = require('../repositories');
const C = require('./constants');
const exits = require('./exits');

const PREFIX = 'os';

// §12.2. `MIS` is intraday — §1.2 puts overnight carry out of scope, and a
// product code that permits it would let a failed square-off become a
// positional trade nobody chose.
const PRODUCT = 'MIS';

class OrderManager {
  constructor({ router, broker, onEvent = null }) {
    this.router = router;
    this.broker = broker;
    this.onEvent = onEvent;
  }

  /* ------------------------------------------------------------- the entry -- */

  // §12.2 — a SELL LIMIT for the whole position.
  //
  // `priceP` has already been through ladder.entryPrice(), which is the only
  // function permitted to derive it and which cannot see a live quote. Nothing
  // here recomputes it.
  async placeEntry(trade, priceP) {
    const order = await this.router.place({
      prefix: PREFIX,
      oseTradeId: trade.dbId,
      scopeId: trade.dbId,
      optionType: trade.optionType,
      attemptSeq: 1,
      stage: 'ENTRY',
      token: trade.token,
      segment: trade.segment,
      symbol: trade.symbol,
      side: 'SELL',
      orderType: 'L',
      qty: trade.qty,
      limitPriceP: priceP,
      product: PRODUCT,
      tickP: trade.tickP,
    }).catch(async (err) => {
      // A PRE-SEND failure — the rate limiter refused and nothing left the
      // process. §20.2 classes it transient and the row is already back at
      // PENDING, so the honest answer is "no order", not "an unknown order".
      logger.warn('ose: the entry was refused before it was sent', { err: err.message });
      return null;
    });

    if (!order) return { placed: false, order: null, reason: 'rate limited before send' };

    if (order.status === 'WORKING') return { placed: true, order, reason: null };
    if (order.status === 'UNKNOWN') {
      // §12.3 — the order MAY be live. It is never resent from here; the caller
      // runs the recovery protocol.
      return { placed: false, order, ambiguous: true, reason: order.reason };
    }
    return { placed: false, order, reason: order.reason || order.status };
  }

  // §12.4 — the entry did not fill inside ENTRY_FILL_TIMEOUT_MS.
  //
  // Returns what actually happened, because the three outcomes need three
  // different responses from the caller and guessing between them is how a
  // partial fill becomes an untracked position:
  //
  //   NO_FILL      cancelled cleanly, nothing was ever open -> COOLDOWN, and it
  //                does NOT count against maxTradesPerDay
  //   PARTIAL      the remainder is cancelled and the position is the filled
  //                quantity -> POSITION_OPEN at that size
  //   FILLED       the cancel lost the race. A filled short, not an error.
  //   CANCEL_FAILED §12.4 -> HALT(CANCEL_FAILED) and attempt a market exit of
  //                whatever filled
  async cancelUnfilledEntry(trade) {
    if (!trade.entryOrderId) return { outcome: 'NO_FILL', filledQty: 0 };

    const before = await repo.orders.byId(trade.entryOrderId);
    if (before && before.status === 'FILLED') {
      return {
        outcome: 'FILLED',
        filledQty: before.filled_qty,
        filledPriceP: before.filled_price_p,
      };
    }

    const res = await this.router.cancel(trade.entryOrderId,
      `unfilled after ${C.ENTRY_FILL_TIMEOUT_MS}ms`);

    if (res.outcome === 'ALREADY_FILLED') {
      const row = await repo.orders.byId(trade.entryOrderId);
      return {
        outcome: 'FILLED',
        filledQty: row?.filled_qty || trade.qty,
        filledPriceP: row?.filled_price_p ?? null,
      };
    }

    if (res.outcome === 'FAILED') {
      return { outcome: 'CANCEL_FAILED', filledQty: before?.filled_qty || 0, reason: res.reason };
    }

    const after = await repo.orders.byId(trade.entryOrderId);
    const filledQty = after?.filled_qty || 0;
    if (filledQty > 0) {
      return { outcome: 'PARTIAL', filledQty, filledPriceP: after.filled_price_p };
    }
    return { outcome: 'NO_FILL', filledQty: 0 };
  }

  /* -------------------------------------------------------------- the exit -- */

  // §12.5 — a MARKET buy-back of the whole filled quantity.
  //
  // `attempt` is 1-based and becomes the client_ref revision, so a RETRY of the
  // same exit gets a genuinely new key rather than colliding with the order that
  // failed. That is the opposite of the entry's rule and it is correct for the
  // same reason the entry's is: a failed entry must not be duplicated, and a
  // failed exit must not be abandoned.
  //
  // Before sending, the caller MUST have established that no exit order for this
  // trade is live — see `ordersLive`.
  async placeExit(trade, reason, attempt = 1) {
    const order = await this.router.place({
      prefix: PREFIX,
      oseTradeId: trade.dbId,
      scopeId: trade.dbId,
      optionType: trade.optionType,
      attemptSeq: 1,
      stage: exits.stageFor(reason),
      revision: Math.max(0, Math.trunc(attempt) - 1),
      token: trade.token,
      segment: trade.segment,
      symbol: trade.symbol,
      side: 'BUY',
      orderType: 'MKT',
      qty: trade.filledQty || trade.qty,
      limitPriceP: 0,
      product: PRODUCT,
      tickP: trade.tickP,
    }).catch((err) => {
      logger.error('ose: THE EXIT ORDER FAILED TO SEND — the position is still open',
        { reason, attempt, err: err.message });
      return null;
    });

    if (!order) return { placed: false, order: null };
    if (order.status === 'WORKING' || order.status === 'FILLED') {
      return { placed: true, order };
    }
    // UNKNOWN on an exit is not the same problem as UNKNOWN on an entry. The
    // order may be live, so it is not resent blindly — but a short that may or
    // may not have been bought back cannot be left alone either, and the caller
    // resolves it through the order book on the next reconciler pass.
    return { placed: false, order, ambiguous: order.status === 'UNKNOWN' };
  }

  /* ------------------------------------------------- §12.3, the recovery -- */

  // "On any ambiguous failure the Order Manager MUST NOT blindly retry."
  //
  //   1. wait ORDER_SETTLE_MS
  //   2. query the broker order book filtered by clientOrderId
  //   3. found      -> adopt that order's state
  //   4. not found  -> retry ONCE with the same clientOrderId
  //   5. still ambiguous -> HALT(ORDER_AMBIGUOUS)
  //
  // Step 2 is done against the trading SYMBOL rather than a client order id
  // because Kotak does not carry one. The shared reconciler already implements
  // exactly that match — symbol, side and quantity, and it refuses to guess when
  // more than one row fits — so this defers to it rather than writing a second,
  // subtly different matcher.
  //
  // Returns `{ resolved, status, halt }`. `halt` true is step 5.
  async recoverAmbiguous(orderId, reconciler) {
    await sleep(C.ORDER_SETTLE_MS);

    await reconciler.runOnce();
    let row = await repo.orders.byId(orderId);
    if (!row) return { resolved: false, status: null, halt: true };

    if (row.status !== 'UNKNOWN') {
      logger.info('ose: an ambiguous order resolved through the book', {
        ref: row.client_ref, status: row.status,
      });
      return { resolved: true, status: row.status, halt: false };
    }

    // Not found. One more pass before giving up — a book can lag by a poll.
    await sleep(C.ORDER_SETTLE_MS);
    await reconciler.runOnce();
    row = await repo.orders.byId(orderId);

    if (row && row.status !== 'UNKNOWN') {
      return { resolved: true, status: row.status, halt: false };
    }

    logger.error('ose: ORDER_AMBIGUOUS — the broker book cannot account for this order after '
      + 'two passes. Halting rather than guessing.', { orderId, ref: row?.client_ref });
    return { resolved: false, status: 'UNKNOWN', halt: true };
  }

  // What is live at the broker for this trade, according to the DATABASE.
  //
  // Every resend in this engine goes through here first. The in-memory trade is
  // not evidence: it is exactly the thing that was wrong when the process died.
  async ordersLive(tradeDbId, stage = null) {
    return repo.orders.workingForOseTrade(tradeDbId, stage);
  }

  /* --------------------------------------------------- §20.6, the dangling -- */

  // Step 5 of the startup reconciliation — "Cancel any dangling open orders
  // tagged by this engine."
  //
  // Scoped by the `OS-` client_ref prefix, so an order belonging to the scalper
  // or the Price-Filter Engine can never be cancelled by this engine's boot.
  async cancelDangling() {
    const rows = await repo.orders.danglingForPrefix(PREFIX);
    const cancelled = [];
    for (const order of rows) {
      const res = await this.router.cancel(order.id, 'dangling at startup reconciliation');
      cancelled.push({ ref: order.client_ref, stage: order.stage, outcome: res.outcome });
    }
    if (cancelled.length) {
      logger.warn('ose: cancelled orders left behind by a previous run', { orders: cancelled });
    }
    return cancelled;
  }

  /* ------------------------------------------------------------ §20.3, slippage */

  // "If |fill − request| > 2 points -> log SEVERE_SLIPPAGE, continue with the
  // actual fill, alert."
  //
  // Continue, not abort: the position exists at the price it exists at, and
  // every target and stop is derived from the FILL (§12.4). Refusing to accept a
  // fill the exchange has already given us would leave an untracked short, which
  // is the one thing worse than a bad price.
  checkSlippage(trade) {
    if (trade.entryPriceP == null || trade.requestedPriceP == null) return null;
    const diffP = Math.abs(trade.entryPriceP - trade.requestedPriceP);
    if (diffP <= C.SEVERE_SLIPPAGE_POINTS * C.POINT) return null;

    const detail = {
      requested: money.formatPrice(trade.requestedPriceP),
      filled: money.formatPrice(trade.entryPriceP),
      slippage: money.formatPrice(diffP),
      symbol: trade.symbol,
    };
    logger.error('ose: SEVERE_SLIPPAGE — the fill is more than '
      + `${C.SEVERE_SLIPPAGE_POINTS} points from the requested price`, detail);
    return detail;
  }
}

const sleep = (ms) => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });

module.exports = { OrderManager, PREFIX, PRODUCT };
