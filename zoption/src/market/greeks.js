// Black-Scholes greeks and implied volatility, computed here because the broker
// does not send them.
//
// This is the honest version of the specification's "IV / Delta / Gamma / Theta
// / Vega / Rho" columns. Kotak's Trade API quote endpoint on this account class
// returns a last traded price and, depending on entitlement, a little OHLC and
// depth. It does not return greeks and it does not return an implied vol. So
// every greek in this terminal is MODELLED FROM THE LTP, and three consequences
// follow that a trader must know before acting on the numbers:
//
//   1. Garbage in, garbage out. IV is solved from the last trade. On an illiquid
//      far strike whose last trade was twenty minutes ago, the IV — and every
//      greek derived from it — describes twenty minutes ago.
//
//   2. European, no dividends, continuous rate. That is right for NIFTY index
//      options (they are European and cash-settled) and would be wrong for a
//      stock option. This platform only trades index options.
//
//   3. An IV can be solvable and still be meaningless. A price the model cannot
//      reach at ANY volatility between 0.5% and 500% — below intrinsic, or
//      above the 500%-vol price — returns null rather than the edge of the
//      search range, because a boundary value printed in a table gets read as a
//      measurement. But a tick-floor quote on a far strike often DOES solve,
//      at something like 300%, and that number is arithmetically correct and
//      practically noise. It is why "highest IV" in the chain reliably points at
//      the least liquid strike on the board, and why that highlight is a
//      pointer to look rather than a signal to act.
//
// Time is measured to 15:30 IST on the expiry date, on a 365-day calendar basis.
// Calendar rather than trading days because theta is quoted per calendar day and
// a weekend genuinely decays an option.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

// NSE index options stop trading at 15:30 IST on expiry day.
const EXPIRY_HOUR_IST = 15.5;

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/* --------------------------------------------------------------- normals -- */

const pdf = (x) => Math.exp(-0.5 * x * x) / SQRT_2PI;

// Abramowitz & Stegun 7.1.26 on erf, good to ~1.5e-7 — three orders of magnitude
// finer than any greek here is meaningful to, and it avoids pulling in a stats
// dependency for one function.
function cdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/* ------------------------------------------------------------------ time -- */

// Years to expiry. `expiryDate` is 'YYYY-MM-DD' as the instrument master stores
// it; the instant is 15:30 IST on that date.
//
// Never returns 0 or a negative: on expiry afternoon T collapses toward zero and
// every greek divides by sqrt(T). The floor is one minute of a year, which keeps
// the maths finite while making the numbers obviously extreme — which is the
// truth about an option in its last minutes.
const MIN_YEARS = 1 / (365 * 24 * 60);

function yearsToExpiry(expiryDate, nowMs = Date.now()) {
  if (!expiryDate) return null;
  const d = String(expiryDate).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  const utcMidnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const expiryMs = utcMidnight + EXPIRY_HOUR_IST * 3600 * 1000 - IST_OFFSET_MS;
  return Math.max(MIN_YEARS, (expiryMs - Number(nowMs)) / MS_PER_YEAR);
}

/* ---------------------------------------------------------------- pricing - */

function d1d2(S, K, T, r, sigma) {
  const vt = sigma * Math.sqrt(T);
  const a = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / vt;
  return { d1: a, d2: a - vt, vt };
}

// The theoretical premium. `type` is 'CE' or 'PE'.
function price(type, S, K, T, r, sigma) {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return null;
  const { d1, d2 } = d1d2(S, K, T, r, sigma);
  const df = Math.exp(-r * T);
  return type === 'PE'
    ? K * df * cdf(-d2) - S * cdf(-d1)
    : S * cdf(d1) - K * df * cdf(d2);
}

// Intrinsic value — what the option is worth if the market stopped here. This
// is the undiscounted figure, which is what the chain's "Intrinsic / Time
// value" split means and what a trader expects to read.
function intrinsic(type, S, K) {
  if (!(S > 0) || !(K > 0)) return null;
  return type === 'PE' ? Math.max(0, K - S) : Math.max(0, S - K);
}

// The no-arbitrage floor a EUROPEAN option can trade at — and it is NOT the
// intrinsic value. A European put cannot be exercised early, so its floor is
// K·e^(-rT) − S rather than K − S: a deep in-the-money put legitimately trades
// BELOW its intrinsic value by the interest on the strike until expiry.
//
// Getting this wrong is not academic. Using intrinsic as the floor rejects
// every deep ITM put as "unpriceable", and the implied volatility — and with it
// every greek — comes back null for exactly the strikes whose greeks a seller
// most wants to see.
function lowerBound(type, S, K, T, r) {
  const df = Math.exp(-r * T);
  return type === 'PE' ? Math.max(0, K * df - S) : Math.max(0, S - K * df);
}

/* ----------------------------------------------------------------- greeks - */

// All five, in the units a trading desk quotes them:
//
//   delta  per 1 point of the underlying         (-1 … 1)
//   gamma  delta change per 1 point              (per point)
//   theta  premium lost per CALENDAR DAY         (negative for a long option)
//   vega   premium change per 1 VOL POINT (1%)   (positive)
//   rho    premium change per 1% of rate         (signed by type)
//
// Theta and vega are the two that get misreported most often: the raw formulas
// give theta per year and vega per unit of sigma (i.e. per 100 vol points), and
// publishing those unscaled makes vega look a hundred times too big.
function greeks(type, S, K, T, r, sigma) {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return null;
  const { d1, d2 } = d1d2(S, K, T, r, sigma);
  const df = Math.exp(-r * T);
  const sqrtT = Math.sqrt(T);
  const nd1 = pdf(d1);

  const gamma = nd1 / (S * sigma * sqrtT);
  const vega = S * nd1 * sqrtT / 100;

  if (type === 'PE') {
    const thetaYear = -(S * nd1 * sigma) / (2 * sqrtT) + r * K * df * cdf(-d2);
    return {
      delta: cdf(d1) - 1,
      gamma,
      theta: thetaYear / 365,
      vega,
      rho: -K * T * df * cdf(-d2) / 100,
    };
  }
  const thetaYear = -(S * nd1 * sigma) / (2 * sqrtT) - r * K * df * cdf(d2);
  return {
    delta: cdf(d1),
    gamma,
    theta: thetaYear / 365,
    vega,
    rho: K * T * df * cdf(d2) / 100,
  };
}

/* -------------------------------------------------------- implied vol ----- */

const MIN_SIGMA = 0.005;   // 0.5%
const MAX_SIGMA = 5.0;     // 500%

// Newton-Raphson with a bisection fallback.
//
// Newton alone is fast and wrong at the edges: vega goes to zero for a deep ITM
// or deep OTM option, so the step blows up and the iteration wanders off. So the
// search is bracketed first, Newton runs inside the bracket, and any step that
// leaves it falls back to a bisection — which cannot diverge, only be slow.
//
// Returns null rather than a boundary value when the market price is outside
// what the model can produce at any volatility. That is not a failure to
// converge, it is the market disagreeing with the model (a stale print, a
// crossed quote, an arbitrage-violating price), and the caller needs to be able
// to tell the difference.
function impliedVol(type, marketPrice, S, K, T, r, { tolerance = 1e-6, maxIterations = 60 } = {}) {
  if (!(marketPrice > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;

  // No volatility can price a European option below its no-arbitrage floor, so
  // a price under it has no solution at all — it is a stale print or a crossed
  // quote, not a low volatility.
  if (marketPrice < lowerBound(type, S, K, T, r) - 1e-9) return null;

  let lo = MIN_SIGMA;
  let hi = MAX_SIGMA;
  const loPrice = price(type, S, K, T, r, lo);
  const hiPrice = price(type, S, K, T, r, hi);
  if (loPrice === null || hiPrice === null) return null;
  // Below the 0.5%-vol price or above the 500%-vol price the answer is outside
  // the search range. Reporting the boundary would print "500% IV" for what is
  // really a tick-floor quote on a dead strike.
  if (marketPrice <= loPrice || marketPrice >= hiPrice) return null;

  let sigma = Math.max(MIN_SIGMA, Math.min(MAX_SIGMA,
    // Brenner-Subrahmanyam: an ATM starting guess that is close enough to save
    // most of the iterations.
    Math.sqrt(2 * Math.PI / T) * marketPrice / S));

  for (let i = 0; i < maxIterations; i++) {
    const p = price(type, S, K, T, r, sigma);
    if (p === null) return null;
    const diff = p - marketPrice;
    if (Math.abs(diff) < tolerance) return sigma;

    if (diff > 0) hi = sigma; else lo = sigma;

    const g = greeks(type, S, K, T, r, sigma);
    const vegaPerUnit = g ? g.vega * 100 : 0;      // back to per-unit-sigma
    let next = vegaPerUnit > 1e-8 ? sigma - diff / vegaPerUnit : NaN;
    if (!Number.isFinite(next) || next <= lo || next >= hi) next = 0.5 * (lo + hi);
    sigma = next;
  }
  // Out of iterations inside a valid bracket: the bracket midpoint is accurate
  // to (hi-lo)/2, which after 60 halvings is far finer than the answer means.
  return 0.5 * (lo + hi);
}

/* ----------------------------------------------------------------- facade - */

// Everything the option chain needs for one contract, from the one number the
// broker gives us. `spot`, `strike` and `premium` are in RUPEES here — this is a
// modelling layer and the model is written in the units the formulas assume; the
// callers convert from paise at the boundary.
//
// Every field is null rather than absent when it cannot be computed, so a table
// column never silently shifts.
function analyse({ type, premium, spot, strike, expiryDate, rate = 0.065, nowMs = Date.now() }) {
  const T = yearsToExpiry(expiryDate, nowMs);
  const iv = (T && premium > 0)
    ? impliedVol(type, premium, spot, strike, T, rate)
    : null;
  const g = iv ? greeks(type, spot, strike, T, rate, iv) : null;
  const intr = intrinsic(type, spot, strike);
  return {
    yearsToExpiry: T,
    iv: iv === null ? null : iv * 100,              // percentage points
    delta: g ? g.delta : null,
    gamma: g ? g.gamma : null,
    theta: g ? g.theta : null,
    vega: g ? g.vega : null,
    rho: g ? g.rho : null,
    intrinsic: intr,
    // Time value can come out slightly negative on a stale ITM print. That is
    // real information about the quote, not an error to clamp away.
    timeValue: (intr === null || !(premium > 0)) ? null : premium - intr,
    theoretical: iv ? price(type, spot, strike, T, rate, iv) : null,
  };
}

module.exports = {
  MIN_SIGMA, MAX_SIGMA, EXPIRY_HOUR_IST,
  cdf, pdf, yearsToExpiry, price, intrinsic, lowerBound, greeks, impliedVol, analyse,
};
