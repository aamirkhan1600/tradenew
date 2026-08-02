// The Price-Filter Engine's own settings profile.
//
// A SEPARATE row in `settings`, under the name `pfe`. It is not a section of
// the scalper's profile and it is not merged with it, for one reason that is
// worth stating plainly: the two engines disagree about what a good
// configuration is. The scalper ships 1.5 / 1.5 because a 2-for-1 loss needs a
// 67% hit rate; doc/new.md specifies 1.0 / 2.0 and compensates with a target
// ladder and a 60–90 second maximum hold. Both are coherent. Sharing one row
// would mean one of them silently getting the other's numbers.
//
// Everything here therefore has its OWN default, its own validation and its own
// page, and `validate()` says out loud when a value is legal but probably not
// what the operator meant.

const time = require('../core/time');
const money = require('../core/money');
const repo = require('../repositories');
const logger = require('../core/logger');
const config = require('../config');
const scanner = require('./scanner');
const direction = require('./direction');
const { ValidationError } = require('../core/errors');

const PROFILE = 'pfe';

// Used ONLY when the instrument master cannot be reached. The engine itself
// sizes real orders from the master (src/pfe/engine.js reads chosen.lotSize and
// refuses a contract that has none), so this number never reaches an order — it
// exists so the settings page and the boot log can render economics.
//
// NIFTY was 75 and is now 65. Every figure a human read here was ~15% off.
const FALLBACK_LOT = 65;

const EXPIRY_MODES = ['CURRENT_WEEKLY', 'NEXT_WEEKLY', 'MONTHLY', 'MANUAL'];
const TRADE_MODES = ['BOTH', 'CE', 'PE'];
const MODES = ['PAPER', 'LIVE'];

// Straight out of doc/new.md. Where the document gives a range rather than a
// number the midpoint is taken and the range becomes two settings.
const DEFAULTS = {
  symbol: 'NIFTY',
  expiryMode: 'CURRENT_WEEKLY',
  manualExpiry: null,
  // Which sides the scanner may choose from at all. The trend filter narrows it
  // further on every bar — this is the operator's own restriction on top.
  tradeMode: 'BOTH',
  lots: 1,
  mode: 'PAPER',

  /* --- Module 1, the session ---------------------------------------------- */
  sessionStart: '09:16',
  lastEntryAt: '15:10',
  squareOffAt: '15:20',

  /* --- Module 2, premium selection ---------------------------------------- */
  premiumMin: 12,
  premiumMax: 30,
  premiumIdealMin: 15,
  premiumIdealMax: 25,

  // Liquidity. See the header of scanner.js: Kotak's retail entitlement sends
  // none of these fields, so the mode decides what a missing field means.
  liquidityMode: 'LENIENT',
  minOpenInterest: 100000,
  minVolume: 10000,
  minBidQty: 100,
  minAskQty: 100,
  maxSpread: 0.20,

  // The ranking score's five terms. 0 drops a term entirely.
  weightPremium: 1,
  weightSpread: 1,
  weightOi: 1,
  weightVolume: 1,
  weightDepth: 1,

  // Strikes either side of the money to quote on each scan. 12 is 25 strikes
  // per side, two batched quote requests — the premium band sits several
  // strikes out and a narrower window would keep missing it.
  scanRange: 12,
  // How long a scan's answer is worth acting on before it is re-run.
  scanIntervalSec: 5,

  /* --- Module 3, trend direction ------------------------------------------ */
  trendTimeframe: '5s',
  trendBars: 3,
  trendCloseRule: 'LAST',
  trendMinTicks: 3,

  /* --- Modules 4 and 5, entry --------------------------------------------- */
  optionTimeframe: '5s',
  optionMinTicks: 2,
  sellOffset: 0.10,
  pendingTimeout: 5,
  // A selected contract that never gets a tradable candle inside this window is
  // released so the next scan can choose against the spot as it is now.
  armTimeout: 120,

  /* --- Module 6, initial risk --------------------------------------------- */
  target: 1.0,
  stopLoss: 2.0,

  /* --- Module 8, the dynamic target --------------------------------------- */
  dynamicTarget: true,
  targetStep: 1.0,
  maxTargetSteps: 4,          // "Fourth+ — trail until exit"

  /* --- Module 9, the trailing stop ---------------------------------------- */
  trailStart: 0,
  trailGap: 1.0,
  // The gap tightens by this much on every trail, down to trailMinGap. With
  // 1.00 / 0.20 / 0.40 the engine reproduces the document's worked example
  // (22.00 -> 20.20 -> 19.30 -> 18.40) exactly. 0 gives a fixed-gap trail.
  trailTighten: 0.20,
  trailMinGap: 0.40,

  /* --- Module 10, the exits ----------------------------------------------- */
  maxHoldSeconds: 90,
  premiumSafetyExit: 2.0,
  exitOnFilterFail: true,
  exitOnTrendBreak: true,
  exitOnLiquidity: true,
  liquidityExitSpread: 0.50,

  /* --- Module 11, re-entry ------------------------------------------------ */
  reentryCandles: 2,

  /* --- Module 12, risk ---------------------------------------------------- */
  maxTradesPerDay: 30,
  maxConsecutiveLosses: 5,
  maxDailyLoss: 3000,
  maxDailyProfit: 5000,
  cooldownAfterSL: 60,
};

// A profile written before a key existed must keep booting, so absent keys are
// filled on read as well as on write.
function withDefaults(s) {
  const out = { ...(s || {}) };
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (out[k] === undefined || out[k] === null || out[k] === '') out[k] = v;
  }
  return out;
}

/* -------------------------------------------------------------- validate -- */

function validate(raw, { lotSize = FALLBACK_LOT } = {}) {
  const s = withDefaults(raw);
  const errors = [];
  const warnings = [];

  const oneOf = (field, allowed) => {
    if (!allowed.includes(String(s[field] || '').toUpperCase())) {
      errors.push(`${field} must be one of ${allowed.join(', ')} (got "${s[field]}")`);
    }
  };
  oneOf('expiryMode', EXPIRY_MODES);
  oneOf('tradeMode', TRADE_MODES);
  oneOf('mode', MODES);
  oneOf('liquidityMode', scanner.MODES);
  oneOf('trendCloseRule', direction.CLOSE_RULES);

  for (const field of ['optionTimeframe', 'trendTimeframe']) {
    if (!time.isTimeframe(s[field])) {
      errors.push(`${field} must be one of ${Object.keys(time.TIMEFRAMES).join(', ')}`);
    }
  }

  const positive = (field, { allowZero = false } = {}) => {
    const v = Number(s[field]);
    if (!Number.isFinite(v) || (allowZero ? v < 0 : v <= 0)) {
      errors.push(`${field} must be a ${allowZero ? 'non-negative' : 'positive'} number`);
    }
  };
  positive('lots');
  positive('premiumMin');
  positive('premiumMax');
  positive('premiumIdealMin');
  positive('premiumIdealMax');
  positive('maxSpread');
  positive('sellOffset', { allowZero: true });
  positive('pendingTimeout');
  positive('armTimeout', { allowZero: true });
  positive('target');
  positive('stopLoss');
  positive('targetStep');
  positive('maxHoldSeconds');
  positive('premiumSafetyExit', { allowZero: true });
  positive('liquidityExitSpread', { allowZero: true });
  positive('trailGap', { allowZero: true });
  positive('trailStart', { allowZero: true });
  positive('trailTighten', { allowZero: true });
  positive('trailMinGap', { allowZero: true });
  positive('cooldownAfterSL', { allowZero: true });

  const nonNegativeInt = (field) => {
    const v = Number(s[field]);
    if (!Number.isFinite(v) || v < 0 || Math.trunc(v) !== v) {
      errors.push(`${field} must be a whole number of 0 or more`);
    }
  };
  for (const f of ['minOpenInterest', 'minVolume', 'minBidQty', 'minAskQty',
    'reentryCandles', 'maxTradesPerDay', 'maxConsecutiveLosses',
    'maxDailyLoss', 'maxDailyProfit']) nonNegativeInt(f);

  const inRange = (field, lo, hi) => {
    const v = Number(s[field]);
    if (!Number.isFinite(v) || v < lo || v > hi) {
      errors.push(`${field} must be between ${lo} and ${hi} (got "${s[field]}")`);
    }
  };
  inRange('trendBars', 2, 10);
  inRange('maxTargetSteps', 1, 20);
  inRange('scanRange', 1, 40);
  inRange('scanIntervalSec', 1, 300);
  inRange('trendMinTicks', 0, 100);
  inRange('optionMinTicks', 0, 100);
  for (const w of ['weightPremium', 'weightSpread', 'weightOi', 'weightVolume', 'weightDepth']) {
    inRange(w, 0, 10);
  }

  if (Number(s.premiumMin) >= Number(s.premiumMax)) {
    errors.push('premiumMin must be below premiumMax');
  }
  if (Number(s.premiumIdealMin) > Number(s.premiumIdealMax)) {
    errors.push('premiumIdealMin must not be above premiumIdealMax');
  }
  if (Number(s.premiumIdealMin) < Number(s.premiumMin)
    || Number(s.premiumIdealMax) > Number(s.premiumMax)) {
    errors.push('the ideal premium band must sit inside the accepted band '
      + `(${s.premiumMin}–${s.premiumMax})`);
  }
  if (Number(s.trailMinGap) > Number(s.trailGap) && Number(s.trailGap) > 0) {
    errors.push(`trailMinGap (${s.trailMinGap}) is above trailGap (${s.trailGap}) — `
      + 'the trail would tighten upwards, which it cannot');
  }
  if (String(s.expiryMode).toUpperCase() === 'MANUAL' && !s.manualExpiry) {
    errors.push('expiryMode is MANUAL but manualExpiry is not set');
  }

  for (const field of ['sessionStart', 'lastEntryAt', 'squareOffAt']) {
    try { time.parseHhMm(s[field]); } catch (err) { errors.push(err.message); }
  }

  if (errors.length) return { errors, warnings };

  /* --- warnings: legal, but probably not what was meant -------------------- */

  const start = time.parseHhMm(s.sessionStart);
  const last = time.parseHhMm(s.lastEntryAt);
  const flat = time.parseHhMm(s.squareOffAt);
  if (start >= last) errors.push('sessionStart must be before lastEntryAt');
  if (last >= flat) {
    warnings.push(`lastEntryAt (${s.lastEntryAt}) is not before squareOffAt (${s.squareOffAt}) — `
      + 'a trade could be entered and flattened in the same breath, paying both sides of the '
      + 'round trip for nothing');
  }

  // THE number an operator has to see before a live session. doc/new.md's own
  // 1.0 / 2.0 needs to be right roughly seven times in ten before charges, and
  // charges are paid in full on winners and losers alike.
  const qty = Math.max(1, Number(s.lots) * (Number(lotSize) || FALLBACK_LOT));
  const entryP = money.toPaise((Number(s.premiumIdealMin) + Number(s.premiumIdealMax)) / 2)
    + money.toPaise(s.sellOffset);
  const need = money.requiredWinRate({
    entryPaise: entryP, qty,
    targetPaise: money.toPaise(s.target),
    stopPaise: money.toPaise(s.stopLoss),
  });
  if (need.rate === null) {
    errors.push(`a winning trade LOSES money at this size: a ₹${s.target} target on ${qty} qty `
      + `nets ${money.formatInr(need.winP)} after ${money.formatInr(need.chargesP)} of charges. `
      + 'Raise the target or the lot size.');
  } else if (need.rate >= 0.6) {
    warnings.push(`the FIRST rung of the ladder needs a ${(need.rate * 100).toFixed(0)}% win rate `
      + `to break even: a ₹${s.target} win nets ${money.formatInr(need.winP)} and a ₹${s.stopLoss} `
      + `loss ${money.formatInr(need.lossP)} on ${qty} qty. This strategy is meant to make that `
      + 'back by extending the target while the move continues — check the ladder is actually '
      + `firing (dynamicTarget is ${s.dynamicTarget ? 'ON' : 'OFF'}) before trading it live.`);
  }

  if (!s.dynamicTarget) {
    warnings.push('dynamicTarget is OFF, so every trade takes one point and stops there — '
      + `with a ${s.stopLoss}-point stop that is the losing side of the risk/reward the ladder `
      + 'exists to fix. See doc/new.md Module 8.');
  }

  if (String(s.liquidityMode).toUpperCase() === 'LENIENT') {
    warnings.push('liquidityMode is LENIENT: any liquidity field the broker does not send is '
      + 'SKIPPED rather than treated as a failure. Kotak\'s retail Trade API sends no open '
      + 'interest, volume or market depth on most accounts, so in practice the strike is chosen '
      + 'on premium alone. The Price Filter page reports exactly which checks ran — read it '
      + 'once at the start of a session.');
  } else {
    warnings.push('liquidityMode is STRICT: a liquidity field the broker does not send counts as '
      + 'a FAILURE, so if this account only answers the `ltp` quote filter NO STRIKE WILL EVER '
      + 'BE SELECTED. That is the honest reading of a required filter, but it looks exactly like '
      + 'a quiet market — check the Price Filter page for "unavailable" fields.');
  }

  const optSec = time.timeframeSeconds(s.optionTimeframe);
  const trendSec = time.timeframeSeconds(s.trendTimeframe);

  if (Number(s.pendingTimeout) >= optSec * 2) {
    warnings.push(`pendingTimeout (${s.pendingTimeout}s) spans two or more ${s.optionTimeframe} `
      + 'candles — a working sell will usually survive past the close that was supposed to '
      + 'requote it');
  }
  if (Number(s.maxHoldSeconds) < optSec * 3) {
    warnings.push(`maxHoldSeconds (${s.maxHoldSeconds}s) is under three ${s.optionTimeframe} `
      + 'candles — most trades will exit on the clock before the target or the ladder gets a '
      + 'fair chance');
  }
  if (s.dynamicTarget && Number(s.maxHoldSeconds) < Number(s.maxTargetSteps) * trendSec) {
    warnings.push(`maxHoldSeconds (${s.maxHoldSeconds}s) is shorter than the `
      + `${Number(s.maxTargetSteps) * trendSec}s the ladder needs to reach `
      + `${s.maxTargetSteps} confirmations at ${s.trendTimeframe} — the maximum hold will cut `
      + 'winners off before the ladder can finish developing');
  }

  // The premium safety exit and the stop-loss are both "the premium ran against
  // us by N points". If the safety margin is at or below the stop it fires
  // first, every time, and the configured stop never happens.
  if (Number(s.premiumSafetyExit) > 0 && Number(s.premiumSafetyExit) <= Number(s.stopLoss)) {
    warnings.push(`premiumSafetyExit (${s.premiumSafetyExit}) is at or below stopLoss `
      + `(${s.stopLoss}), so it fires first and the stop-loss level is never reached. That is `
      + 'legal — the safety exit is meant to be the tighter of the two — but the effective stop '
      + `on this configuration is ${s.premiumSafetyExit} points, not ${s.stopLoss}.`);
  }

  if (Number(s.liquidityExitSpread) > 0 && Number(s.liquidityExitSpread) <= Number(s.maxSpread)) {
    warnings.push(`liquidityExitSpread (${s.liquidityExitSpread}) is not wider than maxSpread `
      + `(${s.maxSpread}) — a contract would be exited for a spread it was allowed to be `
      + 'selected with');
  }

  // The thin-bar guard against the feed's actual cadence, the same arithmetic
  // the scalper's settings does: on the REST quote fallback a bar holds at most
  // one sample per poll interval.
  const pollSec = Math.max(0.001, config.neo.pollMs / 1000);
  for (const [field, sec, label] of [
    ['trendMinTicks', trendSec, 'index'], ['optionMinTicks', optSec, 'option']]) {
    const ceiling = Math.floor(sec / pollSec);
    const want = Number(s[field]);
    if (want > ceiling) {
      warnings.push(`a ${sec}s ${label} bar holds at most ${ceiling} samples on the REST quote `
        + `fallback (NEO_POLL_MS=${config.neo.pollMs}), under ${field} (${want}) — on a quiet `
        + 'tape every bar reads as unmeasured and nothing will ever trade. Lower it, or confirm '
        + 'the market socket is genuinely streaming.');
    }
  }

  if (Number(s.reentryCandles) === 0) {
    warnings.push('reentryCandles is 0 — the engine may re-enter on the candle immediately after '
      + 'an exit, on a fresh scan but into the same conditions that just stopped it out. '
      + 'doc/new.md Module 11 asks for at least 2.');
  }

  if (Number(s.maxTradesPerDay) === 0) {
    warnings.push('maxTradesPerDay is 0 (unlimited) — doc/new.md Module 12 caps it at 30');
  }

  return { errors, warnings };
}

/* ---------------------------------------------------------------- derive -- */

// Everything the engine runs on, precomputed in paise and milliseconds so no hot
// path has to convert.
function derive(raw) {
  const s = withDefaults(raw);
  return {
    ...s,
    _optionSeconds: time.timeframeSeconds(s.optionTimeframe),
    _trendSeconds: time.timeframeSeconds(s.trendTimeframe),

    _sellOffsetP: money.toPaise(s.sellOffset),
    _targetP: money.toPaise(s.target),
    _stopLossP: money.toPaise(s.stopLoss),
    _stepP: money.toPaise(s.targetStep),
    _trailStartP: money.toPaise(s.trailStart),
    _trailGapP: money.toPaise(s.trailGap),
    _trailTightenP: money.toPaise(s.trailTighten),
    _trailMinGapP: money.toPaise(s.trailMinGap),
    _safetyMarginP: money.toPaise(s.premiumSafetyExit),

    _pendingTimeoutMs: Math.round(Number(s.pendingTimeout) * 1000),
    _maxHoldMs: Math.round(Number(s.maxHoldSeconds) * 1000),
    _armTimeoutMs: Math.round(Number(s.armTimeout) * 1000),
    _scanIntervalMs: Math.round(Number(s.scanIntervalSec) * 1000),
    _cooldownMs: Math.round(Number(s.cooldownAfterSL) * 1000),

    // The shapes the pure modules read, built once here so no call site can
    // assemble them differently.
    _scanner: {
      liquidityMode: String(s.liquidityMode).toUpperCase(),
      premiumMinP: money.toPaise(s.premiumMin),
      premiumMaxP: money.toPaise(s.premiumMax),
      premiumIdealMinP: money.toPaise(s.premiumIdealMin),
      premiumIdealMaxP: money.toPaise(s.premiumIdealMax),
      minOpenInterest: Number(s.minOpenInterest),
      minVolume: Number(s.minVolume),
      minBidQty: Number(s.minBidQty),
      minAskQty: Number(s.minAskQty),
      maxSpreadP: money.toPaise(s.maxSpread),
      weights: {
        premium: Number(s.weightPremium),
        spread: Number(s.weightSpread),
        oi: Number(s.weightOi),
        volume: Number(s.weightVolume),
        depth: Number(s.weightDepth),
      },
    },

    _direction: {
      bars: Math.trunc(Number(s.trendBars)),
      closeRule: String(s.trendCloseRule).toUpperCase(),
      minTicks: Math.trunc(Number(s.trendMinTicks)),
    },

    _liquidityExit: {
      exitSpreadPaise: money.toPaise(s.liquidityExitSpread),
      minBidQty: Number(s.minBidQty),
      volumeCollapsePct: 100,
    },

    // What the state machine is handed. Named separately from the profile so a
    // reader can see the machine's whole config surface in one place.
    _machine: {
      sellOffsetP: money.toPaise(s.sellOffset),
      targetP: money.toPaise(s.target),
      stopLossP: money.toPaise(s.stopLoss),
      stepP: money.toPaise(s.targetStep),
      maxSteps: Math.trunc(Number(s.maxTargetSteps)),
      trailStartP: money.toPaise(s.trailStart),
      trailGapP: money.toPaise(s.trailGap),
      trailTightenP: money.toPaise(s.trailTighten),
      trailMinGapP: money.toPaise(s.trailMinGap),
      safetyMarginP: money.toPaise(s.premiumSafetyExit),
      pendingTimeoutMs: Math.round(Number(s.pendingTimeout) * 1000),
      maxHoldMs: Math.round(Number(s.maxHoldSeconds) * 1000),
      armTimeoutMs: Math.round(Number(s.armTimeout) * 1000),
      dynamicTarget: Boolean(s.dynamicTarget),
    },
  };
}

// The economics of the FIRST rung, in the shape the boot log and the page both
// read. Deliberately says what it does not cover: a ladder that reaches its
// fourth confirmation changes these numbers completely, and quoting the first
// rung as if it were the strategy's expectancy would be its own kind of lie.
function breakevenNote(s, lotSize = FALLBACK_LOT) {
  const qty = Math.max(1, Number(s.lots) * Number(lotSize || FALLBACK_LOT));
  const entryP = money.toPaise((Number(s.premiumIdealMin) + Number(s.premiumIdealMax)) / 2)
    + money.toPaise(s.sellOffset);
  const be = money.breakevenPaise({
    entryPaise: entryP, qty, assumeTargetPaise: money.toPaise(s.target),
  });
  const need = money.requiredWinRate({
    entryPaise: entryP, qty,
    targetPaise: money.toPaise(s.target),
    stopPaise: money.toPaise(s.stopLoss),
  });
  // The best case the ladder can reach, for contrast.
  const ladderTargetP = money.toPaise(s.target)
    + money.toPaise(s.targetStep) * Math.max(0, Number(s.maxTargetSteps) - 1);
  const laddered = money.requiredWinRate({
    entryPaise: entryP, qty, targetPaise: ladderTargetP, stopPaise: money.toPaise(s.stopLoss),
  });

  return {
    qty,
    chargesP: be.chargesPaise,
    breakevenPointsP: be.pointsPaise,
    targetP: money.toPaise(s.target),
    covered: money.toPaise(s.target) > be.pointsPaise,
    requiredWinRate: need.rate,
    winP: need.winP,
    lossP: need.lossP,
    ladderTargetP,
    ladderRequiredWinRate: laddered.rate,
    ladderWinP: laddered.winP,
  };
}

/* ------------------------------------------------------------------- I/O -- */

// The contract size the exchange is using, or the fallback when the master is
// unreachable. Read once per settings load, not per cycle.
async function lotSizeFor(underlying = 'NIFTY') {
  try {
    return (await repo.instruments.lotSize(underlying)) || FALLBACK_LOT;
  } catch (_) {
    return FALLBACK_LOT;
  }
}

async function load(name = PROFILE) {
  const raw = await repo.settings.get(name);
  if (!raw) {
    throw new ValidationError(
      `the "${name}" settings profile does not exist — run npm run migrate`);
  }
  const { errors, warnings } = validate(raw, { lotSize: await lotSizeFor(raw?.symbol) });
  if (errors.length) {
    throw new ValidationError(`the Price Filter settings are invalid:\n  - ${errors.join('\n  - ')}`);
  }
  for (const w of warnings) logger.warn('pfe settings: ' + w);
  return derive(raw);
}

async function save(name, patch) {
  const current = (await repo.settings.get(name)) || {};
  const merged = withDefaults({ ...current, ...patch });
  delete merged._name; delete merged._version; delete merged._updatedAt;
  const { errors, warnings } = validate(merged, { lotSize: await lotSizeFor(merged.symbol) });
  if (errors.length) {
    throw new ValidationError(`the Price Filter settings are invalid:\n  - ${errors.join('\n  - ')}`);
  }
  await repo.settings.save(name, merged);
  return { settings: derive(merged), warnings };
}

module.exports = {
  PROFILE, DEFAULTS, EXPIRY_MODES, TRADE_MODES, MODES,
  withDefaults, validate, derive, breakevenNote, load, save, lotSizeFor, FALLBACK_LOT,
};
