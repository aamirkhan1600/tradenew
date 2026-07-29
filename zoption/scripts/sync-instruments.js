#!/usr/bin/env node
// Sync the instrument master from the command line.
//
//   node scripts/sync-instruments.js
//
// Does exactly what the Broker page's "Sync now" button does, but prints what
// it found. Run it once a session — the master changes daily as contracts are
// added and expire, and a stale row points at a contract that no longer exists.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = require('../src/config');
const session = require('../src/broker/neoSession');
const instrumentMaster = require('../src/market/instrumentMaster');
const repo = require('../src/repositories');
const db = require('../src/core/db');

async function main() {
  await session.load();
  if (!session.session?.sessionToken) {
    console.error(`No Kotak session. Log in at ${config.appUrl}/brokers first.`);
    process.exit(1);
  }

  const t0 = Date.now();
  const result = await instrumentMaster.syncAll(session.session);
  console.log('');
  console.log(`options : ${result.options}`);
  console.log(`indices : ${result.indices}`);
  console.log(`pruned  : ${result.pruned}`);
  console.log(`took    : ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const symbol = (await repo.settings.get('default'))?.symbol || 'NIFTY';
  const expiries = await repo.instruments.expiries(symbol);
  console.log('');
  console.log(`${symbol} expiries: ${expiries.slice(0, 6).join('  ')}`);

  const spot = await instrumentMaster.indexInstrument(symbol);
  console.log(`${symbol} spot     : ${spot ? `${spot.segment}|${spot.token}` : 'MISSING — no ATM can be computed'}`);

  if (expiries.length) {
    const chain = await repo.instruments.chain(symbol, expiries[0]);
    const strikes = [...new Set(chain.map(r => Number(r.strike)))].sort((a, b) => a - b);
    console.log(`${expiries[0]}: ${chain.length} contracts, `
      + `strikes ${strikes[0]}–${strikes[strikes.length - 1]}, `
      + `lot ${chain[0]?.lot_size}`);
  }
}

main()
  .catch(err => { console.error('\nsync failed:\n' + err.message); process.exitCode = 1; })
  .finally(() => db.close());
