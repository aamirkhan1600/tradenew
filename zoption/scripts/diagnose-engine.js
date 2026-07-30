#!/usr/bin/env node
// Why is the scalper not trading?
//
//   node scripts/diagnose-engine.js
//
// There are about fifteen conditions between "the process is up" and "an order
// goes out", and when nothing happens they all look identical from the outside:
// a quiet log and a flat P&L. This walks every one of them in the order the
// engine does and prints PASS or the reason it stops.
//
// It is READ-ONLY. It opens no cycle, places no order and writes no flag.

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = require('../src/config');
const db = require('../src/core/db');
const time = require('../src/core/time');
const money = require('../src/core/money');
const repo = require('../src/repositories');
const settingsService = require('../src/strategy/settings');
const session = require('../src/broker/neoSession');
const selectors = require('../src/strategy/selectors');
const instrumentMaster = require('../src/market/instrumentMaster');

const now = Date.now();
let blockers = 0;
let warnings = 0;

const pass = (label, detail = '') => console.log(`  ✓ ${label.padEnd(34)} ${detail}`);
const fail = (label, detail) => { blockers += 1; console.log(`  ✗ ${label.padEnd(34)} ${detail}`); };
const warn = (label, detail) => { warnings += 1; console.log(`  ! ${label.padEnd(34)} ${detail}`); };
const head = (t) => console.log(`\n${t}\n  ${'-'.repeat(70)}`);

async function main() {
  if (!await db.healthCheck()) {
    throw new Error('the database is not reachable — check DB_* in .env and run npm run migrate');
  }

  console.log(`\nzoption engine diagnosis — ${time.tradeDate(now)} ${time.istClock(now, true)} IST`);

  /* ------------------------------------------------------------ 1. process */

  head('1. IS AN ENGINE EVEN RUNNING?');
  const lock = await db.queryOne(
    'SELECT owner, heartbeat_at FROM engine_locks WHERE name = ? LIMIT 1', ['zoption-engine']);
  if (!lock) {
    fail('engine process', 'no leader lock at all — `npm run engine` has never run. '
      + 'The web app alone never trades.');
  } else {
    const ageMs = now - time.fromMysql(lock.heartbeat_at);
    if (ageMs > config.engine.lockTtlMs) {
      fail('engine process', `the lock is ${(ageMs / 1000).toFixed(0)}s stale (owner ${lock.owner}) `
        + '— the engine is DEAD. Start it with `npm run engine`.');
    } else {
      pass('engine process', `alive, owner ${lock.owner}, heartbeat ${(ageMs / 1000).toFixed(1)}s ago`);
    }
  }

  /* ------------------------------------------------------------- 2. intent */

  head('2. OPERATOR INTENT   (the Start / Stop / Pause buttons)');
  const intent = String(await repo.flags.get('engine_intent', 'STOP')).toUpperCase();
  if (intent === 'RUN') {
    pass('engine_intent', 'RUN — new cycles may open');
  } else {
    fail('engine_intent', `${intent} — NO NEW CYCLES WILL OPEN. Press Start on the dashboard `
      + `(${config.appUrl}) or POST /api/start. Open positions are still managed.`);
  }

  if (config.tradingHalted) {
    fail('TRADING_HALTED', 'set in .env — entries are blocked at the environment level');
  } else {
    pass('TRADING_HALTED', 'false');
  }

  /* ------------------------------------------------------------ 3. session */

  head('3. BROKER SESSION');
  await session.load();
  const account = await repo.broker.get('primary');
  if (!account || !account.session_token) {
    fail('Kotak session', `none stored — log in at ${config.appUrl}/brokers`);
  } else if (account.status !== 'ACTIVE') {
    fail('Kotak session', `${account.status} — ${account.last_error || 'log in again'}`);
  } else {
    const ageH = account.last_login_at
      ? (now - time.fromMysql(account.last_login_at)) / 3600000 : null;
    pass('Kotak session', `ACTIVE as ${account.ucc}`
      + (ageH === null ? '' : `, logged in ${ageH.toFixed(1)}h ago`));
    // Kotak sessions are a trading-day thing. One from yesterday will start
    // failing on the first call rather than at load.
    if (ageH !== null && ageH > 12) {
      warn('session age', `${ageH.toFixed(1)}h old — Kotak sessions expire daily, `
        + 'so this may fail on the next call');
    }
  }

  /* ------------------------------------------------------------ 4. settings */

  head('4. SETTINGS');
  const raw = settingsService.withDefaults(await repo.settings.get('default'));
  const { errors, warnings: settingWarnings } = settingsService.validate(raw);
  if (errors.length) {
    fail('settings', `INVALID — the engine refuses to boot:\n      - ${errors.join('\n      - ')}`);
  } else {
    pass('settings', `${raw.mode} mode, ${raw.strikeMode}, ${raw.tradeMode}, `
      + `${raw.candleTimeframe} candles, offset ${raw.sellOffset}`);
  }
  for (const w of settingWarnings.slice(0, 4)) warn('settings', w.slice(0, 150));
  if (raw.mode === 'PAPER') {
    warn('mode', 'PAPER — orders are simulated and never reach the exchange');
  }

  /* -------------------------------------------------------------- 5. clock */

  head('5. THE MARKET CLOCK');
  const ist = time.istParts(now);
  const weekend = ist.weekday === 0 || ist.weekday === 6;
  if (weekend) {
    fail('weekday', `it is ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][ist.weekday]}`
      + ' — the market is closed');
  } else {
    pass('weekday', 'a trading day (exchange holidays are NOT known to this platform)');
  }

  const inWindow = time.isWithinSession(now, raw.sessionStart, raw.sessionEnd);
  if (!inWindow) {
    fail('session window', `outside ${raw.sessionStart}–${raw.sessionEnd} IST `
      + `(now ${time.istClock(now)})`);
  } else {
    pass('session window', `inside ${raw.sessionStart}–${raw.sessionEnd} IST`);
  }

  const squareOffAt = time.atIstTime(now, raw.squareOffAt);
  const minHoldMs = Number(raw.positionTimeout || 60) * 1000;
  if (now + minHoldMs > squareOffAt && !weekend) {
    fail('room before square-off', `too close to ${raw.squareOffAt} to hold a full `
      + `${raw.positionTimeout}s position`);
  } else {
    pass('room before square-off', `square-off at ${raw.squareOffAt}`);
  }

  /* --------------------------------------------------------------- 6. risk */

  head('6. RISK GATES');
  const tradeDate = time.tradeDate(now);
  const stats = await repo.stats.ensure(tradeDate);
  if (stats.disabled) {
    fail('daily disable', `trading disabled today — ${stats.disabled_reason || 'risk limit'}`);
  } else {
    pass('daily disable', 'not disabled');
  }

  if (stats.cooldown_until) {
    const until = time.fromMysql(stats.cooldown_until);
    if (until && now < until) {
      fail('cooldown', `${Math.ceil((until - now) / 1000)}s remaining after a stop-loss`);
    } else pass('cooldown', 'none active');
  } else pass('cooldown', 'none active');

  const realized = stats.realized_pnl_p;
  pass('today', `${money.formatInr(realized)} net over ${stats.trade_count} trades `
    + `(${stats.win_count}W/${stats.loss_count}L), ${stats.cycle_count} cycles`);

  if (raw.maxDailyLoss > 0 && realized <= -money.toPaise(raw.maxDailyLoss)) {
    fail('daily loss limit', `reached (${money.formatInr(realized)})`);
  }
  if (raw.maxDailyProfit > 0 && realized >= money.toPaise(raw.maxDailyProfit)) {
    fail('daily profit target', `reached (${money.formatInr(realized)})`);
  }
  if (raw.maxConsecutiveLoss > 0 && stats.consecutive_losses >= raw.maxConsecutiveLoss) {
    fail('consecutive losses', `${stats.consecutive_losses} — at the limit of ${raw.maxConsecutiveLoss}`);
  }
  if (raw.maxCyclesPerDay > 0 && stats.cycle_count >= raw.maxCyclesPerDay) {
    fail('daily cycle cap', `${stats.cycle_count} of ${raw.maxCyclesPerDay} used`);
  }

  /* -------------------------------------------------------- 7. instruments */

  head('7. INSTRUMENTS AND THE CHAIN');
  const instrumentCount = await repo.instruments.count();
  if (!instrumentCount) {
    fail('instrument master', 'EMPTY — sync it on the Broker page');
  } else {
    pass('instrument master', `${instrumentCount} rows`);
  }

  const index = await instrumentMaster.indexInstrument(raw.symbol);
  if (!index?.token) {
    fail('index instrument', `no ${raw.symbol} index row — the engine cannot compute an ATM`);
  } else {
    // An index is addressed by NAME. The numeric token its own master publishes
    // answers 200 with an empty array — see instrumentMaster.indexInstrument.
    pass('index instrument', `${index.segment}|${index.token}`
      + (index.quoteBy === 'name' ? '   (by name; exchange token '
        + `${index.exchangeToken || 'unknown'})` : ''));
  }

  const expiries = await repo.instruments.expiries(raw.symbol);
  if (!expiries.length) {
    fail('expiries', 'none in the master — sync instruments');
  } else {
    let expiry = null;
    try {
      expiry = selectors.selectExpiry({
        mode: raw.expiryMode, expiries, manualExpiry: raw.manualExpiry,
      });
      pass('expiry selection', `${raw.expiryMode} -> ${expiry} (have ${expiries.slice(0, 3).join(', ')})`);
    } catch (err) {
      fail('expiry selection', err.message);
    }

    if (expiry) {
      const chain = await repo.instruments.chain(raw.symbol, expiry);
      if (!chain.length) fail('option chain', `empty for ${raw.symbol} ${expiry}`);
      else pass('option chain', `${chain.length} tradable contracts`);
    }
  }

  /* --------------------------------------------------------- 8. market data */

  head('8. MARKET DATA   (the gate that stops everything silently)');
  // The engine will not select a strike unless the ticker is healthy, and it
  // will not price an entry from anything but a closed candle. Both are checked
  // through what actually reached the database, because the engine's own feed
  // state lives in another process.
  if (index?.token) {
    const recent = await repo.candles.recent(String(index.token), raw.trendTimeframe, 5);
    const live = recent.filter(c => (c.source || 'LIVE') === 'LIVE');
    if (!live.length) {
      warn('index candles', `no LIVE ${raw.trendTimeframe} bars stored — either the trend filter `
        + 'is off (it is the only thing that records them) or the feed is silent');
    } else {
      const ageS = (now - time.fromMysql(live[live.length - 1].bucket_start)) / 1000;
      if (ageS > 300) {
        fail('index candles', `the newest LIVE bar is ${(ageS / 60).toFixed(0)} minutes old — `
          + 'the feed is not delivering');
      } else pass('index candles', `newest LIVE bar ${ageS.toFixed(0)}s ago`);
    }
  }

  const optionBars = await db.queryOne(
    `SELECT COUNT(*) AS n, MAX(c.bucket_start) AS latest
       FROM candles c JOIN instruments i ON i.token = c.token
      WHERE i.option_type IN ('CE','PE') AND c.source = 'LIVE'
        AND c.created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)`);
  if (!optionBars || !optionBars.n) {
    warn('option candles', 'none recorded in the last day — the engine only builds them for a '
      + 'LOCKED strike, so this is expected if no cycle has opened');
  } else {
    const ageS = (now - time.fromMysql(optionBars.latest)) / 1000;
    pass('option candles', `${optionBars.n} bars today, newest ${ageS.toFixed(0)}s ago`);
  }

  console.log('\n  The definitive feed check is the engine\'s own log. Look for');
  console.log('  "ticker: connected" and whether `source` is ws, rest or ws+rest.');
  console.log('  If quotes are returning HTTP 503 the engine is BLIND and will never');
  console.log('  select a strike — run `node scripts/diagnose-spot.js`.');

  /* ------------------------------------------------------------ 9. the day */

  head('9. WHAT ACTUALLY HAPPENED TODAY');
  const cycle = await repo.cycles.openCycle();
  if (cycle) {
    const legs = await repo.legs.byCycle(cycle.id);
    pass('open cycle', `#${cycle.id} ${cycle.expiry_date} `
      + `CE ${cycle.ce_strike ?? '—'} / PE ${cycle.pe_strike ?? '—'}, locked `
      + `${time.istClock(time.fromMysql(cycle.locked_at), true)}`);
    for (const l of legs) {
      console.log(`      ${l.option_type} ${l.strike}  ${l.state}`
        + `  attempts ${l.attempt_seq}  sell ${l.sell_price_p ?? '—'}`
        + `  filled ${l.filled_price_p ?? '—'}`);
    }
  } else {
    console.log('  no cycle is open');
  }

  const events = await repo.events.recent(12);
  if (!events.length) {
    console.log('  no events recorded — the engine has never done anything');
  } else {
    console.log('\n  last 12 events:');
    for (const e of events) {
      const detail = e.to_state ? `${e.from_state || '—'} -> ${e.to_state}` : (e.reason || '');
      console.log(`      ${time.istClock(Number(e.ts_ms), true)}  ${(e.option_type || '  ').padEnd(3)}`
        + ` ${String(e.kind).padEnd(18)} ${String(detail).slice(0, 70)}`);
    }
  }

  /* ----------------------------------------------------------- the verdict */

  head('VERDICT');
  if (blockers) {
    console.log(`  ${blockers} blocker${blockers === 1 ? '' : 's'} above (✗). `
      + 'The engine cannot open a cycle until every one is cleared.');
  } else if (warnings) {
    console.log(`  No hard blockers. ${warnings} warning${warnings === 1 ? '' : 's'} (!) —`);
    console.log('  if nothing is trading, the cause is most likely in the market-data or');
    console.log('  strike-selection path: a PREMIUM band with no strike inside it, or a');
    console.log('  trend filter refusing every bar. The engine log names both.');
  } else {
    console.log('  Everything this script can check is clear. If nothing is trading, the');
    console.log('  remaining candidates are all per-tick and only the engine log shows them:');
    console.log('    - no strike inside the premium band (strikeMode PREMIUM)');
    console.log('    - the trend filter blocking the permitted side');
    console.log('    - a stale or missing quote on the selected strike');
    console.log('    - candles arriving low-confidence (under CANDLE_MIN_TICKS)');
  }
  console.log('');
}

main()
  .catch((err) => { console.error('\ndiagnosis failed:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
