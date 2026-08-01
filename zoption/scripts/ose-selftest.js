#!/usr/bin/env node
// Does the Option Selling Engine actually trade?
//
//   node scripts/ose-selftest.js
//
// Outside market hours the engine correctly refuses everything with
// SESSION_CLOSED, so watching it run proves the plumbing and nothing about the
// trade. This drives a COMPLETE round trip through the real engine, the real
// order router and the real database, against the paper broker:
//
//   select a strike -> place the entry -> fill it -> extend the target ->
//   trail the stop -> hit the stop -> book the P&L
//
// What is REAL here: OseEngine, OrderRouter (client_ref, claimForPlacement),
// Reconciler, PaperBroker, every `ose_*` table, and every pure decision module.
//
// What is FAKED, and why: the market. The session windows are forced open (it
// may be Saturday), the chain snapshot is supplied rather than fetched (the
// account is `ltp`-only and the market is shut), and candles are handed in
// rather than sampled. Those are the INPUTS; every decision taken on them is
// the engine's own.
//
// It cleans up after itself — the rows it writes are deleted at the end — so it
// is safe to run against the working database.

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

const KEEP = process.argv.includes('--keep');
const CLEAN = process.argv.includes('--clean');

const TOKEN = '999999';
const SYMBOL = 'SELFTEST24500PE';
const LOT = 75;

let passed = 0;
let failed = 0;
const step = (ok, label, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
};

const ist = (hhmm, offsetSec = 0) => {
  const base = time.atIstTime(Date.now(), hhmm);
  return base + offsetSec * 1000;
};

// A sealed 5s bar in the shape CandleBuilder emits.
function bar(token, o, h, l, c, tsMs, over = {}) {
  return {
    token, timeframe: '5s', bucketStart: tsMs, bucketEnd: tsMs + 5000,
    openP: o, highP: h, lowP: l, closeP: c,
    tickCount: 5, synthetic: false, lowConfidence: false, tradable: true, ...over,
  };
}

function optionQuote(ltpP) {
  return {
    token: TOKEN, segment: 'nse_fo', symbol: SYMBOL, strike: 24500, optionType: 'PE',
    expiry: '2026-08-04', lotSize: LOT, tickP: 5,
    ltpP, bidP: null, askP: null, spreadP: null, midP: null,
    bidQty: null, askQty: null, oi: null, volume: null, snapshotTs: Date.now(),
  };
}

async function main() {
  console.log('\nOption Selling Engine — self test\n');

  if (!await db.healthCheck()) throw new Error('the database is not reachable');

  // `--clean` removes everything this script has ever left behind, including
  // runs that were interrupted before their own cleanup could run.
  //
  // Scoped by the SELFTEST symbol rather than by a date or an id range, so it
  // is incapable of touching a real trade: a contract this engine actually sold
  // is named by the instrument master and can never begin with SELFTEST.
  if (CLEAN) {
    const rows = await db.query("SELECT id FROM ose_trades WHERE symbol LIKE 'SELFTEST%'");
    for (const r of rows) {
      await db.query('DELETE FROM orders WHERE ose_trade_id = ?', [r.id]).catch(() => {});
      await db.query('DELETE FROM ose_guard WHERE trade_id = ?', [r.id]).catch(() => {});
      await db.query('DELETE FROM ose_trades WHERE id = ?', [r.id]).catch(() => {});
    }
    console.log(`  removed ${rows.length} self-test trade(s) and their orders\n`);
    return;
  }

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

  // LENIENT, because the account is `ltp`-only and STRICT would (correctly)
  // select nothing — that behaviour has its own test.
  engine.cfg = settingsService.derive(settingsService.withDefaults({
    mode: 'PAPER', liquidityMode: 'LENIENT', lots: 1,
    premiumMin: 15, premiumMax: 25, initialTargetPoints: 1, initialStopPoints: 2,
  }));
  engine.machine.current = STATES.SCANNING;
  engine.indexToken = 'NIFTY-SELFTEST';
  engine._maintainedDate = time.tradeDate();      // suppress the daily maintenance

  // The market, forced open.
  const savedRisk = {
    canOpenTrade: risk.canOpenTrade, isSessionOpen: risk.isSessionOpen,
    isPastSquareOff: risk.isPastSquareOff, isEntryWindowClosed: risk.isEntryWindowClosed,
  };
  risk.isSessionOpen = () => true;
  risk.isPastSquareOff = () => false;
  risk.isEntryWindowClosed = () => false;
  risk.canOpenTrade = () => ({ allowed: true, verdict: 'ALLOW', reason: null });

  // The chain, supplied. One PE at ₹20.00, inside the premium band.
  let premium = 2000;
  engine.chain.get = () => ({ ok: true, snapshot: { quotes: [optionQuote(premium)] } });
  engine.chain.isExpiryDay = false;

  const t0 = ist('10:00:00');
  let tradeDbId = null;
  const extraTradeIds = [];

  // The self test books a REAL trade through `_bookTrade`, which increments the
  // day's risk counters — trades, losses, the consecutive-loss streak and the
  // realised P&L. Those are the counters `maxConsecutiveLosses` halts on, so a
  // few runs of this script would trip a HALT on a live engine over trades that
  // never happened. Snapshot them, and put them back.
  const tradeDate = time.tradeDate();
  const statsBefore = await repo.oseStats.ensure(tradeDate);

  try {
    /* --- 1. the trend, from three rising candles ------------------------- */
    for (let i = 0; i < 3; i += 1) {
      const c = 2450000 + i * 300;
      engine.indexSeries.push(bar('NIFTY-SELFTEST', c - 300, c + 100, c - 400, c, t0 + i * 5000));
    }
    // A candle that closes above its own bullish midpoint -> SELL PE.
    const entryCandle = bar('NIFTY-SELFTEST', 2451000, 2451400, 2450800, 2451350, t0 + 15000);
    engine.indexSeries.push(entryCandle);

    /* --- 2. first sight of the strike: tracked, not traded --------------- */
    await engine._cycle(entryCandle);
    step(engine.candidate?.token === TOKEN,
      'a newly chosen strike is tracked before it can be priced',
      engine.candidate ? SYMBOL : '(no candidate)');

    /* --- 3. with a sealed option bar, the entry is priced ---------------- */
    engine.optionLast.set(TOKEN, bar(TOKEN, 2000, 2010, 1990, 2000, t0 + 15000));
    const c2 = bar('NIFTY-SELFTEST', 2451000, 2451400, 2450800, 2451350, t0 + 20000);
    engine.indexSeries.push(c2);
    await engine._cycle(c2);

    tradeDbId = engine.trade?.dbId ?? null;
    step(Boolean(engine.trade), 'an entry was taken',
      engine.trade ? `${engine.trade.symbol} @ ${money.formatPrice(engine.trade.requestedPriceP)}` : '');
    // §12.1 — close 2000 + offset 10, floored to the 5-paise tick.
    step(engine.trade?.requestedPriceP === 2010,
      'the limit is the sealed close + offset, floored to the tick',
      `expected 20.10, got ${money.formatPrice(engine.trade?.requestedPriceP)}`);
    step(engine.trade?.qty === LOT, 'quantity is lots x lot size', String(engine.trade?.qty));

    /* --- 4. the paper broker fills the SELL limit ------------------------ */
    paper.onTick(TOKEN, 2015);                       // trades through the limit
    await reconciler.runOnce();
    await engine._pollEntryFill();

    step(engine.machine.is(STATES.POSITION_MANAGEMENT, STATES.POSITION_OPEN),
      'the fill moved the engine into position management', engine.machine.current);
    step(engine.trade?.entryPriceP === 2010,
      'the fill price is the limit, never better (§12.7)',
      money.formatPrice(engine.trade?.entryPriceP));
    step(engine.trade?.stopPriceP === 2210 && engine.trade?.targetPriceP === 1910,
      'target and stop derive from the FILL',
      `target ${money.formatPrice(engine.trade?.targetPriceP)}, stop ${money.formatPrice(engine.trade?.stopPriceP)}`);

    /* --- 5. the target is reached: rung out, stop tightened -------------- */
    const beforeStop = engine.trade.stopPriceP;
    await engine._manageOnOptionCandle(bar(TOKEN, 1930, 1935, 1900, 1910, t0 + 25000));
    step(engine.trade.targetLevel === 2, 'the target rung advanced',
      `level ${engine.trade.targetLevel} -> ${money.formatPrice(engine.trade.targetPriceP)}`);
    step(engine.trade.stopPriceP < beforeStop,
      'the stop tightened behind it (§15.2)',
      `${money.formatPrice(beforeStop)} -> ${money.formatPrice(engine.trade.stopPriceP)}`);
    step(engine.trade.stopPriceP === 2010,
      'level 1 locks breakeven exactly', money.formatPrice(engine.trade.stopPriceP));

    /* --- 6. the stop is hit on a candle HIGH ----------------------------- */
    premium = 2100;
    await engine._manageOnOptionCandle(bar(TOKEN, 1950, 2050, 1940, 2020, t0 + 30000));
    step(engine.machine.is(STATES.EXIT_PENDING), 'the stop fired and an exit was sent',
      engine.machine.current);

    /* --- 7. the exit fills and the trade is booked ----------------------- */
    paper.onTick(TOKEN, 2020);
    await reconciler.runOnce();
    await engine._pollExitFill();

    const row = tradeDbId ? await repo.oseTrades.byId(tradeDbId) : null;
    step(row?.status === 'CLOSED', 'the trade is booked CLOSED', row?.exit_reason || '');
    step(Number(row?.entry_price_p) === 2010 && Number(row?.stop_price_p) > 0,
      'the FILL and the ladder were persisted to the row',
      row ? `entry ${money.formatPrice(row.entry_price_p)}, stop ${money.formatPrice(row.stop_price_p)}, `
        + `rung ${row.max_target_level ?? row.target_level}` : '');
    step(row?.net_pnl_p != null, 'net P&L was computed including charges',
      row ? `gross ${money.formatInr(row.gross_pnl_p)} · charges ${money.formatInr(row.charges_p)} `
        + `· net ${money.formatInr(row.net_pnl_p)}` : '');
    step(engine.trade === null, 'the position slot was released');

    /* --- 8. A WINNING trade, so both outcomes are proven ------------------ */
    //
    // The run above books a LOSS. A suite that only ever proves the losing path
    // has not shown that the ladder pays: it has shown that the stop works.
    // Here the premium decays, the rung walks out twice, the stop trails behind
    // it, and the position is closed on a trend break in profit.
    {
      const e2 = engine;
      e2.machine.current = STATES.SCANNING;
      e2.trade = null;
      e2.candidate = null;
      e2._cooldownLeft = 0;

      const w0 = t0 + 60000;
      e2.indexSeries.length = 0;
      for (let i = 0; i < 3; i += 1) {
        const c = 2450000 + i * 300;
        e2.indexSeries.push(bar('NIFTY-SELFTEST', c - 300, c + 100, c - 400, c, w0 + i * 5000));
      }
      const wc = bar('NIFTY-SELFTEST', 2451000, 2451400, 2450800, 2451350, w0 + 15000);
      e2.indexSeries.push(wc);
      e2.optionLast.set(TOKEN, bar(TOKEN, 2000, 2010, 1990, 2000, w0 + 15000));

      await e2._cycle(wc);                             // tracks the candidate
      const wc2 = bar('NIFTY-SELFTEST', 2451000, 2451400, 2450800, 2451350, w0 + 20000);
      e2.indexSeries.push(wc2);
      await e2._cycle(wc2);                            // takes the entry

      const winId = e2.trade?.dbId ?? null;
      paper.onTick(TOKEN, 2015);
      await reconciler.runOnce();
      await e2._pollEntryFill();
      step(Boolean(e2.trade?.entryPriceP), 'WIN: entry filled',
        money.formatPrice(e2.trade?.entryPriceP));

      // The premium decays. Each sealed bar closes at or through the rung.
      //
      // `optionLast` is updated alongside, because that is what `_onOptionCandle`
      // does in the real engine — and without it the INDEX cycle below still sees
      // the entry bar, whose 20.10 high sits above the trailed stop and fires
      // EXIT_STOP_HIT. The scenario would still go green while proving something
      // else entirely.
      const feed = async (o, h, l, c, ts) => {
        const b = bar(TOKEN, o, h, l, c, ts);
        e2.optionLast.set(TOKEN, b);
        await e2._manageOnOptionCandle(b);
      };
      await feed(1930, 1935, 1900, 1910, w0 + 25000);
      await feed(1830, 1835, 1800, 1810, w0 + 30000);
      step(e2.trade?.targetLevel === 3, 'WIN: the ladder walked out twice',
        `rung ${e2.trade?.targetLevel}, target ${money.formatPrice(e2.trade?.targetPriceP)}`);
      step(e2.trade?.stopPriceP === 1910, 'WIN: the stop trailed to +1 point locked',
        money.formatPrice(e2.trade?.stopPriceP));

      // The index turns against the thesis -> §13.3 closes it, in profit.
      const turn = bar('NIFTY-SELFTEST', 2451400, 2451450, 2450000, 2450100, w0 + 35000);
      e2.indexSeries.push(turn);
      await e2._cycle(turn);
      step(e2.machine.is(STATES.EXIT_PENDING), 'WIN: the position was closed',
        e2.machine.current);
      step(e2.trade?.exitReason === 'EXIT_TREND_BREAK' || e2.trade?.exitReason === 'EXIT_FILTER_FAIL',
        'WIN: closed by the POSITION FILTER, not the stop',
        e2.trade?.exitReason || '(none)');

      paper.onTick(TOKEN, 1810);
      await reconciler.runOnce();
      await e2._pollExitFill();

      const wrow = winId ? await repo.oseTrades.byId(winId) : null;
      step(wrow?.status === 'CLOSED', 'WIN: booked', wrow?.exit_reason || '');
      step(Number(wrow?.net_pnl_p) > 0, 'WIN: net P&L is POSITIVE after charges',
        wrow ? `gross ${money.formatInr(wrow.gross_pnl_p)} · charges `
          + `${money.formatInr(wrow.charges_p)} · net ${money.formatInr(wrow.net_pnl_p)}` : '');
      if (winId) extraTradeIds.push(winId);
    }

    /* --- 9. the audit trail --------------------------------------------- */
    const orders = tradeDbId ? await repo.orders.forOseTrade(tradeDbId) : [];
    const refs = orders.map(o => o.client_ref);
    step(orders.length === 2, 'exactly two orders — one entry, one exit',
      refs.join(' , '));
    step(new Set(refs).size === refs.length,
      'every order carries a distinct idempotency key (§12.3)');
    step(orders.every(o => /^OS-/.test(o.client_ref)),
      'all keys are scoped to this engine');
  } finally {
    Object.assign(risk, savedRisk);
    const allIds = [tradeDbId, ...extraTradeIds].filter(Boolean);
    if (allIds.length && !KEEP) {
      for (const id of allIds) {
        await db.query('DELETE FROM orders WHERE ose_trade_id = ?', [id]).catch(() => {});
        await db.query('DELETE FROM ose_guard WHERE trade_id = ?', [id]).catch(() => {});
        await db.query('DELETE FROM ose_trades WHERE id = ?', [id]).catch(() => {});
      }
      console.log(`\n  (cleaned up ${allIds.length} test trade(s) and their orders)`);
    } else if (allIds.length) {
      console.log(`\n  --keep: ${allIds.length} trade(s) left in the database so they show on /ose.`);
      console.log('  Named SELFTEST so they cannot be mistaken for a real one.');
      console.log('  Remove them with:  node scripts/ose-selftest.js --clean');
    }
    // Put the risk counters back exactly as they were. Without this the streak
    // this script invents is indistinguishable from a real one to the engine.
    // Restored even under --keep: the TRADE may stay for inspection, but an
    // invented loss streak must never gate a real session.
    if (statsBefore) {
      await db.query(
        `UPDATE ose_stats SET trades_today = ?, consecutive_losses = ?, realised_pnl_p = ?,
                gross_pnl_p = ?, charges_p = ?, win_count = ?, loss_count = ?, scratch_count = ?
          WHERE trade_date = ?`,
        [statsBefore.trades_today, statsBefore.consecutive_losses, statsBefore.realised_pnl_p,
          statsBefore.gross_pnl_p, statsBefore.charges_p, statsBefore.win_count,
          statsBefore.loss_count, statsBefore.scratch_count, tradeDate]).catch(() => {});
      console.log('  (restored the day\'s risk counters)');
    }
    await db.close();
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('\nself test failed to run:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
