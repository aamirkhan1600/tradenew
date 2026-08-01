#!/usr/bin/env node
// Replay the engine over a synthetic session and report what it did.
//
//   node scripts/ose-replay.js                     30 minutes, seed 1
//   node scripts/ose-replay.js --minutes 60 --seed 7 --vol 3
//   node scripts/ose-replay.js --trades            print every trade
//
// The engine is REAL — the decision cycle, the strike selector, the ladder, the
// exits, the order router, the paper broker and every `ose_*` table. What is
// synthetic is the market: an index path and an option chain priced off it.
//
// ---------------------------------------------------------------------------
// What this can and cannot tell you
// ---------------------------------------------------------------------------
//
// IT CAN tell you how the RULES behave: how often an entry is found, how far
// the ladder gets, which exit fires, and what the charges do to the total. Those
// are properties of the engine and they are exactly what is hard to see by
// reading code.
//
// IT CANNOT tell you whether the strategy makes money. The index path is a
// random walk with no memory, and the option prices come from a smooth textbook
// curve with no spread, no queue and no slippage. A real chain is none of those
// things. Treat the P&L as a way of noticing "this configuration cannot pay for
// its own charges", never as an estimate of what Monday will do.
//
// Deterministic: the same seed replays exactly the same session. It cleans up
// after itself, including the day's risk counters.

const repo = require('../src/repositories');
const db = require('../src/core/db');
const money = require('../src/core/money');
const time = require('../src/core/time');
const risk = require('../src/ose/risk');
const settingsService = require('../src/ose/settings');
const { OseEngine } = require('../src/ose/engine');
const { STATES } = require('../src/ose/machine');
const { OrderRouter } = require('../src/execution/orderRouter');
const { Reconciler } = require('../src/execution/reconciler');
const { PaperBroker } = require('../src/broker/paperBroker');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const MINUTES = arg('minutes', 30);
const SEED = arg('seed', 1);
const VOL = arg('vol', 2.5);          // index points of noise per 5s bar
const DRIFT = arg('drift', 0);        // points per bar of trend
const SHOW_TRADES = process.argv.includes('--trades');

const STEP_MS = 5000;
const STRIKE_STEP = 50;
const SPOT0 = 2438360;                // paise — where the real index actually is

// Deterministic PRNG. `Math.random` would make a replay unrepeatable, which
// defeats the point of a replay.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A textbook premium: intrinsic plus a bell of time value centred at the money.
// TV0 and SIGMA are fitted to the live chain observed on this account — the
// 24400 CE at ₹77.75 and the 24550 CE at ₹24.05 with spot at 24383.
const TV0 = 80;
const SIGMA = 110;
function premiumP(strike, type, spotP) {
  const spot = spotP / 100;
  const intrinsic = type === 'CE' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const tv = TV0 * Math.exp(-0.5 * ((strike - spot) / SIGMA) ** 2);
  return Math.max(5, Math.round((intrinsic + tv) * 100));
}

function chainAt(spotP, expiry) {
  const atm = Math.round((spotP / 100) / STRIKE_STEP) * STRIKE_STEP;
  const out = [];
  for (let k = atm - 20 * STRIKE_STEP; k <= atm + 20 * STRIKE_STEP; k += STRIKE_STEP) {
    for (const type of ['CE', 'PE']) {
      out.push({
        token: `${k}${type}`, segment: 'nse_fo', symbol: `SIM${k}${type}`,
        strike: k, optionType: type, expiry, lotSize: 75, tickP: 5,
        ltpP: premiumP(k, type, spotP),
        bidP: null, askP: null, spreadP: null, midP: null,
        bidQty: null, askQty: null, oi: null, volume: null, snapshotTs: Date.now(),
      });
    }
  }
  return out;
}

const bar = (token, o, h, l, c, ts) => ({
  token, timeframe: '5s', bucketStart: ts, bucketEnd: ts + STEP_MS,
  openP: o, highP: h, lowP: l, closeP: c,
  tickCount: 5, synthetic: false, lowConfidence: false, tradable: true,
});

async function main() {
  const bars = Math.round((MINUTES * 60) / 5);
  console.log(`\nOption Selling Engine — replay\n`);
  console.log(`  ${MINUTES} minutes (${bars} bars of 5s) · seed ${SEED} · `
    + `noise ${VOL} pts/bar · drift ${DRIFT} pts/bar\n`);

  if (!await db.healthCheck()) throw new Error('the database is not reachable');

  const cfg = await settingsService.load();
  console.log(`  band ₹${(cfg._gate.premiumMinP / 100).toFixed(0)}–`
    + `${(cfg._gate.premiumMaxP / 100).toFixed(0)} · ${cfg.lots} lot(s) · `
    + `target ${cfg.initialTargetPoints} · stop ${cfg.initialStopPoints} · `
    + `${cfg.liquidityMode} · trail ${cfg._rules.trailingStopEnabled ? 'on' : 'off'}\n`);

  const paper = new PaperBroker();
  const broker = {
    mode: 'PAPER',
    placeOrder: (o) => paper.placeOrder(o),
    cancelOrder: (a) => paper.cancelOrder(a),
    fetchBook: () => paper.fetchBook(),
    status: () => ({ mode: 'PAPER', connected: true }),
  };
  const router = new OrderRouter({ broker, events: async () => {} });
  const reconciler = new Reconciler({ broker, intervalMs: 1000 });

  const engine = new OseEngine({
    ticker: { on() {}, subscribe() {}, unsubscribe() {}, resume() {} },
    indexCandles: { on() {}, start() {}, stop() {}, track() {}, untrack() {} },
    optionCandles: { on() {}, start() {}, stop() {}, track() {}, untrack() {} },
    quoteSource: { snapshot: async () => new Map(), filter: 'ltp' },
    router, reconciler, broker, session: null,
  });
  engine.cfg = cfg;
  engine.machine.current = STATES.SCANNING;
  engine.indexToken = 'SIM-NIFTY';
  engine._maintainedDate = time.tradeDate();
  engine._settingsCheckedAt = Date.now();       // no reload mid-replay

  // ONLY THE CALENDAR IS FAKED. Every other gate the risk engine applies —
  // maxOpenTrades, maxTradesPerDay, the consecutive-loss breaker, the cooldown,
  // expiry day — is left real, because those are part of what is being measured.
  //
  // A replay run on a Sunday night otherwise reports SESSION_CLOSED for every
  // cycle and looks like an engine that never trades.
  const savedRisk = {
    canOpenTrade: risk.canOpenTrade, isSessionOpen: risk.isSessionOpen,
    isPastSquareOff: risk.isPastSquareOff, isEntryWindowClosed: risk.isEntryWindowClosed,
    isWeekend: risk.isWeekend,
  };
  // A timestamp the REAL gate accepts: the most recent weekday, at 11:00 IST.
  //
  // Stubbing `risk.isWeekend` does nothing here — `canOpenTrade` calls the
  // module-local function, not the export, so the only lever on it is the clock
  // it is handed. Walk back to a weekday rather than pretend.
  let marketNow = time.atIstTime(Date.now(), '11:00:00');
  let guard = 0;
  while (savedRisk.isWeekend(marketNow) && guard++ < 7) marketNow -= 24 * 3600 * 1000;
  risk.isSessionOpen = () => true;
  risk.isPastSquareOff = () => false;
  risk.isEntryWindowClosed = () => false;
  risk.isWeekend = () => false;
  const realGate = savedRisk.canOpenTrade;
  risk.canOpenTrade = (counters, c, ctx) => realGate(counters, c, { ...ctx, nowMs: marketNow });

  const tradeDate = time.tradeDate();
  const statsBefore = await repo.oseStats.ensure(tradeDate);
  const madeIds = [];

  const rnd = mulberry32(SEED);
  const t0 = time.atIstTime(Date.now(), '10:00:00');
  const expiry = '2026-08-04';

  // The whole path is generated UP FRONT, five samples per bar, so the loop can
  // replay it in the order the engine would have seen it: seal bar i, decide,
  // then let the NEXT bar's samples arrive one at a time while a limit order is
  // working. Feeding one tick per bar instead gives every entry a single chance
  // to fill and reports an engine that never trades.
  const path = [];
  {
    let spot = SPOT0;
    let prevClose = spot;
    for (let i = 0; i < bars; i += 1) {
      const samples = [];
      for (let s = 0; s < 5; s += 1) {
        const shock = (rnd() - 0.5) * 2 * VOL * 100;
        spot = Math.max(1, Math.round(spot + shock + DRIFT * 20));
        samples.push(spot);
      }
      const o = prevClose;
      const c = samples[samples.length - 1];
      path.push({
        ts: t0 + i * STEP_MS, samples,
        bar: bar('SIM-NIFTY', o, Math.max(o, ...samples), Math.min(o, ...samples), c, t0 + i * STEP_MS),
      });
      prevClose = c;
    }
  }

  const outcomes = new Map();
  let spotP = SPOT0;

  try {
    for (let i = 0; i < bars; i += 1) {
      const step = path[i];
      spotP = step.bar.closeP;

      engine.indexSeries.push(step.bar);
      if (engine.indexSeries.length > 720) engine.indexSeries.shift();

      const quotes = chainAt(spotP, expiry);
      engine.chain.snapshot = { ts: Date.now(), quotes, corrupt: false, considered: quotes.length };
      engine.chain.get = () => ({ ok: true, snapshot: engine.chain.snapshot });

      // The option series for whatever is watched or held, sealed alongside.
      for (const tok of [engine.candidate?.token, engine.trade?.token].filter(Boolean)) {
        const q = quotes.find(x => x.token === tok);
        if (!q) continue;
        const prev = engine.optionLast.get(tok);
        const po = prev ? prev.closeP : q.ltpP;
        engine.optionLast.set(tok,
          bar(tok, po, Math.max(po, q.ltpP), Math.min(po, q.ltpP), q.ltpP, step.ts));
        engine.liveSample.set(tok, { ltpPaise: q.ltpP, ts: Date.now() });
      }

      const res = await engine._cycle(step.bar);
      outcomes.set(res?.outcome, (outcomes.get(res?.outcome) || 0) + 1);

      if (engine.trade) {
        const ob = engine.optionLast.get(engine.trade.token);
        if (ob) await engine._manageOnOptionCandle(ob);
      }

      // The next bar's samples, one at a time — this is where a working limit
      // gets its chance to fill, and where §12.4's timeout runs out if it does
      // not. One second of simulated time per sample.
      const next = path[i + 1];
      if (next) {
        for (const sampleSpot of next.samples) {
          for (const tok of [engine.candidate?.token, engine.trade?.token].filter(Boolean)) {
            const m = /^(\d+)(CE|PE)$/.exec(tok);
            if (!m) continue;
            paper.onTick(tok, premiumP(Number(m[1]), m[2], sampleSpot));
          }
          if (engine._entryDeadline) engine._entryDeadline -= 1000;
          if (engine._exitDeadline) engine._exitDeadline -= 1000;
          await reconciler.runOnce();
          await engine._pollEntryFill();
          await engine._pollExitFill();
          if (engine.trade?.dbId && !madeIds.includes(engine.trade.dbId)) {
            madeIds.push(engine.trade.dbId);
          }
        }
      }

      if (engine.trade?.dbId && !madeIds.includes(engine.trade.dbId)) madeIds.push(engine.trade.dbId);
    }

    /* ------------------------------------------------------------- results */
    const trades = [];
    for (const id of madeIds) {
      const row = await repo.oseTrades.byId(id);
      if (row) trades.push(row);
    }
    const closed = trades.filter(t => t.status === 'CLOSED');
    const errored = trades.filter(t => t.status === 'ERROR');
    const stillOpen = trades.filter(t => t.status === 'OPEN');
    const wins = closed.filter(t => Number(t.net_pnl_p) > 0);
    const losses = closed.filter(t => Number(t.net_pnl_p) < 0);
    const net = closed.reduce((a, t) => a + Number(t.net_pnl_p || 0), 0);
    const gross = closed.reduce((a, t) => a + Number(t.gross_pnl_p || 0), 0);
    const charges = closed.reduce((a, t) => a + Number(t.charges_p || 0), 0);

    console.log('  index      ', (SPOT0 / 100).toFixed(2), '->', (spotP / 100).toFixed(2),
      `(${((spotP - SPOT0) / 100).toFixed(2)} pts)`);
    console.log('  cycles     ', bars);
    console.log('  entries    ', trades.length, '| filled & closed', closed.length,
      '| never filled', errored.length, '| left open', stillOpen.length);
    console.log('  wins/losses', `${wins.length}/${losses.length}`,
      closed.length ? `(${Math.round((wins.length / closed.length) * 100)}% win rate)` : '');
    console.log('  gross      ', money.formatInr(gross));
    console.log('  charges    ', money.formatInr(charges));
    console.log('  NET        ', money.formatInr(net));

    // The halt is the headline when it happens: everything after it is the
    // engine refusing to trade, not the strategy performing.
    const finalStats = await repo.oseStats.get(tradeDate);
    if (finalStats?.halted) {
      console.log(`
  *** HALTED mid-session: ${finalStats.halt_reason}`);
      console.log(`      ${outcomes.get('HALTED') || 0} of ${bars} cycles were spent halted, `
        + 'so the numbers above cover only the part before it.');
    }

    const byReason = new Map();
    for (const t of closed) byReason.set(t.exit_reason, (byReason.get(t.exit_reason) || 0) + 1);
    if (byReason.size) {
      console.log('\n  exits by reason:');
      for (const [r, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(r).padEnd(24)} ${n}`);
      }
    }

    console.log('\n  why the other cycles did nothing:');
    for (const [k, n] of [...outcomes].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`    ${String(k).padEnd(24)} ${n}`);
    }

    if (SHOW_TRADES && closed.length) {
      console.log('\n  trades:');
      console.log('    contract        entry    exit  rung    stop  reason              net');
      for (const t of closed) {
        console.log('    ' + String(t.symbol).padEnd(15),
          money.formatPrice(t.entry_price_p).padStart(6),
          money.formatPrice(t.exit_price_p).padStart(7),
          String(t.target_level).padStart(4),
          money.formatPrice(t.stop_price_p).padStart(7),
          ' ' + String(t.exit_reason).padEnd(19),
          money.formatInr(t.net_pnl_p).padStart(9));
      }
    }

    console.log('\n  This is a random walk priced off a textbook curve. It shows how the RULES');
    console.log('  behave, not what the market will do.\n');
  } finally {
    Object.assign(risk, savedRisk);

    // Scoped by the SIM symbol prefix rather than by the ids collected during
    // the run. A trade that was created and abandoned inside a single poll can
    // be missed by the tracking, and one missed row is a simulated position left
    // in the table the real engine reconciles against. The prefix cannot match a
    // contract the instrument master ever produced, so it is safe and it also
    // sweeps up runs that were interrupted.
    const junk = await db.query("SELECT id FROM ose_trades WHERE symbol LIKE 'SIM%'").catch(() => []);
    for (const row of junk) {
      await db.query('DELETE FROM orders WHERE ose_trade_id = ?', [row.id]).catch(() => {});
      await db.query('DELETE FROM ose_guard WHERE trade_id = ?', [row.id]).catch(() => {});
      await db.query('DELETE FROM ose_trades WHERE id = ?', [row.id]).catch(() => {});
    }
    // Orphans: an order or a guard row whose trade was removed by an earlier
    // pass. Scoped by "no such trade", so a live row is never touched.
    await db.query(`DELETE FROM orders WHERE ose_trade_id IS NOT NULL
                      AND ose_trade_id NOT IN (SELECT id FROM ose_trades)`).catch(() => {});
    await db.query(`DELETE FROM ose_guard
                     WHERE trade_id NOT IN (SELECT id FROM ose_trades)`).catch(() => {});
    if (statsBefore) {
      await db.query(
        `UPDATE ose_stats SET trades_today = ?, consecutive_losses = ?, realised_pnl_p = ?,
                gross_pnl_p = ?, charges_p = ?, win_count = ?, loss_count = ?, scratch_count = ?,
                halted = ?, halt_reason = ?
          WHERE trade_date = ?`,
        [statsBefore.trades_today, statsBefore.consecutive_losses, statsBefore.realised_pnl_p,
          statsBefore.gross_pnl_p, statsBefore.charges_p, statsBefore.win_count,
          statsBefore.loss_count, statsBefore.scratch_count,
          // THE IMPORTANT ONE. A replay that trips the consecutive-loss breaker
          // writes halted=1 for TODAY, and a halt is not auto-clearing: the real
          // engine would refuse to trade on Monday because of a simulation.
          statsBefore.halted, statsBefore.halt_reason,
          tradeDate]).catch(() => {});
    }
    await db.close();
  }
}

main().catch((err) => {
  console.error('\nreplay failed:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
