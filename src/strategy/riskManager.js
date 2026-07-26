// Risk gates. Pure functions over the day's counters — no I/O — so the same
// rules can be evaluated in the engine, previewed in the UI, and tested.
//
// The distinction that matters here: a gate BLOCKS NEW ENTRIES, it never
// closes an open position. Hitting a daily loss limit must not trigger a
// panic exit at whatever the market happens to be showing; it stops the
// strategy from adding more risk and leaves the existing trade to its own
// target, stop and square-off.

const { round, formatInr } = require('../core/money');
const { istDate } = require('../core/time');

// "No more entries today" as a real instant rather than Infinity. The runtime is
// persisted as JSON, and JSON.stringify(Infinity) is `null` — which reads back
// as falsy and silently RE-ENABLES entry. Any restart would therefore undo
// `reentryAfterStop: false`, which is a shipped default.
function endOfTradingDay(now) {
  const ist = istDate(now);
  // 23:59 IST on the current IST date, expressed as an epoch instant.
  const midnightUtc = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  return midnightUtc - (5 * 60 + 30) * 60 * 1000 + 24 * 3600 * 1000 - 60000;
}

function emptyStats(tradeDate = null) {
  return {
    tradeDate, trades: 0, wins: 0, losses: 0,
    grossPnl: 0, charges: 0, netPnl: 0, blockedReason: null,
  };
}

// Why this strategy may not open a new position right now, or null if it may.
// Checked in the order an operator would ask about them.
function checkEntryGates({ config, stats }) {
  const s = stats || emptyStats();

  const maxTrades = Number(config.maxTradesPerDay);
  if (maxTrades > 0 && s.trades >= maxTrades) {
    return `daily trade limit reached (${s.trades} of ${maxTrades})`;
  }

  if (config.dailyMaxLoss != null) {
    const limit = Math.abs(Number(config.dailyMaxLoss));
    if (s.netPnl <= -limit) {
      return `daily loss limit hit (${formatInr(s.netPnl)} against a ${formatInr(-limit)} limit)`;
    }
  }

  if (config.dailyMaxProfit != null) {
    const target = Math.abs(Number(config.dailyMaxProfit));
    if (s.netPnl >= target) {
      return `daily profit target reached (${formatInr(s.netPnl)} of ${formatInr(target)}) — stopping for the day`;
    }
  }

  // Set by an operator or by a repeated execution failure; sticky for the day.
  if (s.blockedReason) return s.blockedReason;

  return null;
}

// When may this strategy look for a new entry after a trade closed?
// Returns an epoch-ms timestamp, or Infinity when re-entry is off for the day.
//
// The two flags are about intent, not timing: `reentryAfterStop: false` means
// "if I was wrong once today, stop" — so it disables re-entry entirely rather
// than merely delaying it.
function nextEntryAllowedAt({ config, exitReason, now }) {
  if (exitReason === 'target' && !config.reentryAfterTarget) return endOfTradingDay(now);
  if (exitReason === 'stoploss' && !config.reentryAfterStop) return endOfTradingDay(now);
  const cooldown = Number(config.reentryCooldownSec) || 0;
  return cooldown > 0 ? now + cooldown * 1000 : 0;
}

// Fold a closed trade into the day's counters.
function applyTradeResult(stats, { gross, charges, net }) {
  const s = stats || emptyStats();
  return {
    ...s,
    trades: s.trades + 1,
    wins: s.wins + (net >= 0 ? 1 : 0),
    losses: s.losses + (net < 0 ? 1 : 0),
    grossPnl: round(s.grossPnl + gross),
    charges: round(s.charges + charges),
    netPnl: round(s.netPnl + net),
  };
}

// A hedge unwound without a short still costs money, but it is not a "trade"
// for the purposes of maxTradesPerDay — no position was ever taken, and
// counting it would let a run of missed arms exhaust the day's allowance.
function applyAbortResult(stats, { gross, charges, net }) {
  const s = stats || emptyStats();
  return {
    ...s,
    grossPnl: round(s.grossPnl + gross),
    charges: round(s.charges + charges),
    netPnl: round(s.netPnl + net),
  };
}

function summarise(stats) {
  const s = stats || emptyStats();
  const decided = s.wins + s.losses;
  return {
    ...s,
    winRate: decided ? Math.round((s.wins / decided) * 100) : 0,
  };
}

module.exports = {
  emptyStats, checkEntryGates, nextEntryAllowedAt, endOfTradingDay,
  applyTradeResult, applyAbortResult, summarise,
};
