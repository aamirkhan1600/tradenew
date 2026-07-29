const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const { PaperBroker } = require('../src/broker/paperBroker');

const sell = (b, price, qty = 75) => b.placeOrder({
  token: 'T', segment: 'nse_fo', tradingSymbol: 'NIFTYCE', side: 'SELL',
  orderType: 'L', qty, limitPrice: price, product: 'NRML',
});

const buy = (b, price, qty = 75) => b.placeOrder({
  token: 'T', segment: 'nse_fo', tradingSymbol: 'NIFTYCE', side: 'BUY',
  orderType: 'L', qty, limitPrice: price, product: 'NRML',
});

const status = async (b, id) => (await b.fetchBook()).find(r => r.brokerOrderId === id);

test('a SELL limit fills only when a tick prints at or above it', async () => {
  const b = new PaperBroker();
  const { brokerOrderId } = await sell(b, 13.40);

  b.onTick('T', 1330);
  assert.equal((await status(b, brokerOrderId)).status, 'WORKING');

  b.onTick('T', 1340);
  const filled = await status(b, brokerOrderId);
  assert.equal(filled.status, 'FILLED');
  // A limit fills at its own price, never better. Assuming improvement would
  // flatter every backtest by a tick — five percent of a one-point target.
  assert.equal(filled.avgPrice, 13.40);
});

test('a BUY limit fills only when a tick prints at or below it', async () => {
  const b = new PaperBroker();
  const { brokerOrderId } = await buy(b, 12.40);

  b.onTick('T', 1250);
  assert.equal((await status(b, brokerOrderId)).status, 'WORKING');

  b.onTick('T', 1235);
  const filled = await status(b, brokerOrderId);
  assert.equal(filled.status, 'FILLED');
  assert.equal(filled.avgPrice, 12.40);
});

test('a market order fills at the NEXT tick, not the last one seen', async () => {
  const b = new PaperBroker();
  b.onTick('T', 1500);                                  // before the order exists
  const { brokerOrderId } = await b.placeOrder({
    token: 'T', segment: 'nse_fo', tradingSymbol: 'NIFTYCE', side: 'BUY',
    orderType: 'MKT', qty: 75, limitPrice: 0, product: 'NRML',
  });
  assert.equal((await status(b, brokerOrderId)).status, 'WORKING');

  b.onTick('T', 1560);
  const filled = await status(b, brokerOrderId);
  assert.equal(filled.status, 'FILLED');
  assert.equal(filled.avgPrice, 15.60, 'the round trip to the exchange costs the move');
});

test('a filled order cannot be cancelled — the OCO race is reproduced, not smoothed over', async () => {
  const b = new PaperBroker();
  const { brokerOrderId } = await sell(b, 13.40);
  b.onTick('T', 1345);

  const res = await b.cancelOrder({ brokerOrderId });
  assert.equal(res.stat, 'Not_Ok');
  assert.match(res.emsg, /already executed/);
});

test('a working order cancels and then never fills', async () => {
  const b = new PaperBroker();
  const { brokerOrderId } = await sell(b, 13.40);

  assert.equal((await b.cancelOrder({ brokerOrderId })).stat, 'Ok');
  b.onTick('T', 1400);
  assert.equal((await status(b, brokerOrderId)).status, 'CANCELLED');
});

test('a tick on another token leaves the order alone', async () => {
  const b = new PaperBroker();
  const { brokerOrderId } = await sell(b, 13.40);
  b.onTick('OTHER', 9999);
  assert.equal((await status(b, brokerOrderId)).status, 'WORKING');
});

test('a fill emits an event so the engine can react without polling', async () => {
  const b = new PaperBroker();
  const seen = [];
  b.on('fill', e => seen.push(e));
  const { brokerOrderId } = await sell(b, 13.40);
  b.onTick('T', 1350);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].brokerOrderId, brokerOrderId);
  assert.equal(seen[0].avgPaise, 1340);
});

test('the book reports quantities and prices in the shape the reconciler expects', async () => {
  const b = new PaperBroker();
  const { brokerOrderId } = await sell(b, 13.40, 150);
  b.onTick('T', 1400);
  const row = await status(b, brokerOrderId);
  assert.deepEqual(
    { id: row.brokerOrderId, status: row.status, filled: row.filledQty, total: row.totalQty },
    { id: brokerOrderId, status: 'FILLED', filled: 150, total: 150 });
});
