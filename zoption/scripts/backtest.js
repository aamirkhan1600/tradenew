#!/usr/bin/env node
// Replay the index trend filter over stored history.
//
//   node scripts/backtest.js                      # NIFTY, 1m, last 30 days
//   node scripts/backtest.js NIFTY 5m 60
//   node scripts/backtest.js NIFTY 1m 7 --sweep   # also grid the thresholds
//
// WHAT THIS BACKTESTS, said plainly before any number appears: the index trend
// filter, and only that. It is a pure function of index bars, so downloaded
// index history can genuinely exercise it.
//
// WHAT IT DOES NOT BACKTEST: entries, targets, stops or P&L. Those need the
// OPTION contract's own candles — `doc/PROJECT_PLAN.md` §2 R1 makes the sell
// price the option candle's close plus an offset — and Yahoo carries no NSE
// option data at all. Those series accumulate only while this platform is
// running. `node scripts/backfill-history.js` will tell you what is stored.

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../src/core/db');
const time = require('../src/core/time');
const repo = require('../src/repositories');
const instrumentMaster = require('../src/market/instrumentMaster');
const trendReplay = require('../src/backtest/trendReplay');

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));

const UNDERLYING = (args[0] || 'NIFTY').toUpperCase();
const TIMEFRAME = args[1] || '1m';
const DAYS = Number(args[2] || 30);

const pct = (v) => (v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%');
const stamp = (ms) => (ms ? `${time.tradeDate(ms)} ${time.istClock(ms)}` : '—');

async function main() {
  if (!await db.healthCheck()) {
    throw new Error('the database is not reachable — check DB_* in .env and run npm run migrate');
  }

  const index = await instrumentMaster.indexInstrument(UNDERLYING);
  if (!index?.token) throw new Error(`no ${UNDERLYING} index instrument — sync instruments first`);

  const to = Date.now();
  const from = to - DAYS * 24 * 60 * 60 * 1000;

  const result = await trendReplay.run({
    token: String(index.token),
    timeframe: TIMEFRAME,
    from,
    to,
    limit: 20000,
    lookaheadBars: 3,
  });

  if (!result.bars) {
    console.log(`\nNo stored ${TIMEFRAME} bars for ${UNDERLYING} in the last ${DAYS} days.`);
    console.log('Run `node scripts/backfill-history.js` to download index history from Yahoo.\n');
    return;
  }

  console.log(`\n${UNDERLYING} trend filter replay`);
  console.log(`  bars        ${result.bars} × ${TIMEFRAME}   (${result.source})`);
  console.log(`  window      ${stamp(result.from)}  ..  ${stamp(result.to)}`);
  console.log(`  config      ${result.config.confirmBars} bars, body ≥ ${result.config.bodyPct}%, `
    + `score ≥ ${result.config.minScore}/5, span ≤ ${(result.config.maxRangeP / 100).toFixed(1)}pts`);

  for (const note of result.notes) console.log(`  ! ${note}`);

  /* ------------------------------------------------------------- verdicts -- */

  console.log('\n  VERDICT DISTRIBUTION      (which rule is doing the blocking)');
  const total = result.evaluated || 1;
  const rows = Object.entries(result.states).sort((a, b) => b[1] - a[1]);
  for (const [state, count] of rows) {
    const bar = '█'.repeat(Math.round(40 * count / total));
    console.log(`    ${state.padEnd(18)} ${String(count).padStart(6)}  ${pct(count / total).padStart(6)}  ${bar}`);
  }

  /* -------------------------------------------------------------- signals -- */

  console.log('\n  PERMISSIONS');
  console.log(`    signals            ${result.signals}   (${pct(result.signalRate)} of bars)`);
  console.log(`    CE / PE            ${result.ce} / ${result.pe}`);

  if (!result.signals) {
    console.log('\n  The filter permitted nothing over this window. That is a configuration');
    console.log('  that has turned the strategy off rather than made it selective — look at');
    console.log('  the distribution above for which rule is rejecting everything.\n');
    return;
  }

  console.log(`\n  FOLLOW-THROUGH             (index over the next ${result.lookaheadBars} bars)`);
  console.log(`    went the permitted way   ${pct(result.hitRate)}  of ${result.scored} signals`);
  console.log(`    average move             ${result.avgMovePoints === null ? '—' : result.avgMovePoints.toFixed(2)} points (favourable-signed)`);
  console.log(`    median move              ${result.medianMovePoints === null ? '—' : result.medianMovePoints.toFixed(2)} points`);
  console.log('\n    A hit rate near 50% means the filter has no directional read on this');
  console.log('    data. Above it, the read is real — but this measures the INDEX, and the');
  console.log('    strategy sells option premium, so it is not a P&L result.');

  /* ---------------------------------------------------------------- sweep -- */

  if (flags.has('--sweep')) {
    const seconds = time.chartTimeframeSeconds(TIMEFRAME);
    const stored = await repo.candles.range(String(index.token), TIMEFRAME, from, to, 20000);
    const bars = stored.map(r => trendReplay.toTrendBar(r, seconds));

    console.log('\n  THRESHOLD SWEEP            (best hit rate first)');
    console.log('    confirm  score  span(pts)  signals   rate    hit     avg move');
    console.log('    ' + '-'.repeat(62));
    // The span grid is anchored on the √time-equivalent of the configured
    // ceiling, because sweeping the 5s value across 1m bars just reproduces the
    // HIGH_VOLATILITY wall in every row.
    const eq = Math.max(5, Math.round(result.suggestedMaxRangePoints));
    const swept = trendReplay.sweep(bars, result.config, {
      confirmBars: [2, 3, 4],
      minScore: [0, 3, 5],
      maxRangeP: [...new Set([
        Math.round(result.config.maxRangeP), eq * 50, eq * 100, eq * 200,
      ])],
    });
    for (const s of swept.slice(0, 12)) {
      // A handful of signals can score 100% by luck. Anything under thirty is
      // marked rather than dropped, because "there were only four" is itself
      // the useful finding.
      const thin = s.signals < 30 ? ' (thin)' : '';
      console.log(`    ${String(s.override.confirmBars).padStart(7)}  ${String(s.override.minScore).padStart(5)}  `
        + `${(s.override.maxRangeP / 100).toFixed(0).padStart(9)}   ${String(s.signals).padStart(7)}  `
        + `${pct(s.signalRate).padStart(6)}  ${pct(s.hitRate).padStart(6)}  `
        + `${s.avgMovePoints === null ? '—' : s.avgMovePoints.toFixed(2).padStart(8)}${thin}`);
    }
    console.log(`\n    The span grid is anchored on ${eq} points — the √time equivalent of the`);
    console.log(`    configured ${(result.config.maxRangeP / 100).toFixed(0)}-point ceiling at `
      + `${result.configuredTimeframe}, scaled to ${TIMEFRAME}. Rows at the`);
    console.log('    original ceiling are kept so the mismatch is visible rather than hidden.');
  }

  /* ----------------------------------------------------- option coverage --- */

  console.log('\n  OPTION PREMIUM HISTORY     (what a full P&L backtest would need)');
  const optionBars = await db.query(
    `SELECT c.timeframe, COUNT(*) AS bars, COUNT(DISTINCT c.token) AS contracts,
            MIN(c.bucket_start) AS first_bar, MAX(c.bucket_start) AS last_bar
       FROM candles c JOIN instruments i ON i.token = c.token
      WHERE i.option_type IN ('CE','PE') GROUP BY c.timeframe`);
  if (!optionBars.length) {
    console.log('    none stored. Yahoo carries no NSE option data, so these accumulate only');
    console.log('    while `npm run engine` or the terminal is running. Until then, entries,');
    console.log('    targets, stops and P&L cannot be replayed — only the filter above.');
  } else {
    for (const r of optionBars) {
      console.log(`    ${String(r.timeframe).padEnd(5)} ${String(r.bars).padStart(8)} bars across `
        + `${String(r.contracts).padStart(4)} contracts   `
        + `${stamp(time.fromMysql(r.first_bar))} .. ${stamp(time.fromMysql(r.last_bar))}`);
    }
  }
  console.log('');
}

main()
  .catch((err) => { console.error('\nbacktest failed:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
