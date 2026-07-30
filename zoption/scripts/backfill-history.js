#!/usr/bin/env node
// Download index history from Yahoo into the `candles` table.
//
//   node scripts/backfill-history.js                    # NIFTY, the default plan
//   node scripts/backfill-history.js BANKNIFTY
//   node scripts/backfill-history.js NIFTY 1d 3650      # one timeframe, N days
//   node scripts/backfill-history.js NIFTY --purge      # drop imported bars first
//
// Kotak's Trade API has no historical-candles endpoint, so without this every
// chart in the terminal starts empty and fills in only while the page is open.
//
// WHAT THIS CANNOT DO: Yahoo carries no NSE option contracts — checked against
// the live API, not assumed — so this backfills the INDEX only. The strategy's
// entry price comes from the option contract's own closed candle, and there is
// no source for that series here at any price. See doc/history.md.
//
// Safe to re-run. A bucket this platform recorded from its own tick stream is
// never overwritten by a downloaded one.

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../src/core/db');
const time = require('../src/core/time');
const repo = require('../src/repositories');
const backfill = require('../src/market/backfill');

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));

const UNDERLYING = (args[0] || 'NIFTY').toUpperCase();
const TIMEFRAME = args[1] || null;
const DAYS = args[2] ? Number(args[2]) : null;

const stamp = (ms) => (ms ? `${time.tradeDate(ms)} ${time.istClock(ms)}` : '—');

async function main() {
  if (!await db.healthCheck()) {
    throw new Error('the database is not reachable — check DB_* in .env and run npm run migrate');
  }

  const target = await backfill.resolveTarget(UNDERLYING);
  console.log(`\n${UNDERLYING} -> token ${target.token}`
    + (target.quoteBy === 'name' ? '   (addressed by name — an index is quoted that way)' : ''));

  if (flags.has('--purge')) {
    const removed = await repo.candles.purgeBackfill(target.token, TIMEFRAME);
    console.log(`purged ${removed} previously imported bars`
      + (TIMEFRAME ? ` at ${TIMEFRAME}` : '')
      + '   (bars recorded live were left alone)');
  }

  const plan = TIMEFRAME
    ? [{ timeframe: TIMEFRAME, days: DAYS ?? 30 }]
    : backfill.DEFAULT_PLAN;

  console.log('\n  tf     source   downloaded   stored   held   rejected   covering');
  console.log('  ' + '-'.repeat(74));

  let total = 0;
  for (const step of plan) {
    let result;
    try {
      result = await backfill.importTimeframe({ ...step, underlying: UNDERLYING, target });
    } catch (err) {
      console.log(`  ${String(step.timeframe).padEnd(6)} FAILED   ${err.message}`);
      continue;
    }
    total += result.stored;
    const rejected = Object.entries(result.rejected)
      .filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(' ') || '-';
    console.log(
      `  ${result.timeframe.padEnd(6)} ${(result.interval + (result.folded ? '*' : '')).padEnd(8)} `
      + `${String(result.downloaded).padStart(10)} ${String(result.stored).padStart(8)} `
      + `${String(result.alreadyHeld).padStart(6)} ${rejected.padStart(10)}   `
      + `${stamp(result.from)} .. ${stamp(result.to)}`);
  }

  console.log('\n  * folded locally from the source interval into this platform\'s absolute');
  console.log('    IST buckets — NSE sessions start at 09:15, so an exchange hourly bar is');
  console.log('    NOT the same bar as a 09:00-10:00 bucket. See src/market/backfill.js.');

  /* ------------------------------------------------------------- coverage -- */

  console.log(`\nSTORED COVERAGE for token ${target.token}`);
  console.log('  tf      bars   imported   from                  to');
  console.log('  ' + '-'.repeat(66));
  for (const tf of ['5s', '1m', '5m', '15m', '1h', '1d']) {
    const c = await repo.candles.coverage(target.token, tf);
    if (!c.bars) continue;
    console.log(`  ${tf.padEnd(6)} ${String(c.bars).padStart(6)} ${String(c.backfilled).padStart(10)}   `
      + `${stamp(c.firstBar).padEnd(21)} ${stamp(c.lastBar)}`);
  }

  console.log(`\n${total} new bars stored. The terminal's index chart will show them immediately.`);
  console.log('Option premiums are NOT available from Yahoo — they accumulate only while');
  console.log('the engine or the terminal is running. See doc/history.md.\n');
}

main()
  .catch((err) => { console.error('\nbackfill failed:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
