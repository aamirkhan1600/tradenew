// Prices are integers in paise, everywhere. 12.40 is 1240.
//
// A float premium multiplied by a lot size and compared against a rupee limit is
// exactly where P&L silently drifts, and this strategy is unusually exposed to
// it: the target is one rupee of premium, which is twenty ticks. Rupees exist in
// this codebase in two places only — the edge where an operator types a number,
// and the edge where one is displayed.
//
// The second thing this module carries is the charge model, and it is not a
// display nicety. Brokerage is a FLAT fee per order, so the cost of a round trip
// is dominated by a constant and the breakeven MOVE in premium points scales as
// roughly 1/quantity:
//
//     NIFTY, 1 lot  (75 qty) -> ~0.75 points to break even on a round trip
//     NIFTY, 2 lots (150 qty) -> ~0.40 points
//
// Against a configured target of 1.00 point that is most of the edge. Gross P&L
// on this strategy is misleading by roughly the size of the target itself, so
// `positions.net_pnl_p` is the number the risk manager reads and the dashboard
// shows.

const config = require('../config');

const R = config.charges;

/* ---------------------------------------------------------- conversions -- */

// Rupees in, paise out. Rounds — a price that cannot be expressed in paise is
// not a price.
function toPaise(rupees) {
  const n = Number(rupees);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function toRupees(paise) {
  const n = Number(paise);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

// Snap to the instrument's tick. NSE options trade in 5-paise steps and an
// off-tick limit price is rejected outright by the exchange, so this is the one
// function allowed to move a price the strategy computed.
//
// This is the ONLY rounding boundary between a computed price and an order.
function roundToTickPaise(pricePaise, tickPaise = 5) {
  const t = Math.max(1, Math.round(Number(tickPaise) || 5));
  const p = Math.round(Number(pricePaise) || 0);
  return Math.max(t, Math.round(p / t) * t);
}

/* -------------------------------------------------------------- charges -- */

// Charges for ONE option order, in paise. `qty` is total units (lots x lotSize).
function charges({ side, pricePaise, qty }) {
  const premium = Math.max(0, Math.round(Number(pricePaise) || 0));
  const q = Math.max(0, Math.trunc(Number(qty) || 0));
  const turnover = premium * q;                       // paise
  const isBuy = String(side).toUpperCase() === 'BUY';

  const brokerage = Math.round(R.brokeragePerOrder * 100);
  const stt = isBuy ? 0 : Math.round(turnover * R.sttSellPct);        // sell side only
  const exchTxn = Math.round(turnover * R.exchTxnPct);
  const sebi = Math.round(turnover * R.sebiPct);
  const gst = Math.round((brokerage + exchTxn + sebi) * R.gstPct);
  const stamp = isBuy ? Math.round(turnover * R.stampBuyPct) : 0;     // buy side only

  return {
    turnover,
    brokerage,
    stt,
    exchangeTxn: exchTxn,
    sebi,
    gst,
    stampDuty: stamp,
    total: brokerage + stt + exchTxn + sebi + gst + stamp,
  };
}

// The two orders of one round trip: the short and its buy-back.
function roundTripCharges({ entryPaise, exitPaise, qty }) {
  const sell = charges({ side: 'SELL', pricePaise: entryPaise, qty });
  const buy = charges({ side: 'BUY', pricePaise: exitPaise, qty });
  return {
    total: sell.total + buy.total,
    breakdown: [{ leg: 'entry', ...sell }, { leg: 'exit', ...buy }],
  };
}

// How far the premium must fall for one round trip to break even, in paise of
// premium. The buy-back is priced at `assumeTargetPaise` below entry; charges
// move by only a few paise across a couple of points of premium, so a single
// pass is accurate to well under the tick size.
function breakevenPaise({ entryPaise, qty, assumeTargetPaise = 0 }) {
  const q = Math.max(1, Math.trunc(Number(qty) || 1));
  const { total } = roundTripCharges({
    entryPaise,
    exitPaise: Math.max(0, Math.round(entryPaise) - Math.round(assumeTargetPaise || 0)),
    qty: q,
  });
  return { chargesPaise: total, pointsPaise: Math.ceil(total / q), qty: q };
}

/* ------------------------------------------------------------------ P&L -- */

// Realised P&L of one short round trip, in paise. A short profits when the
// premium falls.
function shortPnl({ entryPaise, exitPaise, qty }) {
  const q = Math.max(0, Math.trunc(Number(qty) || 0));
  const gross = (Math.round(entryPaise) - Math.round(exitPaise)) * q;
  const { total, breakdown } = roundTripCharges({ entryPaise, exitPaise, qty: q });
  return { grossPaise: gross, chargesPaise: total, netPaise: gross - total, breakdown };
}

// Unrealised P&L of an open short at the current premium.
function openPnl({ entryPaise, ltpPaise, qty }) {
  const q = Math.max(0, Math.trunc(Number(qty) || 0));
  return (Math.round(entryPaise) - Math.round(ltpPaise)) * q;
}

/* ------------------------------------------------------------ formatting - */

function formatInr(paise) {
  if (paise == null || !Number.isFinite(Number(paise))) return '—';
  const rupees = toRupees(paise);
  return (rupees < 0 ? '-₹' : '₹')
    + Math.abs(rupees).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function formatPrice(paise) {
  if (paise == null || !Number.isFinite(Number(paise))) return '—';
  return toRupees(paise).toFixed(2);
}

module.exports = {
  toPaise, toRupees, roundToTickPaise,
  charges, roundTripCharges, breakevenPaise,
  shortPnl, openPnl,
  formatInr, formatPrice,
};
