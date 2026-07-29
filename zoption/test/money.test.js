const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const money = require('../src/core/money');

test('rupees convert to paise as integers', () => {
  assert.equal(money.toPaise(12.4), 1240);
  assert.equal(money.toPaise(13.4), 1340);
  assert.equal(money.toPaise(0.05), 5);
  // The classic float trap: 0.1 + 0.2 !== 0.3 in binary. Paise avoid it.
  assert.equal(money.toPaise(0.1) + money.toPaise(0.2), money.toPaise(0.3));
});

test('the worked example from the documents: 12.40 + 1.00 = 13.40', () => {
  const closeP = money.toPaise(12.40);
  const offsetP = money.toPaise(1.00);
  assert.equal(closeP + offsetP, money.toPaise(13.40));
  assert.equal(money.formatPrice(closeP + offsetP), '13.40');
});

test('the PE example: 11.80 + 1.00 = 12.80', () => {
  assert.equal(money.toPaise(11.80) + money.toPaise(1.00), money.toPaise(12.80));
});

test('roundToTickPaise snaps to the 5-paise NSE option tick', () => {
  assert.equal(money.roundToTickPaise(1243), 1245);
  assert.equal(money.roundToTickPaise(1242), 1240);
  assert.equal(money.roundToTickPaise(1240), 1240);
  // An off-tick limit is rejected by the exchange, so this must never round to
  // something un-tradable — including at the floor.
  assert.equal(money.roundToTickPaise(1), 5);
  assert.equal(money.roundToTickPaise(0), 5);
});

test('a rounded price is always a whole number of ticks', () => {
  for (let p = 1; p < 5000; p += 7) {
    assert.equal(money.roundToTickPaise(p) % 5, 0, `${p} did not land on a tick`);
  }
});

test('STT is charged on the sell leg and stamp duty on the buy leg', () => {
  const qty = 75;
  const sell = money.charges({ side: 'SELL', pricePaise: 1340, qty });
  const buy = money.charges({ side: 'BUY', pricePaise: 1240, qty });
  assert.ok(sell.stt > 0, 'a sell pays STT');
  assert.equal(buy.stt, 0, 'a buy does not');
  assert.ok(buy.stampDuty > 0, 'a buy pays stamp duty');
  assert.equal(sell.stampDuty, 0, 'a sell does not');
});

test('brokerage is flat, so breakeven in points scales as 1/quantity', () => {
  // This is the fact that decides whether a one-point target is viable at all.
  const one = money.breakevenPaise({ entryPaise: 1340, qty: 75, assumeTargetPaise: 100 });
  const four = money.breakevenPaise({ entryPaise: 1340, qty: 300, assumeTargetPaise: 100 });
  assert.ok(one.pointsPaise > four.pointsPaise);
  // Four times the size should be roughly a quarter of the per-point cost.
  assert.ok(four.pointsPaise < one.pointsPaise * 0.45,
    `expected roughly a quarter, got ${four.pointsPaise} vs ${one.pointsPaise}`);
});

test('on a per-order brokerage plan, a one-point target on one lot is mostly charges', () => {
  // The headline risk in doc/PROJECT_PLAN.md §10, asserted rather than asserted
  // about. Charges are pinned in helpers.js, so this measures the model.
  const be = money.breakevenPaise({ entryPaise: 1340, qty: 75, assumeTargetPaise: 100 });
  assert.ok(be.pointsPaise > 25,
    `breakeven of ${be.pointsPaise}p should be a large share of a 100p target`);
});

test('on a zero-brokerage plan the flat fee vanishes and breakeven collapses', () => {
  // Worth its own test because it changes the strategy's viability, not just a
  // number: with no per-order fee the cost is purely proportional to turnover,
  // so breakeven stops scaling with size and a one-point target has real room.
  // This is the configuration in the operator's .env.
  const zero = {
    brokeragePerOrder: 0,
    sttSellPct: 0.001, exchTxnPct: 0.0003503, sebiPct: 0.000001,
    gstPct: 0.18, stampBuyPct: 0.00003,
  };
  const charges = ({ side, pricePaise, qty }) => {
    const turnover = pricePaise * qty;
    const isBuy = side === 'BUY';
    const stt = isBuy ? 0 : Math.round(turnover * zero.sttSellPct);
    const exch = Math.round(turnover * zero.exchTxnPct);
    const sebi = Math.round(turnover * zero.sebiPct);
    const gst = Math.round((zero.brokeragePerOrder + exch + sebi) * zero.gstPct);
    const stamp = isBuy ? Math.round(turnover * zero.stampBuyPct) : 0;
    return stt + exch + sebi + gst + stamp;
  };

  const perPoint = (qty) => {
    const total = charges({ side: 'SELL', pricePaise: 1340, qty })
      + charges({ side: 'BUY', pricePaise: 1240, qty });
    return total / qty;
  };

  // Roughly flat across size, unlike the per-order plan.
  assert.ok(Math.abs(perPoint(75) - perPoint(300)) < 1,
    'without a flat fee, breakeven per unit should barely move with size');
  // And small enough that a 100-paise target clears it comfortably.
  assert.ok(perPoint(75) < 25, `expected well under a quarter of the target, got ${perPoint(75)}p`);
});

test('a short profits when the premium falls, and net is below gross', () => {
  const pnl = money.shortPnl({ entryPaise: 1340, exitPaise: 1240, qty: 75 });
  assert.equal(pnl.grossPaise, 100 * 75);
  assert.ok(pnl.chargesPaise > 0);
  assert.equal(pnl.netPaise, pnl.grossPaise - pnl.chargesPaise);
  assert.ok(pnl.netPaise < pnl.grossPaise);
});

test('a short loses when the premium rises', () => {
  const pnl = money.shortPnl({ entryPaise: 1340, exitPaise: 1540, qty: 75 });
  assert.equal(pnl.grossPaise, -200 * 75);
  assert.ok(pnl.netPaise < pnl.grossPaise, 'charges make a loss worse, not better');
});

test('openPnl mirrors a closed round trip before charges', () => {
  assert.equal(money.openPnl({ entryPaise: 1340, ltpPaise: 1240, qty: 75 }), 7500);
  assert.equal(money.openPnl({ entryPaise: 1340, ltpPaise: 1440, qty: 75 }), -7500);
});

test('formatting is Indian and signed', () => {
  assert.equal(money.formatInr(500000), '₹5,000');
  assert.equal(money.formatInr(-300000), '-₹3,000');
  assert.equal(money.formatInr(null), '—');
  assert.equal(money.formatPrice(1240), '12.40');
});
