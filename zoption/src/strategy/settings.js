// Settings: load, validate, normalise.
//
// Two jobs beyond reading a row. First, refuse to run a configuration that
// contradicts the strategy — `useLiveAsk: true` is not a preference the engine
// can honour, it is a request for a different strategy, and the honest response
// is to stop rather than to quietly ignore it.
//
// Second, warn about combinations that are legal but almost certainly not what
// the operator meant. `positionTimeout: 60` with `candleTimeframe: "1m"` is the
// one that matters: a position opened mid-bar and timed out at 60 seconds will
// mostly exit on TIMEOUT before target or stop gets a fair chance, so the
// strategy ends up measuring its own timeout. Both are defaults in the source
// documents, and they conflict.

const time = require('../core/time');
const money = require('../core/money');
const repo = require('../repositories');
const logger = require('../core/logger');
const config = require('../config');
const trendFilter = require('./trendFilter');
const { ValidationError } = require('../core/errors');

// The index trend filter arrived after the first deploy, so a stored profile can
// legitimately be missing every one of these keys. They are filled in on read
// rather than assumed present — an old row must keep booting, and validating a
// field nobody has ever set would turn an upgrade into an outage.
//
// `trendFilter: false` is the safe default: an upgrade changes nothing until the
// operator turns it on.
const TREND_DEFAULTS = {
  // A leg that never gets permission to enter stands down after this many
  // seconds so the cycle can release the strike. 0 disables it — and with a
  // one-sided trend filter and `tradeMode: BOTH`, disabling it means the cycle
  // can deadlock until the square-off. See the warning in validate().
  legEntryTimeout: 180,

  // How long a locked strike may keep being re-used under `cycleScope: PER_LEG`
  // before the cycle is allowed to close and a fresh strike is selected. 0 =
  // unlimited, which under PER_LEG means a strike chosen at 09:20 can still be
  // sold at 15:00 against a spot hundreds of points away.
  cycleMaxAge: 900,

  trendFilter: false,
  trendTimeframe: '5s',
  trendConfirmBars: 3,
  trendBodyPct: 60,          // classification: body share of the range
  trendCloseNearPct: 25,     // classification: how near the extreme the close is
  trendStrongBodyPct: 70,    // score: the +2 body term
  trendWickPct: 15,          // score: the opposing-wick and at-the-extreme terms
  trendMaxRangePoints: 10,   // combined across the whole window, not per bar
  trendMinScore: 5,          // out of 5; 0 leaves the plain direction rule
  trendMinTicks: 4,          // a bar built from fewer samples measured nothing
  trendMomentum: true,       // skip when the bars' ranges keep shrinking

  // --- the dynamic target and trailing stop (doc/traling-traget -stoploss.md) -
  // Also off by default. It changes what a winning trade is worth, which is not
  // something to inherit from an upgrade.
  dynamicTarget: false,
  dynamicTargetStep: 1.0,    // points added to the target per confirmation
  dynamicTargetMax: 4,       // confirmations; past this, no target — trail only
  trailStart: 0.5,           // profit needed before the trail engages
  trailGap: 0.5,             // the stop sits this far above the best premium
  // Off with the rest of the family. It is usable on its own — "do not ladder my
  // target, but do get me out when the trend turns" is a coherent setup — but
  // nothing in this group should switch itself on during an upgrade.
  exitOnReversal: false,
};

function withDefaults(s) {
  const out = { ...s };
  for (const [k, v] of Object.entries(TREND_DEFAULTS)) {
    if (out[k] === undefined || out[k] === null || out[k] === '') out[k] = v;
  }
  return out;
}

const EXPIRY_MODES = ['CURRENT_WEEKLY', 'NEXT_WEEKLY', 'MONTHLY', 'MANUAL'];
const STRIKE_MODES = ['ATM', 'ATM_OFFSET', 'PREMIUM'];
const TRADE_MODES = ['BOTH', 'CE', 'PE'];
const CYCLE_SCOPES = ['BOTH_LEGS', 'PER_LEG'];
const MODES = ['PAPER', 'LIVE'];

function validate(raw) {
  const s = withDefaults(raw);
  const errors = [];
  const warnings = [];

  const oneOf = (field, allowed) => {
    if (!allowed.includes(String(s[field] || '').toUpperCase())) {
      errors.push(`${field} must be one of ${allowed.join(', ')} (got "${s[field]}")`);
    }
  };

  oneOf('expiryMode', EXPIRY_MODES);
  oneOf('strikeMode', STRIKE_MODES);
  oneOf('tradeMode', TRADE_MODES);
  oneOf('cycleScope', CYCLE_SCOPES);
  oneOf('mode', MODES);

  if (!time.isTimeframe(s.candleTimeframe)) {
    errors.push(`candleTimeframe must be one of ${Object.keys(time.TIMEFRAMES).join(', ')}`);
  }
  if (!time.isTimeframe(s.trendTimeframe)) {
    errors.push(`trendTimeframe must be one of ${Object.keys(time.TIMEFRAMES).join(', ')}`);
  }

  // The entry price comes from a closed candle. These three flags exist in the
  // source documents as explicit `false`s, so an operator who sets one to true
  // is asking for the v2.0 ask-based entry that v3.0 supersedes. Refuse rather
  // than silently do something else.
  for (const flag of ['useLiveAsk', 'useLiveBid', 'useLTP']) {
    if (s[flag] === true) {
      errors.push(`${flag} must be false — the entry price comes from a closed candle, `
        + 'never from live data. See doc/PROJECT_PLAN.md §2 R1.');
    }
  }
  if (s.lockStrike === false) {
    errors.push('lockStrike must be true — the strike is selected once per cycle and held '
      + 'until both legs are flat. See doc/PROJECT_PLAN.md §2 R6.');
  }
  if (String(s.priceSource || '').toUpperCase() !== 'CANDLE_CLOSE') {
    errors.push('priceSource must be CANDLE_CLOSE');
  }

  const positive = (field, { allowZero = false } = {}) => {
    const v = Number(s[field]);
    if (!Number.isFinite(v) || (allowZero ? v < 0 : v <= 0)) {
      errors.push(`${field} must be a ${allowZero ? 'non-negative' : 'positive'} number`);
    }
  };
  positive('sellOffset', { allowZero: true });
  positive('target');
  positive('stopLoss');
  positive('pendingTimeout');
  positive('positionTimeout');
  positive('lots');
  positive('legEntryTimeout', { allowZero: true });    // 0 = never stand down
  positive('cycleMaxAge', { allowZero: true });        // 0 = re-use forever

  // --- the index trend filter (doc/update-point.md) --------------------------
  const inRange = (field, lo, hi) => {
    const v = Number(s[field]);
    if (!Number.isFinite(v) || v < lo || v > hi) {
      errors.push(`${field} must be between ${lo} and ${hi} (got "${s[field]}")`);
    }
  };
  inRange('trendConfirmBars', 1, 10);
  inRange('trendBodyPct', 0, 100);
  inRange('trendCloseNearPct', 0, 100);
  inRange('trendStrongBodyPct', 0, 100);
  inRange('trendWickPct', 0, 100);
  inRange('trendMinScore', 0, trendFilter.MAX_SCORE);
  inRange('trendMinTicks', 0, 100);
  positive('trendMaxRangePoints');

  positive('dynamicTargetStep');
  inRange('dynamicTargetMax', 1, 20);
  positive('trailStart', { allowZero: true });
  positive('trailGap', { allowZero: true });          // 0 = no trailing

  // Both features read the same 3×5s index verdict. Without the filter running
  // there is no verdict to read, so this would be a switch that silently does
  // nothing — refuse it instead.
  if ((s.dynamicTarget || s.exitOnReversal) && !s.trendFilter) {
    const which = [s.dynamicTarget ? 'dynamicTarget' : null, s.exitOnReversal ? 'exitOnReversal' : null]
      .filter(Boolean).join(' and ');
    warnings.push(`${which} needs the index trend filter to have anything to react to — `
      + 'trendFilter is off, so the target ladder and the reversal exit will never fire');
  }

  if (Number(s.trendStrongBodyPct) < Number(s.trendBodyPct)) {
    warnings.push(`trendStrongBodyPct (${s.trendStrongBodyPct}) is below trendBodyPct `
      + `(${s.trendBodyPct}) — the quality score's body point is then earned by every bar `
      + 'the classifier already accepted, so it stops discriminating');
  }

  for (const field of ['sessionStart', 'sessionEnd', 'squareOffAt']) {
    try { time.parseHhMm(s[field]); } catch (err) { errors.push(err.message); }
  }
  if (!errors.length) {
    if (time.parseHhMm(s.sessionStart) >= time.parseHhMm(s.sessionEnd)) {
      errors.push('sessionStart must be before sessionEnd');
    }
    if (time.parseHhMm(s.squareOffAt) < time.parseHhMm(s.sessionEnd)) {
      warnings.push(`squareOffAt (${s.squareOffAt}) is before sessionEnd (${s.sessionEnd}) — `
        + 'entries would be allowed after the flatten');
    }
  }

  if (Number(s.stopLoss) <= Number(s.target)) {
    warnings.push(`stopLoss (${s.stopLoss}) is not larger than target (${s.target}) — `
      + 'the strategy needs a hit rate above 50% just to break even before charges');
  }

  if (!errors.length) {
    const candleSec = time.timeframeSeconds(s.candleTimeframe);
    if (Number(s.positionTimeout) < candleSec * 3) {
      warnings.push(`positionTimeout (${s.positionTimeout}s) is less than 3 candles `
        + `(${candleSec * 3}s at ${s.candleTimeframe}) — most trades will exit on TIMEOUT `
        + 'before target or stop gets a fair chance. See doc/PROJECT_PLAN.md §2 R7.');
    }
    if (Number(s.pendingTimeout) >= candleSec) {
      warnings.push(`pendingTimeout (${s.pendingTimeout}s) is not shorter than one candle `
        + `(${candleSec}s) — a working order will usually survive to the next close anyway`);
    }

    if (s.trendFilter) {
      const trendSec = time.timeframeSeconds(s.trendTimeframe);
      // The verdict expires one trend bar after the bar that produced it. If the
      // index bar is WIDER than the option bar, most option closes land on an
      // already-expired verdict and the filter degenerates into "never trade".
      if (trendSec > candleSec) {
        warnings.push(`trendTimeframe (${s.trendTimeframe}) is wider than candleTimeframe `
          + `(${s.candleTimeframe}) — the trend verdict expires ${trendSec}s after each index `
          + 'close, so many option closes would find no valid verdict and be skipped');
      }
      if (String(s.tradeMode).toUpperCase() === 'BOTH') {
        const stand = Number(s.legEntryTimeout);
        if (!stand) {
          // Not a style note — this configuration deadlocks. The cycle unlocks
          // only when BOTH legs are DONE; a one-sided trend filter means the
          // blocked leg never enters, never finishes, and holds the strike until
          // the square-off. legEntryTimeout is the thing that breaks it.
          errors.push('the index trend filter with tradeMode BOTH and legEntryTimeout 0 '
            + 'deadlocks the cycle: a bullish index permits only the PE, so the CE leg never '
            + 'enters, never reaches DONE, and the strike stays locked until squareOffAt. '
            + 'Set legEntryTimeout above 0, or trade one side with tradeMode CE or PE.');
        } else if (String(s.cycleScope).toUpperCase() === 'PER_LEG') {
          warnings.push('the index trend filter is on with tradeMode BOTH — a bullish index '
            + 'permits only the PE and a bearish index only the CE, so the legs no longer enter '
            + `together. The blocked leg stands down after ${stand}s (legEntryTimeout) while the `
            + 'permitted one keeps re-entering, and it stays out until the cycle closes (up to '
            + `cycleMaxAge ${s.cycleMaxAge}s) even if the index later turns in its favour. `
            + 'See doc/update-point.md.');
        } else {
          warnings.push('the index trend filter is on with tradeMode BOTH — a bullish index '
            + 'permits only the PE and a bearish index only the CE, so the legs no longer enter '
            + `together. The blocked leg stands down after ${stand}s (legEntryTimeout) and only `
            + 'THEN does the cycle re-select, so the permitted leg gets roughly one round trip '
            + `per ${stand}s and idles for the rest. cycleScope PER_LEG lets it keep trading `
            + 'instead. See doc/update-point.md.');
        }
      }
      const bars = Number(s.trendConfirmBars);
      if (bars >= 4 && trendSec * bars > candleSec * 2) {
        warnings.push(`trendConfirmBars (${bars}) × trendTimeframe (${trendSec}s) spans `
          + `${bars * trendSec}s of index history against a ${candleSec}s option candle — `
          + 'entries will be rare');
      }

      // The thin-bar guard against the feed's actual cadence. The REST quote
      // poller runs at NEO_POLL_MS and suppresses an unchanged price inside one
      // interval, so a quiet bar holds at most `trendSec / pollSec` samples —
      // fewer than trendMinTicks means the filter blocks on every quiet bar
      // unless the streaming socket is genuinely delivering.
      const pollSec = Math.max(0.001, config.neo.pollMs / 1000);
      const worstCaseTicks = Math.floor(trendSec / pollSec);
      if (worstCaseTicks < Number(s.trendMinTicks)) {
        warnings.push(`a ${trendSec}s index bar holds at most ${worstCaseTicks} samples on the `
          + `REST quote fallback (NEO_POLL_MS=${config.neo.pollMs}), under trendMinTicks `
          + `(${s.trendMinTicks}) — on a quiet tape every bar will read as NO_DATA and no `
          + 'entry will be allowed. Lower trendMinTicks or confirm the market socket is streaming.');
      }
    }

    if (s.dynamicTarget) {
      // Past the top of the ladder the resting target is withdrawn on purpose.
      // With no trail either, the position is then left with only its original
      // fixed stop, the reversal exit and the clock — which is the opposite of
      // what "trail until reversal" asks for.
      if (!Number(s.trailGap)) {
        warnings.push('dynamicTarget is on with trailGap 0 — past '
          + `${s.dynamicTargetMax} confirmations the target is withdrawn and nothing trails, so `
          + 'the position runs on its original stop, the reversal exit and positionTimeout alone');
      }
      if (!s.exitOnReversal) {
        // "5th+ — trail until reversal" needs a reversal to trail until.
        warnings.push('dynamicTarget is on with exitOnReversal off — past '
          + `${s.dynamicTargetMax} confirmations the target is withdrawn and there is no `
          + 'reversal exit, so a winner is given back to the trailing stop or the clock');
      }
      if (s.trendFilter) {
        const trendSec = time.timeframeSeconds(s.trendTimeframe);
        const ladderSec = Number(s.dynamicTargetMax) * trendSec;
        if (Number(s.positionTimeout) < ladderSec) {
          warnings.push(`positionTimeout (${s.positionTimeout}s) is shorter than the `
            + `${ladderSec}s the ladder needs to reach ${s.dynamicTargetMax} confirmations at `
            + `${s.trendTimeframe} — the maximum hold will cut winners off before the ladder `
            + 'can finish developing');
        }
      }
    }

    if (String(s.cycleScope).toUpperCase() === 'PER_LEG') {
      // R6's stated trade-off, said out loud: the strike does not move while the
      // legs keep re-entering on it.
      if (!Number(s.cycleMaxAge)) {
        warnings.push('cycleScope PER_LEG with cycleMaxAge 0 — a leg re-enters on the same '
          + 'locked strike indefinitely, so a strike selected in the morning can still be sold '
          + 'in the afternoon against a spot hundreds of points away. See doc/PROJECT_PLAN.md §2 R6.');
      } else if (Number(s.cycleMaxAge) < Number(s.positionTimeout) * 2) {
        warnings.push(`cycleMaxAge (${s.cycleMaxAge}s) is under two position lifetimes `
          + `(${Number(s.positionTimeout) * 2}s) — a leg would rarely get a second round trip `
          + 'out of a strike, which is most of what PER_LEG is for');
      }
      if (String(s.strikeMode).toUpperCase() !== 'PREMIUM') {
        warnings.push(`cycleScope PER_LEG with strikeMode ${s.strikeMode} — the premium gate `
          + 'only band-checks in PREMIUM mode, so nothing but cycleMaxAge stops a leg from '
          + 're-entering on a strike the selector would no longer choose');
      }
    }

    // Not trend-specific: a leg stands down on this timer whatever is blocking
    // it, so the check belongs outside the filter's block.
    if (Number(s.legEntryTimeout) && Number(s.legEntryTimeout) < candleSec * 2) {
      warnings.push(`legEntryTimeout (${s.legEntryTimeout}s) is under two option candles `
        + `(${candleSec * 2}s at ${s.candleTimeframe}) — a leg would stand down before it had `
        + 'seen a couple of chances to enter');
    }
  }

  if (String(s.expiryMode).toUpperCase() === 'MANUAL' && !s.manualExpiry) {
    errors.push('expiryMode is MANUAL but manualExpiry is not set');
  }

  return { errors, warnings };
}

// Everything the engine actually runs on, precomputed in paise and milliseconds
// so no hot path has to convert.
function derive(raw) {
  const s = withDefaults(raw);
  return {
    ...s,
    _sellOffsetP: money.toPaise(s.sellOffset),
    _targetP: money.toPaise(s.target),
    _stopLossP: money.toPaise(s.stopLoss),
    _pendingTimeoutMs: Math.round(Number(s.pendingTimeout) * 1000),
    _positionTimeoutMs: Math.round(Number(s.positionTimeout) * 1000),
    _legEntryTimeoutMs: Math.round(Number(s.legEntryTimeout) * 1000),
    _dynamicStepP: money.toPaise(s.dynamicTargetStep),
    _trailStartP: money.toPaise(s.trailStart),
    _trailGapP: money.toPaise(s.trailGap),
    _candleSeconds: time.timeframeSeconds(s.candleTimeframe),
    _targetPremiumP: money.toPaise(s.targetPremium),
    _premiumToleranceP: money.toPaise(s.premiumTolerance),
    _trendSeconds: time.timeframeSeconds(s.trendTimeframe),
    // The trend filter's config, in the shape trendFilter.verdict() reads. Index
    // levels are carried in paise like every other price, so a points threshold
    // becomes paise here and nowhere else.
    _trend: {
      confirmBars: Math.trunc(Number(s.trendConfirmBars)),
      bodyPct: Number(s.trendBodyPct),
      closeNearPct: Number(s.trendCloseNearPct),
      strongBodyPct: Number(s.trendStrongBodyPct),
      wickPct: Number(s.trendWickPct),
      minScore: Number(s.trendMinScore),
      minTicks: Math.trunc(Number(s.trendMinTicks)),
      momentum: Boolean(s.trendMomentum),
      maxRangeP: money.toPaise(s.trendMaxRangePoints),
    },
  };
}

// The breakeven check the operator should see before a live session. A one-point
// target on one lot is mostly charges; saying so at boot is cheaper than
// discovering it from a week of "winning" trades that lost money.
function breakevenNote(s, lotSize) {
  const qty = Math.max(1, Number(s.lots) * Number(lotSize || 75));
  const entryP = money.toPaise(s.targetPremium || 12) + money.toPaise(s.sellOffset);
  const be = money.breakevenPaise({ entryPaise: entryP, qty, assumeTargetPaise: money.toPaise(s.target) });
  return {
    qty,
    chargesP: be.chargesPaise,
    breakevenPointsP: be.pointsPaise,
    targetP: money.toPaise(s.target),
    covered: money.toPaise(s.target) > be.pointsPaise,
  };
}

async function load(name = 'default') {
  const raw = await repo.settings.get(name);
  if (!raw) throw new ValidationError(`settings profile "${name}" does not exist — run npm run migrate`);
  const { errors, warnings } = validate(raw);
  if (errors.length) {
    throw new ValidationError(`the settings are invalid:\n  - ${errors.join('\n  - ')}`);
  }
  for (const w of warnings) logger.warn('settings: ' + w);
  return derive(raw);
}

async function save(name, patch) {
  const current = (await repo.settings.get(name)) || {};
  // Back-fill on write as well as on read: a profile that predates the trend
  // filter gets the keys persisted the first time anything is saved, so the
  // settings page shows real values rather than blanks.
  const merged = withDefaults({ ...current, ...patch });
  delete merged._name; delete merged._version; delete merged._updatedAt;
  const { errors, warnings } = validate(merged);
  if (errors.length) {
    throw new ValidationError(`the settings are invalid:\n  - ${errors.join('\n  - ')}`);
  }
  await repo.settings.save(name, merged);
  return { settings: derive(merged), warnings };
}

module.exports = {
  EXPIRY_MODES, STRIKE_MODES, TRADE_MODES, CYCLE_SCOPES, MODES, TREND_DEFAULTS,
  withDefaults, validate, derive, breakevenNote, load, save,
};
