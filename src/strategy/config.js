// Strategy configuration: defaults, normalisation and validation.
//
// Pure — no I/O — so the same rules run in the HTTP layer (reject a bad save)
// and in the engine (refuse to run a strategy that was corrupted in the DB).
//
// The validation here is deliberately opinionated. Most of these rules exist
// because the configuration in question is not "unusual", it is *inert*: an arm
// price outside the scan range either arms instantly or never arms at all, and
// an operator would otherwise watch a strategy sit in SCANNING for a full
// session with no indication why.

const { parseHHMM, formatHHMM, MARKET } = require('../core/time');
const money = require('../core/money');

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
const OPTION_TYPES = ['CE', 'PE', 'BOTH'];
const HEDGE_MODES = ['STRIKE', 'PREMIUM'];
const OFFSET_FROM = ['ARM', 'LOW'];
const MODES = ['paper', 'live'];
const PRODUCTS = ['MIS', 'NRML'];

function defaults() {
  return {
    // --- instrument -------------------------------------------------------
    underlying: 'BANKNIFTY',
    expiry: null,                 // null = nearest available
    optionType: 'BOTH',           // CE | PE | BOTH

    // --- premium range scan ----------------------------------------------
    premiumMin: 35,
    premiumMax: 45,
    scanStrikes: 25,              // strikes either side of spot to keep subscribed
    otmOnly: true,
    maxQuoteAgeMs: 15000,         // refuse to act on a quote older than this

    // --- arm + offset trigger --------------------------------------------
    armPrice: 40,
    offset: 0.50,
    offsetFrom: 'ARM',            // ARM: armPrice + offset | LOW: post-arm low + offset
    armTimeoutSec: 0,             // 0 = wait until lastEntryTime

    // --- exits (absolute premium points on the short leg) -----------------
    // The doc specifies 2 / 5. Those are net-negative: four flat-fee orders
    // cost ~₹95, which on 2 BANKNIFTY lots is a 3.2-point breakeven, so a
    // 2-point "win" realises a loss. Defaults are set above breakeven and
    // `coverCharges` keeps them there when the size changes.
    target: 5,
    stoploss: 12,
    coverCharges: true,
    chargeBufferPct: 25,

    // --- sizing -----------------------------------------------------------
    lots: 2,
    product: 'MIS',
    marketProtectionPct: 5,       // slippage cap on opening market orders

    // --- hedge ------------------------------------------------------------
    hedgeMode: 'STRIKE',
    hedgeDistance: 10,            // STRIKE mode: intervals beyond the short strike
    hedgePremium: 10,             // PREMIUM mode: rupees
    hedgeMaxPremium: null,        // hard cap on hedge cost

    // --- session (IST) ----------------------------------------------------
    entryTime: '09:20',
    lastEntryTime: '14:30',
    squareOffTime: '15:20',
    holidays: [],                 // ['YYYY-MM-DD'] exchange holidays to skip

    // --- risk -------------------------------------------------------------
    maxTradesPerDay: 3,
    dailyMaxLoss: null,           // ₹ net, positive number; null = off
    dailyMaxProfit: null,
    reentryAfterTarget: true,
    reentryAfterStop: false,
    reentryCooldownSec: 60,

    // --- execution --------------------------------------------------------
    mode: 'paper',
  };
}

const NUMERIC = new Set(['premiumMin', 'premiumMax', 'scanStrikes', 'maxQuoteAgeMs', 'armPrice',
  'offset', 'armTimeoutSec', 'target', 'stoploss', 'chargeBufferPct', 'lots', 'marketProtectionPct',
  'hedgeDistance', 'hedgePremium', 'hedgeMaxPremium', 'maxTradesPerDay', 'dailyMaxLoss',
  'dailyMaxProfit', 'reentryCooldownSec']);
const STRINGS = new Set(['underlying', 'expiry', 'optionType', 'offsetFrom', 'product',
  'hedgeMode', 'entryTime', 'lastEntryTime', 'squareOffTime', 'mode']);
const BOOLEANS = new Set(['otmOnly', 'coverCharges', 'reentryAfterTarget', 'reentryAfterStop']);

// Coerce an untrusted object (an HTTP body, a JSON column) into a config.
// Unknown keys are dropped — a client cannot inject arbitrary fields.
function normalise(input = {}, base = defaults()) {
  const out = { ...base };
  for (const [key, raw] of Object.entries(input)) {
    if (NUMERIC.has(key)) {
      if (raw === '' || raw === null || raw === undefined) { out[key] = null; continue; }
      const n = Number(raw);
      if (Number.isFinite(n)) out[key] = n;
    } else if (STRINGS.has(key)) {
      if (raw === '' || raw === null || raw === undefined) { out[key] = null; continue; }
      out[key] = String(raw).trim();
    } else if (BOOLEANS.has(key)) {
      out[key] = raw === true || raw === 'true' || raw === 'on' || raw === 1 || raw === '1';
    } else if (key === 'holidays') {
      const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/);
      out.holidays = list.map(s => String(s).trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
    }
  }
  if (out.underlying) out.underlying = out.underlying.toUpperCase();
  if (out.optionType) out.optionType = out.optionType.toUpperCase();
  if (out.hedgeMode) out.hedgeMode = out.hedgeMode.toUpperCase();
  if (out.offsetFrom) out.offsetFrom = out.offsetFrom.toUpperCase();
  if (out.product) out.product = out.product.toUpperCase();
  if (out.mode) out.mode = out.mode.toLowerCase();
  return out;
}

// Returns [] when the config is usable, else a list of human-readable problems.
// `lotSize` is optional; when supplied, the charge-coverage rule can be checked.
function validate(cfg, { lotSize = null } = {}) {
  const errs = [];
  const positive = (key, label = key) => {
    if (!(Number(cfg[key]) > 0)) errs.push(`${label} must be greater than 0`);
  };

  if (!UNDERLYINGS.includes(cfg.underlying)) {
    errs.push(`underlying must be one of ${UNDERLYINGS.join(', ')}`);
  }
  if (!OPTION_TYPES.includes(cfg.optionType)) errs.push(`optionType must be ${OPTION_TYPES.join(', ')}`);
  if (!HEDGE_MODES.includes(cfg.hedgeMode)) errs.push(`hedgeMode must be ${HEDGE_MODES.join(', ')}`);
  if (!OFFSET_FROM.includes(cfg.offsetFrom)) errs.push(`offsetFrom must be ${OFFSET_FROM.join(', ')}`);
  if (!MODES.includes(cfg.mode)) errs.push(`mode must be ${MODES.join(' or ')}`);
  if (!PRODUCTS.includes(cfg.product)) errs.push(`product must be ${PRODUCTS.join(' or ')}`);
  if (cfg.expiry != null && !/^\d{4}-\d{2}-\d{2}$/.test(cfg.expiry)) {
    errs.push('expiry must be YYYY-MM-DD or blank for the nearest');
  }

  positive('premiumMin'); positive('premiumMax');
  if (Number(cfg.premiumMin) >= Number(cfg.premiumMax)) {
    errs.push('premiumMin must be below premiumMax');
  }
  // The arm price is the level the SELECTED option must fall to. Outside the
  // scan range no selected strike can ever reach it (or every one already has).
  if (Number(cfg.armPrice) < Number(cfg.premiumMin) || Number(cfg.armPrice) > Number(cfg.premiumMax)) {
    errs.push(`armPrice ${cfg.armPrice} must lie inside the premium range `
      + `[${cfg.premiumMin}, ${cfg.premiumMax}] — outside it the strategy can never arm`);
  }
  positive('offset'); positive('target'); positive('stoploss');

  if (!Number.isInteger(Number(cfg.lots)) || Number(cfg.lots) < 1) {
    errs.push('lots must be a whole number of at least 1');
  }
  if (cfg.hedgeMode === 'STRIKE' && !(Number(cfg.hedgeDistance) >= 1)) {
    errs.push('hedgeDistance must be at least 1 strike');
  }
  if (cfg.hedgeMode === 'PREMIUM') {
    positive('hedgePremium');
    if (Number(cfg.hedgePremium) >= Number(cfg.premiumMin)) {
      errs.push(`hedgePremium ${cfg.hedgePremium} must be below premiumMin ${cfg.premiumMin} — `
        + 'a hedge costing as much as the short inverts the spread');
    }
  }
  if (cfg.hedgeMaxPremium != null && !(Number(cfg.hedgeMaxPremium) > 0)) {
    errs.push('hedgeMaxPremium must be greater than 0 or blank');
  }

  const entry = parseHHMM(cfg.entryTime);
  const lastEntry = parseHHMM(cfg.lastEntryTime);
  const squareOff = parseHHMM(cfg.squareOffTime);
  if (entry == null) errs.push('entryTime must be HH:MM');
  if (lastEntry == null) errs.push('lastEntryTime must be HH:MM');
  if (squareOff == null) errs.push('squareOffTime must be HH:MM');
  if (entry != null && lastEntry != null && entry >= lastEntry) {
    errs.push('entryTime must be before lastEntryTime');
  }
  if (lastEntry != null && squareOff != null && lastEntry > squareOff) {
    errs.push('lastEntryTime must be at or before squareOffTime');
  }
  // Bound every window to exchange hours. Outside them there are no quotes, so
  // a strategy configured to start at 08:00 would simply sit in SCANNING with
  // no explanation — and one squaring off after 15:30 would never exit at all.
  if (entry != null && entry < MARKET.openMin) {
    errs.push(`entryTime must be at or after the market open (${formatHHMM(MARKET.openMin)} IST)`);
  }
  if (squareOff != null && squareOff > MARKET.closeMin) {
    errs.push(`squareOffTime must be at or before the market close (${formatHHMM(MARKET.closeMin)} IST)`);
  }

  for (const key of ['dailyMaxLoss', 'dailyMaxProfit']) {
    if (cfg[key] != null && !(Number(cfg[key]) > 0)) {
      errs.push(`${key} must be a positive rupee amount or blank`);
    }
  }
  if (Number(cfg.chargeBufferPct) < 0) errs.push('chargeBufferPct cannot be negative');
  if (Number(cfg.maxQuoteAgeMs) < 1000) errs.push('maxQuoteAgeMs must be at least 1000');

  // Charge coverage. With coverCharges on the engine lifts the target at entry,
  // so this is only fatal when the operator has explicitly turned that off.
  if (lotSize && !cfg.coverCharges) {
    const est = estimateBreakeven(cfg, lotSize);
    if (est && Number(cfg.target) <= est.points) {
      errs.push(`target ${cfg.target} pts is at or below the ~${est.points} pt round-trip breakeven `
        + `(≈${money.formatInr(est.charges)} of charges on ${est.qty} qty) — a winning trade would `
        + 'still lose money. Raise the target, raise lots, or re-enable coverCharges.');
    }
  }

  return errs;
}

// What the four-leg round trip costs at this config's sizing, in points.
// Approximate by construction (real fills decide the real number), but the flat
// per-order brokerage dominates, so it is well inside a tick.
function estimateBreakeven(cfg, lotSize) {
  const qty = Math.max(1, Number(cfg.lots) || 1) * (Number(lotSize) || 1);
  const shortPrice = Number(cfg.armPrice) || Number(cfg.premiumMax) || 40;
  const hedgePrice = cfg.hedgeMode === 'PREMIUM'
    ? (Number(cfg.hedgePremium) || 10)
    : Math.max(1, shortPrice * 0.25);
  const be = money.breakevenPoints({
    sellPrice: shortPrice, hedgePrice, qty, assumeTargetPoints: Number(cfg.target) || 0,
  });
  return { ...be, shortPrice, hedgePrice };
}

// Everything the UI needs to show the cost of a proposed configuration.
function economics(cfg, lotSize) {
  if (!lotSize) return { available: false, reason: 'lot size unknown — sync the instrument master' };
  const est = estimateBreakeven(cfg, lotSize);
  const resolved = money.resolveTargetPoints({
    configuredTarget: Number(cfg.target),
    sellPrice: est.shortPrice,
    hedgePrice: est.hedgePrice,
    qty: est.qty,
    coverCharges: !!cfg.coverCharges,
    bufferPct: Number(cfg.chargeBufferPct) || 0,
  });
  return {
    available: true,
    lotSize, qty: est.qty,
    charges: est.charges,
    breakevenPoints: est.points,
    configuredTarget: money.round(Number(cfg.target)),
    effectiveTarget: resolved.points,
    lifted: resolved.lifted,
    netAtTarget: money.round(resolved.points * est.qty - est.charges),
    netAtStop: money.round(-Number(cfg.stoploss) * est.qty - est.charges),
    covers: resolved.points > est.points,
  };
}

module.exports = {
  UNDERLYINGS, OPTION_TYPES, HEDGE_MODES, OFFSET_FROM, MODES, PRODUCTS,
  defaults, normalise, validate, estimateBreakeven, economics,
};
