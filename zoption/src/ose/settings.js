// §5 — the Configuration Contract.
//
// A SEPARATE row in `settings`, under the name `ose`. Not a section of the
// scalper's profile and not merged with the Price-Filter Engine's, for the same
// reason those two are separate from each other: `target` means a different
// thing in each engine, and one shared row would mean one of them silently
// getting another's numbers.
//
// ---------------------------------------------------------------------------
// What §5.1 lists, and what it does not
// ---------------------------------------------------------------------------
//
// §5.1 is a closed list: "These are the ONLY values an operator may change."
// Every key in it is below, with its documented default and its validation rule.
//
// A handful of keys here are NOT in §5.1, and each one is marked. They exist
// because this engine runs on a real broker rather than on the specification's
// idealised one, and pretending otherwise would move the decision from a
// settings page into a hardcoded assumption:
//
//   lots               `[MUST-CONFIRM #2]` — §12.2 leaves position size open
//   mode               PAPER/LIVE. §5.3 puts it in the environment; this
//                      platform keeps it per-profile so the two engines beside
//                      this one can be in different modes at once
//   liquidityMode      the §9.2 / `[MUST-CONFIRM #10]` entanglement — see the
//                      long comment above MIN_OI in ./constants.js
//   tradeOnExpiryDay   `[MUST-CONFIRM #7]`
//   scanRange          §8.1 says "the option chain"; quoting all 200-odd strikes
//                      once a cycle would consume the whole rate-limit budget
//   indexMinTicks /    §7.3 counts ticks per bucket but never says how few is
//   optionMinTicks     too few. On Kotak's REST quote fallback a 5s bar can hold
//                      one sample, and one sample is not an OHLC
//   confirmed          the §22 sign-off register
//
// §5.1 also freezes the config at boot. `derive()` returns a deeply frozen
// object for exactly that reason.

const time = require('../core/time');
const money = require('../core/money');
const repo = require('../repositories');
const logger = require('../core/logger');
const config = require('../config');
const C = require('./constants');
const { ValidationError } = require('../core/errors');

const PROFILE = 'ose';

const MODES = ['PAPER', 'LIVE'];
const LIQUIDITY_MODES = ['STRICT', 'LENIENT'];

// §5.1's table, verbatim, plus the marked additions.
const DEFAULTS = {
  /* --- §5.1, the contract ------------------------------------------------- */
  index: 'NIFTY',
  timeframeSeconds: 5,
  premiumMin: 15.00,
  premiumMax: 25.00,
  entryOffset: 0.10,
  initialTargetPoints: 1,
  initialStopPoints: 2,
  targetExtensionPoints: 1,
  trailingStopEnabled: true,
  premiumSafetyExitPoints: 2,
  reentryWaitCandles: 2,
  maxOpenTrades: 1,
  maxTradesPerDay: 30,
  maxConsecutiveLosses: 5,

  /* --- not in §5.1; see the header ---------------------------------------- */
  lots: 1,
  mode: 'PAPER',
  // Ships STRICT because that is §9.2 read literally, and a liquidity filter
  // that silently did not run is worse than one that visibly refuses. On a
  // Kotak retail entitlement STRICT means NOTHING IS EVER SELECTED — the engine
  // says so, loudly, on the first scan.
  liquidityMode: 'STRICT',
  tradeOnExpiryDay: false,
  scanRange: 20,
  indexMinTicks: 3,
  optionMinTicks: 2,
  // §16.4, `[MUST-CONFIRM #12]`. Re-checks the live sample against the stop on
  // the 1000ms safety timer, because §15.4's `candle.high` is the maximum of at
  // most five REST samples and a spike between two polls leaves no trace in it.
  //
  // Ships ENABLED: the alternative is knowingly accepting a stop that can be
  // stepped over without firing, and of the two defensible positions this is the
  // one that fails closed. It can only ever close a position, never open one.
  stopGuardEnabled: true,
  // Ids from §22 that the desk has signed off. LIVE mode refuses to start while
  // any remain unsigned — §22, first paragraph.
  confirmed: [],
};

function withDefaults(s) {
  const out = { ...(s || {}) };
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (out[k] === undefined || out[k] === null || out[k] === '') out[k] = v;
  }
  if (!Array.isArray(out.confirmed)) out.confirmed = [];
  return out;
}

/* -------------------------------------------------------------- validate -- */

function validate(raw) {
  const s = withDefaults(raw);
  const errors = [];
  const warnings = [];

  /* --- §5.1's validation column ------------------------------------------- */

  if (String(s.index).toUpperCase() !== 'NIFTY') {
    errors.push('index must be NIFTY — §1.2 puts every other underlying out of scope, '
      + 'and §27 forbids it appearing in this codebase even as a stub');
  }
  if (Number(s.timeframeSeconds) !== 5) {
    errors.push('timeframeSeconds must be 5 — §5.1 makes it a constant, not a choice');
  }
  if (!MODES.includes(String(s.mode).toUpperCase())) {
    errors.push(`mode must be one of ${MODES.join(', ')} (got "${s.mode}")`);
  }
  if (!LIQUIDITY_MODES.includes(String(s.liquidityMode).toUpperCase())) {
    errors.push(`liquidityMode must be one of ${LIQUIDITY_MODES.join(', ')}`);
  }

  const positive = (field, { allowZero = false } = {}) => {
    const v = Number(s[field]);
    if (!Number.isFinite(v) || (allowZero ? v < 0 : v <= 0)) {
      errors.push(`${field} must be a ${allowZero ? 'non-negative' : 'positive'} number`);
    }
  };
  positive('premiumMin');
  positive('premiumMax');
  positive('entryOffset', { allowZero: true });
  positive('lots');

  const wholeAtLeast = (field, min) => {
    const v = Number(s[field]);
    if (!Number.isFinite(v) || v < min || Math.trunc(v) !== v) {
      errors.push(`${field} must be a whole number of ${min} or more`);
    }
  };
  wholeAtLeast('initialTargetPoints', 1);
  wholeAtLeast('initialStopPoints', 1);
  wholeAtLeast('targetExtensionPoints', 1);
  wholeAtLeast('premiumSafetyExitPoints', 1);
  wholeAtLeast('reentryWaitCandles', 0);
  wholeAtLeast('maxTradesPerDay', 1);
  wholeAtLeast('maxConsecutiveLosses', 1);
  wholeAtLeast('indexMinTicks', 0);
  wholeAtLeast('optionMinTicks', 0);

  if (Number(s.maxOpenTrades) !== 1) {
    errors.push('maxOpenTrades must be 1 — §5.1 makes it a constant and §3.3 is built on it');
  }
  if (Number(s.premiumMin) >= Number(s.premiumMax)) {
    errors.push('premiumMin must be below premiumMax');
  }

  // §5.1 — "multiple of tick". An off-tick offset produces an off-tick limit
  // before floorToTick ever sees it, which is a rounding bug waiting to be
  // discovered by a rejection.
  const offsetP = money.toPaise(s.entryOffset);
  if (offsetP % C.TICK !== 0) {
    errors.push(`entryOffset ${s.entryOffset} is not a multiple of the ${C.TICK / 100} tick`);
  }

  const range = Number(s.scanRange);
  if (!Number.isFinite(range) || range < 1 || range > 40 || Math.trunc(range) !== range) {
    errors.push('scanRange must be a whole number between 1 and 40');
  }

  const unknownIds = (s.confirmed || []).map(Number)
    .filter(id => !C.MUST_CONFIRM_IDS.includes(id));
  if (unknownIds.length) {
    errors.push(`confirmed lists ids that are not in the §22 register: ${unknownIds.join(', ')}`);
  }

  if (errors.length) return { errors, warnings };

  /* --- warnings: legal, but the operator should have read them ------------ */

  const qty = Math.max(1, Number(s.lots) * 75);
  // The middle of the premium band plus the offset — the price a typical entry
  // actually fills at, which is what the economics have to be measured against.
  const entryP = money.toPaise((Number(s.premiumMin) + Number(s.premiumMax)) / 2) + offsetP;
  const need = money.requiredWinRate({
    entryPaise: entryP,
    qty,
    targetPaise: Number(s.initialTargetPoints) * C.POINT,
    stopPaise: Number(s.initialStopPoints) * C.POINT,
  });

  // THE number an operator has to see before a live session. The shipped
  // configuration is a 1-point target against a 2-point stop, which loses two to
  // win one BEFORE charges — and charges are a flat fee paid in full on winners
  // and losers alike.
  if (need.rate === null) {
    errors.push(`a winning trade LOSES money at this size: a ${s.initialTargetPoints}-point `
      + `target on ${qty} qty nets ${money.formatInr(need.winP)} after `
      + `${money.formatInr(need.chargesP)} of charges. Raise the target or the lot size.`);
  } else if (need.rate >= 0.6) {
    warnings.push(`the FIRST rung needs a ${(need.rate * 100).toFixed(0)}% win rate to break `
      + `even: a ${s.initialTargetPoints}-point win nets ${money.formatInr(need.winP)} and a `
      + `${s.initialStopPoints}-point loss ${money.formatInr(need.lossP)} on ${qty} qty. §14.2 `
      + 'exists to fix that by extending the target while the move continues — the ladder is '
      + `${s.trailingStopEnabled ? 'live' : 'running with the trail DISABLED'}, so check it is `
      + 'actually firing before trading this live.');
  }

  // §16.2.4, asserted as a warning rather than left to be discovered. With both
  // set to 2 the safety exit fires at exactly the stop level and the configured
  // stop is never the sole reason.
  if (Number(s.premiumSafetyExitPoints) <= Number(s.initialStopPoints)) {
    warnings.push(`premiumSafetyExitPoints (${s.premiumSafetyExitPoints}) is at or below `
      + `initialStopPoints (${s.initialStopPoints}), so before the first target it fires at the `
      + 'same premium as the stop. That is §16.2.4 working as designed — it is defence in depth '
      + 'and is expected never to be the sole trigger — but the effective initial stop on this '
      + `configuration is ${Math.min(s.premiumSafetyExitPoints, s.initialStopPoints)} points.`);
  }

  if (s.trailingStopEnabled === false) {
    warnings.push('trailingStopEnabled is off (§15.5), so the stop stays at entry + '
      + `${s.initialStopPoints} for the life of every trade. The ladder still extends the `
      + 'target, which means a trade can reach its fourth rung and still give the whole move '
      + 'back to the original stop.');
  }

  if (Number(s.reentryWaitCandles) === 0) {
    warnings.push('reentryWaitCandles is 0 — the engine may re-enter on the candle immediately '
      + 'after an exit, into the conditions that just stopped it out. §5.1 ships 2.');
  }

  // §15.4 / `[MUST-CONFIRM #4]`. The single largest behavioural difference from
  // the other two engines on this platform, and it is not obvious from the
  // settings page.
  warnings.push('the stop is evaluated on SEALED OPTION CANDLES (§15.4), not on ticks. Between '
    + `two seals the position is unprotected for up to ${s.timeframeSeconds}s, and the stop `
    + 'fires on the candle HIGH so an adverse wick counts in full. This is `[MUST-CONFIRM #4]` '
    + 'and differs from the Price Filter engine, whose stop reacts at tick speed.');

  if (String(s.liquidityMode).toUpperCase() === 'STRICT') {
    warnings.push('liquidityMode is STRICT: a liquidity field the broker does not send counts '
      + 'as a FAILURE, per §8.4 and §9.2 read literally. On a Kotak retail entitlement that '
      + 'means NO STRIKE WILL EVER BE SELECTED and every chain snapshot trips CHAIN_CORRUPT. '
      + 'That is the honest behaviour of a required filter with nothing to filter on — see '
      + '`[MUST-CONFIRM #10]`. The engine reports it explicitly on the first scan; switch to '
      + 'LENIENT only as a deliberate, recorded decision.');
  } else {
    warnings.push('liquidityMode is LENIENT: any liquidity field the broker does not send is '
      + 'SKIPPED rather than treated as a failure. On this entitlement that usually means the '
      + 'strike is chosen on premium alone and §9.2 filters 3–8 never run. The scan record '
      + 'names exactly which checks were made.');
  }

  // The thin-bar guard against the feed's real cadence. On the REST quote
  // fallback a bar holds at most one sample per poll interval.
  const pollSec = Math.max(0.001, config.neo.pollMs / 1000);
  const ceiling = Math.floor(Number(s.timeframeSeconds) / pollSec);
  for (const field of ['indexMinTicks', 'optionMinTicks']) {
    if (Number(s[field]) > ceiling) {
      warnings.push(`a ${s.timeframeSeconds}s bar holds at most ${ceiling} samples on the REST `
        + `quote fallback (NEO_POLL_MS=${config.neo.pollMs}), under ${field} (${s[field]}) — on `
        + 'a quiet tape every bar reads as unmeasured and nothing will ever trade. This is the '
        + 'practical half of `[MUST-CONFIRM #10]`.');
    }
  }

  const unsigned = C.MUST_CONFIRM_IDS.filter(id => !(s.confirmed || []).map(Number).includes(id));
  if (unsigned.length) {
    warnings.push(`§22: ${unsigned.length} of ${C.MUST_CONFIRM_IDS.length} MUST-CONFIRM items `
      + `are unsigned (#${unsigned.join(', #')}). PAPER mode runs regardless; LIVE mode refuses `
      + 'to start until every one is recorded in `confirmed`.');
  }

  return { errors, warnings };
}

/* ---------------------------------------------------------------- derive -- */

// Everything the engine runs on, precomputed in paise and frozen. §5.1: "loaded
// once at boot, validated against a schema, and frozen (Object.freeze, deep)."
function derive(raw) {
  const s = withDefaults(raw);

  const out = {
    ...s,
    index: String(s.index).toUpperCase(),
    mode: String(s.mode).toUpperCase(),
    liquidityMode: String(s.liquidityMode).toUpperCase(),
    confirmed: Object.freeze((s.confirmed || []).map(Number)),

    _timeframe: `${Math.trunc(Number(s.timeframeSeconds))}s`,

    _premiumMinP: money.toPaise(s.premiumMin),
    _premiumMaxP: money.toPaise(s.premiumMax),
    _entryOffsetP: money.toPaise(s.entryOffset),

    _initialTargetP: Math.trunc(Number(s.initialTargetPoints)) * C.POINT,
    _initialStopP: Math.trunc(Number(s.initialStopPoints)) * C.POINT,

    // The shape ./strikes.js and ./exits.js read. Built once here so no call
    // site can assemble it differently — the selection gate and the liquidity
    // exit MUST see the same thresholds or a contract gets exited for a rule it
    // was allowed in under.
    _gate: Object.freeze({
      liquidityMode: String(s.liquidityMode).toUpperCase(),
      premiumMinP: money.toPaise(s.premiumMin),
      premiumMaxP: money.toPaise(s.premiumMax),
    }),

    // The shape ./exits.js and ./ladder.js read.
    _rules: Object.freeze({
      targetExtensionPoints: Math.trunc(Number(s.targetExtensionPoints)),
      premiumSafetyExitPoints: Math.trunc(Number(s.premiumSafetyExitPoints)),
      trailingStopEnabled: Boolean(s.trailingStopEnabled),
      // §16.4. Read by the safety timer, not by the candle cycle — the guard
      // exists precisely for the moments the candle cycle cannot see.
      stopGuardEnabled: Boolean(s.stopGuardEnabled),
      maxHoldCandles: C.MAX_HOLD_CANDLES,
      liquidityMode: String(s.liquidityMode).toUpperCase(),
      premiumMinP: money.toPaise(s.premiumMin),
      premiumMaxP: money.toPaise(s.premiumMax),
    }),

    _risk: Object.freeze({
      maxOpenTrades: Math.trunc(Number(s.maxOpenTrades)),
      maxTradesPerDay: Math.trunc(Number(s.maxTradesPerDay)),
      maxConsecutiveLosses: Math.trunc(Number(s.maxConsecutiveLosses)),
      tradeOnExpiryDay: Boolean(s.tradeOnExpiryDay),
    }),
  };

  return Object.freeze(out);
}

/* -------------------------------------------------------------- §22, gating -- */

// The §22 sentence the engine is able to enforce: "the engine MUST NOT be
// enabled in LIVE mode until every item below is signed off".
//
// Returns the unsigned ids. The boot path refuses LIVE while this is non-empty.
function unsignedItems(s) {
  const signed = new Set((s.confirmed || []).map(Number));
  return C.MUST_CONFIRM.filter(m => !signed.has(m.id));
}

// §5.3 — "TRADING_MODE=LIVE in NODE_ENV != production MUST cause the process to
// refuse to start."
//
// Two refusals, both normative, both at boot rather than at the first order:
// discovering either of these when a position is about to be opened is
// discovering them too late.
function assertLiveAllowed(s) {
  if (String(s.mode).toUpperCase() !== 'LIVE') return;

  if (!config.isProd) {
    throw new ValidationError(
      `mode is LIVE but NODE_ENV is "${config.env}". §5.3 refuses to start: a live order from a `
      + 'process that believes it is a development box is the one mistake this engine cannot '
      + 'take back. Set NODE_ENV=production, or run in PAPER.');
  }

  const unsigned = unsignedItems(s);
  if (unsigned.length) {
    throw new ValidationError(
      '§22 refuses LIVE mode: the following specification items are not signed off — '
      + unsigned.map(m => `#${m.id} ${m.section} ${m.item}`).join('; ')
      + '. Record the sign-offs in the `confirmed` list on the settings page once the desk has '
      + 'agreed each one.');
  }
}

// The economics of the first rung, in the shape the boot log and the page both
// read. Deliberately reports what it does NOT cover: a trade that reaches its
// fourth rung has completely different numbers, and quoting the first rung as if
// it were the strategy's expectancy would be its own kind of lie.
function breakevenNote(s, lotSize = 75) {
  const w = withDefaults(s);
  const qty = Math.max(1, Number(w.lots) * Number(lotSize || 75));
  const entryP = money.toPaise((Number(w.premiumMin) + Number(w.premiumMax)) / 2)
    + money.toPaise(w.entryOffset);

  const targetP = Number(w.initialTargetPoints) * C.POINT;
  const stopP = Number(w.initialStopPoints) * C.POINT;

  const be = money.breakevenPaise({ entryPaise: entryP, qty, assumeTargetPaise: targetP });
  const need = money.requiredWinRate({ entryPaise: entryP, qty, targetPaise: targetP, stopPaise: stopP });

  // A four-rung ladder for contrast — the case §14.2 exists to produce. The
  // stop by then is at entry − 3, so the trade cannot lose; the comparison is
  // against the same initial stop so the two numbers are commensurable.
  const ladderTargetP = targetP + Number(w.targetExtensionPoints) * C.POINT * 3;
  const laddered = money.requiredWinRate({
    entryPaise: entryP, qty, targetPaise: ladderTargetP, stopPaise: stopP,
  });

  return {
    qty,
    entryP,
    chargesP: be.chargesPaise,
    breakevenPointsP: be.pointsPaise,
    targetP,
    covered: targetP > be.pointsPaise,
    requiredWinRate: need.rate,
    winP: need.winP,
    lossP: need.lossP,
    ladderTargetP,
    ladderRequiredWinRate: laddered.rate,
    ladderWinP: laddered.winP,
  };
}

/* ------------------------------------------------------------------- I/O -- */

async function load(name = PROFILE) {
  const raw = await repo.settings.get(name);
  if (!raw) {
    throw new ValidationError(
      `the "${name}" settings profile does not exist — run npm run migrate`);
  }
  const { errors, warnings } = validate(raw);
  if (errors.length) {
    throw new ValidationError(
      `the Option Selling Engine settings are invalid:\n  - ${errors.join('\n  - ')}`);
  }
  for (const w of warnings) logger.warn('ose settings: ' + w);

  const derived = derive(raw);
  assertLiveAllowed(derived);
  return derived;
}

async function save(name, patch) {
  const current = (await repo.settings.get(name)) || {};
  const merged = withDefaults({ ...current, ...patch });
  delete merged._name; delete merged._version; delete merged._updatedAt;

  const { errors, warnings } = validate(merged);
  if (errors.length) {
    throw new ValidationError(
      `the Option Selling Engine settings are invalid:\n  - ${errors.join('\n  - ')}`);
  }
  await repo.settings.save(name, merged);
  return { settings: derive(merged), warnings };
}

module.exports = {
  PROFILE, DEFAULTS, MODES, LIQUIDITY_MODES,
  withDefaults, validate, derive,
  unsignedItems, assertLiveAllowed, breakevenNote,
  load, save,
};
