// The charge model decides whether this strategy is viable at all, so it gets
// its own suite. The headline fact under test: a four-leg round trip is
// dominated by flat per-order brokerage, so the breakeven MOVE scales with 1/qty
// and a target chosen without reference to size can be a guaranteed loss.

const test = require('node:test');
const assert = require('node:assert/strict');

const money = require('../src/core/money');

const LOT = 15;   // BANKNIFTY

test('a sell leg pays STT, a buy leg pays stamp duty', () => {
  const sell = money.charges({ side: 'SELL', price: 40, qty: 30 });
  const buy = money.charges({ side: 'BUY', price: 40, qty: 30 });
  assert.ok(sell.stt > 0, 'sell pays STT');
  assert.equal(buy.stt, 0, 'buy pays no STT');
  assert.ok(buy.stampDuty > 0, 'buy pays stamp duty');
  assert.equal(sell.stampDuty, 0, 'sell pays no stamp duty');
});

test('the round trip is four orders, so brokerage alone is 4x the per-order fee', () => {
  const { total, breakdown } = money.roundTripCharges({
    sellPrice: 40, sellExitPrice: 38, hedgePrice: 10, hedgeExitPrice: 10, qty: 2 * LOT,
  });
  assert.equal(breakdown.length, 4);
  assert.deepEqual(breakdown.map(b => b.leg),
    ['hedge_entry', 'short_entry', 'short_exit', 'hedge_exit']);
  const brokerageOnly = breakdown.reduce((a, b) => a + b.brokerage, 0);
  assert.equal(brokerageOnly, 80);
  assert.ok(total > brokerageOnly, 'taxes sit on top of brokerage');
});

test('breakeven in points scales inversely with quantity', () => {
  const one = money.breakevenPoints({ sellPrice: 40, hedgePrice: 10, qty: 1 * LOT });
  const two = money.breakevenPoints({ sellPrice: 40, hedgePrice: 10, qty: 2 * LOT });
  const five = money.breakevenPoints({ sellPrice: 40, hedgePrice: 10, qty: 5 * LOT });

  assert.ok(one.points > two.points && two.points > five.points);
  // Sanity-check the magnitudes an operator would be sizing against.
  assert.ok(one.points > 5.5 && one.points < 7.5, `1 lot breakeven was ${one.points}`);
  assert.ok(two.points > 2.8 && two.points < 3.8, `2 lot breakeven was ${two.points}`);
});

test("the doc's 2-point target on 2 lots is a LOSS even when it wins", () => {
  const pnl = money.tradePnl({
    sellPrice: 40.5, sellExitPrice: 38.5,     // the 2-point target, hit
    hedgePrice: 10, hedgeExitPrice: 10,
    qty: 2 * LOT,
  });
  assert.equal(pnl.gross, 60, 'two points on 30 qty is ₹60 gross');
  assert.ok(pnl.charges > pnl.gross, 'charges exceed the entire gross profit');
  assert.ok(pnl.net < 0, `net should be negative, was ${pnl.net}`);
});

test('coverCharges lifts a too-small target above breakeven', () => {
  const r = money.resolveTargetPoints({
    configuredTarget: 2, sellPrice: 40, hedgePrice: 10, qty: 2 * LOT,
    coverCharges: true, bufferPct: 25,
  });
  assert.equal(r.lifted, true);
  assert.ok(r.points > r.breakeven, 'the lifted target must clear breakeven');
  assert.ok(r.points >= r.floor);
});

test('coverCharges leaves an already-sufficient target alone', () => {
  const r = money.resolveTargetPoints({
    configuredTarget: 12, sellPrice: 40, hedgePrice: 10, qty: 2 * LOT,
    coverCharges: true, bufferPct: 25,
  });
  assert.equal(r.lifted, false);
  assert.equal(r.points, 12);
});

test('coverCharges=false honours the configured target verbatim', () => {
  const r = money.resolveTargetPoints({
    configuredTarget: 2, sellPrice: 40, hedgePrice: 10, qty: 2 * LOT,
    coverCharges: false,
  });
  assert.equal(r.points, 2);
  assert.equal(r.lifted, false);
});

test('the shipped default target actually clears its own breakeven', () => {
  const { defaults } = require('../src/strategy/config');
  const cfg = defaults();
  const qty = cfg.lots * LOT;
  const be = money.breakevenPoints({ sellPrice: cfg.armPrice, hedgePrice: 10, qty });
  assert.ok(cfg.target > be.points,
    `default target ${cfg.target} must exceed the ${be.points} pt breakeven at ${cfg.lots} lots`);

  const pnl = money.tradePnl({
    sellPrice: cfg.armPrice, sellExitPrice: cfg.armPrice - cfg.target,
    hedgePrice: 10, hedgeExitPrice: 10, qty,
  });
  assert.ok(pnl.net > 0, `a default-config win must be net positive, was ${pnl.net}`);
});

test('P&L nets the short and the hedge together', () => {
  // Short loses 5 points, hedge gains 2 — the hedge is doing its job.
  const pnl = money.tradePnl({
    sellPrice: 40, sellExitPrice: 45, hedgePrice: 10, hedgeExitPrice: 12, qty: 30,
  });
  assert.equal(pnl.shortGross, -150);
  assert.equal(pnl.hedgeGross, 60);
  assert.equal(pnl.gross, -90);
  assert.ok(pnl.net < pnl.gross, 'charges make a loss worse');
});

test('an unwound lone hedge is costed on two legs, not four', () => {
  const r = money.hedgeOnlyPnl({ hedgePrice: 10, hedgeExitPrice: 9.5, qty: 30 });
  assert.equal(r.gross, -15);
  assert.ok(r.charges > 35 && r.charges < 55, `two legs of charges, was ${r.charges}`);
});

test('prices snap to the exchange tick', () => {
  assert.equal(money.roundToTick(40.53), 40.55);
  assert.equal(money.roundToTick(40.51), 40.5);
  assert.equal(money.roundToTick(0.07), 0.05);
});
