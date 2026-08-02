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

// Used ONLY when the instrument master cannot be reached — a settings page that
// renders no economics at all is worse than one that renders approximate ones,
// but the approximation has to be visible. Every caller that can reach the
// master passes the real value instead.
//
// NIFTY was 75 and is now 65. That number was hardcoded in five places, and the
// engine (which sizes from the master) disagreed with every figure a human read.
const FALLBACK_LOT = 65;

// The last warning set logged per profile — see load(). Module-scoped because the
// engine reloads settings every five seconds through a fresh call.
const _lastWarned = new Map();

const MODES = ['PAPER', 'LIVE'];
const LIQUIDITY_MODES = ['STRICT', 'LENIENT'];
const SYNTHETIC_MODES = ['AUTO', 'OFF', 'FORCE'];

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
  // §16.2.6's holding-time cap, in 5s candles — 24 is two minutes. This was a
  // DEAD control: exits.js read `cfg.maxHoldCandles ?? C.MAX_HOLD_CANDLES`, but
  // derive() pinned the value to the constant, so the `??` never fell through
  // and no operator number could reach it. Same defect as initialTargetPoints.
  //
  // 0 disables the time exit entirely; see the guard in exits.js, because a
  // naive `candlesHeld >= 0` would close every position on its first candle.
  maxHoldCandles: C.MAX_HOLD_CANDLES,
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

  /* --- newdoc/ema.md, the EMA Trend Confirmation Engine -------------------- */
  //
  // The filter itself and its exit are switches rather than constants for one
  // reason: ema.md calls the entry filter MANDATORY, so both ship ON, and an
  // operator who turns either off has made a recorded decision rather than
  // discovered a default. The four thresholds below them are tunable because
  // the document specifies them in prose and gives no number for any — see
  // `[MUST-CONFIRM #18]`.
  emaFilterEnabled: true,
  emaExitOnCrossover: true,
  // §13.3's position validity filter, as an EXIT — split into its two halves so
  // they can be turned independently. v3.0 gives them one priority and treats
  // them as one rule; separating them is a deliberate departure, because the two
  // are not equally severe. A trend flip says the direction the trade was sold
  // into has reversed. A midpoint failure says this one candle consolidated —
  // §13.3's own design note calls that "strict, unforgiving" and the reason the
  // holding period is so short.
  //
  // Either off, the filter still EVALUATES and is still logged; it just does not
  // close. Neither reaches a safety exit, and neither can suppress the
  // unreadable-candle refusal (§3.8) that shares EXIT_FILTER_FAIL's code.
  trendBreakExitEnabled: true,
  filterFailExitEnabled: true,
  // Index POINTS, not premium points, and not paise. 0.25 is a quarter of one
  // NIFTY point — see EMA_FLAT_P in ./constants.js for why the band exists at all.
  emaFlatPoints: 0.25,
  emaChopLookback: 6,
  emaChopFlips: 3,
  emaCrossCooldownCandles: 2,

  /* --- the index-feed sanity check — see ./spotGuard.js -------------------- */
  //
  // Named spotCheck*, NOT spotGuard*, to keep it distinct from `stopGuardEnabled`
  // (§16.4), which is a completely different mechanism about a completely
  // different risk. Two settings one letter apart would be read wrong exactly
  // once, at the worst moment.
  //
  // Ships ON. It cost this desk a silent 734-point index error that no log line,
  // no preflight and no diagnostic caught.
  spotCheckEnabled: true,
  // Index POINTS. Generous on purpose: put-call parity over a two-day expiry and
  // a stale far-OTM leg are worth a handful of points, never a hundred. The
  // failure this exists for was 734.
  spotCheckMaxDivergencePoints: 100,
  // Below this many strikes quoting BOTH legs, the chain has no opinion and the
  // check says so rather than guessing.
  spotCheckMinPairs: 5,

  /* --- the synthetic index — see ./syntheticIndex.js ----------------------- */
  //
  // What the engine does when the index feed and the option chain disagree.
  //
  //   AUTO   use the quoted index; fall back to the chain-derived level while
  //          the two disagree, and switch back when they agree again
  //   OFF    never derive. A divergent feed simply stops the engine (the
  //          spot-check refuses the entry) — the behaviour before this existed
  //   FORCE  always derive, even when the quoted index looks fine. For proving
  //          the path works, not for a normal session
  //
  // AUTO ships, and on a healthy feed it does nothing at all.
  syntheticIndexMode: 'AUTO',
  // Strikes to derive from. Twelve legs sit comfortably inside NEO_QUOTE_BATCH
  // (25) alongside the index and the held option, so this costs no extra HTTP
  // request — the legs ride in the poll that was happening anyway.
  syntheticIndexStrikes: 6,

  // Ids from §22 that the desk has signed off. LIVE mode refuses to start while
  // any remain unsigned — §22, first paragraph.
  confirmed: [],
};

// A boolean setting, however it was stored.
//
// `Boolean(x)` is WRONG here and was wrong in nine places. Settings arrive from
// an HTML form as strings, and every one of them is truthy: `Boolean('false')`
// is `true`. A row written by a build whose route did not yet coerce a given key
// — which is exactly what happens when a new setting ships and the running app
// process is older than the code — stores the string "false", and every reader
// then sees the switch as ON while the settings page renders it as OFF.
//
// That is not hypothetical: `trendBreakExitEnabled` and `filterFailExitEnabled`
// were both turned off from the page, both stored as "false", and both went on
// closing positions. The route-level coercion is still the right place to
// normalise, but derive() must not DEPEND on it having happened.
function boolOf(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const t = String(v).trim().toLowerCase();
  if (t === 'false' || t === '0' || t === 'no' || t === 'off') return false;
  if (t === 'true' || t === '1' || t === 'yes' || t === 'on') return true;
  return fallback;
}

function withDefaults(s) {
  const out = { ...(s || {}) };
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (out[k] === undefined || out[k] === null || out[k] === '') out[k] = v;
    // Normalise EVERY boolean here rather than only in derive(). withDefaults()
    // is what the settings PAGE renders from, and the page tests raw truthiness
    // — `<%= settings.x ? 'selected' : '' %>`. A row holding the string "false"
    // therefore rendered the switch as ON while the database said off and the
    // engine, once boolOf() reached derive(), said off too: three readers, two
    // answers. Fixing derive() alone left the page lying.
    if (typeof v === 'boolean') out[k] = boolOf(out[k], v);
  }
  if (!Array.isArray(out.confirmed)) out.confirmed = [];
  return out;
}

/* -------------------------------------------------------------- validate -- */

function validate(raw, { lotSize = FALLBACK_LOT } = {}) {
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
  // §14.1 writes the ladder as "level k: entryPrice − k points", which fixes the
  // rung at one point. This is now a REAL control — the desk asked for a
  // half-point target — and `ladder.targetPriceFor` takes the rung as a
  // parameter, so the whole ladder, the trail and the locked-in progression
  // follow it together.
  //
  // Constrained to a multiple of the 5-paise TICK. An off-tick rung would put an
  // off-tick price on a target, and the exchange rejects those outright.
  const rungP = money.toPaise(s.initialTargetPoints);
  if (!Number.isFinite(rungP) || rungP < C.TICK) {
    errors.push(`initialTargetPoints must be at least ${C.TICK / 100} — one exchange tick`);
  } else if (rungP % C.TICK !== 0) {
    errors.push(`initialTargetPoints ${s.initialTargetPoints} is not a multiple of the `
      + `${C.TICK / 100} tick, so a target would land on a price the exchange rejects`);
  }

  wholeAtLeast('initialStopPoints', 1);
  wholeAtLeast('targetExtensionPoints', 1);
  wholeAtLeast('premiumSafetyExitPoints', 1);
  wholeAtLeast('maxHoldCandles', 0);
  wholeAtLeast('reentryWaitCandles', 0);
  wholeAtLeast('maxTradesPerDay', 1);
  wholeAtLeast('maxConsecutiveLosses', 1);
  wholeAtLeast('indexMinTicks', 0);
  wholeAtLeast('optionMinTicks', 0);
  wholeAtLeast('emaChopLookback', 0);
  wholeAtLeast('emaChopFlips', 0);
  wholeAtLeast('emaCrossCooldownCandles', 0);
  positive('emaFlatPoints', { allowZero: true });
  wholeAtLeast('spotCheckMinPairs', 1);
  wholeAtLeast('syntheticIndexStrikes', 3);
  if (!SYNTHETIC_MODES.includes(String(s.syntheticIndexMode).toUpperCase())) {
    errors.push(`syntheticIndexMode must be one of ${SYNTHETIC_MODES.join(', ')}`);
  }
  positive('spotCheckMaxDivergencePoints');

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

  // ema.md's chop rule counts SIDE CHANGES, so a window of n candles can hold at
  // most n-1 of them. A threshold above that cannot ever be reached, which does
  // not read as "the rule is off" anywhere — it reads as a configured filter
  // that silently never fires. Refused rather than warned for that reason.
  const chopLookback = Number(s.emaChopLookback);
  const chopFlips = Number(s.emaChopFlips);
  if (chopFlips > 0) {
    if (chopLookback < 2) {
      errors.push('emaChopLookback must be 2 or more while emaChopFlips is set — a window of '
        + 'fewer than two candles cannot contain a crossing. Set emaChopFlips to 0 to turn the '
        + 'chop rule off deliberately.');
    } else if (chopFlips > chopLookback - 1) {
      errors.push(`emaChopFlips (${chopFlips}) can never be reached inside emaChopLookback `
        + `(${chopLookback}) candles — the maximum possible is ${chopLookback - 1}. A rule that `
        + 'cannot fire is worse than one that is off, because nothing says so.');
    }
  }

  const unknownIds = (s.confirmed || []).map(Number)
    .filter(id => !C.MUST_CONFIRM_IDS.includes(id));
  if (unknownIds.length) {
    errors.push(`confirmed lists ids that are not in the §22 register: ${unknownIds.join(', ')}`);
  }

  if (errors.length) return { errors, warnings };

  /* --- warnings: legal, but the operator should have read them ------------ */

  const qty = Math.max(1, Number(s.lots) * (Number(lotSize) || FALLBACK_LOT));
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

  /* --- newdoc/ema.md ------------------------------------------------------ */

  // The warm-up, stated in the unit an operator restarting the process at 11:00
  // actually cares about. EMA20 first exists on the 20th completed candle and
  // the crossover test needs the one before it, so the filter is silent — and
  // therefore NO ENTRY IS POSSIBLE — for the first 21 candles of every process
  // life. That is 105 seconds, and it is the single most surprising consequence
  // of adding this filter.
  const warmCandles = C.EMA_SLOW + 1;
  warnings.push(`the EMA filter needs ${warmCandles} completed ${s.timeframeSeconds}s candles `
    + `before it will pass anything, so a restart costs about `
    + `${Math.ceil(warmCandles * Number(s.timeframeSeconds))}s of no entries while EMA`
    + `${C.EMA_FAST}/EMA${C.EMA_SLOW} warm up. The decision log says EMA_WARMING_UP throughout — `
    + 'that is the filter working, not a stalled feed.');

  if (!s.emaFilterEnabled) {
    warnings.push('emaFilterEnabled is OFF. ema.md makes the EMA confirmation a MANDATORY entry '
      + 'filter, so this configuration is the strategy WITHOUT its first trend filter: entries '
      + 'are decided by the 3-candle trend and the midpoint break alone, and nothing is stopping '
      + 'the engine selling into a sideways tape. Turn it back on unless this is a deliberate, '
      + 'recorded comparison run.');
  }
  if (Number(s.maxHoldCandles) === 0) {
    warnings.push('maxHoldCandles is 0, so §16.2.6\'s holding-time exit is OFF: a position with no '
      + 'target and no stop hit is held until the session square-off. Combined with a disabled '
      + 'position-validity filter there is no longer any exit that fires on TIME at all.');
  }
  if (!s.trendBreakExitEnabled) {
    warnings.push('trendBreakExitEnabled is OFF, so EXIT_TREND_BREAK no longer closes a position: '
      + 'a short held into a REVERSED trend stays open until the target, the stop or a safety exit '
      + 'takes it. This is the more severe half of §13.3 — the direction the trade was sold into '
      + 'has gone against it, and the stop is now the only thing sizing that loss.');
  }
  if (!s.filterFailExitEnabled) {
    warnings.push('filterFailExitEnabled is OFF, so EXIT_FILTER_FAIL no longer closes a position: '
      + 'a candle that stops breaking its midpoint while the trend still holds is no longer an '
      + 'exit. This is the milder half of §13.3 and the one its design note calls "strict, '
      + 'unforgiving" — turning it off lengthens the hold without abandoning the direction. The '
      + 'unreadable-candle refusal (§3.8) still fires; this switch cannot reach it.');
  }
  if (!s.trendBreakExitEnabled && !s.filterFailExitEnabled) {
    warnings.push('BOTH halves of §13.3 are OFF, so no thesis failure closes a position at all. '
      + 'Replaying 2026-07-30 in that configuration made all three two-hour windows worse, because '
      + 'every loser then ran to the full stop instead of being cut early. Confirm initialStopPoints '
      + 'is what you are willing to lose on every losing trade before running this live.');
  }
  if (!s.emaExitOnCrossover) {
    warnings.push('emaExitOnCrossover is OFF, so ema.md\'s §Position Exit Rule is not enforced: a '
      + 'position whose EMA structure has inverted is held until the 3-candle trend break, the '
      + 'position-validity filter or the stop takes it out instead. Those are usually FASTER, '
      + 'which is why this is a warning rather than an error — but the crossover exit is the one '
      + 'that survives a candle the cycle dropped.');
  }

  if (Number(s.emaFlatPoints) === 0) {
    warnings.push('emaFlatPoints is 0, which reads ema.md\'s "EMA9 == EMA20" literally. Two '
      + 'floating averages of different periods are essentially never equal, so the flat-market '
      + 'rule will fire NEVER and the sideways filter is left with only its chop and crossover '
      + 'halves. `[MUST-CONFIRM #18]` ships 0.25.');
  } else if (Number(s.emaFlatPoints) > 5) {
    warnings.push(`emaFlatPoints is ${s.emaFlatPoints} index points. On 5-second NIFTY bars EMA9 `
      + 'and EMA20 are rarely further apart than that even in a strong move, so this band will '
      + 'read most of the session as flat and the engine will sit idle. Check the EMA_SIDEWAYS '
      + 'tally on /ose before trading it.');
  }

  if (Number(s.emaChopFlips) === 0) {
    warnings.push('emaChopFlips is 0 — ema.md\'s "price is moving repeatedly above and below '
      + 'EMA9" rule is OFF. The flat-band and fresh-crossover halves of the sideways filter still '
      + 'apply.');
  }
  if (Number(s.emaCrossCooldownCandles) === 0) {
    warnings.push('emaCrossCooldownCandles is 0 — ema.md\'s "EMA crossover has just occurred" '
      + 'rule is OFF, so the engine may enter on the crossover candle itself, which is the moment '
      + 'the separation between the two averages is smallest and least trustworthy.');
  }

  /* --- the index-feed sanity check ---------------------------------------- */

  if (!s.spotCheckEnabled) {
    warnings.push('spotCheckEnabled is OFF. Nothing then compares the index feed against the '
      + 'option chain, and a gateway that answers with a plausible but WRONG index level — which '
      + 'this account has done, by 734 points, with a 200 and no error — will drive the trend, '
      + 'both midpoints, the EMA filter and the at-the-money strike without anything noticing.');
  } else if (Number(s.spotCheckMaxDivergencePoints) > 300) {
    warnings.push(`spotCheckMaxDivergencePoints is ${s.spotCheckMaxDivergencePoints} index `
      + 'points. The failure this check exists for was 734 points, so a band this wide still '
      + 'catches it — but a smaller error, which is the kind that looks plausible, will pass. '
      + 'Put-call parity over a near expiry is worth single-digit points; 100 is the shipped '
      + 'default and there is little reason to widen it.');
  }

  const synthMode = String(s.syntheticIndexMode).toUpperCase();
  if (synthMode === 'FORCE') {
    warnings.push('syntheticIndexMode is FORCE: the index is derived from option premiums even '
      + 'when the quoted index is perfectly good. Every candle the strategy reads — its shape, '
      + 'its midpoints, its EMA — is then a function of option prices rather than of the index. '
      + 'That is a proving mode, not a trading one.');
  } else if (synthMode === 'OFF') {
    warnings.push('syntheticIndexMode is OFF: if the index feed goes wrong again the engine will '
      + 'refuse entries and sit idle rather than deriving the level from the chain. That is the '
      + 'safe answer and it was the behaviour before 2026-08-02 — just know it is a choice.');
  } else {
    warnings.push('syntheticIndexMode is AUTO. On a healthy feed this does nothing. If the index '
      + 'and the chain disagree, the engine switches to a level derived from option premiums and '
      + 'RESETS its candle buffer — which costs a full EMA warm-up (21 candles) at the switch, in '
      + 'each direction. A feed that flaps would spend the session warming up.');
  }

  if (Number(s.initialTargetPoints) < 1) {
    warnings.push(`initialTargetPoints is ${s.initialTargetPoints}, so every rung of the ladder `
      + `is ${s.initialTargetPoints} points — the first target, every extension and the trailing `
      + 'stop all move together. A smaller rung wins more often and wins less each time, and it '
      + 'does NOT reduce the loss: the stop is still initialStopPoints away. Read the break-even '
      + 'figure above before trading it.');
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

    // One rung, in paise. THE number the ladder is built on — see
    // ladder.targetPriceFor.
    _rungP: money.toPaise(s.initialTargetPoints),
    _initialTargetP: money.toPaise(s.initialTargetPoints),
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

    // The shape ./ema.js reads — `resolve()` there takes exactly these keys.
    // Built once here for the same reason `_gate` is: the ENTRY filter and the
    // crossover EXIT must see identical averages, or a position gets closed
    // under a different indicator from the one that opened it.
    _ema: Object.freeze({
      enabled: boolOf(s.emaFilterEnabled, true),
      exitOnCrossover: boolOf(s.emaExitOnCrossover, true),
      emaFast: C.EMA_FAST,
      emaSlow: C.EMA_SLOW,
      emaFlatP: money.toPaise(s.emaFlatPoints),
      emaChopLookback: Math.trunc(Number(s.emaChopLookback)),
      emaChopFlips: Math.trunc(Number(s.emaChopFlips)),
      emaCrossCooldown: Math.trunc(Number(s.emaCrossCooldownCandles)),
      warmupCandles: C.EMA_SLOW + 1,
    }),

    // The shape ./spotGuard.js reads. Paise, converted once here, so no call
    // site can convert index points differently.
    _spotCheck: Object.freeze({
      enabled: boolOf(s.spotCheckEnabled, true),
      maxDivergenceP: money.toPaise(s.spotCheckMaxDivergencePoints),
      minPairs: Math.trunc(Number(s.spotCheckMinPairs)),
    }),

    // The shape ./syntheticIndex.js and the engine's source switch read.
    _synthetic: Object.freeze({
      mode: String(s.syntheticIndexMode).toUpperCase(),
      strikes: Math.trunc(Number(s.syntheticIndexStrikes)),
      // Two poll intervals. A leg that has survived two polls without an update
      // is one the gateway is not refreshing, and a stale leg moves `C − P` for
      // a reason that is not the index.
      maxSampleAgeMs: 2 * Math.max(1, config.neo.pollMs),
      minStrikes: Math.max(3, Math.ceil(Math.trunc(Number(s.syntheticIndexStrikes)) / 2)),
    }),

    // The shape ./exits.js and ./ladder.js read.
    _rules: Object.freeze({
      // The ladder's rung. `targetExtensionPoints` is how many RUNGS an
      // extension advances; this is how big a rung is.
      rungP: money.toPaise(s.initialTargetPoints),
      targetExtensionPoints: Math.trunc(Number(s.targetExtensionPoints)),
      premiumSafetyExitPoints: Math.trunc(Number(s.premiumSafetyExitPoints)),
      trailingStopEnabled: boolOf(s.trailingStopEnabled, true),
      // §16.4. Read by the safety timer, not by the candle cycle — the guard
      // exists precisely for the moments the candle cycle cannot see.
      stopGuardEnabled: boolOf(s.stopGuardEnabled, true),
      maxHoldCandles: Math.trunc(Number(s.maxHoldCandles ?? C.MAX_HOLD_CANDLES)),
      liquidityMode: String(s.liquidityMode).toUpperCase(),
      premiumMinP: money.toPaise(s.premiumMin),
      premiumMaxP: money.toPaise(s.premiumMax),
      // ema.md §Position Exit Rule. Read by exits.onCandle(), which is handed
      // `_rules` and nothing else.
      emaExitOnCrossover: boolOf(s.emaExitOnCrossover, true),
      // §13.3 as an exit, per half. Same channel: exits.onCandle() sees `_rules`.
      trendBreakExitEnabled: boolOf(s.trendBreakExitEnabled, true),
      filterFailExitEnabled: boolOf(s.filterFailExitEnabled, true),
    }),

    _risk: Object.freeze({
      maxOpenTrades: Math.trunc(Number(s.maxOpenTrades)),
      maxTradesPerDay: Math.trunc(Number(s.maxTradesPerDay)),
      maxConsecutiveLosses: Math.trunc(Number(s.maxConsecutiveLosses)),
      tradeOnExpiryDay: boolOf(s.tradeOnExpiryDay, false),
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
function breakevenNote(s, lotSize = FALLBACK_LOT) {
  const w = withDefaults(s);
  const qty = Math.max(1, Number(w.lots) * Number(lotSize || FALLBACK_LOT));
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

// The contract size the exchange is using, or the fallback when the master is
// unreachable. Small and cached-free on purpose: it is read once per settings
// load, not per cycle.
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
  const { errors, warnings } = validate(raw, { lotSize: await lotSizeFor(raw?.index) });
  if (errors.length) {
    throw new ValidationError(
      `the Option Selling Engine settings are invalid:\n  - ${errors.join('\n  - ')}`);
  }

  // Logged only when the SET of warnings changes.
  //
  // `load()` is called on the engine's settings-reload timer every five seconds,
  // and it used to re-log every warning on every call — seven lines each time,
  // eighty-four a minute, for a configuration nobody had touched. It buried the
  // lines that carry information: a source switch, a parity re-centre and a halt
  // all scrolled past inside a wall of advice about premium safety exits.
  //
  // Keyed by the warnings themselves, not by a timer, so a change an operator
  // just saved is still announced immediately.
  const signature = `${name} ${warnings.join(' ')}`;
  if (_lastWarned.get(name) !== signature) {
    _lastWarned.set(name, signature);
    for (const w of warnings) logger.warn('ose settings: ' + w);
  }

  const derived = derive(raw);
  assertLiveAllowed(derived);
  return derived;
}

async function save(name, patch) {
  const current = (await repo.settings.get(name)) || {};
  const merged = withDefaults({ ...current, ...patch });
  delete merged._name; delete merged._version; delete merged._updatedAt;

  const { errors, warnings } = validate(merged, { lotSize: await lotSizeFor(merged.index) });
  if (errors.length) {
    throw new ValidationError(
      `the Option Selling Engine settings are invalid:\n  - ${errors.join('\n  - ')}`);
  }
  await repo.settings.save(name, merged);
  return { settings: derive(merged), warnings };
}

module.exports = {
  PROFILE, DEFAULTS, MODES, LIQUIDITY_MODES, SYNTHETIC_MODES,
  withDefaults, validate, derive,
  unsignedItems, assertLiveAllowed, breakevenNote, lotSizeFor, FALLBACK_LOT,
  load, save,
};
