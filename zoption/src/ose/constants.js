// The Option Selling Engine's compiled-in constants — newdoc/update.md §5.2.
//
// The specification draws a hard line between two kinds of number and this file
// is one side of it:
//
//   §5.1  TUNABLE     an operator may change it. Lives in the `ose` settings
//                     row and is validated on every save. See ./settings.js.
//   §5.2  NON-TUNABLE business logic. Changing it is a CODE CHANGE requiring
//                     review and a full regression run. It is deliberately not
//                     a setting and deliberately not an environment variable,
//                     because a value that can be edited between sessions is a
//                     value nobody can reason about across sessions.
//
// Session windows (§17.4) and liquidity thresholds (§9.2) are non-tunable by the
// same rule even though both are still `[MUST-CONFIRM]`. They are constants that
// are not yet signed off, not settings — and that distinction is the whole point
// of the MUST_CONFIRM register at the bottom of this file.
//
// Prices are integer paise throughout. A "point" is one rupee of option premium,
// which is 100 paise and 20 ticks.

/* ------------------------------------------------------- §2, the arithmetic -- */

// NSE option tick. An off-tick limit price is rejected by the exchange outright.
const TICK = 5;                       // paise

// §14.1 — "1 point = 100 paise". Every target and stop in the specification is
// quoted in premium points, never in index points.
const POINT = 100;                    // paise

/* ------------------------------------------------------ §5.2, the constants -- */

const TREND_LOOKBACK = 3;             // completed index candles — §10.1
const CANDLE_MS = 5000;               // §5.2
const MAX_CANDLE_HISTORY = 720;       // one hour of 5s bars — §7.6

/* ---------------------------------------------------- §7, market data timing -- */

// §7.3 — a bucket seals at the earlier of the first tick past it or this long
// after its end. `CandleBuilder` sweeps on its own clock, so this is the sweep
// interval rather than a per-bucket timer; the effect is the same and the
// resolution is finer.
const SEAL_GRACE_MS = 400;

// §7.5 — one silent bucket is synthesised so the "one candle, one decision
// cycle" invariant survives. Two or more is a FEED GAP and is never synthesised:
// a close that is ten seconds stale is fiction, and pricing from it is worse
// than not trading.
const MAX_SYNTHETIC_RUN = 1;

/* ------------------------------------------------------- §8, the option chain -- */

const CHAIN_REFRESH_MS = 5000;        // §8.3
const CHAIN_TIMEOUT_MS = 800;         // §8.3 — the cycle never waits longer
const CHAIN_MAX_AGE_MS = 5000;        // §8.4 — older than this is not evidence
const CHAIN_CORRUPT_PCT = 0.40;       // §8.4 — discard rate that rejects a snapshot
const STRIKE_MULTIPLE = 50;           // §8.4 — NIFTY strikes are 50s

// §20.3 — five consecutive stale-chain cycles is a halt, not a shrug.
const CHAIN_STALE_HALT = 5;

/* ------------------------------- §9.2, the liquidity filters [MUST-CONFIRM #1] -- */

// THE MOST IMPORTANT COMMENT IN THIS FILE.
//
// These thresholds assume a market-data entitlement that answers with open
// interest, traded volume and both sides of the book. A Kotak Neo RETAIL
// entitlement answers with `ltp` and nothing else on most accounts —
// `src/market/quoteSource.js` probes for a richer quote filter at boot and
// reports what it settled on.
//
// Read literally, §8.4 discards any quote with `bid <= 0 || ask <= 0` and §9.2
// then requires four fields that never arrive. On an `ltp`-only account that
// combination discards 100% of the chain, trips CHAIN_CORRUPT on every cycle,
// and the engine never trades — not as a bug, but as the correct behaviour of a
// required filter with nothing to filter on.
//
// That is exactly what `[MUST-CONFIRM #10]` calls a hard blocker, so it is not
// papered over. `settings.liquidityMode` chooses which honest answer applies:
//
//   STRICT   the specification as written. A field the broker does not send
//            counts as a FAILURE. Ships as the default because it is what the
//            document says, and because a liquidity filter that silently did
//            not run is worse than one that visibly refuses.
//   LENIENT  a field the broker does not send is SKIPPED and recorded. The
//            strike is chosen on the checks that could actually be made, which
//            on this entitlement means premium alone.
//
// Neither mode ever coerces a missing field to zero. `Number(null)` is 0, and a
// chain where every strike reports zero open interest does not read as "the
// broker sent nothing" — it reads as "nobody holds these", which is a lie a
// trader can act on.
const MIN_OI = 500000;                // contracts
const MIN_VOLUME = 100000;            // contracts, cumulative for the day
const MIN_BID_LOTS = 5;               // × lot size — §9.2 gives `5 * LOT`
const MIN_ASK_LOTS = 5;
const MAX_SPREAD_ABS = 50;            // paise = ₹0.50
const MAX_SPREAD_PCT = 0.03;          // 3% of the mid

/* ---------------------------------------------------------- §9.3, the ranking -- */

// Min-max normalised across the surviving candidate set, summing to 1.0. These
// are §9.3 verbatim and are NOT weights an operator may retune — a different
// weighting is a different selection strategy and belongs in a revision of the
// specification, not in a settings form.
const SCORE_WEIGHTS = Object.freeze({
  oi: 0.40,
  volume: 0.30,
  depth: 0.20,
  spread: 0.10,                       // applied to (1 − spreadNorm)
});

// §9.3 — "score = round(score, 6)". Six decimal places, so the determinism gate
// compares exact values rather than floats that agree to within an epsilon.
const SCORE_DP = 6;

/* ------------------------------------------------------- §12, order mechanics -- */

const ORDER_SETTLE_MS = 500;          // §12.3 — wait before querying the book
const ENTRY_FILL_TIMEOUT_MS = 3000;   // §12.4 — then cancel whatever is unfilled
const EXIT_FILL_TIMEOUT_MS = 2000;    // §12.5
const EXIT_RETRY_MAX = 3;             // §12.5 — then HALT(EXIT_FAILED)
const REJECTION_HALT = 3;             // §12.4 — three consecutive → HALT
const SEVERE_SLIPPAGE_POINTS = 2;     // §20.3 — |fill − request| beyond this alerts

/* --------------------------------------------- §16.2, the maximum holding time -- */

// `[MUST-CONFIRM #9]` — v2.0 references a maximum holding time and gives no
// value. 24 candles at 5 seconds is 120 seconds, which sits just above the
// Price-Filter Engine's shipped 90s and below the point where a naked short
// stops being an intraday scalp.
const MAX_HOLD_CANDLES = 24;

// §14.4 — below one rupee of premium the spread makes further holding
// uneconomic, and the ladder is naturally bounded here anyway.
const PREMIUM_FLOOR = 100;            // paise

/* --------------------------------------- §17.4, the session windows [MUST-CONFIRM #8] -- */

// IST wall clock. Non-tunable per §5.2: an operator who can move the square-off
// can move it past the point where the position can still be closed.
const SESSION = Object.freeze({
  MARKET_OPEN: '09:15:00',
  FIRST_ENTRY_TIME: '09:20:00',       // skip the opening five candles of noise
  NO_NEW_ENTRY_TIME: '15:10:00',
  SQUARE_OFF_TIME: '15:15:00',        // forced flat, on the priority-0 timer
  MARKET_CLOSE: '15:30:00',
});

/* ------------------------------------------------------- §4.2 / §20, the guards -- */

const CYCLE_OVERRUN_LIMIT = 3;        // §4.2 — in a rolling 60s window → HALT
const CYCLE_EXCEPTION_LIMIT = 3;      // §20.5 — same window, same consequence
const ILLEGAL_TRANSITION_LIMIT = 3;   // §18.2 — three in a session → HALT
const GUARD_WINDOW_MS = 60000;

// §20.3 — a broker socket down this long while a position is open is a feed gap
// by another name.
const FEED_DOWN_EXIT_MS = 10000;

// §16.2 — priority-0 conditions run on their own timer so they fire even when
// the candle feed has stopped. That is the entire reason they are priority 0.
const SAFETY_TIMER_MS = 1000;

/* ---------------------------------------------------------- §20.4, retry policy -- */

const RETRY = Object.freeze({
  baseMs: 200,
  maxMs: 5000,
  maxAttempts: 5,
});

/* ============================================================================ */
/* §22 — the open specification items, as data rather than as prose.            */
/* ============================================================================ */

// "Development may begin on all modules, but the engine MUST NOT be enabled in
// LIVE mode until every item below is signed off."
//
// Keeping the register here rather than only in the document means the engine
// can enforce that sentence: `settings.load()` reads it, the boot log prints the
// unsigned ones, and the page shows them. A sign-off is recorded by listing the
// item's id in `settings.confirmed`.
//
// `implemented` names where the proposed default actually lives, so a reviewer
// checking an item off has one place to look rather than a section number to
// chase.
const MUST_CONFIRM = Object.freeze([
  {
    id: 1,
    section: '§9.2',
    item: 'Liquidity threshold constants (OI, volume, depth, spread)',
    proposed: 'MIN_OI 500,000 · MIN_VOLUME 100,000 · 5 lots each side · ₹0.50 / 3% spread',
    implemented: 'src/ose/constants.js, applied by src/ose/strikes.js',
    note: 'A Kotak retail entitlement sends none of these. See the comment above '
      + 'MIN_OI and the liquidityMode setting — this item is entangled with #10.',
  },
  {
    id: 2,
    section: '§12.2',
    item: 'Position size — lots per trade',
    proposed: '1 lot',
    implemented: 'settings.lots (§5.1 is silent on it, so it is tunable)',
    note: null,
  },
  {
    id: 3,
    section: '§14.3',
    item: 'Multi-level target advancement within one candle',
    proposed: 'One level per candle',
    implemented: 'src/ose/ladder.js — advanceTarget()',
    note: 'One level per sealed candle preserves the one-decision-per-candle invariant.',
  },
  {
    id: 4,
    section: '§15.4',
    item: 'Stop uses candle `high`; target uses `close`',
    proposed: 'As specified',
    implemented: 'src/ose/ladder.js — stopHit() / targetReached()',
    note: 'The asymmetry is deliberate and conservative in both directions, but it '
      + 'also means the stop is only evaluated once every 5 seconds. See the boot '
      + 'warning in src/ose/settings.js.',
  },
  {
    id: 5,
    section: '§16.2.4',
    item: 'Premium Safety Exit vs Initial Stop Loss distinction',
    proposed: 'Backstop, as specified',
    implemented: 'src/ose/exits.js — evaluate(), priority 2',
    note: 'Firing WITHOUT the stop also firing indicates a stop-evaluation bug and '
      + 'raises a warn-level alert.',
  },
  {
    id: 6,
    section: '§17.3',
    item: 'Loss defined on gross or net P&L',
    proposed: 'Net, including charges',
    implemented: 'src/ose/engine.js — _bookTrade() folds money.shortPnl().netPaise',
    note: 'A gross-scratch trade is a net loss; the circuit breaker should reflect that.',
  },
  {
    id: 7,
    section: '§8.2',
    item: 'Trading permitted on expiry day',
    proposed: 'Not permitted',
    implemented: 'settings.tradeOnExpiryDay, enforced in engine._canOpenTrade()',
    note: null,
  },
  {
    id: 8,
    section: '§17.4',
    item: 'Session windows and square-off time',
    proposed: '09:20 first entry · 15:10 no new entry · 15:15 square off',
    implemented: 'SESSION in this file',
    note: null,
  },
  {
    id: 9,
    section: '§16.2',
    item: 'MAX_HOLD_CANDLES',
    proposed: '24 candles (120 s)',
    implemented: 'MAX_HOLD_CANDLES in this file',
    note: null,
  },
  {
    id: 10,
    section: '§7.7',
    item: 'Broker identity and API capabilities (5s option candles available?)',
    proposed: '—',
    implemented: 'Kotak Neo. src/market/candleBuilder.js assembles 5s option bars '
      + 'from the tick stream; src/market/quoteSource.js reports the entitlement.',
    note: 'HARD BLOCKER. 5s option candles ARE buildable here, but on the REST quote '
      + 'fallback (NEO_POLL_MS=1000) a 5s bar holds at most 5 samples and often 1–2. '
      + 'settings.optionMinTicks decides whether such a bar may price an order.',
  },

  /* ------------------------------------------------------------------------ */
  /* Raised by v4.0 of the specification, when #10 was resolved to Kotak Neo.  */
  /*                                                                          */
  /* These five are not new questions — they are the PRICE of that answer.     */
  /* Each one is a place where this broker cannot do what the specification    */
  /* assumed, and the engine's behaviour there is a choice the desk makes      */
  /* rather than one the code can make on its own.                             */
  /* ------------------------------------------------------------------------ */
  {
    id: 11,
    section: '§7.8',
    item: 'indexMinTicks / optionMinTicks — how few samples is too few to trade on',
    proposed: '3 for the index series, 2 for an option series',
    implemented: 'settings.indexMinTicks / settings.optionMinTicks, applied by CandleBuilder '
      + 'and surfaced as the `tradable` flag',
    note: 'The asymmetry is deliberate: the index is quoted on every poll and should see '
      + '3+ samples in 5s, while an option quoted inside a 41-strike batch may honestly see '
      + 'fewer. Set these too high and the engine never trades; too low and it prices orders '
      + 'from a close that predates the bucket by most of its width.',
  },
  {
    id: 12,
    section: '§16.4',
    item: 'The sampled-stop guard on the priority-0 timer',
    proposed: 'Enabled',
    implemented: 'settings.stopGuardEnabled, evaluated by exits.onTimer()',
    note: '§15.4 evaluates the stop once per 5s candle on SAMPLED extremes, so a spike that '
      + 'crosses the stop and retraces between two polls leaves no trace in the candle at all. '
      + 'The guard re-checks the live sample every second. It can only ever CLOSE a position, '
      + 'never open one, which is why it is permitted to read a live quote at all. Declining '
      + 'this item is defensible; shipping without choosing is not.',
  },
  {
    id: 13,
    section: '§9.2.1',
    item: 'liquidityMode default under this account\'s real entitlement',
    proposed: 'STRICT',
    implemented: 'settings.liquidityMode, applied by src/ose/strikes.js gate()',
    note: 'Entangled with #1 and #10. On an ltp-only entitlement STRICT selects NO strike, '
      + 'ever — correct behaviour, but the engine sits visibly idle. LENIENT trades on premium '
      + 'alone and records every skipped filter per trade. Run scripts/diagnose-spot.js against '
      + 'a live session before deciding: if this UCC answers `quote` or `full`, the question '
      + 'is moot.',
  },
  {
    id: 14,
    section: '§31.2',
    item: 'Who performs the daily interactive login, and by when',
    proposed: 'An operator, by 09:00 IST',
    implemented: 'Not automatable. The engine waits in IDLE; /health reports brokerSession',
    note: 'Kotak authenticates with a TOTP and an MPIN and neither may be persisted, so the '
      + 'engine cannot start a trading day on its own. This is the single point at which a '
      + 'trading day can silently fail to begin, and the failure is indistinguishable from a '
      + 'quiet market unless something watches for it — alert if the session is inactive at '
      + '09:10.',
  },
  {
    id: 15,
    section: '§17.6 / §31.4',
    item: 'Behaviour when the Kotak session expires with a position open',
    proposed: 'HALT + critical page; hold the position under operator supervision',
    implemented: 'Session-expiry guard in the engine; HALT(SESSION_EXPIRED)',
    note: 'THE ONE FAILURE THIS ENGINE CANNOT PROTECT ITSELF FROM. Without a session it cannot '
      + 'send the exit — the kill switch cannot close the position either. Every mitigation is '
      + 'operational: an operator present during the session, the alert, and the Kotak terminal '
      + 'as the manual exit path.',
  },

  /* ------------------------------------------------------------------------ */
  /* Raised by v4.1 — areas both v3.0 and v4.0 left silent, where silence had  */
  /* quietly resolved to a default nobody chose.                               */
  /* ------------------------------------------------------------------------ */
  {
    id: 16,
    section: '§12.6',
    item: 'Margin: pre-check every order, or absorb the rejection',
    proposed: 'Absorb. One check-margin at boot; no per-order check',
    implemented: 'Boot check in src/oseEngine.js; rejections handled by §12.4',
    note: 'A pre-check costs a rate token and a round trip inside the 100ms order budget to '
      + 'answer a question that is a RACE anyway — margin can move between the check and the '
      + 'place, so passing does not make the order safe. Two consecutive margin rejections '
      + 'halt with MARGIN_EXHAUSTED, kept distinct from REPEATED_REJECTION because the fix is '
      + 'to fund the account, not to debug the engine.',
  },
  {
    id: 17,
    section: '§12.7',
    item: 'PAPER fill model, and what ten paper sessions cannot evidence',
    proposed: 'Pessimistic: limits fill at their own price only, markets at the NEXT sample',
    implemented: 'src/broker/paperBroker.js',
    note: 'PAPER simulates neither partial fills nor rejections nor queue position, so §12.4\'s '
      + 'PARTIAL and rejection paths are mock-only and the ₹15–25 strikes this strategy sells '
      + 'will fill more slowly in reality than in simulation. Paper results are an OPTIMISTIC '
      + 'BOUND, which is why §25.8 accepts on "zero halts from defects" rather than on P&L.',
  },
]);

const MUST_CONFIRM_IDS = Object.freeze(MUST_CONFIRM.map(m => m.id));

module.exports = Object.freeze({
  TICK, POINT,
  TREND_LOOKBACK, CANDLE_MS, MAX_CANDLE_HISTORY,
  SEAL_GRACE_MS, MAX_SYNTHETIC_RUN,
  CHAIN_REFRESH_MS, CHAIN_TIMEOUT_MS, CHAIN_MAX_AGE_MS, CHAIN_CORRUPT_PCT,
  STRIKE_MULTIPLE, CHAIN_STALE_HALT,
  MIN_OI, MIN_VOLUME, MIN_BID_LOTS, MIN_ASK_LOTS, MAX_SPREAD_ABS, MAX_SPREAD_PCT,
  SCORE_WEIGHTS, SCORE_DP,
  ORDER_SETTLE_MS, ENTRY_FILL_TIMEOUT_MS, EXIT_FILL_TIMEOUT_MS, EXIT_RETRY_MAX,
  REJECTION_HALT, SEVERE_SLIPPAGE_POINTS,
  MAX_HOLD_CANDLES, PREMIUM_FLOOR,
  SESSION,
  CYCLE_OVERRUN_LIMIT, CYCLE_EXCEPTION_LIMIT, ILLEGAL_TRANSITION_LIMIT, GUARD_WINDOW_MS,
  FEED_DOWN_EXIT_MS, SAFETY_TIMER_MS,
  RETRY,
  MUST_CONFIRM, MUST_CONFIRM_IDS,
});
