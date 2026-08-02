#!/usr/bin/env node
// Everything that has to be true before a trading session, checked in one place.
//
//   node scripts/ose-preflight.js
//
// Run it the night before and again after the morning login. It reads state and
// asks the broker questions; it places no orders and changes nothing.
//
//   PASS  ready
//   WARN  will not stop the session, but you should know
//   FAIL  the session will not work, or will not work safely
//
// Exit code is non-zero if anything FAILed, so it can gate a start script.

const config = require('../src/config');
const db = require('../src/core/db');
const repo = require('../src/repositories');
const time = require('../src/core/time');
const money = require('../src/core/money');
const risk = require('../src/ose/risk');
const strikes = require('../src/ose/strikes');
const spotGuard = require('../src/ose/spotGuard');
const chainRules = require('../src/ose/chain');
const settingsService = require('../src/ose/settings');
const C = require('../src/ose/constants');
const session = require('../src/broker/neoSession');
const { QuoteSource } = require('../src/market/quoteSource');
const { ChainSnapshot } = require('../src/ose/snapshot');
const fs = require('fs');

let fails = 0;
let warns = 0;
const pass = (l, d) => console.log(`  PASS  ${l}${d ? '  —  ' + d : ''}`);
const warn = (l, d) => { warns += 1; console.log(`  WARN  ${l}${d ? '  —  ' + d : ''}`); };
const fail = (l, d) => { fails += 1; console.log(`  FAIL  ${l}${d ? '  —  ' + d : ''}`); };
const head = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

async function main() {
  console.log('\nOption Selling Engine — preflight\n');
  console.log(`  now ${time.istClock()} IST, trade date ${time.tradeDate()}`);

  /* ---------------------------------------------------------- infrastructure */
  head('Infrastructure');

  if (!await db.healthCheck()) { fail('database reachable'); return; }
  pass('database reachable', config.db.database);

  const cols = await db.query(
    `SELECT column_name AS c FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'ose_decisions'`, [config.db.database]);
  const names = cols.map(r => r.c || r.column_name);
  const missing = ['low_confidence', 'tick_count'].filter(c => !names.includes(c));
  if (missing.length) fail('schema up to date', `run npm run migrate — missing ${missing.join(', ')}`);
  else pass('schema up to date', 'ose_decisions has the §19.4 columns');

  // §26.2 — the local clock IS the candle timestamp on this broker (§7.2), so
  // drift corrupts bucketing directly rather than merely being untidy.
  const dbNow = await db.queryOne('SELECT UNIX_TIMESTAMP(NOW()) AS t');
  const skewMs = Math.abs(Date.now() - Number(dbNow.t) * 1000);
  if (skewMs > 5000) fail('clock agrees with the database', `${Math.round(skewMs / 1000)}s apart`);
  else if (skewMs > 2000) warn('clock agrees with the database', `${skewMs}ms apart`);
  else pass('clock agrees with the database', `${skewMs}ms`);

  /* ------------------------------------------------------------------ broker */
  head('Broker');

  await session.load();
  if (!session.isActive()) {
    fail('Kotak session active',
      `log in at ${config.appUrl}/brokers — the TOTP + MPIN step cannot be automated (§31.2)`);
  } else {
    pass('Kotak session active', `UCC ${session.meta.ucc}`);
  }

  /* -------------------------------------------------------------- the market */
  head('Market and calendar');

  const today = time.tradeDate();
  const holidayRaw = (() => {
    try { return JSON.parse(fs.readFileSync(config.ose.holidayFile, 'utf8')); }
    catch (_) { return null; }
  })();
  const holidays = risk.readCalendar(holidayRaw);
  if (!holidays.length) {
    warn('exchange holiday calendar loaded',
      `${config.ose.holidayFile} is EMPTY — weekends are detected, holidays are not. `
      + 'In production this is a refusal to start (§17.7).');
  } else {
    const v = risk.validateCalendar(holidays, today);
    if (v.ok) pass('exchange holiday calendar loaded', `${holidays.length} dates`);
    else warn('exchange holiday calendar loaded', v.reason);
  }

  const expiries = await repo.instruments.expiries('NIFTY');
  const picked = chainRules.selectExpiry(expiries, today);
  if (!picked.expiry) {
    fail('an expiry is available', 'run node scripts/sync-instruments.js');
  } else {
    const days = Math.round(
      (Date.parse(picked.expiry + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
    if (picked.isExpiryDay) {
      warn('expiry selected', `${picked.expiry} is TODAY — tradeOnExpiryDay is `
        + `${(await settingsService.load()).tradeOnExpiryDay ? 'ON' : 'OFF'}`);
    } else if (days <= 1) {
      warn('expiry selected', `${picked.expiry} is ${days} day away — gamma and theta are at `
        + 'their most violent on the last day, and a 2-point stop is very close to noise');
    } else {
      pass('expiry selected', `${picked.expiry}, ${days} days out`);
    }
  }

  const instrCount = await repo.instruments.count();
  const stale = await db.queryOne(
    'SELECT TIMESTAMPDIFF(HOUR, MAX(synced_at), NOW()) AS h FROM instruments');
  if (Number(stale?.h) > 24) {
    warn('instrument master fresh', `last synced ${stale.h}h ago — the engine re-syncs on the `
      + 'first maintenance pass of a new day, but check it did');
  } else {
    pass('instrument master fresh', `${instrCount} rows, synced ${stale?.h ?? 0}h ago`);
  }

  /* ------------------------------------------------------------------ config */
  head('Configuration');

  const cfg = await settingsService.load();
  const band = `₹${(cfg._gate.premiumMinP / 100).toFixed(0)}–${(cfg._gate.premiumMaxP / 100).toFixed(0)}`;

  if (cfg.mode === 'LIVE') warn('trading mode', 'LIVE — orders will reach the exchange');
  else pass('trading mode', 'PAPER — nothing reaches the exchange');

  const unsigned = settingsService.unsignedItems(cfg);
  if (unsigned.length) {
    if (cfg.mode === 'LIVE') fail('§22 sign-off', `${unsigned.length} unsigned — LIVE will refuse`);
    else pass('§22 sign-off', `${unsigned.length} unsigned — LIVE is blocked, PAPER is fine`);
  } else pass('§22 sign-off', 'all items signed');

  if (cfg.liquidityMode === 'LENIENT') {
    warn('liquidity mode', 'LENIENT — strikes are chosen on PREMIUM ALONE. This account sends no '
      + 'open interest, volume or bid/ask, so nothing checks whether the strike can be got out of.');
  } else pass('liquidity mode', 'STRICT');

  if (!cfg._rules.stopGuardEnabled) {
    warn('sampled-stop guard', 'OFF — the stop is evaluated ONLY on sealed 5-second candle highs. '
      + 'A spike that crosses the stop and retraces between two polls will not fire it (§16.4).');
  } else pass('sampled-stop guard', 'ON — the live sample is re-checked every second');

  // newdoc/ema.md. Reported here because the filter changes when the engine can
  // trade at all — an operator who starts the process at 09:19 and sees nothing
  // happen at 09:20 is looking at the warm-up, not at a fault.
  if (!cfg._ema.enabled) {
    warn('EMA trend filter', 'OFF — ema.md makes EMA9/EMA20 confirmation MANDATORY before any '
      + 'entry. With it off, nothing stops the engine selling into a sideways tape.');
  } else {
    pass('EMA trend filter', `ON — EMA${C.EMA_FAST}/EMA${C.EMA_SLOW}, flat band `
      + `${(cfg._ema.emaFlatP / 100).toFixed(2)} pts, cooldown ${cfg._ema.emaCrossCooldown} `
      + `candles, chop ${cfg._ema.emaChopFlips}/${cfg._ema.emaChopLookback}. First entry is `
      + `possible ${cfg._ema.warmupCandles * Number(cfg.timeframeSeconds)}s after the feed starts.`);
  }

  if (!cfg._rules.emaExitOnCrossover) {
    warn('EMA crossover exit', 'OFF — ema.md\'s §Position Exit Rule is not enforced. A position '
      + 'whose EMA structure has inverted waits for the trend break, the validity filter or the '
      + 'stop instead.');
  } else pass('EMA crossover exit', 'ON — an inverted EMA structure closes the position');

  const note = settingsService.breakevenNote(cfg, 75);
  const rate = note.requiredWinRate == null ? null : Math.round(note.requiredWinRate * 100);
  if (rate == null) fail('first rung clears charges', 'a winning trade still books a loss at this size');
  else if (rate >= 60) {
    warn('first rung economics', `needs a ${rate}% win rate to break even `
      + `(win ${money.formatInr(note.winP)} vs loss ${money.formatInr(note.lossP)} on ${note.qty}) — `
      + 'the target ladder is what is meant to fix that, so confirm extensions actually fire');
  } else pass('first rung economics', `${rate}% break-even win rate`);

  pass('premium band', `${band}, ${cfg.lots} lot(s), scanRange ±${cfg.scanRange} strikes`);

  /* --------------------------------------------------------------- run state */
  head('Run state');

  const stats = await repo.oseStats.get(today);
  if (stats?.halted) fail('not halted', `${stats.halt_reason} — clear with scripts/ose-reset-halt.js`);
  else pass('not halted');

  const intent = await repo.flags.get('ose_intent', 'RUN');
  if (intent !== 'RUN') warn('operator intent', `${intent} — press Start on /ose before the open`);
  else pass('operator intent', 'RUN');

  const killed = fs.existsSync(config.ose.killSwitchFile);
  if (killed) fail('kill switch clear', `${config.ose.killSwitchFile} exists — remove it`);
  else pass('kill switch clear');

  const open = await repo.oseTrades.openTrades();
  if (open.length) warn('no position carried over', `${open.length} open trade row(s) — the next `
    + 'boot will try to adopt them (§20.6)');
  else pass('no position carried over');

  const lock = await db.queryOne(
    `SELECT owner, TIMESTAMPDIFF(SECOND, heartbeat_at, NOW()) AS age
       FROM engine_locks WHERE name = 'zoption-engine'`);
  if (lock && lock.age < config.engine.lockTtlMs / 1000) {
    warn('leader lock', `held by ${lock.owner}, ${lock.age}s ago — an engine is already running`);
  } else pass('leader lock', lock ? `stale (${lock.age}s), free to take` : 'free');

  const stateRaw = await repo.flags.get('ose_state', null);
  const st = stateRaw ? JSON.parse(stateRaw) : null;
  const age = st?.atMs ? Math.round((Date.now() - st.atMs) / 1000) : null;
  if (st && age < 15) pass('engine heartbeat', `${st.state}, ${st.cycles} cycles, ${age}s ago`);
  else warn('engine heartbeat', st ? `stale by ${age}s — the engine is not running` : 'never started');

  /* -------------------------------------------------- the chain, end to end */
  head('Chain and strike selection');

  if (!session.isActive()) {
    fail('chain reachable', 'no session — cannot check');
  } else {
    const qs = new QuoteSource({ session, batchSize: config.neo.quoteBatch, label: 'preflight' });
    const chain = new ChainSnapshot({ quoteSource: qs });
    // The column is `nifty_close_p`, and the placeholder needs a value.
    //
    // This query used to select `close_p` and bind nothing, so it threw
    // `Unknown column` on EVERY run — and the `.catch(() => null)` swallowed it
    // whole. Preflight then silently fell through to whatever the `candles`
    // table happened to hold, which is a different number from the one the
    // engine is deciding on. The check that exists to be run before a session
    // was reporting on data the engine does not use, and it reported "Ready"
    // through a 734-point index error on 2026-08-02.
    //
    // The catch is gone with it. A failing diagnostic must fail visibly.
    let spotRow = null;
    try {
      spotRow = await db.queryOne(
        `SELECT nifty_close_p FROM ose_decisions WHERE trade_date = ?
           ORDER BY id DESC LIMIT 1`, [time.tradeDate()]);
    } catch (err) {
      fail('engine spot readable', `the decision log could not be read — ${err.message}`);
    }
    const engineSpotP = Number(spotRow?.nifty_close_p) || 0;
    const spotP = engineSpotP || await lastIndexClose();

    if (!spotP) {
      warn('spot price known', 'no sealed index candle yet — start the engine first');
    } else if (!engineSpotP) {
      warn('spot price known', 'no decision row for today — this is the last stored 5s candle, '
        + 'NOT what a running engine is deciding on. Start the engine and re-run.');
    }

    if (spotP) {
      const t0 = Date.now();
      await chain.refresh({ spotP, cfg: cfg._gate });
      const took = Date.now() - t0;
      const snap = chain.snapshot;

      if (!snap || !snap.quotes.length) {
        fail('chain fetched', 'the snapshot came back empty — retry; if it persists the quote '
          + 'service is not answering');
      } else {
        pass('chain fetched', `${snap.quotes.length}/${snap.considered} strikes in ${took}ms`);
        if (took > C.CHAIN_TIMEOUT_MS) {
          warn('chain within its budget',
            `${took}ms against §8.3's ${C.CHAIN_TIMEOUT_MS}ms — the snapshot a cycle reads can be `
            + 'that much older than specified');
        }
        pass('quote entitlement', `filter "${qs.filter}"`
          + (qs.filter === 'ltp' ? ' — LTP only, no OI/volume/depth' : ''));

        // THE check that would have caught 2026-08-02, run here because this is
        // the first moment both halves exist: a spot the engine is deciding on
        // and a chain to cross-examine it with.
        const sc = spotGuard.check(spotP, snap.quotes, cfg._spotCheck);
        if (sc.verdict === spotGuard.VERDICT.DIVERGED) {
          fail('index feed agrees with the chain',
            `feed ${money.formatPrice(sc.feedSpotP)} vs ${sc.pairs} strikes pricing it at `
            + `${money.formatPrice(sc.impliedSpotP)} — out by `
            + `${money.formatPrice(Math.abs(sc.divergenceP))} points. DO NOT TRADE: the strike `
            + 'selector will pick from the wrong part of the chain.');
        } else if (sc.verdict === spotGuard.VERDICT.UNKNOWN) {
          warn('index feed agrees with the chain', `not measurable — ${sc.reason}`);
        } else if (sc.verdict === spotGuard.VERDICT.DISABLED) {
          warn('index feed agrees with the chain', 'spotCheckEnabled is OFF');
        } else {
          pass('index feed agrees with the chain',
            `${sc.pairs} strikes price the index at ${money.formatPrice(sc.impliedSpotP)}, `
            + `within ${money.formatPrice(Math.abs(sc.divergenceP))} points of the feed`);
        }

        const spot = spotP / 100;
        const atm = Math.round(spot / C.STRIKE_MULTIPLE) * C.STRIKE_MULTIPLE;
        console.log(`\n  spot ${spot.toFixed(2)}, at-the-money strike ${atm}, band ${band}`);
        for (const type of ['CE', 'PE']) {
          const r = strikes.select(snap.quotes, type, { ...cfg._gate, spotP });
          if (!r.chosen) {
            warn(`${type} candidate`, `none in band — ${r.reason}`);
            continue;
          }
          const otm = type === 'CE' ? r.chosen.strike - atm : atm - r.chosen.strike;
          const bad = type === 'CE' ? r.chosen.strike < atm : r.chosen.strike > atm;
          if (bad) fail(`${type} candidate`, `${r.chosen.strike} is IN THE MONEY`);
          else {
            pass(`${type} candidate`, `${r.chosen.symbol} @ ${money.formatPrice(r.chosen.ltpP)}, `
              + `${otm} pts OTM, ${r.ranked.length} in band`);
          }
        }
      }
    }
  }

  /* ------------------------------------------------------------------ verdict */
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${fails} FAIL, ${warns} WARN`);
  console.log(fails ? '  NOT READY — fix the failures above.'
    : '  Ready. Read the warnings; none of them blocks a session.');
  console.log(`${'='.repeat(60)}\n`);
  process.exitCode = fails ? 1 : 0;
}

async function lastIndexClose() {
  const row = await db.queryOne(
    `SELECT close_p FROM candles WHERE timeframe = '5s' ORDER BY id DESC LIMIT 1`).catch(() => null);
  return Number(row?.close_p) || 0;
}

main()
  .catch((err) => { console.error('\npreflight could not run:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
