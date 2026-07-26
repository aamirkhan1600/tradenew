// Charges, rounding and the breakeven arithmetic the strategy depends on.
//
// This module exists mainly because of one fact that decides whether the whole
// strategy is viable: a hedged round trip is FOUR orders (hedge buy, short
// sell, short buy-back, hedge sell), and brokerage is a FLAT fee per order.
// The cost is therefore dominated by a constant, so the breakeven MOVE in
// premium points scales as roughly 1/quantity:
//
//     BANKNIFTY, 1 lot  (15 qty) -> ~6.3 points just to break even
//     BANKNIFTY, 2 lots (30 qty) -> ~3.2 points
//     BANKNIFTY, 5 lots (75 qty) -> ~1.3 points
//
// A target chosen without reference to size books "wins" that are realised
// losses. Nothing here is a display nicety — `breakevenPoints` gates the
// strategy's target.

const config = require('../config');

const R = config.charges;

function round(v, digits = 2) {
  const m = 10 ** digits;
  return Math.round((Number(v) + Number.EPSILON) * m) / m;
}

// Snap a price to the instrument's tick (NSE options: ₹0.05). Sending an
// off-tick limit price is rejected by the exchange.
function roundToTick(price, tick = 0.05) {
  const t = Number(tick) > 0 ? Number(tick) : 0.05;
  return round(Math.round(Number(price) / t) * t, 2);
}

// Charges for ONE option order. `qty` is total units (lots x lotSize).
function charges({ side, price, qty }) {
  const premium = Math.max(0, Number(price) || 0);
  const q = Math.max(0, Math.trunc(Number(qty) || 0));
  const turnover = premium * q;
  const isBuy = String(side).toUpperCase() === 'BUY';

  const brokerage = R.brokeragePerOrder;
  const stt = isBuy ? 0 : turnover * R.sttSellPct;          // sell side only
  const exchTxn = turnover * R.exchTxnPct;
  const sebi = turnover * R.sebiPct;
  const gst = (brokerage + exchTxn + sebi) * R.gstPct;
  const stamp = isBuy ? turnover * R.stampBuyPct : 0;       // buy side only

  return {
    turnover: round(turnover),
    brokerage: round(brokerage),
    stt: round(stt),
    exchangeTxn: round(exchTxn),
    sebi: round(sebi, 4),
    gst: round(gst),
    stampDuty: round(stamp),
    total: round(brokerage + stt + exchTxn + sebi + gst + stamp),
  };
}

// Total charges for the complete four-leg structure.
function roundTripCharges({ sellPrice, sellExitPrice, hedgePrice, hedgeExitPrice, qty }) {
  const legs = [
    { side: 'BUY', price: hedgePrice, qty, leg: 'hedge_entry' },
    { side: 'SELL', price: sellPrice, qty, leg: 'short_entry' },
    { side: 'BUY', price: sellExitPrice, qty, leg: 'short_exit' },
    { side: 'SELL', price: hedgeExitPrice, qty, leg: 'hedge_exit' },
  ];
  const breakdown = legs.map(l => ({ leg: l.leg, ...charges(l) }));
  return {
    total: round(breakdown.reduce((a, b) => a + b.total, 0)),
    breakdown,
  };
}

// How far the short premium must fall for the trade to break even, in points.
// The buy-back leg is priced at `assumeTargetPoints` below entry; charges move
// by only a few paise across a few points of premium, so a single pass is
// accurate to well under the tick size.
function breakevenPoints({ sellPrice, hedgePrice, qty, assumeTargetPoints = 0 }) {
  const q = Math.max(1, Math.trunc(Number(qty) || 1));
  const { total } = roundTripCharges({
    sellPrice,
    sellExitPrice: Math.max(0, Number(sellPrice) - Number(assumeTargetPoints || 0)),
    hedgePrice,
    hedgeExitPrice: hedgePrice,
    qty: q,
  });
  return { charges: total, points: round(total / q), qty: q };
}

// The target the strategy will actually use: never below what the round trip
// costs, plus a buffer, unless the operator has explicitly opted out.
function resolveTargetPoints({ configuredTarget, sellPrice, hedgePrice, qty, coverCharges = true, bufferPct = 25 }) {
  const be = breakevenPoints({ sellPrice, hedgePrice, qty, assumeTargetPoints: configuredTarget });
  if (!coverCharges) {
    return {
      points: round(configuredTarget), breakeven: be.points, charges: be.charges,
      floor: null, lifted: false,
    };
  }
  const floor = round(be.points * (1 + (Number(bufferPct) || 0) / 100));
  const points = Math.max(round(configuredTarget), floor);
  return { points, breakeven: be.points, charges: be.charges, floor, lifted: points > round(configuredTarget) };
}

// Realised P&L of the closed structure. The short profits when premium falls;
// the long hedge profits when it rises.
function tradePnl({ sellPrice, sellExitPrice, hedgePrice, hedgeExitPrice, qty }) {
  const q = Math.max(0, Math.trunc(Number(qty) || 0));
  const shortGross = round((Number(sellPrice) - Number(sellExitPrice)) * q);
  const hedgeGross = round((Number(hedgeExitPrice) - Number(hedgePrice)) * q);
  const gross = round(shortGross + hedgeGross);
  const { total: chargeTotal, breakdown } = roundTripCharges({
    sellPrice, sellExitPrice, hedgePrice, hedgeExitPrice, qty: q,
  });
  return {
    shortGross, hedgeGross, gross,
    charges: chargeTotal, chargeBreakdown: breakdown,
    net: round(gross - chargeTotal),
  };
}

// P&L of a hedge that was opened but never paired with a short (the arm price
// never arrived, or the short was rejected).
function hedgeOnlyPnl({ hedgePrice, hedgeExitPrice, qty }) {
  const q = Math.max(0, Math.trunc(Number(qty) || 0));
  const gross = round((Number(hedgeExitPrice) - Number(hedgePrice)) * q);
  const total = round(
    charges({ side: 'BUY', price: hedgePrice, qty: q }).total
    + charges({ side: 'SELL', price: hedgeExitPrice, qty: q }).total,
  );
  return { gross, charges: total, net: round(gross - total) };
}

function formatInr(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return (n < 0 ? '-₹' : '₹') + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

module.exports = {
  round, roundToTick, charges, roundTripCharges,
  breakevenPoints, resolveTargetPoints, tradePnl, hedgeOnlyPnl, formatInr,
};
