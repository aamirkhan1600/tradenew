// End-to-end drive of the real runner against the real database, with only the
// market feed stubbed. Everything else — the state machine, the scanner, the
// order router, the trade rows, the audit trail, the P&L — is production code.
//
// Not part of `npm test` (it needs a live database and mutates it). Run with:
//   node test/integration.e2e.js

const assert = require('node:assert/strict');

process.env.APP_ROLE = 'e2e';

const db = require('../src/core/db');
const repo = require('../src/repositories');
const feed = require('../src/market/feed');
const instrumentStore = require('../src/market/instrumentStore');
const { StrategyRunner } = require('../src/strategy/strategyRunner');
const { STATES: S } = require('../src/strategy/stateMachine');
const strategyConfig = require('../src/strategy/config');
const money = require('../src/core/money');
const config = require('../src/config');

// This script writes to whatever database .env points at. Refuse outright to do
// that against production — the synthetic contracts it creates carry both
// brokers' tokens and would look tradable to a live strategy.
if (config.isProd) {
  console.error('refusing to run the integration script with NODE_ENV=production');
  process.exit(1);
}

/* --------------------------------------------------- a synthetic BANKNIFTY */
const SPOT_TOKEN = '260105';
const STRIKES = [38100, 38200, 38300, 38350, 38400, 38450, 38500];
const SEED = { 38100: 72, 38200: 54, 38300: 44, 38350: 41, 38400: 38, 38450: 10, 38500: 6 };
const LOT = 15;
const PRICES = new Map([[SPOT_TOKEN, 38050]]);

// A ticker stand-in with the same surface the runner uses.
const fakeTicker = {
  subs: new Set(),
  subscribe(t) { (Array.isArray(t) ? t : [t]).forEach(x => this.subs.add(String(x))); },
  quote(token) {
    const v = PRICES.get(String(token));
    return v == null ? null : { ltp: v, ts: Date.now(), ageMs: 50, source: 'test' };
  },
  ltp(token) { return PRICES.get(String(token)) ?? null; },
  isHealthy() { return true; },
  status() { return { connected: true, healthy: true, subscriptions: this.subs.size }; },
};

// 11:00 IST on a Thursday — inside every default window.
let clock = Date.UTC(2026, 6, 30, 5, 30, 0);
const tick = (ms = 1000) => { clock += ms; };

let userId;
let strategyId;

async function seedInstruments(expiry) {
  const rows = [];
  STRIKES.forEach((strike, i) => {
    PRICES.set(String(9000 + i), SEED[strike]);
    rows.push({
      underlying: 'BANKNIFTY', expiryDate: expiry, strike, optionType: 'CE',
      a: 9000 + i, b: `BNF${strike}CE`, c: 'NFO', lotSize: LOT, tickSize: 0.05,
    });
  });
  await repo.instruments.upsertMany(rows, 'z');

  const kotakRows = STRIKES.map((strike, i) => ({
    underlying: 'BANKNIFTY', expiryDate: expiry, strike, optionType: 'CE',
    a: `K${9000 + i}`, b: `BANKNIFTY${strike}CE`, c: 'nse_fo', lotSize: LOT, tickSize: 0.05,
  }));
  await repo.instruments.upsertMany(kotakRows, 'k');

  // Must use the same sentinels as a real sync: NULLs never match the UNIQUE
  // key, so seeding with them would insert a duplicate index row on every run.
  await repo.instruments.upsertMany([{
    underlying: 'BANKNIFTY',
    expiryDate: instrumentStore.INDEX_SENTINEL.expiryDate,
    strike: instrumentStore.INDEX_SENTINEL.strike,
    optionType: 'IDX',
    a: Number(SPOT_TOKEN), b: 'NIFTY BANK', c: 'NSE', lotSize: null, tickSize: null,
  }], 'z');

  await repo.instruments.refreshTradableFlags();
}

async function setup() {
  const email = `e2e-${Date.now()}@local`;
  userId = await repo.users.create({ email, password: 'integration-test-pw', fullName: 'E2E' });

  // A deliberately impossible expiry. A real one would be overwritten by the
  // next instrument sync — or worse, would overwrite a real contract's tokens
  // with these fakes.
  const expiry = '2099-12-31';
  await seedInstruments(expiry);

  const config = strategyConfig.normalise({
    underlying: 'BANKNIFTY', expiry, optionType: 'CE',
    premiumMin: 35, premiumMax: 45, armPrice: 40, offset: 0.5, offsetFrom: 'ARM',
    // The doc's own 2-point target, deliberately: the run must show the engine
    // refusing to use it as-is.
    target: 2, stoploss: 12, lots: 2,
    hedgeMode: 'PREMIUM', hedgePremium: 10,
    entryTime: '09:20', lastEntryTime: '14:30', squareOffTime: '15:20',
    mode: 'paper', maxTradesPerDay: 3, reentryCooldownSec: 0,
  });
  const errors = strategyConfig.validate(config, { lotSize: LOT });
  assert.deepEqual(errors, [], 'the test config must be valid');

  strategyId = await repo.strategies.create(userId, { name: 'E2E premium range', config });
  await repo.strategies.setEnabled(strategyId, userId, true);

  // The runner asks instrumentStore for the spot token; keep it off the network.
  instrumentStore.indexToken = async () => SPOT_TOKEN;
  feed.attach = async () => fakeTicker;
}

async function teardown() {
  // The synthetic contracts MUST go. They carry both brokers' tokens, so they
  // look perfectly tradable to the scanner — leaving them behind would let a
  // live strategy select a strike that does not exist and send its fake Kotak
  // token as a real order.
  const r = await db.query(
    "DELETE FROM instruments WHERE z_symbol LIKE 'BNF%' AND k_token LIKE 'K90%'");
  if (r.affectedRows) console.log(`cleaned up ${r.affectedRows} synthetic instruments`);

  await db.query('DELETE FROM strategy_events WHERE user_id = ?', [userId]);
  await db.query('DELETE FROM orders WHERE user_id = ?', [userId]);
  await db.query('DELETE FROM trades WHERE user_id = ?', [userId]);
  await db.query('DELETE FROM daily_stats WHERE user_id = ?', [userId]);
  await db.query('DELETE FROM strategies WHERE user_id = ?', [userId]);
  await db.query('DELETE FROM users WHERE id = ?', [userId]);
}

async function run() {
  await setup();

  const row = await repo.strategies.get(strategyId);
  const runner = new StrategyRunner({ row, ticker: fakeTicker, kotakSession: null });

  const shortToken = String(9000 + STRIKES.indexOf(38350));
  const seen = [];
  const step = async (label) => {
    tick();
    await runner.tick({ hasPositionSlot: true, halted: false, now: clock });
    seen.push(runner.state);
    console.log(String(label).padEnd(8), runner.state.padEnd(16), runner.lastDecision);
  };

  console.log('\n— entry: the doc\'s price path on the 38350 CE —');
  for (const price of [41, 40.7, 40.3, 40.0, 39.9, 40.1, 40.3, 40.5]) {
    PRICES.set(shortToken, price);
    await step(price);
  }

  const trade = await repo.trades.openForStrategy(strategyId);
  assert.ok(trade, 'a trade must exist');
  assert.equal(Number(trade.sell_strike), 38350, 'the doc selects 38350');
  assert.equal(Number(trade.hedge_strike), 38450, 'the doc hedges at 38450');
  assert.equal(Number(trade.qty), 2 * LOT);
  assert.equal(trade.status, 'OPEN');

  // The configured 2-point target does not cover four legs of charges, so the
  // engine must have raised it rather than book a losing "win".
  const usedPoints = Number(trade.target_points);
  console.log(`\ntarget: configured 2 pts -> used ${usedPoints} pts`);
  assert.ok(usedPoints > 2, 'the target must have been lifted above the configured 2 points');
  const breakeven = money.breakevenPoints({
    sellPrice: Number(trade.sell_price), hedgePrice: Number(trade.hedge_price), qty: Number(trade.qty),
  });
  assert.ok(usedPoints > breakeven.points, 'the used target must clear breakeven');

  console.log('\n— hedge-first ordering —');
  const orders = await repo.orders.listByTrade(trade.id);
  console.log(orders.map(o => `${o.purpose} ${o.side} ${o.qty} @ ${o.avg_fill_price}`).join('\n'));
  assert.equal(orders[0].purpose, 'HEDGE_ENTRY', 'the hedge must be the first order');
  assert.equal(orders[0].side, 'BUY');
  assert.equal(orders[1].purpose, 'SHORT_ENTRY');
  assert.equal(orders[1].side, 'SELL');

  console.log('\n— exit: walk the premium down to the target —');
  const targetPrice = Number(trade.target_price);
  for (const price of [39, 37, targetPrice + 0.5, targetPrice]) {
    PRICES.set(shortToken, price);
    await step(price);
  }

  const closed = await repo.trades.get(trade.id);
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.exit_reason, 'target');

  console.log('\n— result —');
  console.log(`short ${closed.sell_price} -> ${closed.sell_exit_price}`);
  console.log(`hedge ${closed.hedge_price} -> ${closed.hedge_exit_price}`);
  console.log(`gross ${closed.gross_pnl}  charges ${closed.charges}  net ${closed.net_pnl}`);
  assert.ok(Number(closed.net_pnl) > 0,
    `a target hit must be net positive, was ${closed.net_pnl}`);

  const allOrders = await repo.orders.listByTrade(trade.id);
  assert.equal(allOrders.length, 4, 'four legs: hedge in, short in, short out, hedge out');
  assert.deepEqual(allOrders.map(o => o.purpose),
    ['HEDGE_ENTRY', 'SHORT_ENTRY', 'SHORT_EXIT', 'HEDGE_EXIT'],
    'INVARIANT: hedge on first, short off before hedge');

  // Idempotency: every leg carries a distinct key, and re-reserving one is refused.
  const keys = new Set(allOrders.map(o => o.client_order_id));
  assert.equal(keys.size, 4, 'each leg needs its own idempotency key');
  const replay = await repo.orders.reserve({
    userId, strategyId, tradeId: trade.id,
    clientOrderId: allOrders[0].client_order_id, purpose: 'HEDGE_ENTRY',
    kToken: allOrders[0].k_token, kSymbol: allOrders[0].k_symbol, kSegment: 'nse_fo',
    side: 'BUY', qty: allOrders[0].qty,
  });
  assert.equal(replay.duplicate, true, 'the database must refuse a duplicate order');
  console.log('\nidempotency: a replayed order was refused by the unique key ✓');

  const stats = await repo.dailyStats.get(strategyId, '2026-07-30');   // the frozen clock's date
  assert.equal(stats.trades, 1);
  assert.equal(stats.wins, 1);

  const events = await repo.events.list(userId, { limit: 100 });
  const types = new Set(events.map(e => e.event_type));
  for (const required of ['STATE', 'HEDGE', 'SHORT', 'TARGET', 'EXIT', 'CLOSED']) {
    assert.ok(types.has(required), `the audit trail must record ${required}`);
  }
  console.log(`audit: ${events.length} events recorded, covering ${[...types].sort().join(', ')}`);

  console.log('\nstates visited:', [...new Set(seen)].join(' -> '));
  assert.ok(seen.includes(S.HEDGE_OPEN) && seen.includes(S.OFFSET_WAIT)
    && seen.includes(S.POSITION_OPEN) && seen.includes(S.COMPLETE));

  console.log('\nALL INTEGRATION CHECKS PASSED');
}

run()
  .then(async () => { await teardown(); await db.close(); process.exit(0); })
  .catch(async (err) => {
    console.error('\nINTEGRATION FAILED:', err.message);
    console.error(err.stack);
    try { await teardown(); } catch (_) { /* leave the mess for inspection */ }
    await db.close();
    process.exit(1);
  });
