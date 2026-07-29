// One interface, two implementations. Everything above this line places orders
// without knowing whether they reach an exchange:
//
//   placeOrder(order)            -> { brokerOrderId }
//   cancelOrder({brokerOrderId}) -> broker response
//   fetchBook()                  -> normalised rows
//
// The point of the shared shape is that PAPER and LIVE exercise the SAME
// orderRouter, the same reconciler and the same OCO path. A paper mode that
// took a shortcut around the order layer would validate the strategy while
// leaving the dangerous code untested.

const logger = require('../core/logger');
const neo = require('./neoClient');
const session = require('./neoSession');
const { PaperBroker } = require('./paperBroker');

const paper = new PaperBroker();

const liveAdapter = {
  mode: 'LIVE',
  placeOrder: (order) => session.placeOrder(order),
  cancelOrder: (args) => session.cancelOrder(args),
  fetchBook: async () => neo.readOrderBook(await session.orderBook()),
  status: () => ({ mode: 'LIVE', ...session.status() }),
};

const paperAdapter = {
  mode: 'PAPER',
  placeOrder: (order) => paper.placeOrder(order),
  cancelOrder: (args) => paper.cancelOrder(args),
  fetchBook: () => paper.fetchBook(),
  status: () => paper.status(),
};

// `mode` comes from settings, so it can be flipped without a restart — but only
// between cycles: the engine reads settings at cycle start, never mid-cycle.
function adapterFor(mode) {
  const m = String(mode || 'PAPER').toUpperCase();
  if (m === 'LIVE') return liveAdapter;
  if (m !== 'PAPER') {
    logger.warn('broker: unknown mode, falling back to PAPER', { mode });
  }
  return paperAdapter;
}

module.exports = { adapterFor, paper, session, liveAdapter, paperAdapter };
