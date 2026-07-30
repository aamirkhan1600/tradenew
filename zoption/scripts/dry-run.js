#!/usr/bin/env node
// Walk the engine's entry path with live quotes, and open nothing.
//
//   node scripts/dry-run.js
//
// `diagnose-engine.js` checks the gates that live in the database. This checks
// the part that only shows up against the broker: expiry selection, the warm
// chain, and whether STRIKE SELECTION would actually return a contract. Those
// are the steps that fail silently — `_openCycle` logs "no strike selected" at
// DEBUG and returns, so a PREMIUM band nothing falls inside looks exactly like
// a quiet market.
//
// It calls the SAME `selectors` the engine calls, with the SAME settings, so a
// pick here is the pick the engine would make.
//
// READ-ONLY. No cycle, no order, no flag. Safe during market hours, and safe
// outside them — quotes then return the last traded price, which is enough to
// prove selection works.

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../src/core/db');
const time = require('../src/core/time');
const money = require('../src/core/money');
const repo = require('../src/repositories');
const session = require('../src/broker/neoSession');
const settingsService = require('../src/strategy/settings');
const selectors = require('../src/strategy/selectors');
const instrumentMaster = require('../src/market/instrumentMaster');

const UNDERLYING = (process.argv[2] || '').toUpperCase();

// Paced: this shares the account's quota with a running engine and terminal.
const PACE_MS = 900;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function quoteMany(instruments) {
  const prices = new Map();
  const batch = 25;
  for (let i = 0; i < instruments.length; i += batch) {
    if (i) await sleep(PACE_MS);
    const slice = instruments.slice(i, i + batch);
    let rows;
    try {
      rows = await session.quotes(slice, 'ltp');
    } catch (err) {
      console.log(`    quote batch ${i / batch + 1} failed: ${String(err.message).slice(0, 90)}`);
      continue;
    }
    const neo = require('../src/broker/neoClient');
    for (let j = 0; j < rows.length; j++) {
      const q = neo.readQuoteFull(rows[j]);
      if (q.ltp == null) continue;
      let match = null;
      for (const id of q.ids) { match = slice.find(s => String(s.token) === id); if (match) break; }
      if (!match && rows.length === slice.length) match = slice[j];
      if (match) prices.set(String(match.token), Math.round(q.ltp * 100));
    }
  }
  return prices;
}

async function main() {
  if (!await db.healthCheck()) throw new Error('the database is not reachable');
  await session.load();
  if (!session.isActive()) throw new Error('no active Kotak session — log in on the Broker page');

  const s = settingsService.derive(
    settingsService.withDefaults(await repo.settings.get('default')));
  const symbol = UNDERLYING || s.symbol;

  console.log(`\nDRY RUN — ${symbol}   ${time.tradeDate()} ${time.istClock(Date.now(), true)} IST`);
  console.log(`  strikeMode ${s.strikeMode}   tradeMode ${s.tradeMode}   lots ${s.lots}`);
  if (String(s.strikeMode).toUpperCase() === 'PREMIUM') {
    console.log(`  premium band ₹${s.targetPremium} ± ${s.premiumTolerance}  `
      + `= ₹${s.targetPremium - s.premiumTolerance} … ₹${s.targetPremium + s.premiumTolerance}`);
  }

  /* --------------------------------------------------------------- 1. spot */

  console.log('\n1. SPOT');
  const index = await instrumentMaster.indexInstrument(symbol);
  if (!index?.token) { console.log('   ✗ no index instrument'); return; }
  const spotPrices = await quoteMany([{ token: index.token, segment: index.segment }]);
  const spotP = spotPrices.get(String(index.token));
  if (spotP == null) {
    console.log(`   ✗ ${index.segment}|${index.token} returned no price — the engine cannot`);
    console.log('     compute an ATM and `_openCycle` returns before selecting anything.');
    return;
  }
  const spot = spotP / 100;
  console.log(`   ✓ ${index.segment}|${index.token} = ${spot.toFixed(2)}`);

  /* ------------------------------------------------------------- 2. expiry */

  console.log('\n2. EXPIRY');
  const expiries = await repo.instruments.expiries(symbol);
  let expiry;
  try {
    expiry = selectors.selectExpiry({
      mode: s.expiryMode, expiries, manualExpiry: s.manualExpiry,
    });
    const days = (Date.parse(expiry + 'T15:30:00+05:30') - Date.now()) / 86400000;
    console.log(`   ✓ ${s.expiryMode} -> ${expiry}   (${days.toFixed(1)} days out)`);
  } catch (err) { console.log(`   ✗ ${err.message}`); return; }

  /* -------------------------------------------------------- 3. warm chain */

  console.log('\n3. WARM CHAIN   (the engine subscribes ±12 strikes and waits one poll)');
  const chain = await repo.instruments.chain(symbol, expiry);
  const step = selectors.strikeStep(chain);
  const atm = selectors.atmStrike(spot, step);
  const span = 12 * step;
  const near = chain.filter(r => Math.abs(Number(r.strike) - atm) <= span);
  console.log(`   step ${step}   ATM ${atm}   ${near.length} contracts within ±${span} points`);

  const prices = await quoteMany(near.map(r => ({ token: r.token, segment: r.segment })));
  console.log(`   ✓ ${prices.size} of ${near.length} answered with a price`);
  if (prices.size < near.length * 0.5) {
    console.log('   ! more than half returned nothing — selection will be working blind');
  }

  /* ---------------------------------------------------------- 4. the band */

  const inBand = [];
  const lo = money.toPaise(s.targetPremium - s.premiumTolerance);
  const hi = money.toPaise(s.targetPremium + s.premiumTolerance);
  console.log('\n4. WHAT IS PRICED   (nearest the money first)');
  console.log('   strike    CE        PE      distance');
  const strikes = [...new Set(near.map(r => Number(r.strike)))]
    .sort((a, b) => Math.abs(a - atm) - Math.abs(b - atm)).slice(0, 14);
  for (const k of strikes.sort((a, b) => a - b)) {
    const ce = near.find(r => Number(r.strike) === k && r.option_type === 'CE');
    const pe = near.find(r => Number(r.strike) === k && r.option_type === 'PE');
    const cp = ce ? prices.get(String(ce.token)) : null;
    const pp = pe ? prices.get(String(pe.token)) : null;
    const mark = (p) => {
      if (p == null) return '     —';
      const hit = p >= lo && p <= hi ? '*' : ' ';
      return (p / 100).toFixed(2).padStart(6) + hit;
    };
    if (cp != null && cp >= lo && cp <= hi) inBand.push(`${k}CE`);
    if (pp != null && pp >= lo && pp <= hi) inBand.push(`${k}PE`);
    console.log(`   ${String(k).padStart(6)}  ${mark(cp)}  ${mark(pp)}   `
      + `${(k - atm >= 0 ? '+' : '') + (k - atm)}`);
  }
  console.log(`   * = inside the ₹${s.targetPremium}±${s.premiumTolerance} band`);

  /* ------------------------------------------------------- 5. selection -- */

  console.log('\n5. STRIKE SELECTION   (the engine\'s own selectors, its own settings)');
  let picked;
  try {
    picked = selectors.selectStrikes({
      chain,
      spot,
      mode: s.strikeMode,
      atmOffset: s.atmOffset,
      targetPremium: s.targetPremium,
      premiumTolerance: s.premiumTolerance,
      tradeMode: s.tradeMode,
      premiumPaise: (token) => prices.get(String(token)) ?? null,
    });
  } catch (err) { console.log(`   ✗ ${err.message}`); return; }

  const wantCE = s.tradeMode === 'BOTH' || s.tradeMode === 'CE';
  const wantPE = s.tradeMode === 'BOTH' || s.tradeMode === 'PE';
  const show = (type, row) => {
    if (!row) { console.log(`   ✗ ${type}  nothing selected`); return; }
    const p = prices.get(String(row.token));
    console.log(`   ✓ ${type}  ${row.symbol}  strike ${row.strike}  `
      + `premium ${p == null ? '—' : (p / 100).toFixed(2)}  lot ${row.lot_size}`);
  };
  if (wantCE) show('CE', picked.ce);
  if (wantPE) show('PE', picked.pe);

  const blocked = (wantCE && !picked.ce) || (wantPE && !picked.pe);
  if (blocked) {
    console.log(`\n   ✗ NO CYCLE WOULD OPEN — ${picked.reason || 'no contract satisfied the rules'}`);
    if (String(s.strikeMode).toUpperCase() === 'PREMIUM') {
      const priced = [...prices.values()].sort((a, b) => a - b);
      if (priced.length) {
        console.log(`     Priced premiums run ₹${(priced[0] / 100).toFixed(2)} … `
          + `₹${(priced[priced.length - 1] / 100).toFixed(2)} across the ±${span}-point window.`);
        console.log(`     Your band is ₹${s.targetPremium - s.premiumTolerance} … `
          + `₹${s.targetPremium + s.premiumTolerance}, and ${inBand.length} contract(s) fall inside it`
          + (inBand.length ? `: ${inBand.slice(0, 8).join(', ')}` : ''));
        if (!inBand.length) {
          console.log('     Widen premiumTolerance or move targetPremium onto what the board offers.');
        } else {
          console.log('     Contracts ARE in the band — so the miss is one-sided: tradeMode BOTH');
          console.log('     needs a CE *and* a PE inside it, and only one side qualifies.');
        }
      }
    }
  } else {
    console.log('\n   ✓ A CYCLE WOULD OPEN. Beyond this point the only remaining gates are');
    console.log('     per-tick: the trend filter\'s verdict, quote staleness, and waiting for');
    console.log(`     the contract's own ${s.candleTimeframe} candle to close.`);
    const qty = Number((picked.ce || picked.pe).lot_size) * Number(s.lots);
    const note = settingsService.breakevenNote(s, Number((picked.ce || picked.pe).lot_size));
    console.log(`\n     qty ${qty}   target ₹${s.target}   stop ₹${s.stopLoss}`);
    console.log(`     a win nets ${money.formatInr(note.winP)}, a loss ${money.formatInr(note.lossP)}`);
    if (note.requiredWinRate != null) {
      console.log(`     break-even win rate ${(note.requiredWinRate * 100).toFixed(0)}%`);
    }
  }

  /* --------------------------------------------------------- 6. the clock */

  const inWindow = time.isWithinSession(Date.now(), s.sessionStart, s.sessionEnd);
  console.log(`\n6. CLOCK   ${inWindow ? '✓ inside' : '✗ outside'} `
    + `${s.sessionStart}–${s.sessionEnd} IST`);
  if (!inWindow) {
    console.log('   Selection above still ran — quotes return the last traded price when the');
    console.log('   market is shut, which is enough to prove the path works. The engine will');
    console.log('   not act on it until the window opens.');
  }
  console.log('');
}

main()
  .catch((err) => { console.error('\ndry run failed:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
