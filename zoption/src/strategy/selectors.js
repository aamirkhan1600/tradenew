// Expiry and strike selection. Pure functions over a chain — no I/O, no clock,
// no network — so the whole of "which contract does the strategy trade" is
// testable without a broker.
//
// Both selections run EXACTLY ONCE per cycle, before the strike lock closes.
// After that the answer is frozen until both legs are flat. That is the single
// rule every source document repeats, and it is enforced structurally: nothing
// here is reachable from the state machine.

const { ValidationError } = require('../core/errors');

/* ---------------------------------------------------------------- expiry -- */

// `expiries` is the ascending list of dates the instrument master actually
// carries. It is the only source of truth for what exists — a hardcoded weekday
// silently trades the wrong contract the first time the exchange moves expiry
// day, and NSE has moved it more than once.
function selectExpiry({ mode, expiries, manualExpiry = null }) {
  const list = (expiries || []).filter(Boolean).slice().sort();
  if (!list.length) throw new ValidationError('no expiries in the instrument master — sync it first');

  switch (String(mode || 'CURRENT_WEEKLY').toUpperCase()) {
    case 'CURRENT_WEEKLY':
      return list[0];

    case 'NEXT_WEEKLY':
      if (list.length < 2) throw new ValidationError('the master carries only one expiry — NEXT_WEEKLY is unavailable');
      return list[1];

    case 'MONTHLY': {
      // The monthly is the last expiry of its calendar month. Picking "the
      // furthest date in the nearest month with more than one expiry" would be
      // wrong in a month whose weeklies have already passed, so the rule is
      // stated directly: for each month, the last date; take the nearest such.
      const byMonth = new Map();
      for (const d of list) {
        const key = d.slice(0, 7);
        if (!byMonth.has(key) || d > byMonth.get(key)) byMonth.set(key, d);
      }
      const monthlies = [...byMonth.values()].sort();
      return monthlies[0];
    }

    case 'MANUAL': {
      if (!manualExpiry) throw new ValidationError('expiryMode is MANUAL but manualExpiry is not set');
      if (!list.includes(manualExpiry)) {
        throw new ValidationError(
          `manualExpiry ${manualExpiry} is not in the master (have ${list.slice(0, 4).join(', ')}…)`);
      }
      return manualExpiry;
    }

    default:
      throw new ValidationError(`unknown expiryMode "${mode}"`);
  }
}

/* ---------------------------------------------------------------- strike -- */

// The strike ladder step, read from the chain rather than assumed. NIFTY is 50
// today and has not always been.
function strikeStep(chain) {
  const strikes = [...new Set(chain.map(r => Number(r.strike)))].sort((a, b) => a - b);
  if (strikes.length < 2) return 50;
  const gaps = [];
  for (let i = 1; i < strikes.length; i++) gaps.push(strikes[i] - strikes[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] || 50;      // median gap
}

function atmStrike(spot, step) {
  return Math.round(Number(spot) / step) * step;
}

const rowsOfType = (chain, type) => chain.filter(r => r.option_type === type || r.optionType === type);

function findStrike(chain, type, strike) {
  return rowsOfType(chain, type).find(r => Number(r.strike) === Number(strike)) || null;
}

// Mode 1 — ATM. Both legs on the money.
// Mode 2 — ATM_OFFSET. `atmOffset` steps AWAY from the money on each side:
//          CE goes up, PE goes down, which is what makes them both OTM.
// Mode 3 — PREMIUM. The strike whose live premium sits nearest `targetPremium`,
//          inside `targetPremium ± premiumTolerance`. If nothing is inside the
//          band the answer is NO TRADE — not the nearest miss. A selector that
//          quietly returns the closest strike outside tolerance turns a
//          configured constraint into a suggestion.
//
// `premiumPaise` is a lookup token -> paise. It is used ONLY here, to choose a
// contract. It never reaches the entry price: that comes from a closed candle.
function selectStrikes({
  chain, spot, mode, atmOffset = 0, targetPremium = 0, premiumTolerance = 0,
  tradeMode = 'BOTH', premiumPaise = () => null,
}) {
  if (!chain || !chain.length) throw new ValidationError('the option chain is empty for this expiry');

  const step = strikeStep(chain);
  const atm = atmStrike(spot, step);
  const wantCE = tradeMode === 'BOTH' || tradeMode === 'CE';
  const wantPE = tradeMode === 'BOTH' || tradeMode === 'PE';

  const out = { atm, step, ce: null, pe: null, reason: null };

  const upper = String(mode || 'ATM').toUpperCase();

  if (upper === 'ATM' || upper === 'ATM_OFFSET') {
    const steps = upper === 'ATM_OFFSET' ? Math.trunc(atmOffset) : 0;
    if (wantCE) out.ce = findStrike(chain, 'CE', atm + steps * step);
    if (wantPE) out.pe = findStrike(chain, 'PE', atm - steps * step);
    if (wantCE && !out.ce) out.reason = `no CE at strike ${atm + steps * step}`;
    if (wantPE && !out.pe) out.reason = `no PE at strike ${atm - steps * step}`;
    return out;
  }

  if (upper === 'PREMIUM') {
    const targetP = Math.round(Number(targetPremium) * 100);
    const tolP = Math.round(Number(premiumTolerance) * 100);
    const lo = targetP - tolP;
    const hi = targetP + tolP;

    const best = (type) => {
      let winner = null;
      let winnerDistance = Infinity;
      for (const row of rowsOfType(chain, type)) {
        const p = premiumPaise(row.token);
        if (p == null || p <= 0) continue;
        if (p < lo || p > hi) continue;
        const distance = Math.abs(p - targetP);
        // Ties break toward the FURTHER strike — further out of the money is
        // the safer of two contracts the band likes equally.
        if (distance < winnerDistance
          || (distance === winnerDistance && winner
              && (type === 'CE' ? Number(row.strike) > Number(winner.strike)
                : Number(row.strike) < Number(winner.strike)))) {
          winner = row;
          winnerDistance = distance;
        }
      }
      return winner;
    };

    if (wantCE) out.ce = best('CE');
    if (wantPE) out.pe = best('PE');
    if ((wantCE && !out.ce) || (wantPE && !out.pe)) {
      out.reason = `no strike with a premium inside ₹${targetPremium} ± ${premiumTolerance}`;
    }
    return out;
  }

  throw new ValidationError(`unknown strikeMode "${mode}"`);
}

module.exports = { selectExpiry, selectStrikes, strikeStep, atmStrike, findStrike };
