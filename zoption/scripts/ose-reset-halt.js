#!/usr/bin/env node
// §26.6 — the ONLY way to clear a HALT.
//
//   node scripts/ose-reset-halt.js --date 2026-08-01 --reason "why"
//
// There is deliberately no API and no button. §17.6 makes a halt terminal for
// the session and says it "MUST NOT be cleared by a process restart", which
// leaves exactly one safe way to clear it: a human who has looked, typing a
// reason that is recorded next to the reset.
//
// The order of the three steps in §26.6 matters and is enforced here as far as a
// script can enforce it:
//
//   1. Confirm flat VIA THE BROKER TERMINAL — not via the engine. The engine is
//      the thing whose view of the world is in question; asking it whether it is
//      flat is asking the defendant for a verdict. This script therefore refuses
//      to run while the database still holds an open trade, and says to square
//      off at Kotak first.
//   2. Run this. The reset is written to `ose_transitions` so the audit trail
//      shows who cleared what, and why.
//   3. Restart the process. This script does NOT signal a running engine — an
//      engine that could be un-halted underneath itself is an engine whose halt
//      means nothing.

const repo = require('../src/repositories');
const db = require('../src/core/db');
const time = require('../src/core/time');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const date = arg('date', time.tradeDate());
  const reason = arg('reason');
  const force = process.argv.includes('--force');

  if (!reason) {
    console.error('\n  --reason is required. The reset is recorded next to it, and "cleared the\n'
      + '  halt" six months from now is not an answer to why it was safe to.\n\n'
      + '  node scripts/ose-reset-halt.js --date YYYY-MM-DD --reason "..."\n');
    process.exit(2);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`  --date must be YYYY-MM-DD (got "${date}")`);
    process.exit(2);
  }

  const stats = await repo.oseStats.get(date);
  if (!stats) {
    console.log(`  no ose_stats row for ${date} — nothing to clear`);
    return;
  }
  if (!stats.halted) {
    console.log(`  ${date} is not halted — nothing to do`);
    return;
  }

  // Step 1, as far as this side of the wire can check it.
  const open = await repo.oseTrades.openTrades();
  if (open.length && !force) {
    console.error(`\n  REFUSING: the database still holds ${open.length} open trade(s):\n`
      + open.map(t => `    #${t.id} ${t.symbol} qty ${t.filled_qty || t.qty} `
        + `entry ${t.entry_price_p == null ? '—' : (t.entry_price_p / 100).toFixed(2)}`).join('\n')
      + '\n\n  Square off at the Kotak terminal and reconcile before clearing the halt.\n'
      + '  Clearing it now would let the engine open a SECOND position alongside one it\n'
      + '  has already lost track of.\n\n'
      + '  If the position is genuinely closed and the row is stale, re-run with --force.\n');
    process.exit(1);
  }

  await repo.oseStats.clearHalt(date);
  await repo.oseTransitions.log({
    cycleId: null,
    tradeUid: null,
    fromState: 'HALTED',
    toState: 'BOOTING',
    triggerEvent: 'MANUAL_RESET',
    reason: `operator reset: ${reason} (was: ${stats.halt_reason || 'unknown'})`,
    illegal: false,
    tsMs: Date.now(),
  });

  console.log(`\n  cleared the halt on ${date}`);
  console.log(`    was: ${stats.halt_reason || 'unknown'}`);
  console.log(`    now: ${reason}`);
  if (open.length) console.log(`    NOTE: forced past ${open.length} open trade row(s)`);
  console.log('\n  Restart the engine — this script does not signal a running one.\n');
}

main()
  .catch((err) => { console.error('reset failed:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
