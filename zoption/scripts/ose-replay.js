#!/usr/bin/env node
// Replay the engine over a synthetic session and report what it did.
//
//   node scripts/ose-replay.js                     30 minutes, seed 1
//   node scripts/ose-replay.js --minutes 60 --seed 7 --vol 3
//   node scripts/ose-replay.js --trades            print every trade
//
//   --history 2026-07-31 --start 09:20             replay a REAL session's index
//                                                  path instead of a random walk
//   --fill-market                                  take every signal at the
//                                                  prevailing premium (a market
//                                                  entry) rather than waiting for
//                                                  the limit to be reached
//   --fill-all                                     fill every entry AT its limit.
//                                                  An upper bound nobody can
//                                                  reach — see FILL_ALL below
//   --min-move 70                                  stretch a quiet real session
//                                                  until it spans 70 index
//                                                  points, keeping its shape
//   --offset 0.3 / --fill-window 3000              override the entry limit and
//                                                  the time it waits to fill
//   --no-trend-break / --no-filter-fail            disable either half of §13.3
//                                                  for this run only
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
//
// ---------------------------------------------------------------------------
// The decision rows it writes are NOT a record of the replay
// ---------------------------------------------------------------------------
//
// The bars are stamped from a fixed 10:00 IST, so a second run on the same day
// produces the same `(trade_date, candle_ts)` keys as the first. `ose_decisions`
// is keyed on exactly that pair with `ON DUPLICATE KEY UPDATE id = id`, so those
// rows are SILENTLY DROPPED — and on a live day they collide with the real
// engine's rows instead.
//
// Everything this script reports comes from its own in-memory tally and from the
// trades it made, so its OUTPUT is unaffected. But do not read `ose_decisions`
// afterwards expecting to find this run in it: you will find the first run of
// the day, or the engine's. That mistake has already been made once.

const repo = require('../src/repositories');
const db = require('../src/core/db');
const money = require('../src/core/money');
const time = require('../src/core/time');
const risk = require('../src/ose/risk');
const settingsService = require('../src/ose/settings');
const C = require('../src/ose/constants');
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
// Replay a REAL session instead of a random walk:
//   --history 2026-07-31 --start 09:20 --minutes 30
const argStr = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
};
const HISTORY = argStr('history', null);
const START = argStr('start', '09:20');
const SEED = arg('seed', 1);
const VOL = arg('vol', 2.5);          // index points of noise per 5s bar
const DRIFT = arg('drift', 0);        // points per bar of trend
const SHOW_TRADES = process.argv.includes('--trades');
// Force every entry to fill at its own limit price.
//
// Not realism — a counterfactual. A SELL limit at `close + offset` only fills
// when the premium ticks UP, and for a short that is the trade starting against
// you; the ones that never fill are the ones where the premium fell straight
// away, which is what the strategy is trying to catch. So the fill rule
// ADVERSELY SELECTS, and this measures how much that costs by removing it.
const FILL_ALL = process.argv.includes('--fill-all');
// The ATTAINABLE 100% fill: take every signal, but at the price the market is
// actually showing rather than at a limit it never traded through.
//
// `--fill-all` is an upper bound nobody can reach — it fills at `close + offset`
// even when the premium fell straight away and never came back. A MARKET entry
// is how you would really take those trades, and it pays for them: you get the
// prevailing premium, which on exactly those trades is LOWER than the limit.
// That is the honest counterfactual, and the gap between the two is the cost of
// insisting on a price.
const FILL_MARKET = process.argv.includes('--fill-market');

// The two levers over the entry fill rate, overridable so the trade-off can be
// MEASURED rather than argued about. `--offset` is the rupees above the option's
// close the SELL limit is placed at (settings.entryOffset); `--fill-window` is
// the milliseconds it waits before cancelling (§12.4's ENTRY_FILL_TIMEOUT_MS).
// Both default to whatever the live configuration says, so an unflagged run is
// unchanged.
// §13.3 as an exit, off for this run only — so the desk can see what the strict
// filter costs and earns before deciding to change the saved settings.
const NO_TREND_BREAK = process.argv.includes('--no-trend-break');
const NO_FILTER_FAIL = process.argv.includes('--no-filter-fail');
// Kept as the shorthand for "neither half of §13.3 closes anything".
const NO_FILTER_EXIT = process.argv.includes('--no-filter-exit');
const OFFSET = argStr('offset', null);
const FILL_WINDOW = arg('fill-window', null);
// Amplify a real session so the window covers at least this many index points.
//
// A quiet hour is a real hour, and most hours are quiet: 2026-07-30 from 10:00
// spans 19 points, which exercises the engine's refusals far more than its
// trades. `--min-move 70` keeps that hour's SHAPE — every turn, every pause,
// every reversal, in the order the exchange produced them — and scales its
// AMPLITUDE about the opening level until the high-to-low range reaches the
// number asked for. A window already wider than the target is left alone.
//
// The result is synthetic and says so on every run. It is a stress test of the
// decision path against a violent tape, not evidence about a real one: NIFTY
// did not move 70 points in that hour, and no P&L from an amplified path is a
// claim about what the day would have paid.
const MIN_MOVE = arg('min-move', null);

const STEP_MS = 5000;
const STRIKE_STEP = 50;
const SPOT0 = 2438360;                // paise — where the real index actually is
// The contract size the replay prices on. Resolved from the instrument master at
// startup rather than hardcoded: NIFTY moved from 75 to 65, and a replay sized
// on 75 overstates every P&L figure it reports by about 15%.
let LOT = 65;

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
        strike: k, optionType: type, expiry, lotSize: LOT, tickP: 5,
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

// A REAL index path, from Yahoo's one-minute NIFTY bars.
//
// ---------------------------------------------------------------------------
// What is real here, and what is not
// ---------------------------------------------------------------------------
//
// REAL: every minute's open, high, low and close. That is the actual index,
// from an actual session, and it is what the 3-candle trend, the EMA filter and
// the midpoint rules will overwhelmingly be reading — a 21-candle EMA at 5s
// spans under two minutes, so minute-scale structure dominates it.
//
// CONSTRUCTED: the path WITHIN each minute. Yahoo's finest interval is 1m and
// nothing available on this account records the index at 5s resolution
// (`candles` has 5s rows, but the recent ones carry the 25117.55 stale feed).
// So each real minute is expanded into twelve 5s bars that start at its open,
// end at its close, and touch its high and its low — the anchors are real, the
// wiggle between them is not.
//
// The OPTION CHAIN is still modelled off the spot by the same textbook curve the
// random-walk mode uses. Yahoo carries no NSE option data at all. So this tests
// the DECISION path against real index movement; it does not test the fills.
//
// Deterministic: the same date and start replay identically.
async function buildHistoryPath(path, bars, t0, rnd) {
  const { service } = require('../src/market/yahoo');
  const day = HISTORY;
  const next = new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);

  const res = await service.getHistoricalData('NIFTY', '1m', day, next);
  const ist = (t) => new Date(t + 19800000).toISOString().slice(11, 16);
  const all = (res.bars || []).filter(b => b.close != null);
  if (!all.length) throw new Error(`Yahoo returned no 1-minute bars for ${day}`);

  const from = all.filter(b => ist(b.time) >= START);
  const minutes = from.slice(0, Math.ceil(bars / 12));
  if (minutes.length < Math.ceil(bars / 12)) {
    console.log(`  NOTE: only ${minutes.length} minutes available from ${START} on ${day}`);
  }

  console.log(`  REAL index path: ${day} from ${START}, ${minutes.length} one-minute bars`);
  console.log('  minute open/high/low/close are REAL; the path inside each minute is constructed;');
  console.log('  the option chain is modelled off the spot (Yahoo has no NSE option data).');

  // --min-move: scale the session's amplitude about its opening level until the
  // high-to-low range reaches the target. Every bar is scaled by the SAME factor
  // about the SAME anchor, so the shape is preserved exactly — the ratio between
  // any two deviations is unchanged, and a bar that was flat stays flat.
  let scale = 1;
  if (MIN_MOVE !== null) {
    const anchor = minutes[0].open;
    const hi = Math.max(...minutes.map(m => m.high));
    const lo = Math.min(...minutes.map(m => m.low));
    const realRange = hi - lo;
    if (realRange > 0 && realRange < Number(MIN_MOVE)) {
      scale = Number(MIN_MOVE) / realRange;
      const grow = (v) => anchor + (v - anchor) * scale;
      for (const m of minutes) {
        m.open = grow(m.open); m.high = grow(m.high);
        m.low = grow(m.low); m.close = grow(m.close);
      }
      console.log('');
      console.log(`  *** AMPLIFIED ${scale.toFixed(2)}x: this hour really moved `
        + `${realRange.toFixed(1)} points, stretched to ${Number(MIN_MOVE).toFixed(1)}. ***`);
      console.log('  The SHAPE is the real session — every turn and pause in exchange order.');
      console.log('  The SIZE is invented. No P&L below is a claim about what this day paid.');
    } else {
      console.log('');
      console.log(`  --min-move ${MIN_MOVE}: already ${realRange.toFixed(1)} points — left as-is.`);
    }
  }
  console.log('');

  let seq = 0;
  let prevClose = Math.round(minutes[0].open * 100);
  for (const m of minutes) {
    const o = Math.round(m.open * 100);
    const h = Math.round(m.high * 100);
    const l = Math.round(m.low * 100);
    const c = Math.round(m.close * 100);

    // ONE CONTINUOUS WALK across the minute, then chunked into 12 bars of 5
    // samples — not 12 independent bars each sitting at its own midpoint.
    //
    // The first version did the latter, and it produced a path with almost no
    // movement INSIDE a bar: five samples at the same interpolated level plus a
    // few paise of jitter. Nothing could ever fill, because a SELL limit at
    // `close + 0.10` needs the premium to travel ten paise within about three
    // samples, and a spot that only wobbles ±0.5 points moves the premium by a
    // fraction of one. The replay reported 25 entries and 0 fills, which read as
    // a broken strategy and was a broken fixture.
    //
    // The anchors are placed so the minute's real extremes are both visited: an
    // up-minute dips to its low first and then makes its high, a down-minute the
    // reverse. That is the ordinary shape, and it keeps the extremes off the
    // close where they would fabricate a spike.
    const up = c >= o;
    const anchors = up ? [o, l, h, c] : [o, h, l, c];
    const N = 60;                              // 12 bars x 5 samples
    const walk = [];
    for (let x = 0; x < N; x += 1) {
      const t = x / (N - 1);                   // 0..1 across the minute
      const seg = Math.min(2, Math.floor(t * 3));
      const inSeg = (t * 3) - seg;
      const a = anchors[seg];
      const b = anchors[seg + 1];
      // Jitter scaled to the minute's own range, so a quiet minute stays quiet
      // and a violent one is not smoothed flat.
      const noise = (rnd() - 0.5) * 2 * Math.max(5, Math.abs(h - l) / 8);
      walk.push(Math.max(1, Math.round(a + (b - a) * inSeg + noise)));
    }

    for (let k = 0; k < 12 && seq < bars; k += 1, seq += 1) {
      const samples = walk.slice(k * 5, k * 5 + 5);
      const barOpen = prevClose;
      const barClose = samples[samples.length - 1];
      const ts = t0 + seq * STEP_MS;
      path.push({
        ts, samples,
        bar: bar('SIM-NIFTY', barOpen, Math.max(barOpen, ...samples),
          Math.min(barOpen, ...samples), barClose, ts),
      });
      prevClose = barClose;
    }
  }
}

async function main() {
  const bars = Math.round((MINUTES * 60) / 5);
  console.log(`\nOption Selling Engine — replay\n`);
  console.log(`  ${MINUTES} minutes (${bars} bars of 5s) · seed ${SEED} · `
    + `noise ${VOL} pts/bar · drift ${DRIFT} pts/bar\n`);

  if (!await db.healthCheck()) throw new Error('the database is not reachable');

  // The overrides are applied by WRAPPING load(), not by patching the config
  // object once. The engine re-reads its settings from the database on the first
  // cycle and every 5s after (`_reloadSettings`), so an override written onto the
  // first cfg is gone before the first candle — which is exactly what happened,
  // and why a run with the flag set produced output identical to one without it.
  if (NO_FILTER_EXIT || NO_TREND_BREAK || NO_FILTER_FAIL || OFFSET !== null) {
    const _load = settingsService.load;
    settingsService.load = async (...a) => {
      const c = await _load.apply(settingsService, a);
      // derive() freezes BOTH the config and each of its sub-blocks, and this
      // file is not a module in strict mode — so `c._rules = ...` threw nothing,
      // changed nothing, and produced a run byte-identical to the unflagged one.
      // The override has to build a new object, not write into the frozen one.
      const patch = {};
      if (NO_FILTER_EXIT || NO_TREND_BREAK || NO_FILTER_FAIL) {
        patch._rules = Object.freeze({
          ...c._rules,
          trendBreakExitEnabled: !(NO_FILTER_EXIT || NO_TREND_BREAK),
          filterFailExitEnabled: !(NO_FILTER_EXIT || NO_FILTER_FAIL),
        });
      }
      if (OFFSET !== null) {
        patch.entryOffset = Number(OFFSET);
        patch._entryOffsetP = money.toPaise(Number(OFFSET));
      }
      return Object.freeze({ ...c, ...patch });
    };
  }

  const cfg = await settingsService.load();
  LOT = (await settingsService.lotSizeFor(cfg.index)) || LOT;

  if (NO_FILTER_EXIT || NO_TREND_BREAK) console.log('  §13.3 EXIT_TREND_BREAK DISABLED');
  if (NO_FILTER_EXIT || NO_FILTER_FAIL) console.log('  §13.3 EXIT_FILTER_FAIL DISABLED');
  if (OFFSET !== null) {
    console.log(`  ENTRY OFFSET overridden: ₹${Number(OFFSET).toFixed(2)} above the option close`);
  }
  if (FILL_WINDOW !== null) {
    // The engine reads this constant per entry, so replacing the property is
    // enough — no engine change, and nothing persists past this process.
    C.ENTRY_FILL_TIMEOUT_MS = Number(FILL_WINDOW);
    console.log(`  ENTRY FILL WINDOW overridden: ${Number(FILL_WINDOW)}ms`);
  }
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
  // Mark every decision row this run writes, so the /ose panel can tell a
  // simulated session from a real one. Without it, eighteen replayed entries
  // read as eighteen trades the engine took today.
  engine.decisionSource = 'REPLAY';
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
  if (HISTORY) {
    await buildHistoryPath(path, bars, t0, rnd);
  } else {
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
      // Feed one tick exactly AT the working limit, so it fills at the price it
      // asked for. Uses the real broker path — nothing is patched.
      if ((FILL_ALL || FILL_MARKET) && engine.trade && engine._entryDeadline
          && engine.trade.requestedPriceP) {
        const tok = String(engine.trade.token);
        let at = engine.trade.requestedPriceP;                    // --fill-all
        if (FILL_MARKET && next) {
          // The premium at the NEXT sample — what a market order would get.
          const m = /^(\d+)(CE|PE)$/.exec(tok);
          if (m) at = premiumP(Number(m[1]), m[2], next.samples[0]);
          // A SELL fills only at or above its limit, so to model a market order
          // the resting limit is moved down to the prevailing price. Nothing
          // else is patched — the fill, the reconciler and the engine's own
          // accounting all run as they normally would.
          for (const row of paper.orders.values()) {
            if (row.status === 'WORKING' && String(row.token) === tok && row.side === 'SELL') {
              row.limitPaise = Math.min(row.limitPaise, at);
            }
          }
        }
        paper.onTick(tok, at);
        await reconciler.runOnce();
        await engine._pollEntryFill();
      }
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

    // The START is the first bar's OPEN, not SPOT0. In history mode the path
    // begins wherever the real session did, and printing the synthetic constant
    // as the open reported a move the replay never made.
    const startP = path.length ? path[0].bar.openP : SPOT0;
    console.log('  index      ', (startP / 100).toFixed(2), '->', (spotP / 100).toFixed(2),
      `(${((spotP - startP) / 100).toFixed(2)} pts)`);
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

    console.log('');
    if (HISTORY) {
      console.log(`  The INDEX PATH is real — ${HISTORY} from ${START}: every minute's open,`);
      console.log('  high, low and close came from the exchange. The path INSIDE each minute is');
      console.log('  constructed, and the OPTION CHAIN is modelled off the spot — Yahoo carries no');
      console.log('  NSE option data, so no fill here reflects a real book.');
      console.log('  This tests the DECISIONS against real movement. It does not test executions.');
    } else {
      console.log('  This is a random walk priced off a textbook curve. It shows how the RULES');
      console.log('  behave, not what the market will do.');
    }
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
