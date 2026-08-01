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

// Directed tick snapping — newdoc/update.md §2.
//
// The Option Selling Engine prices a SELL limit at `floorToTick(close + offset)`
// and will not use round-to-nearest for it. The reason is one-directional: a
// round-half-up on a sell limit can place the order ABOVE the level the strategy
// derived, which lowers the fill probability past what the specification
// describes — the engine would be quoting a trade nobody asked for. Flooring can
// only ever quote at or below the derived level, which is the conservative
// direction for a seller.
//
// `ceilToTickPaise` is its mirror and exists so a future buy-side limit has the
// same guarantee without anyone re-deriving the arithmetic.
//
// Both clamp to one tick: a price below the minimum increment is not a price the
// exchange will accept.
function floorToTickPaise(pricePaise, tickPaise = 5) {
  const t = Math.max(1, Math.round(Number(tickPaise) || 5));
  const p = Math.round(Number(pricePaise) || 0);
  return Math.max(t, Math.floor(p / t) * t);
}

function ceilToTickPaise(pricePaise, tickPaise = 5) {
  const t = Math.max(1, Math.round(Number(tickPaise) || 5));
  const p = Math.round(Number(pricePaise) || 0);
  return Math.max(t, Math.ceil(p / t) * t);
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

// The number that decides whether this strategy can work at all.
//
// Charges are per ROUND TRIP and dominated by a flat brokerage, so they are paid
// in full on a winner and on a loser alike. That asymmetry is brutal when the
// target is small and the stop is not: a one-point target against a two-point
// stop on one lot nets about +26 on a win and -199 on a loss, which needs to be
// right almost nine times in ten merely to stand still.
//
// `breakevenPaise` answers "do charges eat the target". This answers the
// question an operator actually needs answered, which is a different one:
//
//     p · netWin + (1 - p) · netLoss = 0   ->   p = -netLoss / (netWin - netLoss)
//
// Returns null when a win is not profitable at all — no hit rate saves it.
function requiredWinRate({ entryPaise, qty, targetPaise, stopPaise }) {
  const q = Math.max(1, Math.trunc(Number(qty) || 1));
  const win = shortPnl({ entryPaise, exitPaise: entryPaise - Math.round(targetPaise), qty: q });
  const loss = shortPnl({ entryPaise, exitPaise: entryPaise + Math.round(stopPaise), qty: q });

  if (win.netPaise <= 0) {
    return { rate: null, winP: win.netPaise, lossP: loss.netPaise, chargesP: win.chargesPaise };
  }
  return {
    rate: -loss.netPaise / (win.netPaise - loss.netPaise),
    winP: win.netPaise,
    lossP: loss.netPaise,
    chargesP: win.chargesPaise,
  };
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
  toPaise, toRupees, roundToTickPaise, floorToTickPaise, ceilToTickPaise,
  charges, roundTripCharges, breakevenPaise, requiredWinRate,
  shortPnl, openPnl,
  formatInr, formatPrice,
};
