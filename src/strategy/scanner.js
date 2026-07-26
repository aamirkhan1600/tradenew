// The premium scanner: "find an option inside the premium range", and then the
// hedge to protect it.
//
// Pure. Takes a chain snapshot plus a `priceOf(zToken)` lookup and returns a
// decision with its reasoning. No broker, no database, no clock — which is what
// makes the doc's worked example replayable as a test.
//
// Selection rule from the spec:
//   1. keep OTM strikes whose premium lies inside [premiumMin, premiumMax]
//   2. take the one whose premium is NEAREST the configured arm price
//   3. break ties toward the farther-OTM strike (same premium, less risk)

const { round } = require('../core/money');

// The chain's strike interval, taken as the most common gap between adjacent
// strikes. The mode rather than the minimum, because the wings of a chain often
// have missing contracts that would make a naive diff far too small.
function strikeInterval(chain) {
  if (!Array.isArray(chain) || chain.length < 2) return null;
  const counts = new Map();
  for (let i = 1; i < chain.length; i++) {
    const gap = round(chain[i].strike - chain[i - 1].strike);
    if (gap > 0) counts.set(gap, (counts.get(gap) || 0) + 1);
  }
  let best = null; let bestCount = 0;
  for (const [gap, n] of counts) {
    if (n > bestCount) { best = gap; bestCount = n; }
  }
  return best;
}

// Every quotable, tradable, correctly-OTM leg with its live premium.
// Rejections are collected with a reason so an empty scan can explain itself
// rather than just reporting "no strike found".
function collectLegs({ chain, priceOf, spot, config }) {
  const wantCE = config.optionType === 'CE' || config.optionType === 'BOTH';
  const wantPE = config.optionType === 'PE' || config.optionType === 'BOTH';
  const maxAge = Number(config.maxQuoteAgeMs) || 15000;
  const legs = [];
  const rejected = [];

  for (const row of chain) {
    for (const side of ['ce', 'pe']) {
      const cell = row[side];
      if (!cell) continue;
      const optionType = side.toUpperCase();
      if (optionType === 'CE' && !wantCE) continue;
      if (optionType === 'PE' && !wantPE) continue;

      // Sell OTM only: a call strike must sit above spot, a put below.
      if (config.otmOnly !== false && spot != null) {
        if (optionType === 'CE' && row.strike <= spot) continue;
        if (optionType === 'PE' && row.strike >= spot) continue;
      }
      // Quotable on Zerodha but not orderable on Kotak: never selectable.
      if (!cell.tradable) {
        rejected.push({ strike: row.strike, optionType, reason: 'no Kotak contract mapped' });
        continue;
      }
      const q = priceOf(cell.zToken);
      if (!q || !(q.ltp > 0)) {
        rejected.push({ strike: row.strike, optionType, reason: 'no quote' });
        continue;
      }
      if (q.ageMs != null && q.ageMs > maxAge) {
        rejected.push({
          strike: row.strike, optionType,
          reason: `quote ${Math.round(q.ageMs / 1000)}s stale`,
        });
        continue;
      }
      legs.push({
        optionType, strike: row.strike, premium: round(q.ltp),
        ageMs: q.ageMs ?? null, cell,
      });
    }
  }
  return { legs, rejected };
}

function selectStrike({ chain, priceOf, spot, config }) {
  const { legs, rejected } = collectLegs({ chain, priceOf, spot, config });
  const inRange = [];

  for (const leg of legs) {
    if (leg.premium < config.premiumMin || leg.premium > config.premiumMax) {
      rejected.push({
        strike: leg.strike, optionType: leg.optionType, premium: leg.premium,
        reason: `premium ${leg.premium} outside [${config.premiumMin}, ${config.premiumMax}]`,
      });
      continue;
    }
    inRange.push(leg);
  }

  if (!inRange.length) {
    return {
      selected: null, candidates: [], rejected,
      reason: `no strike inside the premium range ${config.premiumMin}–${config.premiumMax}`
        + ` (${legs.length} quoted, ${rejected.length} rejected)`,
    };
  }

  const arm = Number(config.armPrice);
  const ranked = inRange.slice().sort((a, b) => {
    const da = Math.abs(a.premium - arm);
    const db = Math.abs(b.premium - arm);
    if (da !== db) return da - db;
    if (spot == null) return 0;
    return Math.abs(b.strike - spot) - Math.abs(a.strike - spot);   // farther OTM wins
  });

  const selected = ranked[0];
  return {
    selected,
    candidates: ranked,
    rejected,
    reason: `${selected.optionType} ${selected.strike} @ ${selected.premium}`
      + ` — nearest to arm price ${arm} of ${inRange.length} in range`,
  };
}

// The hedge is a further-OTM long leg of the SAME option type, bought before
// the short is sold. Two rules must hold in both modes:
//   * strictly further OTM than the short (otherwise it is not a hedge)
//   * cheaper than the short (otherwise the spread is inverted and the
//     structure cannot profit)
function selectHedge({ chain, priceOf, config, short }) {
  const direction = short.optionType === 'CE' ? 1 : -1;
  const interval = strikeInterval(chain);
  const maxAge = Number(config.maxQuoteAgeMs) || 15000;
  const side = short.optionType.toLowerCase();
  const rejected = [];
  const legs = [];

  for (const row of chain) {
    const cell = row[side];
    if (!cell || !cell.tradable) continue;
    const furtherOtm = direction === 1 ? row.strike > short.strike : row.strike < short.strike;
    if (!furtherOtm) continue;

    const q = priceOf(cell.zToken);
    if (!q || !(q.ltp > 0)) continue;
    if (q.ageMs != null && q.ageMs > maxAge) continue;
    if (q.ltp >= short.premium) {
      rejected.push({ strike: row.strike, reason: `premium ${round(q.ltp)} not below the short's ${short.premium}` });
      continue;
    }
    if (config.hedgeMaxPremium != null && q.ltp > config.hedgeMaxPremium) {
      rejected.push({ strike: row.strike, reason: `premium ${round(q.ltp)} above cap ${config.hedgeMaxPremium}` });
      continue;
    }
    legs.push({ optionType: short.optionType, strike: row.strike, premium: round(q.ltp), cell });
  }

  if (!legs.length) {
    return { hedge: null, interval, rejected, reason: 'no tradable hedge strike with a live quote' };
  }

  if (config.hedgeMode === 'PREMIUM') {
    const want = Number(config.hedgePremium);
    legs.sort((a, b) => {
      const d = Math.abs(a.premium - want) - Math.abs(b.premium - want);
      if (d !== 0) return d;
      return Math.abs(a.strike - short.strike) - Math.abs(b.strike - short.strike);
    });
    return {
      hedge: legs[0], interval, rejected,
      reason: `hedge by premium ≈ ${want} → ${legs[0].strike} @ ${legs[0].premium}`,
    };
  }

  // STRIKE mode. Aim for exactly N intervals out. If that contract is missing or
  // unquoted, fall back to the nearest strike AT OR BEYOND the target, never
  // closer — a hedge nearer than configured silently increases the risk.
  if (!interval) {
    return { hedge: null, interval, rejected, reason: 'cannot infer the chain strike interval' };
  }
  const targetStrike = round(short.strike + direction * interval * Number(config.hedgeDistance));
  const atOrBeyond = legs.filter(l => (direction === 1 ? l.strike >= targetStrike : l.strike <= targetStrike));
  if (!atOrBeyond.length) {
    return {
      hedge: null, interval, rejected,
      reason: `no strike at or beyond ${targetStrike} (${config.hedgeDistance} intervals out) is quotable`,
    };
  }
  atOrBeyond.sort((a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike));
  return {
    hedge: atOrBeyond[0], interval, rejected,
    reason: `hedge ${config.hedgeDistance} strikes out (target ${targetStrike})`
      + ` → ${atOrBeyond[0].strike} @ ${atOrBeyond[0].premium}`,
  };
}

// One call that produces the complete entry candidate, or explains why not.
function findCandidate({ chain, priceOf, spot, config }) {
  const strikeResult = selectStrike({ chain, priceOf, spot, config });
  if (!strikeResult.selected) {
    return { ok: false, reason: strikeResult.reason, strikeResult };
  }
  const hedgeResult = selectHedge({ chain, priceOf, config, short: strikeResult.selected });
  if (!hedgeResult.hedge) {
    return {
      ok: false,
      reason: `strike ${strikeResult.selected.strike} found but ${hedgeResult.reason}`,
      strikeResult, hedgeResult,
    };
  }
  return {
    ok: true,
    short: strikeResult.selected,
    hedge: hedgeResult.hedge,
    interval: hedgeResult.interval,
    reason: `${strikeResult.reason} · ${hedgeResult.reason}`,
    strikeResult, hedgeResult,
  };
}

// Which instrument tokens the feed should stay subscribed to. Kept wider than
// the tradable range so the hedge search and a drifting spot are both covered
// without re-subscribing on every tick.
function subscriptionWindow({ chain, spot, config }) {
  const interval = strikeInterval(chain) || 0;
  const width = interval * (Number(config.scanStrikes) || 25);
  const tokens = [];
  for (const row of chain) {
    if (spot != null && width > 0 && Math.abs(row.strike - spot) > width) continue;
    if (row.ce) tokens.push(row.ce.zToken);
    if (row.pe) tokens.push(row.pe.zToken);
  }
  return tokens;
}

module.exports = {
  strikeInterval, collectLegs, selectStrike, selectHedge, findCandidate, subscriptionWindow,
};
