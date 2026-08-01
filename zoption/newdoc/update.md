# NIFTY Option Selling Engine — Technical Design Document

**Version:** 4.1 (Production Specification — Kotak Neo, single broker)
**Supersedes:** v3.0 (archived at `newdoc/update-v3.0.md`)
**Status:** Approved for Production Development
**Audience:** Technical Lead, Senior Backend Engineers, QA, DevOps, Risk

**Scope note.** v3.0 specified the engine against an *idealised* broker: a streaming
tick feed, a full option chain with depth, and a place-order call carrying a client
order id. **Kotak Neo provides none of those three as v3.0 assumed.** v4.0 binds the
specification to Kotak Neo as the sole and only broker and rewrites every rule that
depended on the idealised assumptions, in place, keeping v3.0's section numbering
byte-for-byte so that the section references already embedded in the code
(`src/ose/*`, `db/schema.sql`, `src/config/index.js`) remain correct.

No new *business* features are introduced. Every rule here either (a) restates v3.0,
(b) replaces a v3.0 rule that Kotak Neo makes unimplementable — each such change is
tagged **`[KOTAK]`** and explains what it replaces and why, or (c) is marked
`[MUST-CONFIRM]` where production cannot proceed without a desk decision. §22 lists
every open item in one place.

**Numbering guarantee.** §1–§27 keep their v3.0 meanings and numbers. Kotak-specific
material that has no v3.0 home is appended as §28–§32 rather than inserted, so no
existing cross-reference shifts.

**Disclaimer:** This is a software design document. It specifies deterministic system
behaviour only. It is not trading advice and makes no claim about profitability.
Capital deployment requires independent validation by the trading desk and compliance
with exchange and broker regulations.

---

## Table of Contents

1. Purpose and Scope
2. Definitions and Notation
3. Design Principles (Normative)
4. Runtime Architecture
5. Configuration Contract
6. Domain Model and Interfaces
7. Market Data Module
8. Option Chain Module
9. Strike Selection Module
10. Trend Engine
11. Entry Validation Engine
12. Order Management Module
13. Position Manager
14. Dynamic Target Engine
15. Trailing Stop Module
16. Exit Engine
17. Risk Engine
18. State Machine
19. Persistence Layer
20. Error Handling and Recovery
21. Logging and Observability
22. Open Specification Items (`[MUST-CONFIRM]`)
23. Performance Budget
24. Coding Standards
25. Testing Requirements
26. Deployment and Production Operations
27. Out of Scope
28. Kotak Neo Adapter Contract (`[KOTAK]`)
29. Kotak Neo Entitlement Matrix and Degraded Modes (`[KOTAK]`)
30. Rate-Limit Budget (`[KOTAK]`)
31. Session Lifecycle and the Daily Login (`[KOTAK]`)
32. Kotak Failure Catalogue (`[KOTAK]`)

---

# 1. Purpose and Scope

## 1.1 Purpose

Build a fully automated intraday NIFTY option-selling engine that selects contracts,
validates entries, manages open positions and exits trades with zero manual
intervention *during the session*, using NIFTY 5-second candles as the sole decision
source, executing exclusively through **Kotak Neo**.

"Zero manual intervention" has one Kotak-imposed exception, stated once here and
specified in §31: **the daily login is interactive.** Kotak Neo authenticates with a
TOTP and an MPIN, neither of which may be persisted, so an operator performs one login
before the session. The engine cannot start a trading day on its own. This is a broker
constraint, not a design choice.

## 1.2 In Scope

- NIFTY index only
- 5-second candle timeframe only
- Option selling only (short CE, short PE)
- Single active position at a time
- Intraday only — no overnight carry
- **Single broker: Kotak Neo. Single account, single UCC.** Kotak Neo is both the
  execution venue *and* the only price source. There is no second data vendor.

## 1.3 Explicitly Out of Scope

BANKNIFTY, multi-index, multi-broker, web dashboard, analytics UI, notifications, ML
parameter tuning, HA clustering. These remain future enhancements and **must not**
appear in the v4.0 codebase, not even as stubs, feature flags or dead branches. Any
pull request introducing them is rejected at review.

**`[KOTAK]`** A broker *abstraction layer* is also out of scope. There is exactly one
adapter, it is named for Kotak, and it may expose Kotak vocabulary (`jData`, `nOrdNo`,
`nse_fo`) at its own boundary. Writing a generic `IBroker` to hold one implementation
buys nothing and hides the quirks in §28 that the engine must actually reason about.

---

# 2. Definitions and Notation

| Term | Definition |
|---|---|
| **Tick** | Minimum price increment. NIFTY options: `0.05` (5 paise). All prices sent to Kotak MUST be exact multiples of the tick — an off-tick limit is rejected by the exchange outright. |
| **Point** | One unit of option premium (₹1.00 = 100 paise = 20 ticks). All targets and stops in this document are in premium points, never index points. |
| **Sample** | **`[KOTAK]`** One observation of a price. On Kotak Neo a sample is one row of a REST quote response, *not* an exchange trade print. See §7.1. |
| **Candle** | A 5-second OHLC bucket built from samples. `ts` = bucket open time, epoch milliseconds, IST-aligned to absolute wall-clock boundaries. |
| **Completed candle** | A candle that has been *sealed* per §7.3. Only completed candles may be read by any decision module. |
| **Tradable candle** | **`[KOTAK]`** A completed candle that is not synthetic and whose `tickCount >= minTicks` (§7.8). **Only a tradable candle may price an order.** A completed-but-not-tradable candle may still be read for trend. |
| **Decision cycle** | The processing triggered by exactly one newly sealed NIFTY candle. |
| **Reference price** | The `close` of the latest completed NIFTY candle. The engine has no other notion of "current price". |
| **Position premium** | The `close` of the latest completed *option* candle for the held contract. |
| **Short P&L** | `pnl_points = entry_price − position_premium`. Positive = profit (premium decayed). |
| **UCC** | Unique Client Code — the Kotak account identity. One UCC per engine instance. |
| **MUST / MUST NOT / SHOULD** | RFC 2119 interpretation. `MUST` items are testable acceptance criteria. |

**Rounding rule (normative).** Two helpers exist and only these two:

```
floorToTick(p)  = Math.floor(round(p / TICK, 8)) * TICK
ceilToTick(p)   = Math.ceil (round(p / TICK, 8)) * TICK
```

All monetary values are handled as **integer paise** (`price_paise = round(price * 100)`)
inside the engine. Floating-point arithmetic on prices is forbidden.

**`[KOTAK]`** Conversion to rupees happens at exactly one boundary: the `jData`
serialiser in `src/broker/neoClient.js` (§28.3), because Kotak's wire format quotes
prices in rupees as strings. Nothing above that function ever holds a rupee float.
Conversion back to paise happens when reading a quote row or an order-book fill.

---

# 3. Design Principles (Normative)

These are acceptance criteria, not aspirations.

1. **Determinism.** Given an identical ordered sequence of completed candles and
   option-chain snapshots, the engine MUST produce a byte-identical sequence of
   decisions. Verified by the determinism test in §25.4.
   **`[KOTAK]`** Determinism is asserted over *sealed candles and snapshots*, not over
   raw Kotak polls: poll timing is not reproducible, so the replay harness (§25.5)
   replays sealed candles, and the sampler that produced them is tested separately.
2. **Completed data only.** No module may read an unsealed candle or a live quote for
   any *decision*. Live quotes may be used only for (a) broker order routing
   mechanics, (b) reconciliation, and (c) **`[KOTAK]`** the priority-0 safety guard of
   §16.4, which is a protective override and never an entry.
3. **Single active trade.** The engine MUST reject any entry attempt while
   `activeTrade !== null`. Enforced by a single guard in the Risk Engine — and,
   **`[KOTAK]`** because a process can die between selecting a strike and recording
   it, additionally by the `ose_guard` partial-unique row in MySQL (§19.1).
4. **Event-driven, single-threaded.** One Node.js event loop. No `child_process`, no
   worker threads, no `Atomics`. State is confined to one thread by construction.
5. **No discretionary logic.** No branch may depend on wall-clock time except the
   session windows in §17.4 and the priority-0 timer in §16.4, on randomness, on
   `Math.random()`, on map/object iteration order, or on any unstable sort.
6. **Stateless between candles except trade state.** The only mutable state surviving
   a decision cycle is: `EngineState`, `ActiveTrade`, `RiskCounters`, and the bounded
   candle ring buffers. Everything else MUST be recomputed.
7. **Module independence.** Modules communicate only through the interfaces in §6. No
   module imports another module's internals. Enforced by lint rule (§24.3).
8. **Fail closed.** Any unhandled condition results in *no trade* or *exit*, never in
   an unprotected position.
9. **`[KOTAK]` Absence is not zero.** A field Kotak does not send is `null`, never `0`.
   A chain rendering `0` open interest reads as "nobody holds this strike", which is a
   lie a filter will act on; `null` reads as "the broker did not say", which is the
   truth. `Number(null) === 0` is the single most dangerous coercion in this codebase
   and is banned by lint in `src/ose/**` and `src/market/**`.
10. **`[KOTAK]` Uncertainty is not failure.** Every Kotak call resolves to exactly one
    of three outcomes — `rejected`, `uncertain`, `auth` (§28.5). Collapsing
    `uncertain` into `rejected` and retrying is how one short becomes two.

---

# 4. Runtime Architecture

## 4.1 Data Flow

```
        ┌──────────────────────────────────────────────┐
        │            Kotak Neo (single broker)          │
        │  REST quotes · REST orders · scrip master     │
        │  HSM WebSocket (optional, unreliable — §7.1)  │
        └───────┬──────────────────────────┬───────────┘
                │ samples (poll ≥ WS)      │ order acks / book
                ▼                          │
       ┌──────────────────┐                │
       │ Quote Sampler    │  §7.1          │
       │ (QuoteSource)    │                │
       └────────┬─────────┘                │
                │ (token, ltp, ts)         │
                ▼                          │
       ┌──────────────────┐                │
       │ Market Data      │  seals 5s candles, flags tradable
       └────────┬─────────┘                │
                │ CandleSealed(NIFTY)      │
                ▼                          │
       ┌──────────────────┐                │
       │ Decision Cycle   │  orchestrator (§4.2)
       └────────┬─────────┘                │
    ┌───────────┼───────────┐              │
    ▼           ▼           ▼              │
┌─────────┐ ┌────────┐ ┌──────────┐        │
│ Option  │ │ Trend  │ │ Position │        │
│ Chain   │ │ Engine │ │ Manager  │        │
└────┬────┘ └───┬────┘ └────┬─────┘        │
     ▼          ▼           ▼              │
┌─────────┐ ┌────────┐ ┌──────────────┐    │
│ Strike  │ │ Entry  │ │ Target /     │    │
│ Select  │ │ Valid. │ │ Trail / Exit │    │
└────┬────┘ └───┬────┘ └──────┬───────┘    │
     └────┬─────┘             │            │
          ▼                   ▼            │
   ┌─────────────┐     ┌─────────────┐     │
   │ Risk Engine │◄────┤ Exit Engine │     │
   └──────┬──────┘     └──────┬──────┘     │
          ▼                   ▼            │
   ┌────────────────────────────────────┐  │
   │ Order Manager  (§12)               │  │
   └────────────────┬───────────────────┘  │
                    ▼                      │
   ┌────────────────────────────────────┐  │
   │ Order Router + Reconciler          │◄─┘
   │ (client_ref idempotency, §12.3)    │
   └────────────────┬───────────────────┘
                    ▼
   ┌────────────────────────────────────┐
   │ NeoSession  (rate bucket, 401 latch)│
   └────────────────┬───────────────────┘
                    ▼
              neoClient (raw HTTP)
```

Two things differ from v3.0's diagram and both are Kotak-imposed: a **Quote Sampler**
stands between the broker and Market Data because there is no dependable push feed, and
a **Reconciler** stands between the Order Manager and the broker because there is no
client order id to query by.

## 4.2 Decision Cycle Orchestrator

Exactly one entry point. Pseudocode is normative:

```js
async function onNiftyCandleSealed(candle) {
  const t0 = hrtimeMs();
  const ctx = { cycleId: uuidv7(), candle, ts: candle.ts };

  try {
    if (!risk.isSessionOpen(candle.ts))       return finish(ctx, 'SESSION_CLOSED');
    if (risk.isHalted())                      return finish(ctx, 'HALTED');
    if (!broker.sessionActive())              return finish(ctx, 'BROKER_SESSION_EXPIRED');

    marketData.appendNifty(candle);

    if (state.is('POSITION_OPEN') || state.is('POSITION_MANAGEMENT')) {
      await manageOpenPosition(ctx);          // §13
    } else if (state.is('SCANNING')) {
      await evaluateEntry(ctx);               // §9–§12
    } else if (state.is('COOLDOWN')) {
      cooldown.tick();                        // §17.5
      if (cooldown.isExpired()) state.to('SCANNING', ctx);
    }
  } catch (err) {
    await failSafe(ctx, err);                 // §20.5
  } finally {
    metrics.observeCycleLatency(hrtimeMs() - t0);
  }
}
```

**`[KOTAK]`** The `BROKER_SESSION_EXPIRED` guard is new in v4.0. A Kotak session dies
without warning (§31.4); continuing to evaluate entries against a dead session
produces a cycle whose every step fails at the last one, and buries the one
informative error under a hundred derived ones.

**Reentrancy.** `onNiftyCandleSealed` MUST NOT overlap with itself. A
cycle-in-progress flag drops any candle sealed while a cycle runs; the dropped candle
is logged as `CYCLE_OVERRUN` and counted. More than `3` overruns in a rolling 60s
window triggers `HALTED` (§17.6).

## 4.3 Process Topology

Single Node.js process for the engine. No horizontal scaling — the single-active-trade
invariant cannot be safely distributed. High availability is explicitly out of scope
(§27).

**`[KOTAK]`** The engine shares one Kotak account with the web process (the read-only
terminal, `src/market/terminal.js`). Kotak's rate limit is **per account, not per
process**, so the two token buckets add rather than isolate. §30 allocates the budget;
exceeding it starves the order path, which is the only path whose failure costs money.

## 4.4 Leadership

Only one engine process may hold the Kotak account at a time. The `engine_locks` row
with `ENGINE_LOCK_TTL_MS` is the guard; a second process that cannot take the lock
starts in read-only mode and never places an order. Two engines on one UCC would each
believe they hold the single active trade.

---

# 5. Configuration Contract

## 5.1 Tunable Configuration

These are the values an operator may change. They live in the `settings` row named
`ose` (`src/ose/settings.js`), are loaded at boot, validated, and deeply frozen.

| Key | Default | Unit | Validation |
|---|---|---|---|
| `index` | `NIFTY` | — | enum, single value |
| `timeframeSeconds` | `5` | s | const `5` |
| `premiumMin` | `15.00` | ₹ | `> 0`, `< premiumMax` |
| `premiumMax` | `25.00` | ₹ | `> premiumMin` |
| `entryOffset` | `0.10` | ₹ | multiple of tick, `>= 0` |
| `initialTargetPoints` | `1` | pts | integer `>= 1` |
| `initialStopPoints` | `2` | pts | integer `>= 1` |
| `targetExtensionPoints` | `1` | pts | integer `>= 1` |
| `trailingStopEnabled` | `true` | bool | — |
| `premiumSafetyExitPoints` | `2` | pts | integer `>= 1` |
| `reentryWaitCandles` | `2` | candles | integer `>= 0` |
| `maxOpenTrades` | `1` | — | const `1` |
| `maxTradesPerDay` | `30` | — | integer `>= 1` |
| `maxConsecutiveLosses` | `5` | — | integer `>= 1` |

### 5.1.1 Kotak-imposed additions `[KOTAK]`

v3.0 called §5.1 a closed list. Running on a real broker rather than an idealised one
requires six more, each of which would otherwise become a hardcoded assumption nobody
can see. Each is marked with the item it settles.

| Key | Default | Why it exists |
|---|---|---|
| `lots` | `1` | `[MUST-CONFIRM #2]` — §12.2 leaves position size open. Quantity = `lots × lotSize`, lot size read from Kotak's scrip master, never hardcoded. |
| `mode` | `PAPER` | `PAPER`/`LIVE`. v3.0 §5.3 put this in the environment; this platform keeps it per-profile so the two sibling engines can be in different modes at once. `LIVE` still requires `NODE_ENV=production` (§5.3). |
| `liquidityMode` | `STRICT` | `STRICT` \| `LENIENT`. The §9.2 ↔ `[MUST-CONFIRM #10]` entanglement — see §29.2. |
| `tradeOnExpiryDay` | `false` | `[MUST-CONFIRM #7]`. |
| `scanRange` | `20` | Strikes either side of ATM to quote. §8.1 says "the option chain"; quoting all ~200 strikes once a cycle would consume the entire rate budget (§30). |
| `indexMinTicks` / `optionMinTicks` | `3` / `2` | §7.3 counts ticks per bucket but never says how few is too few. On Kotak's REST sampler a 5s bar can hold one sample, and one sample is not an OHLC. `[MUST-CONFIRM #11]`. |
| `confirmed` | `[]` | The §22 sign-off register, as data. Listing an item's id records its sign-off; `LIVE` refuses to start while any id is missing (§22). |

## 5.2 Non-Tunable Constants

Business logic constants live in `src/ose/constants.js`, are compiled in, and changing
them is a code change requiring review and a full regression run. They are **not** in
any config file and **not** environment variables.

```js
TICK               = 5;        // paise — NSE option tick
POINT              = 100;      // paise — one premium point
TREND_LOOKBACK     = 3;        // completed candles
CANDLE_MS          = 5000;
MAX_CANDLE_HISTORY = 720;      // one hour ring buffer
SEAL_GRACE_MS      = 400;
MAX_SYNTHETIC_RUN  = 1;
CHAIN_REFRESH_MS   = 5000;
CHAIN_TIMEOUT_MS   = 800;
CHAIN_MAX_AGE_MS   = 5000;
CHAIN_CORRUPT_PCT  = 0.40;
STRIKE_MULTIPLE    = 50;
CHAIN_STALE_HALT   = 5;
MIN_OI = 500_000;  MIN_VOLUME = 100_000;
MIN_BID_LOTS = 5;  MIN_ASK_LOTS = 5;
MAX_SPREAD_ABS = 50;           // paise
MAX_SPREAD_PCT = 0.03;
ORDER_SETTLE_MS = 500;  ENTRY_FILL_TIMEOUT_MS = 3000;
EXIT_FILL_TIMEOUT_MS = 2000;  EXIT_RETRY_MAX = 3;
REJECTION_HALT = 3;  SEVERE_SLIPPAGE_POINTS = 2;
MAX_HOLD_CANDLES = 24;  PREMIUM_FLOOR = 100;
CYCLE_OVERRUN_LIMIT = 3;  CYCLE_EXCEPTION_LIMIT = 3;
ILLEGAL_TRANSITION_LIMIT = 3;  GUARD_WINDOW_MS = 60_000;
FEED_DOWN_EXIT_MS = 10_000;  SAFETY_TIMER_MS = 1000;
```

Session times (§17.4) and liquidity thresholds (§9.2) are non-tunable by the same rule
even though both are still `[MUST-CONFIRM]`. They are constants awaiting sign-off, not
settings — that distinction is the entire point of the `MUST_CONFIRM` register.

## 5.3 Environment Configuration

Infrastructure-only, never business logic. Validated at boot; the process exits
non-zero if invalid (`src/config/index.js`).

```
NODE_ENV                 = development | testing | staging | production

# --- Kotak Neo -----------------------------------------------------------
NEO_API_TOKEN            = <secret>   # sent RAW in Authorization, no "Bearer".
                                      # Whitespace-stripped: an embedded newline
                                      # lands in an HTTP header and Kotak answers
                                      # with an opaque error.
NEO_API_BASE             = https://gw-napi.kotaksecurities.com
NEO_LOGIN_URL            = https://mis.kotaksecurities.com
NEO_FIN_KEY              = neotradeapi
NEO_RPS                  = 8          # token-bucket refill, per ACCOUNT (§30)
NEO_WS_URL               = wss://mlhsm.kotaksecurities.com/realtime
NEO_POLL_MS              = 1000       # quote sampler cadence. 0 is FORBIDDEN in
                                      # production — see §7.1
NEO_QUOTE_BATCH          = 25         # instruments per quote request
NEO_MAX_SYMBOLS          = 250
NEO_DEFAULT_SEGMENT      = nse_fo

# --- platform -------------------------------------------------------------
TOKEN_ENC_KEY            = <64 hex>   # AES-256-GCM for the session at rest
JWT_SECRET               = <secret>
DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
OSE_KILL_SWITCH_FILE     = run/ose.HALT
OSE_HOLIDAY_FILE         = config/holidays.json
OSE_QUEUE_WARN_DEPTH     = 1000
OSE_QUEUE_MAX_DEPTH      = 5000
LOG_LEVEL                = debug | info | warn | error
```

`mode = LIVE` with `NODE_ENV != production` MUST cause the engine to refuse to start.

**`[KOTAK]`** `NEO_POLL_MS = 0` disables the REST sampler and makes the platform depend
on Kotak's HSM socket alone. On the account classes this system targets that socket
accepts subscriptions and then streams nothing (§7.1), so a zero here is not an
optimisation — it is a silent decision to have no market data. Boot MUST reject it in
`production`.

---

# 6. Domain Model and Interfaces

Types are given in TypeScript syntax for precision. The implementation is plain
JavaScript; these MUST be mirrored as JSDoc typedefs and checked with `tsc --checkJs`.

## 6.1 Core Types

```ts
type Paise = number;          // integer
type CandleTs = number;       // epoch ms, multiple of 5000

interface Candle {
  readonly token: string;     // Kotak instrument token, or 'Nifty 50' for the index
  readonly ts: CandleTs;      // bucket open
  readonly open:  Paise;
  readonly high:  Paise;
  readonly low:   Paise;
  readonly close: Paise;
  readonly tickCount: number;   // SAMPLES aggregated; 0 => synthetic
  readonly synthetic: boolean;
  readonly lowConfidence: boolean;  // [KOTAK] tickCount < minTicks
  readonly tradable: boolean;       // [KOTAK] !synthetic && !lowConfidence
}
```

**`[KOTAK]`** `volume` is absent from `Candle`. v3.0 carried it; Kotak's `ltp` quote
filter does not send traded volume, so a per-candle volume would be a field that is
`null` on every row of every production account in the entitlement class this system
targets. Day-cumulative volume, where the entitlement provides it, lives on
`OptionQuote` instead, where its absence is visible and handled (§29).

```ts
type Trend = 'BULLISH' | 'BEARISH';
type OptionType = 'CE' | 'PE';

interface OptionQuote {
  readonly token: string;        // Kotak instrument token (nse_fo)
  readonly symbol: string;       // Kotak trading symbol — what an order names
  readonly segment: string;      // 'nse_fo'
  readonly strike: number;
  readonly optionType: OptionType;
  readonly expiry: string;       // YYYY-MM-DD
  readonly lotSize: number;      // from Kotak's scrip master
  readonly ltp: Paise | null;
  readonly bid: Paise | null;    // null when the entitlement omits it — NEVER 0
  readonly ask: Paise | null;
  readonly bidQty: number | null;
  readonly askQty: number | null;
  readonly oi: number | null;
  readonly volume: number | null;
  readonly snapshotTs: number;   // epoch ms of the chain fetch
}
```

Every optional field is `Paise | null` rather than `Paise`. That is §3.9 expressed in
the type system, and `tsc --checkJs` is what enforces it.

```ts
interface StrikeCandidate {
  readonly quote: OptionQuote;
  readonly score: number;        // 0..1, 6-dp rounded
  readonly components: {
    oiNorm: number; volNorm: number; depthNorm: number; spreadNorm: number;
  };
  readonly skipped: readonly string[];  // [KOTAK] filters that could not be run
}

interface ActiveTrade {
  readonly tradeId: string;          // uuidv7 — the §12.3 idempotency root
  readonly dbId: number;             // ose_trades.id
  readonly token: string;
  readonly symbol: string;
  readonly segment: string;
  readonly optionType: OptionType;
  readonly strike: number;
  readonly side: 'SELL';
  readonly lotSize: number;
  readonly qty: number;              // lots * lotSize
  readonly requestedPrice: Paise;
  readonly entryTs: number;
  readonly entryCandleTs: CandleTs;
  readonly entryTrend: Trend;
  entryPrice: Paise;                 // actual fill VWAP — set on fill
  filledQty: number;                 // may be < qty after a partial (§12.4)
  targetLevel: number;               // 1,2,3,... mutable
  targetPrice: Paise;                // mutable
  stopPrice: Paise;                  // mutable, monotone NON-INCREASING
  candlesHeld: number;               // mutable
  mfePoints: number;                 // max favourable excursion, mutable
}
```

## 6.2 Module Interfaces

```ts
interface IMarketData {
  onCandleSealed(cb: (c: Candle) => Promise<void>): void;
  lastN(token: string, n: number): readonly Candle[];   // newest last
  latest(token: string): Candle | null;
  trackOption(token: string): void;      // [KOTAK] adds to the sampler set
  untrackOption(token: string): void;
  feedLagMs(): number;                   // now − last sample, for §16.4
}

interface IOptionChain {
  snapshot(ts: number): Promise<ChainSnapshot>;   // cached, §8.3
}

interface IStrikeSelector {
  select(chain: ChainSnapshot, type: OptionType): StrikeCandidate | null;
}

interface ITrendEngine {
  evaluate(candles: readonly Candle[]): Trend | null;     // null = tie, §10.3
}

interface IEntryValidator {
  validate(candle: Candle, trend: Trend | null): EntryDecision;
}

interface IOrderManager {
  placeEntry(trade: ActiveTrade, price: Paise): Promise<PlaceResult>;
  cancelUnfilledEntry(trade: ActiveTrade): Promise<CancelOutcome>;
  placeExit(trade: ActiveTrade, reason: ExitReason, attempt: number): Promise<PlaceResult>;
  recoverAmbiguous(orderId: number, reconciler: IReconciler): Promise<Recovery>;
  ordersLive(tradeDbId: number, stage?: string): Promise<OrderRow[]>;  // [KOTAK] from the DB
  cancelDangling(): Promise<Cancelled[]>;
}

interface IRiskEngine {
  isSessionOpen(ts: number): boolean;
  isHalted(): boolean;
  canOpenTrade(ts: number): RiskVerdict;
  onTradeClosed(trade: ClosedTrade): void;
  halt(reason: string): void;
}

interface IBrokerSession {              // [KOTAK] NeoSession
  isActive(): boolean;
  placeOrder(o: NeoOrder): Promise<{ brokerOrderId: string }>;
  cancelOrder(a: { brokerOrderId: string }): Promise<unknown>;
  orderBook(): Promise<unknown>;
  orderHistory(id: string): Promise<unknown>;
  positions(): Promise<unknown>;
  quotes(q: QuoteQuery[], filter: string): Promise<unknown[]>;
  markExpired(reason: string): Promise<boolean>;   // latched — fires once
}
```

All modules are constructed with explicit dependency injection at the composition
root. No module performs `require()` of another module at call time, and no singleton
state exists outside it — with one deliberate exception, `NeoSession`, which is a
process-wide singleton because the rate-limit bucket and the 401 latch it owns are
account-wide facts and must not be duplicated per module (§30, §31.4).

---

# 7. Market Data Module

## 7.1 Responsibilities and the Kotak feed reality `[KOTAK]`

**This is the section v3.0 got wrong, and everything downstream inherits it.**

v3.0 assumed a broker WebSocket delivering exchange ticks. Kotak Neo exposes a binary
HSM gateway at `wss://mlhsm.kotaksecurities.com/realtime`, and on the account classes
this system targets it **accepts subscriptions and then streams nothing** — no error,
no close, no data. A design that treats it as the feed and REST as a fallback that
switches on after a timeout will wait forever for a timeout that never fires.

Normative, therefore:

1. **The REST quote sampler is the primary market-data source and is always running.**
   `NEO_POLL_MS = 1000`. It is not a fallback.
2. The HSM socket MAY run alongside as an accelerant. Where a socket tick and a poll
   sample describe the same bucket both are folded into the same candle by the rules
   below. The engine MUST behave correctly with the socket permanently silent, and the
   integration suite MUST include that scenario (§25.3).
3. **A "tick" in this document therefore means a sample, not a trade print.** A
   5-second bucket holds at most 5 samples at the default cadence, and often 1–2 once
   the sampler is sharing its budget with a chain refresh.

Consequences that must be held in mind while reading §9, §12, §13 and §15:

- Candle `high` and `low` are **sampled extremes**. They understate the true range.
  A stop evaluated on `high` (§15.4) is evaluated on a *sampled* high and can miss an
  adverse spike entirely. §16.4 exists because of this sentence.
- Candle `close` is the **last sample in the bucket**, which may predate the bucket's
  end by most of its width. That is what `tickCount` and `lowConfidence` measure.
- `volume` is unavailable per candle (§6.1).

## 7.2 Bucketing

```
bucketTs(sampleTs) = Math.floor(sampleTs / 5000) * 5000
```

Buckets are **absolute and IST-aligned** — a bar is 10:15:00.000–10:15:04.999, not
"five seconds after I subscribed". Two builders started a second apart MUST produce
byte-identical bars, or a restart silently changes the strategy's entries.

**`[KOTAK]` Timestamp source — an amendment to v3.0.** v3.0 required tick timestamps to
come from the exchange feed and never from the local clock. Kotak's `ltp` quote filter
returns `{ exchange_token, ltp }` **and no timestamp**. There is no exchange time to
use. The sample is therefore stamped with the local receive clock, and three
compensating requirements become normative:

- `chrony` is mandatory; a clock offset `> 250 ms` from NTP is a boot refusal in
  production and a runtime alert (§26.2).
- The stamp is taken when the HTTP response is *received*, not when the request is
  sent, and never later than the first line of the parse.
- A sample whose stamp falls in a bucket already sealed is a **late sample**: dropped,
  counted, logged at `warn`. It MUST NOT mutate a sealed candle.

Where a richer filter that carries an exchange timestamp is available (§29.1), it MUST
be preferred over the local clock. The probe records which applies, and the boot log
states it.

## 7.3 Sealing Rule (Normative)

A bucket `B` is sealed at the **earlier** of:

1. Arrival of the first sample with `bucketTs > B`, or
2. Expiry of the sweep that observes `now >= B + CANDLE_MS`, with a grace of
   `SEAL_GRACE_MS = 400`.

The sweep runs on its own 250 ms clock rather than as a per-bucket timer; the effect
is identical and the resolution is finer. **A bar closes on time, not on the next
sample** — closing only on the next sample would wedge a leg indefinitely on an
illiquid strike, which is exactly when you least want the engine stuck.

Once sealed, `B` is frozen (`Object.freeze`) and emitted exactly once.

## 7.4 Duplicate Candles

Candle identity is `(token, ts)`. The module maintains `lastSealedTs` per token. Any
sealed candle with `ts <= lastSealedTs` is dropped with reason `DUPLICATE_CANDLE`.
This makes the pipeline idempotent under replay.

**`[KOTAK]`** A poll that returns the *same* LTP as the previous poll is **not** a
duplicate — it is a genuine observation that the price has not moved, and it counts
toward `tickCount`. Deduplicating by price would make an illiquid strike look like a
dead feed.

## 7.5 The First Bucket Is Discarded `[KOTAK]`

The first bucket a series touches was joined mid-flight: its open is wherever the
sampler happened to start, so its OHLC describes the subscription, not the market. It
is emitted internally with `partial: true`, counted, and **dropped before anything
downstream sees it**. The engine therefore waits up to one full timeframe after
subscribing to a new option before it can price an entry from it — a real, logged
delay, not a bug, and the reason §12.1's `NO_OPTION_CANDLE` rejection is common in the
first cycles after a strike is selected.

## 7.6 Missing Candles

If a bucket receives zero samples, no real candle exists.

- **Gap of 1 candle** (`MAX_SYNTHETIC_RUN = 1`): emit a synthetic candle where
  `open = high = low = close = previous.close`, `tickCount = 0`, `synthetic = true`,
  `tradable = false`. This preserves the "one candle = one decision cycle" invariant.
- **Gap of 2 or more:** do **not** synthesise. Emit `FEED_GAP`. If flat → `SCANNING`
  is suspended until `TREND_LOOKBACK` real candles have accumulated. If in position →
  immediate exit (`EXIT_FEED_GAP`).

Synthetic candles are readable by the Trend Engine and Entry Validator — a doji at the
previous close naturally fails both entry conditions, since `close == bullishMid ==
bearishMid` requires strict inequality — but they are never `tradable` and can never
price an order. Offsetting from a close that is ten seconds stale is fiction.

## 7.7 History

Ring buffer of `MAX_CANDLE_HISTORY = 720` candles per tracked token, fixed-allocated at
boot. `lastN()` returns a frozen view; callers MUST NOT mutate.

## 7.8 Tradability `[KOTAK]`

```
lowConfidence = !synthetic && tickCount < minTicks
tradable      = !synthetic && !lowConfidence
```

`minTicks` is `indexMinTicks` (default 3) for the NIFTY series and `optionMinTicks`
(default 2) for option series. The asymmetry is deliberate: the index is quoted every
poll and should reliably see 3+ samples in 5 seconds, while an option quoted inside a
41-strike batch may legitimately see fewer.

`tradable` is the single flag the engine reads. Keeping the rule here rather than in
the state machine means there is exactly one place to audit the answer to "was this bar
allowed to price an order".

**Where each flag binds:**

| Consumer | Requires |
|---|---|
| Trend Engine (§10) | completed — synthetic and low-confidence bars are read |
| Entry Validator (§11) | completed |
| Entry price derivation (§12.1) | **tradable** — else `NO_ENTRY(NO_OPTION_CANDLE)` |
| Target confirmation (§14.3) | **tradable** — a stale close must not advance the ladder |
| Stop evaluation (§15.4) | completed — **including low-confidence**, because a stop must fire on weak evidence rather than wait for strong evidence (fail closed) |

## 7.9 Option Subscriptions

The sampler tracks option tokens only for:
- the single selected candidate awaiting entry, and
- the currently held contract.

Both are added to the same batched quote request as the chain scan where possible, so
tracking a candidate costs no extra request (§30). If the option series produces a gap
of 2+ candles while a position is open, the Exit Engine fires `EXIT_OPTION_FEED_GAP`
immediately.

## 7.10 Index Addressing `[KOTAK]`

**An index is quoted by NAME, not by its token.** Verified against the live gateway:

```
nse_cm|26000       -> HTTP 200, and an EMPTY array
nse_cm|Nifty 50    -> HTTP 200, {"exchange_token":"Nifty 50","ltp":"24317.15"}
nse_fo|65867       -> HTTP 200, {"exchange_token":"65867","ltp":"23.20"}   (options by token are fine)
```

The empty array is what makes this hard to see: the gateway does not refuse and does
not error — it answers successfully with nothing, so every layer above reports "no
price for this instrument" and none of them is wrong. NIFTY is therefore quoted as
`nse_cm|Nifty 50`. The numeric token is retained only because the binary socket
addresses instruments that way; the two transports genuinely disagree, and only the
REST path is proven on this account class.

A regression test MUST assert that the index quote query uses the name form. Losing
this line loses the spot price, the ATM, the trend series, and therefore every entry
the engine could ever make.

---

# 8. Option Chain Module

## 8.1 Responsibilities

Produce a normalised, validated `ChainSnapshot` of NIFTY current-expiry option quotes,
from two Kotak sources:

1. **The scrip master** (`src/market/instrumentMaster.js`) — Kotak publishes daily CSV
   scrip files; the NIFTY option rows give token, trading symbol, strike, expiry, lot
   size and tick size. Synced once at boot and cached in `instruments`. **Lot size and
   tick size are read from here and never hardcoded** — an exchange lot-size revision
   must not require a code change.
2. **Batched REST quotes** for the strike window (§8.3).

## 8.2 Expiry Selection

Nearest expiry with `expiryDate >= today`, from the synced master. On expiry day the
same-day expiry is used until session close, **but only if `tradeOnExpiryDay` is
true**; otherwise the engine scans nothing that day and logs `EXPIRY_DAY_SKIPPED` once
at boot. `[MUST-CONFIRM #7]`.

An expiry whose contracts are absent from the master is a boot refusal, not a runtime
surprise: a stale master offers strikes that no longer exist and the selector would
happily choose one.

## 8.3 The Strike Window and Caching `[KOTAK]`

v3.0 said "the option chain". Quoting all ~200 NIFTY strikes at
`NEO_QUOTE_BATCH = 25` costs 8 requests per refresh, which at a 5-second refresh is
1.6 rps of an 8 rps account budget shared with order placement (§30). Normative
instead:

```
window   = ATM ± scanRange strikes            (default ±20 → 41 strikes)
ATM      = round(indexReferencePrice / 50) * 50
requests = ceil(41 * 2 / NEO_QUOTE_BATCH) = 4  per refresh
```

The chain is fetched at most once per `CHAIN_REFRESH_MS = 5000` and cached. A decision
cycle calls `snapshot(ts)`; if the cached snapshot's age `<= 5000 ms` it is returned,
otherwise a fetch is triggered. **The fetch is non-blocking with respect to the
cycle:** if no fresh snapshot is available within `CHAIN_TIMEOUT_MS = 800`, the cycle
returns `NO_ENTRY(CHAIN_STALE)`. The engine never waits on Kotak inside a decision
cycle beyond that bound. Five consecutive stale-chain cycles → `HALT` (§20.3).

An in-flight fetch is deduplicated — concurrent callers share the same promise.

**Partial batches.** One failed batch is one gap in the chain, not a failed snapshot;
the strikes that did answer are still usable. A snapshot is rejected only under §8.4.

## 8.4 Validation

A quote is **discarded** if any of these hold:

```
ltp == null || ltp <= 0
ask != null && bid != null && ask < bid
oi < 0 || volume < 0
expiry missing or unparseable
strike not a multiple of 50
token absent from the scrip master
snapshot age > CHAIN_MAX_AGE_MS (5000 ms)
```

**`[KOTAK]` — the change from v3.0.** v3.0 discarded any quote with `bid <= 0 || ask <= 0`.
On a Kotak retail entitlement `bid` and `ask` are *never sent at all* (§29.1), so read
literally that rule discards 100% of the chain, trips `CHAIN_CORRUPT` on every cycle,
and the engine never trades — not as a bug, but as the correct behaviour of a required
filter with nothing to filter on. v4.0 therefore separates two distinct facts:

- **A field that arrived and is nonsensical** (`ask < bid`, negative OI) → discard the
  quote. The broker sent something wrong.
- **A field that did not arrive at all** (`bid === null`) → the quote survives
  validation and the *filter* that needed it is resolved by `liquidityMode` in §9.2.
  The broker sent nothing, which is a fact about entitlement, not about the strike.

Rejection rules on the snapshot as a whole:

| Condition | Outcome |
|---|---|
| `> CHAIN_CORRUPT_PCT` (40%) of quotes discarded | `CHAIN_CORRUPT` → no entry this cycle |
| A field is `null` on **every** row | `CHAIN_FIELDS_UNAVAILABLE(field)` — logged once per session, **not** corrupt |
| Fewer than 2 strikes survive in the requested window | `NO_LIQUID_STRIKE` |

Distinguishing the second row from the first is the whole of §29 in one line: an
entitlement that omits open interest is not a corrupt feed, and treating it as one
halts an engine that could have been told the truth instead.

---

# 9. Strike Selection Module

## 9.1 Inputs and Outputs

Input: a validated `ChainSnapshot` and a requested `OptionType`. Output: the single
highest-ranked `StrikeCandidate`, or `null`.

Selection is computed **independently for CE and PE**; the Trend Engine determines
which side is requested (§11.4), and only the tradeable side is acted upon.

## 9.2 Hard Filters (applied in this order, all must pass)

| # | Filter | Rule | Needs |
|---|---|---|---|
| 1 | Type | `quote.optionType === requestedType` | — |
| 2 | Premium | `premiumMin <= ltp <= premiumMax` (₹15–₹25 inclusive) | `ltp` |
| 3 | Open Interest | `oi >= MIN_OI` | `oi` |
| 4 | Volume | `volume >= MIN_VOLUME` | `volume` |
| 5 | Bid depth | `bidQty >= MIN_BID_LOTS * lotSize` | `bidQty` |
| 6 | Ask depth | `askQty >= MIN_ASK_LOTS * lotSize` | `askQty` |
| 7 | Absolute spread | `(ask − bid) <= MAX_SPREAD_ABS` | `bid`,`ask` |
| 8 | Relative spread | `(ask − bid) / ((ask + bid)/2) <= MAX_SPREAD_PCT` | `bid`,`ask` |

Thresholds — `[MUST-CONFIRM #1]`:

```js
MIN_OI = 500_000;  MIN_VOLUME = 100_000;
MIN_BID_LOTS = 5;  MIN_ASK_LOTS = 5;
MAX_SPREAD_ABS = 50;   // paise = ₹0.50
MAX_SPREAD_PCT = 0.03; // 3% of the mid
```

### 9.2.1 Missing inputs — `liquidityMode` `[KOTAK]`

Filters 1 and 2 need only `ltp`, which every entitlement sends. Filters 3–8 need
fields a Kotak retail entitlement does not send. `liquidityMode` chooses which honest
answer applies, and **neither mode ever coerces a missing field to zero**:

| Mode | A field the broker did not send | Consequence |
|---|---|---|
| `STRICT` *(default)* | counts as a **FAILURE** | On an `ltp`-only account nothing passes filters 3–8, so nothing is ever selected and the engine visibly does not trade. This is the specification as written, and it ships as the default because a liquidity filter that silently did not run is worse than one that visibly refuses. |
| `LENIENT` | is **SKIPPED** and recorded in `StrikeCandidate.skipped` | The strike is chosen on the checks that could actually be made — on this entitlement, premium alone. Every selection log and every `ose_trades.select_detail` row names the skipped filters. |

`LENIENT` is a decision to trade on less evidence, made explicitly and recorded on
every trade it produced. It MUST NOT be the default and MUST be re-affirmed at each
`LIVE` promotion. `[MUST-CONFIRM #13]`.

If zero candidates survive, return `null` → `NO_ENTRY(NO_LIQUID_STRIKE)`.

## 9.3 Ranking

Min-max normalisation across the **surviving** candidate set. If the set has a single
member, all norms are `1.0` except spread, which is `0.0`.

```
oiNorm     = (oi     − minOI)   / (maxOI   − minOI)     // 0 if maxOI == minOI
volNorm    = (vol    − minVol)  / (maxVol  − minVol)
depth      = min(bidQty, askQty)
depthNorm  = (depth  − minDepth)/ (maxDepth− minDepth)
spreadNorm = (spread − minSpread)/(maxSpread− minSpread)

score = 0.40*oiNorm + 0.30*volNorm + 0.20*depthNorm + 0.10*(1 − spreadNorm)
score = round(score, 6)
```

**`[KOTAK]`** A component whose input is `null` contributes `0` **and its weight is
removed from the denominator**, the score being renormalised over the components that
could be computed:

```
score = Σ(w_i * norm_i for available i) / Σ(w_i for available i)
```

Assigning a missing component a norm of 0 without renormalising would cap every
candidate's score at 0.30 on an `ltp`-only account and make the 6-dp rounding
meaningless for ranking. When *no* component is available the score is `0` for every
candidate and the tie-break of §9.4 decides — which, on an `ltp`-only account, means
selection reduces to "lowest strike among those in the premium band", deterministically
and visibly.

The weights are §9.3 verbatim and are **not** operator-tunable: a different weighting
is a different selection strategy and belongs in a revision of this document, not in a
settings form.

## 9.4 Deterministic Tie-Break

Sorting MUST be total and stable. Comparator, applied in order until non-zero:

1. `score` descending
2. `oi` descending (`null` sorts last)
3. `volume` descending (`null` sorts last)
4. `spread` ascending (`null` sorts last)
5. `strike` ascending
6. `symbol` ascending (`localeCompare` with `'en'`, `{ numeric: false }`)

Step 6 guarantees a unique winner for identical inputs. Never rely on
`Array.prototype.sort` stability alone. `null`-sorts-last at steps 2–4 is what keeps
the comparator total when the entitlement omits those fields.

---

# 10. Trend Engine

## 10.1 Input

The latest `TREND_LOOKBACK = 3` completed NIFTY candles: `C1` (oldest), `C2`, `C3`
(latest). If fewer than 3 exist, return `null`.

Completed, not tradable: a low-confidence or synthetic index bar still carries
directional information, and refusing to form an opinion because a bar was thin would
make the engine blind exactly when the market is quiet.

## 10.2 Classification Rule (Normative)

Binary Bullish/Bearish, no sideways state:

```
d1 = C3.close − C1.close
if d1 > 0  -> BULLISH
if d1 < 0  -> BEARISH

// d1 == 0, tie-break 1: midpoint drift
m(c) = (c.high + c.low) / 2
d2 = m(C3) − m(C1)
if d2 > 0  -> BULLISH
if d2 < 0  -> BEARISH

// tie-break 2: most recent candle direction
d3 = C3.close − C2.close
if d3 > 0  -> BULLISH
if d3 < 0  -> BEARISH

// perfect tie
return null
```

Which branch decided is recorded as `trend_via` on the decision row (`d1`/`d2`/`d3`/
`tie`), so a session's trend behaviour can be audited without re-deriving it.

## 10.3 Perfect-Tie Handling

`null` is **not** "sideways" — it means the trend is *undetermined for this cycle*. The
engine treats it as `NO_ENTRY(TREND_UNDETERMINED)` and takes no action. It does **not**
carry forward a previous trend: carry-forward would make output depend on history
beyond the 3-candle window, violating §3.6.

For an open position, `null` counts as **trend break** and triggers exit (§16.2).
Fail-closed.

**`[KOTAK]`** Perfect ties are materially more common on a sampled feed than on a tick
feed — three consecutive 5-second index bars that share a close are ordinary when each
bar holds three samples. `TREND_UNDETERMINED` is expected to be one of the most
frequent rejection reasons in the decision log and is not, on its own, evidence of a
fault.

## 10.4 Purity

`evaluate` is a pure function: no I/O, no clock access, no instance state. This makes
it trivially unit-testable and is the single largest contributor to reproducibility.

---

# 11. Entry Validation Engine

## 11.1 Input

The latest completed NIFTY candle `C` and the trend from §10.

## 11.2 Midpoints

```
bullishMid = floor((C.open + C.high) / 2)      // integer paise
bearishMid = floor((C.open + C.low)  / 2)      // integer paise
```

Both midpoints come from the *same* candle whose close is the reference price.

## 11.3 Conditions

```
SELL PE  requires  C.close >  bullishMid
SELL CE  requires  C.close <  bearishMid
```

Strict inequality. These are mutually exclusive by construction — a close cannot
simultaneously exceed `(O+H)/2` and fall below `(O+L)/2` unless `O == H == L`, in which
case both fail. No conflict-resolution rule is needed, and a property test MUST assert
it (§25.2).

## 11.4 Confluence with Trend

| Trend | Midpoint condition | Action |
|---|---|---|
| `BULLISH` | `close > bullishMid` | **SELL PE** |
| `BEARISH` | `close < bearishMid` | **SELL CE** |
| `BULLISH` | `close < bearishMid` | Rejected — `TREND_SIGNAL_CONFLICT` |
| `BEARISH` | `close > bullishMid` | Rejected — `TREND_SIGNAL_CONFLICT` |
| any | neither | Rejected — `NO_MIDPOINT_BREAK` |
| `null` | any | Rejected — `TREND_UNDETERMINED` |

## 11.5 Output

```ts
interface EntryDecision {
  allowed: boolean;
  optionType?: OptionType;
  reason: string;               // machine-readable enum
  bullishMid: Paise;
  bearishMid: Paise;
  referencePrice: Paise;
  trend: Trend | null;
  trendVia: 'd1'|'d2'|'d3'|'tie'|null;
}
```

Every rejection is written to `ose_decisions` with the full decision object. **Silent
rejections are forbidden** — one row per sealed candle, whether or not anything
happened, because the rows where nothing happened are the ones that answer "why did it
not trade at 10:42:15" with a `SELECT` instead of an argument.

---

# 12. Order Management Module

## 12.1 Entry Price Derivation

```
optionClose  = close of the latest TRADABLE sealed option candle for the selected token
rawPrice     = optionClose + entryOffset          // + ₹0.10 = +10 paise
entryPrice   = floorToTick(rawPrice)
```

`floorToTick` (not round-half-up) so a SELL limit is never placed *above* the derived
level, which would silently reduce fill probability beyond spec.

If no **tradable** sealed option candle exists for the candidate — the subscription just
started (§7.5), the bucket was synthetic, or `tickCount < optionMinTicks` — the cycle
returns `NO_ENTRY(NO_OPTION_CANDLE)`.

**The engine MUST NOT substitute the LTP.** This is the most commonly violated rule in
implementations of this spec, and on Kotak it is also the most tempting one to violate,
because an LTP is always available from the very poll that failed to fill the bucket.
It MUST have a dedicated test that fails the build.

## 12.2 Order Parameters

```
side          = SELL
orderType     = LIMIT          (Kotak `pt: 'L'`)
price         = entryPrice     (rupees at the wire, §28.3)
quantity      = lots * lotSize        // lotSize from the scrip master; [MUST-CONFIRM #2]
product       = MIS (intraday)        (Kotak `pc: 'MIS'`)
validity      = DAY                   (Kotak `rt: 'DAY'`)
segment       = nse_fo                (Kotak `es`)
tradingSymbol = quote.symbol          (Kotak `ts` — the master's symbol, verbatim)
```

`MIS` is intraday. §1.2 puts overnight carry out of scope, and a product code that
permits it would let a failed square-off become a positional trade nobody chose.

**`[KOTAK]` There is no `tag` and no `clientOrderId` field.** v3.0's line
`clientOrderId = tradeId // idempotency key` describes a field Kotak's place-order does
not have. §12.3 replaces it.

## 12.3 Idempotency — without a client order id `[KOTAK]`

**This is the most important section in the document.**

Kotak's place-order carries no client-supplied identifier, so at the broker a retry
after a network error is indistinguishable from a new order. The broker cannot
deduplicate for us; the engine must make duplication impossible before the request
leaves. Three mechanisms stand between a network timeout and a duplicate naked short,
and none is optional:

1. **A unique key in our own database.** `orders.client_ref` is `UNIQUE` and derived
   from the trade id:
   ```
   client_ref = OS-<tradeUid>-<CE|PE>-<attemptSeq>-<stage>[-R<revision>]
   ```
   The same logical order can only ever be inserted once. This is v3.0's
   `clientOrderId = tradeId` (and `-X` for the exit) expressed in the key format this
   platform already uses across its engines. The `OS-` prefix scopes every query and
   every dangling-order cancel to this engine, so a sibling engine's order can never be
   touched.
2. **An atomic claim.** `claimForPlacement(orderId)` moves that row `PENDING → PLACING`
   in one statement. Only the first caller wins; a second sees a non-`PENDING` row and
   refuses. A crash between claim and send leaves a `PLACING` row, which the
   reconciler resolves and which is never auto-resent.
3. **The database is the source of truth for what is live.** Before resending
   *anything*, the caller asks `ordersLive(tradeDbId, stage)` — the DB, never the
   in-memory trade. The in-memory trade is exactly the thing that was wrong when the
   process died. A resend of a market buy that is already working buys the short back
   twice and leaves the account **naked long**, which is the worst outcome this system
   can produce.

### 12.3.1 The three outcomes

Every placement resolves to exactly one of three, classified in `neoClient.classify`
(§28.5) and never conflated:

| Outcome | Cause | Order row | Engine response |
|---|---|---|---|
| **rejected** | Kotak answered `Not_Ok`, or 4xx, or the rate bucket refused **before the request left** | `REJECTED` (or back to `PENDING` for a pre-send refusal) | Safe. No order exists. Retry is permitted for a pre-send refusal only. |
| **uncertain** | No response at all after the bytes left (timeout, `ECONNRESET`), or 5xx | `UNKNOWN` | **Never resend.** Run the recovery protocol below. |
| **auth** | 401/403 | `UNKNOWN` | Latch the session `EXPIRED` (once), page the operator, `HALT` if a position is open (§31.4). |

A pre-send rate-limit refusal is the one failure that is unambiguously safe, because
nothing left the process. It is classed transient (§20.2), the row returns to
`PENDING`, and the honest answer to the caller is "no order" rather than "an unknown
order".

### 12.3.2 The recovery protocol

v3.0's protocol, with step 2 rewritten for a broker that cannot be queried by client id:

```
1. Wait ORDER_SETTLE_MS = 500
2. Run the reconciler once. It pulls Kotak's order book and matches rows to our
   orders by (tradingSymbol, side, qty, placement window) — NOT by client id,
   because there is none. It REFUSES TO GUESS when more than one book row fits.
3. Found and matched  -> adopt that order's state (WORKING / FILLED / REJECTED / ...)
4. Not found          -> wait ORDER_SETTLE_MS again and run the reconciler once more;
                         a book can lag by a poll
5. Still UNKNOWN      -> HALT(ORDER_AMBIGUOUS) and page the operator
```

There is no exponential backoff on a placement. §20.4 exempts order placement from its
own retry policy for exactly this reason: backoff assumes a retry is safe, and here it
is not.

**Why matching refuses to guess.** Two working orders for the same symbol, side and
quantity are indistinguishable in Kotak's book. The single-active-trade invariant makes
that situation impossible in normal operation — so when it occurs, something the engine
does not understand has happened, and halting is strictly safer than adopting one of
them at random. Case (c) of §20.6 is the same principle at boot.

## 12.4 Fill Handling

| Outcome | Handling |
|---|---|
| **Full fill** | `entryPrice` = fill VWAP (`avgPrc` from the book). → `POSITION_OPEN` |
| **Partial fill**, still open at `ENTRY_FILL_TIMEOUT_MS = 3000` | Cancel remainder. `filledQty` becomes the position. → `POSITION_OPEN`. Log `PARTIAL_FILL`. |
| **Partial fill**, cancel fails | `HALT(CANCEL_FAILED)`, attempt a MARKET exit of the filled quantity |
| **Cancel lost the race** (the order filled while cancelling) | Not an error. A filled short. → `POSITION_OPEN` at full size. |
| **No fill** at timeout | Cancel. → `COOLDOWN`. **Not** counted in `maxTradesPerDay`, not counted as a loss — no position ever existed. |
| **Rejected** | Log Kotak's `emsg` verbatim. → `COOLDOWN`. Three consecutive rejections → `HALT(REPEATED_REJECTION)`. |

`ActiveTrade.entryPrice` is always the **actual fill VWAP**, never the requested price.
All targets and stops derive from it; `requestedPrice` is retained for slippage
analysis and is what makes §20.3's `SEVERE_SLIPPAGE` measurable after the fact.

**`[KOTAK]`** Kotak's book reports a partial fill without always saying so in the
status; `fldQty > 0 && fldQty < qty` on a `WORKING` row is normalised to `PARTIAL` in
one place (§28.6) rather than at three call sites.

## 12.5 Exit Orders

Exits are **MARKET** orders (`pt: 'MKT'`), always. A limit exit can go unfilled, which
breaks the guarantee that a stop-loss actually stops loss. This is a deliberate
asymmetry with entries and is normative. Market protection is left at Kotak's default
(`mp: 0`).

The exit's `client_ref` carries a **revision suffix**: attempt *n* uses `-R<n−1>`. That
is the opposite of the entry's rule and it is correct for the same reason the entry's
is — **a failed entry must not be duplicated, and a failed exit must not be
abandoned.** A retry of an exit is a genuinely new order and needs a genuinely new key;
colliding with the failed one would be silently swallowed by the unique index.

Before sending any exit attempt the caller MUST establish through `ordersLive` that no
exit order for this trade is already working.

If an exit is rejected or unfilled after `EXIT_FILL_TIMEOUT_MS = 2000`, retry as MARKET
up to `EXIT_RETRY_MAX = 3` times, then `HALT(EXIT_FAILED)` with a critical page. **An
unhedged unclosable short is the highest-severity incident this system can produce.**

An `UNKNOWN` outcome on an exit is not the same problem as on an entry: the order may
be live, so it is not resent blindly — but a short that may or may not have been bought
back cannot be left alone either. It is resolved through the order book on the next
reconciler pass, and the position stays in `EXIT_PENDING` until it is.

## 12.6 Margin `[KOTAK]` `[MUST-CONFIRM #16]`

Kotak exposes `POST /quick/user/check-margin`. v3.0 was silent on whether to use it, and
silence resolved to "absorb the rejection", which is a decision nobody made.

**Normative: the engine does NOT pre-check margin per order.** Three reasons, and each
would have to be answered to reverse this:

1. It costs a rate token (§30) and a round trip inside the §23.2 order budget, on every
   entry, to answer a question that is almost always "yes".
2. It is a **race**, not a guarantee. Margin can move between the check and the place,
   so a passing check does not make the placement safe and a failing one does not make
   it impossible. The rejection is authoritative; the check is a forecast.
3. Position size is fixed and small (`lots = 1` by default). The interesting failure is
   "the account is underfunded today", which is a start-of-day fact, not a per-order one.

Instead:

| When | Action |
|---|---|
| Once at boot, after `RECONCILING` | One `check-margin` for the configured size at a representative strike. Failure logs `MARGIN_INSUFFICIENT_AT_BOOT` at `error` and the engine starts in `IDLE` without scanning. It does not halt — margin can be funded during the session and a re-check runs on operator request. |
| Per order | None. A margin rejection is a **Business** error (§20.2): the trade is not taken, the cycle logs Kotak's `emsg` verbatim, and it counts toward the §12.4 rejection breaker. |
| Two consecutive margin rejections | `HALT(MARGIN_EXHAUSTED)`. Distinguished from `REPEATED_REJECTION` because the operator response is different — fund the account, not debug the engine. |

If the desk prefers a per-order pre-check, the §23.2 budget must be re-cut to absorb a
second round trip and §30's headroom re-derived; that is why this is a confirm item and
not a preference.

## 12.7 PAPER mode fill semantics `[KOTAK]` `[MUST-CONFIRM #17]`

§25.8 makes ten paper sessions a gate on `LIVE`. That evidence is only as good as the
fill model, so the model is normative rather than an implementation detail
(`src/broker/paperBroker.js`).

**In PAPER, everything above the adapter is identical to LIVE.** Orders are written to
`orders` with the same `client_ref`, the same `PENDING → PLACING` claim and the same
reconciliation. Only the transport is swapped. This is deliberate: §12.3 is the part
most worth exercising for ten days, and a paper path that bypassed the orders table
would exercise none of it.

Fill model, deliberately pessimistic:

| Order | Fills when | At |
|---|---|---|
| SELL LIMIT `p` | a sample prints at or **above** `p` | exactly `p` — never better |
| BUY LIMIT `p` | a sample prints at or **below** `p` | exactly `p` |
| MARKET | the **next** sample after the order was armed, never the last one seen | that sample's price |

A limit fills at its own price and never improves. Real fills sometimes improve;
assuming they do would flatter every result by a tick, which on a one-point target is
5% of the edge. A market order filling at the *next* sample rather than the last one is
the honest model of a round trip to the exchange, and it is the **only** place this
simulation admits slippage.

**Three things PAPER cannot tell you**, stated here so ten green sessions are not
mistaken for evidence about them:

1. **Partial fills do not occur.** The simulator fills the whole quantity or nothing, so
   §12.4's `PARTIAL` and `CANCEL_FAILED` paths are never exercised. They MUST be covered
   against the mock broker instead (§25.3).
2. **Rejections do not occur.** No margin rejection, no off-tick rejection, no exchange
   refusal — so the §12.4 rejection breaker is likewise mock-only.
3. **Queue position does not exist.** A SELL LIMIT fills the instant a sample touches it,
   where a real order sits behind the book's existing depth at that price. On the
   ₹15–₹25 strikes this strategy sells, that difference is material and unmodelled.

Paper results are therefore an **optimistic bound**, and §25.8's acceptance criteria are
written as "zero halts attributable to engine defects", not as a P&L threshold.

---

# 13. Position Manager

## 13.1 Trigger

Runs on every sealed NIFTY candle while a position is open. Also runs on every sealed
**option** candle for the held token, for stop/target evaluation only (§13.4). The
priority-0 timer of §16.4 runs independently of both.

## 13.2 Per-Cycle Recomputation

```
trend      = trendEngine.evaluate(marketData.lastN(NIFTY, 3))
bullishMid = floor((C.open + C.high) / 2)
bearishMid = floor((C.open + C.low)  / 2)
premium    = close of the latest sealed option candle for trade.token
pnlPoints  = (trade.entryPrice − premium) / 100
trade.candlesHeld += 1
trade.mfePoints = max(trade.mfePoints, pnlPoints)
```

## 13.3 Position Validity Filter

The position remains valid only while the original directional thesis holds:

| Trade | Valid while |
|---|---|
| Short PE (entered BULLISH) | `trend === 'BULLISH'` **and** `C.close > bullishMid` |
| Short CE (entered BEARISH) | `trend === 'BEARISH'` **and** `C.close < bearishMid` |

Failure of either → `POSITION_INVALID` → Exit Engine with `EXIT_FILTER_FAIL` or
`EXIT_TREND_BREAK`.

**Design note (unchanged from v3.0, restated because it dominates behaviour):** this is
a strict, unforgiving filter. Because the midpoint break is re-evaluated each candle
against a *new* candle's own midpoints, an ordinary consolidation candle invalidates
the position. That is intentional and is the dominant driver of the strategy's short
holding period. Flagged for desk awareness, not for change.

**`[KOTAK]`** On a sampled feed this filter fires more often than it would on a tick
feed, because a 5-second bar built from three samples has a narrower range and its
close sits closer to its midpoints. Expect a shorter mean holding period than a
tick-feed backtest of the same rules would predict; §25.5's replay acceptance is
measured on Kotak-sampled data precisely so that this is priced in rather than
discovered live.

## 13.4 Evaluation Order

Within a cycle, checks run in this fixed order and the **first** match wins:

1. Hard stop / trailing stop hit (§15)
2. Premium safety exit (§16.2.4)
3. Liquidity deterioration (§16.2.5)
4. Maximum holding time (§16.2.6)
5. Position validity filter (§13.3)
6. Target reached → extend (§14)

Stops are evaluated before targets so that a candle touching both resolves
conservatively (loss booked), matching fail-closed. A unit test with a candle spanning
both levels MUST assert this ordering.

---

# 14. Dynamic Target Engine

## 14.1 Ladder

For a short, profit accrues as premium falls.

```
level k: targetPrice = entryPrice − (k * POINT)      // POINT = 100 paise
```

## 14.2 Extension Rule

On a **tradable** sealed option candle where `premium <= trade.targetPrice`:

```
trade.targetLevel += targetExtensionPoints          // +1
trade.targetPrice  = trade.entryPrice − (trade.targetLevel * POINT)
stopModule.onTargetAchieved(trade)                  // §15.2
```

The position is **not** closed on target achievement — the target is extended and the
stop is tightened. Exit occurs only via the Exit Engine. This is the core of the "let
winners run" behaviour.

## 14.3 Confirmation Semantics

A confirmation is **a tradable sealed option candle whose close is at or beyond the
current target price.** Intra-candle wicks do not confirm. One candle may advance the
ladder by at most one level, even if the close is 4 points beyond — this preserves the
one-decision-per-candle invariant. `[MUST-CONFIRM #3]`.

**`[KOTAK]`** "Tradable" is load-bearing here and is a v4.0 addition: a low-confidence
bar whose single sample happened to land on a spike would otherwise ratchet the stop
(§15.2) on evidence the engine has already declared too thin to price an order from.
The ladder and the stop must not be advanced by data the entry logic would refuse.

## 14.4 Ladder Cap

The ladder is uncapped. Maximum theoretical profit on a short at entry `E` is `E`
points, so it is naturally bounded by `floor(entryPrice / POINT)`. At
`premium <= PREMIUM_FLOOR = 100` paise (₹1) the Exit Engine force-closes with
`EXIT_PREMIUM_FLOOR` — below ₹1 the spread makes further holding uneconomic.

---

# 15. Trailing Stop Module

## 15.1 Initial Stop

```
trade.stopPrice = entryPrice + (initialStopPoints * POINT)     // entry + 2 points
```

For a short the stop is *above* entry — premium rising is loss.

## 15.2 Trailing Rule

When target level `k` is achieved (§14.2):

```
candidateStop   = entryPrice − ((k − 1) * POINT)
trade.stopPrice = min(trade.stopPrice, candidateStop)
```

| Target level achieved | New stop | Locked-in |
|---|---|---|
| — (entry) | `entry + 2` | −2 pts (max loss) |
| 1 | `entry + 0` | breakeven |
| 2 | `entry − 1` | +1 pt |
| 3 | `entry − 2` | +2 pts |
| k | `entry − (k−1)` | +(k−1) pts |

### 15.2.1 Which `k` — a contradiction in v3.0, resolved

§14.2's pseudocode increments the rung and *then* calls the stop module:

```
trade.targetLevel += targetExtensionPoints          // 1 -> 2
stopModule.onTargetAchieved(trade)                  // reads targetLevel == 2
```

Read literally, achieving level 1 would compute `entryPrice − (2−1)*100` and lock a
full point. The table above says achieving level 1 locks **breakeven**. The two cannot
both hold.

**Normative: `k` is the level ACHIEVED, not the level now being sought.** The table is
the unambiguous statement — its `Locked-in` column reads −2, breakeven, +1, +2 against
achieved levels 0, 1, 2, 3 — and §14.2's ordering is an artefact of writing the
increment first.

This is not pedantry about an index. Following the pseudocode tightens the stop a full
rung early, so a position that takes one point and comes back is stopped at +1 instead
of breakeven: the strategy could never scratch, and every trade would resolve as a
winner or a loser. It changes the return distribution, not just a number.

The engine shipped with the pseudocode reading and `scripts/ose-selftest.js` caught it
on the first end-to-end run. `test/oseEngine.test.js` now walks the whole table rung by
rung.

## 15.3 Monotonicity Invariant (Normative)

```
assert(newStop <= currentStop)      // for a SHORT, the stop only moves DOWN
```

`min()` enforces this structurally. The assertion is **retained in production builds**,
never stripped, and a violation raises `HALT(STOP_INVARIANT_VIOLATION)`. A stored row
whose `stop_price_p` ever rose is an integrity failure, not a data-entry mistake.

## 15.4 Trigger Evaluation

The stop is hit when a **sealed option candle** (completed — including low-confidence,
per §7.8) satisfies:

```
candle.high >= trade.stopPrice
```

`high`, not `close`, because a stop must respect intra-candle adverse movement.
Targets, by contrast, use `close` (§14.3) — conservative in both directions.
`[MUST-CONFIRM #4]`.

**`[KOTAK]` — the sampled-high problem.** On a poll-derived feed `candle.high` is the
maximum of at most five samples, not the true intra-bucket high. A spike that crosses
the stop and retraces between two polls leaves no trace in the candle at all, and the
stop does not fire. This is not a defect that can be fixed inside §15.4 — the data
simply does not contain the event. It is mitigated, not solved, by §16.4, and the
residual risk is explicit: **on this broker the stop is a 5-second-resolution stop
evaluated on sampled extremes, not a guaranteed price.** The desk must sign that
sentence off (`[MUST-CONFIRM #12]`) before `LIVE`.

## 15.5 Disabled Mode

If `trailingStopEnabled === false`, `stopPrice` stays at `entry + initialStopPoints`
for the life of the trade. Target extension still operates.

---

# 16. Exit Engine

## 16.1 Responsibility

Sole owner of position closure. **No other module may call `placeExit`.** The Exit
Engine receives an `ExitReason` and executes a MARKET exit (§12.5).

## 16.2 Exit Conditions

| # | Reason | Trigger | Priority |
|---|---|---|---|
| 1 | `EXIT_STOP_HIT` | sealed option candle `high >= stopPrice` | 1 |
| 2 | `EXIT_PREMIUM_SAFETY` | `premium >= entryPrice + (premiumSafetyExitPoints * POINT)` | 2 |
| 3 | `EXIT_LIQUIDITY` | held contract fails §9.2 filters 3–8 on the current snapshot | 3 |
| 4 | `EXIT_MAX_HOLD` | `candlesHeld >= MAX_HOLD_CANDLES` (24 = 120 s) | 4 |
| 5 | `EXIT_FILTER_FAIL` | midpoint condition fails (§13.3) | 5 |
| 6 | `EXIT_TREND_BREAK` | trend flipped or `null` (§13.3) | 5 |
| 7 | `EXIT_PREMIUM_FLOOR` | `premium <= PREMIUM_FLOOR` | 1 |
| 8 | `EXIT_FEED_GAP` | NIFTY feed gap ≥ 2 candles, or `feedLagMs > FEED_DOWN_EXIT_MS` | 0 |
| 9 | `EXIT_OPTION_FEED_GAP` | option feed gap ≥ 2 candles | 0 |
| 10 | `EXIT_SESSION_END` | `now >= SQUARE_OFF_TIME` | 0 |
| 11 | `EXIT_KILL_SWITCH` | kill-switch file present (§26.5) | 0 |
| 12 | `EXIT_RISK_HALT` | Risk Engine halts mid-position | 0 |
| 13 | `EXIT_STOP_GUARD` **`[KOTAK]`** | priority-0 sampled stop guard (§16.4) | 0 |

Priority-0 conditions run on the `SAFETY_TIMER_MS = 1000` timer, independent of the
candle cycle, because they must fire even when the candle feed has stopped. That is the
entire reason they are priority 0.

**`[KOTAK]` §16.2.3 — `EXIT_LIQUIDITY` under a limited entitlement.** Filters 3–8 need
fields the account may not send. Under `liquidityMode = LENIENT` a filter that was
skipped at entry is also skipped at exit — a position must not be force-exited by a
test that was never applied when it was opened. Under `STRICT` the condition is
unreachable on an `ltp`-only account for the same reason no strike is ever selected.
Either way the behaviour is symmetric between entry and exit, and asymmetry here is a
bug.

### 16.2.4 Premium Safety Exit — clarification

`initialStopPoints` and `premiumSafetyExitPoints` are both 2, so condition 2 is
numerically identical to condition 1 at entry and redundant with it *until the stop
trails below entry*. Its purpose thereafter is as an absolute backstop: it fires on a
**2-point adverse move from entry regardless of trailing state**, protecting against a
stop that failed to evaluate.

Because trailing only tightens (§15.3), condition 2 can only fire before the first
target is achieved, at which point it coincides with condition 1. It is retained as
defence-in-depth and is expected never to be the sole trigger. **Any occurrence where
it fires without condition 1 also firing indicates a stop-evaluation bug and MUST raise
a `warn`-level alert.** `[MUST-CONFIRM #5]`.

## 16.3 Post-Exit Sequence

```
1. Await fill confirmation (or HALT per §12.5)
2. Compute realised P&L from fill VWAP, net of charges (§17.3)
3. Persist ose_trades -> CLOSED  (synchronous, §19.2)
4. riskEngine.onTradeClosed(closedTrade)
5. marketData.untrackOption(trade.token)
6. Release ose_guard; activeTrade = null
7. state.to('COOLDOWN')
8. cooldown.start(reentryWaitCandles)
```

Steps 1–7 MUST be atomic with respect to new candle cycles: the cycle-in-progress flag
is held throughout.

## 16.4 The Sampled-Stop Guard `[KOTAK]` `[MUST-CONFIRM #12]`

§15.4 evaluates the stop once per 5-second candle, on sampled extremes. Between two
sealed candles the engine is blind to an adverse move it has already agreed is
unacceptable. The priority-0 timer already runs every 1000 ms and already holds a fresh
quote sample; using it is the difference between a 5-second stop and a 1-second one.

Normative when enabled (proposed default: **enabled**):

```
every SAFETY_TIMER_MS, while a position is open:
  sample = latest option quote sample for trade.token       // live, not sealed
  if sample.ts is older than 2 * NEO_POLL_MS -> skip (stale sample, no opinion)
  if sample.ltp >= trade.stopPrice -> EXIT_STOP_GUARD
```

This is the **only** place a live quote may drive a decision, and it is permitted under
§3.2(c) because it can only ever *close* a position, never open one. It cannot cause a
trade that would not otherwise have been possible, cannot loosen a stop, and cannot
change any price. `EXIT_STOP_GUARD` is recorded distinctly from `EXIT_STOP_HIT` so the
desk can measure exactly how often the sampled candle missed a stop the live sample
caught — which is the empirical answer to §15.4's residual risk.

If the desk declines this item, §15.4 stands alone and the 5-second resolution is
accepted as-is. Both positions are defensible; what is not defensible is shipping
without choosing.

---

# 17. Risk Engine

## 17.1 Tracked Counters

```ts
interface RiskCounters {
  tradingDate: string;          // YYYY-MM-DD IST
  tradesToday: number;
  consecutiveLosses: number;
  openPositions: number;        // 0 or 1
  realisedPnlPaise: number;     // NET, per §17.3
  halted: boolean;
  haltReason: string | null;
}
```

Persisted to `ose_stats` after every mutation (§19.2) and reloaded on boot. They reset
at the first cycle whose IST date differs from `tradingDate` — never on a timer, so a
restart mid-day does not reset limits.

## 17.2 Pre-Trade Gate

`canOpenTrade()` returns the **first** failing verdict:

```
1. halted                                    -> REJECT(HALTED)
2. broker session not ACTIVE                 -> REJECT(BROKER_SESSION_EXPIRED)   [KOTAK]
3. !isSessionOpen(ts)                        -> REJECT(SESSION_CLOSED)
4. ts <  FIRST_ENTRY_TIME                    -> REJECT(ENTRY_WINDOW_NOT_OPEN)
5. ts >= NO_NEW_ENTRY_TIME                   -> REJECT(ENTRY_WINDOW_CLOSED)
6. expiry day && !tradeOnExpiryDay           -> REJECT(EXPIRY_DAY)
7. openPositions >= maxOpenTrades            -> REJECT(MAX_OPEN_TRADES)
8. tradesToday >= maxTradesPerDay            -> REJECT(MAX_TRADES_PER_DAY)
9. consecutiveLosses >= maxConsecutiveLosses -> REJECT(MAX_CONSECUTIVE_LOSSES) + halt()
10. cooldown active                          -> REJECT(COOLDOWN)
                                             -> ALLOW
```

## 17.3 Loss Definition

A closed trade is a **loss** when `netPnlPaise < 0`, where net is gross minus charges.
Exactly zero is a scratch: it resets nothing and increments nothing except
`tradesToday`. `[MUST-CONFIRM #6]` — recommendation **net**, because a gross-scratch
round trip is a real net loss and the consecutive-loss circuit breaker should reflect
economic reality.

### 17.3.1 The charges model (normative arithmetic)

The engine's own risk arithmetic uses the NSE F&O options schedule below, applied **per
leg** and summed over the round trip. All values are integer paise; every intermediate
is rounded with `Math.round` at the point shown, so the result is reproducible rather
than float-dependent.

```
turnover = pricePaise * qty                        // premium turnover, paise

brokerage   = round(brokeragePerOrder * 100)       // flat ₹20/order → 2000 paise
stt         = SELL ? round(turnover * sttSellPct)   : 0     // 0.10%, sell leg only
exchangeTxn = round(turnover * exchTxnPct)                  // 0.03503%
sebi        = round(turnover * sebiPct)                     // 0.0001%
gst         = round((brokerage + exchangeTxn + sebi) * gstPct)   // 18%
stampDuty   = BUY  ? round(turnover * stampBuyPct)  : 0     // 0.003%, buy leg only

legTotal    = brokerage + stt + exchangeTxn + sebi + gst + stampDuty
charges     = legTotal(SELL @ entry) + legTotal(BUY @ exit)

grossPaise  = (entryPaise − exitPaise) * qty
netPaise    = grossPaise − charges          // what §17.3 and ose_stats read
```

Rates live in `config.charges` (`CHG_*` environment variables) because tax rates change
by statute and a rate change must not be a code deploy. They are **not** strategy
parameters and do not appear in §5.1.

**Why this matters beyond accounting.** Charges are dominated by the flat per-order
brokerage and are therefore paid *per round trip*, not per point. At one lot the round
trip costs roughly 40 paise per unit of premium before taxes — a material fraction of a
one-point target. `settings.breakevenNote()` surfaces this at save time, and the
`covered` flag it returns answers the only question that matters when tuning
`initialTargetPoints`: **does the target clear the charges at all?** A configuration
where it does not is not a bad configuration, it is a guaranteed loss, and the settings
page says so.

**`[KOTAK]`** These are approximations. **Kotak's contract note remains authoritative
for accounting**; a nightly reconciliation of modelled versus billed charges is an
operational task, not an engine one. A persistent divergence is a signal to update the
`CHG_*` rates, never to adjust a booked trade.

## 17.4 Session Windows — `[MUST-CONFIRM #8]`

IST, non-tunable per §5.2 — an operator who can move the square-off can move it past
the point where the position can still be closed:

```js
MARKET_OPEN        = '09:15:00';
FIRST_ENTRY_TIME   = '09:20:00';   // skip the opening five candles of noise
NO_NEW_ENTRY_TIME  = '15:10:00';
SQUARE_OFF_TIME    = '15:15:00';   // forced flat
MARKET_CLOSE       = '15:30:00';
```

`SQUARE_OFF_TIME` is enforced by the priority-0 timer, not the candle cycle.

## 17.5 Cooldown

After every closed trade, `COOLDOWN` lasts `reentryWaitCandles = 2` **sealed NIFTY
candles** (10 s). Counting is by candle, not by clock, so a feed pause extends the
cooldown rather than skipping it. Cancelled/unfilled entries also enter cooldown
(§12.4) but do not consume `tradesToday`.

## 17.6 Halt

`halt(reason)` is terminal for the session:

```
1. If a position is open -> Exit Engine, reason EXIT_RISK_HALT
2. state.to('HALTED')
3. Cancel all open orders carrying the OS- prefix
4. Untrack all option feeds
5. Persist ose_stats with halted = true
6. Emit CRITICAL log + operator alert
7. Refuse all further entries until a manual reset (§26.6)
```

`HALTED` is not auto-clearing. It requires an operator action and MUST NOT be cleared
by a process restart.

**`[KOTAK]`** Step 1 requires a live Kotak session. If the halt was itself caused by
session expiry, the exit cannot be sent: the engine logs `HALT_WITH_OPEN_POSITION` at
`critical`, pages, and holds the position under operator supervision. §31.4 covers the
runbook. This is the one failure mode where the engine genuinely cannot protect itself,
and pretending otherwise in the design would be worse than stating it.

## 17.7 Trading Calendar

The engine MUST NOT trade on exchange holidays. `config/holidays.json` is loaded and
validated at boot; a missing or stale (past year-end) list is a refusal to start in
`production`. Weekend detection is by IST day-of-week.

---

# 18. State Machine

## 18.1 States

```
BOOTING → RECONCILING → IDLE → SCANNING → ENTRY_READY → ORDER_PENDING
        → POSITION_OPEN → POSITION_MANAGEMENT → EXIT_PENDING → COOLDOWN → SCANNING
                                                                       ↘ HALTED
```

## 18.2 Transition Table (Normative)

| From | Event | Guard | To |
|---|---|---|---|
| `BOOTING` | config + DB + **Kotak session** ready | — | `RECONCILING` |
| `BOOTING` | no Kotak session | — | `IDLE` (waits; §31.2) |
| `RECONCILING` | reconcile clean, flat | — | `IDLE` |
| `RECONCILING` | reconcile found open position | matches persisted trade | `POSITION_MANAGEMENT` |
| `RECONCILING` | reconcile found *unknown* position | — | `HALTED` |
| `RECONCILING` | reconcile failed | — | `HALTED` |
| `IDLE` | session open + broker ACTIVE | `!halted` | `SCANNING` |
| `SCANNING` | candle sealed | entry validated + risk allows | `ENTRY_READY` |
| `SCANNING` | candle sealed | any rejection | `SCANNING` |
| `ENTRY_READY` | order placed | — | `ORDER_PENDING` |
| `ORDER_PENDING` | filled / partial | — | `POSITION_OPEN` |
| `ORDER_PENDING` | rejected / timeout / cancelled | — | `COOLDOWN` |
| `ORDER_PENDING` | ambiguous, unresolved after §12.3.2 | — | `HALTED` |
| `POSITION_OPEN` | first management cycle | — | `POSITION_MANAGEMENT` |
| `POSITION_MANAGEMENT` | any exit condition | — | `EXIT_PENDING` |
| `EXIT_PENDING` | exit filled | — | `COOLDOWN` |
| `EXIT_PENDING` | exit failed ×3 | — | `HALTED` |
| `COOLDOWN` | `reentryWaitCandles` elapsed | session open, `!halted` | `SCANNING` |
| `COOLDOWN` | session closed | — | `IDLE` |
| *any* | broker session EXPIRED | flat | `IDLE` |
| *any* | broker session EXPIRED | in position | `HALTED` |
| *any* | `halt()` | — | `HALTED` |
| `HALTED` | manual reset | operator action | `BOOTING` |

Any event/state pair not in this table is an `ILLEGAL_TRANSITION`: logged at `error`,
ignored, counted. Three in a session → `HALTED`.

## 18.3 Transition Logging

Every transition writes an `ose_transitions` row and emits:

```json
{
  "evt": "STATE_TRANSITION",
  "cycleId": "...", "tradeUid": "...",
  "from": "SCANNING", "to": "ENTRY_READY",
  "trigger": "ENTRY_VALIDATED",
  "guardResults": { "risk": "ALLOW", "entry": "SELL_PE" },
  "ts": 1730000000000, "latencyMs": 12.4
}
```

## 18.4 Implementation

A single explicit transition table, not scattered `if` statements. `state.to(next, ctx)`
validates against the table and throws on an illegal transition. The state object is the
only place `currentState` is mutated.

---

# 19. Persistence Layer

MySQL 8.0 / MariaDB 10.4+. Purpose: audit trail, crash recovery and risk-counter
durability — **not** hot-path decision data. No decision path performs a synchronous DB
read. All writes are fire-and-forget through a bounded queue, except the three
synchronous ones below.

## 19.1 Schema

The OSE tables live in the platform's shared `db/schema.sql`, prefixed `ose_`, alongside
the shared `orders` and `instruments` tables. One `orders` table across all engines
means one idempotency key, one reconciler, and one place to read when the question is
"what did this account send today".

```sql
-- One row per position, from strike selection to booked round trip.
CREATE TABLE IF NOT EXISTS ose_trades (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  trade_uid         CHAR(36) NOT NULL,          -- the §12.3 idempotency root
  trade_date        DATE NOT NULL,
  underlying        VARCHAR(24) NOT NULL,
  expiry_date       DATE NOT NULL,
  option_type       ENUM('CE','PE') NOT NULL,
  token             VARCHAR(32) NOT NULL,       -- Kotak instrument token
  symbol            VARCHAR(64) NOT NULL,       -- Kotak trading symbol
  strike            DECIMAL(12,2) NOT NULL,
  lot_size          INT UNSIGNED NOT NULL,      -- from the scrip master
  qty               INT UNSIGNED NOT NULL,
  state             VARCHAR(24) NOT NULL DEFAULT 'ORDER_PENDING',
  entry_trend       ENUM('BULLISH','BEARISH') NOT NULL,
  requested_price_p INT NOT NULL,               -- paise; slippage analysis
  entry_price_p     INT NULL,                   -- paise; the FILL VWAP
  entry_ts          BIGINT UNSIGNED NULL,
  entry_candle_ts   BIGINT UNSIGNED NULL,
  entry_candle_id   INT UNSIGNED NULL,
  filled_qty        INT UNSIGNED NOT NULL DEFAULT 0,
  target_level      INT UNSIGNED NOT NULL DEFAULT 0,
  target_price_p    INT NULL,
  stop_price_p      INT NULL,                   -- monotone non-increasing (§15.3)
  final_stop_p      INT NULL,
  candles_held      INT UNSIGNED NOT NULL DEFAULT 0,
  mfe_points        DECIMAL(8,2) NOT NULL DEFAULT 0,
  exit_price_p      INT NULL,
  exit_ts           BIGINT UNSIGNED NULL,
  exit_reason       VARCHAR(48) NULL,
  exit_attempts     INT UNSIGNED NOT NULL DEFAULT 0,
  gross_pnl_p       INT NULL,
  charges_p         INT NULL,
  net_pnl_p         INT NULL,                   -- what the risk limits read (§17.3)
  select_score      DECIMAL(9,6) NULL,
  select_detail     JSON NULL,                  -- incl. skipped filters (§9.2.1)
  settings_snapshot JSON NULL,
  status            ENUM('OPEN','CLOSED','ERROR') NOT NULL DEFAULT 'OPEN',
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                                     ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ose_uid (trade_uid),
  KEY idx_ose_date_status (trade_date, status),
  KEY idx_ose_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- §3.3 enforced by the database as well as by the Risk Engine. `open_key` is the
-- constant 1 while a trade is live and NULL once finished; MySQL treats NULLs as
-- distinct in a UNIQUE index, so two racing engines produce one winner and one
-- duplicate-key error rather than two positions.
CREATE TABLE IF NOT EXISTS ose_guard (
  trade_id  INT UNSIGNED NOT NULL,
  open_key  TINYINT UNSIGNED NULL,
  PRIMARY KEY (trade_id),
  UNIQUE KEY uk_ose_open (open_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ONE ROW PER SEALED CANDLE, whether or not anything happened (~4,300/session).
CREATE TABLE IF NOT EXISTS ose_decisions (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cycle_id        CHAR(36) NOT NULL,
  trade_date      DATE NOT NULL,
  candle_ts       BIGINT UNSIGNED NOT NULL,
  nifty_open_p    INT NOT NULL,
  nifty_high_p    INT NOT NULL,
  nifty_low_p     INT NOT NULL,
  nifty_close_p   INT NOT NULL,
  synthetic       TINYINT(1) NOT NULL DEFAULT 0,
  low_confidence  TINYINT(1) NOT NULL DEFAULT 0,   -- [KOTAK] §7.8
  tick_count      INT UNSIGNED NOT NULL DEFAULT 0, -- [KOTAK] samples in the bucket
  trend           ENUM('BULLISH','BEARISH','NONE') NOT NULL DEFAULT 'NONE',
  trend_via       VARCHAR(24) NULL,
  bullish_mid_p   INT NULL,
  bearish_mid_p   INT NULL,
  outcome         VARCHAR(48) NOT NULL,            -- ENTRY_TAKEN or the reason
  detail          VARCHAR(255) NULL,
  selected_symbol VARCHAR(64) NULL,
  selection_score DECIMAL(9,6) NULL,
  state           VARCHAR(24) NULL,
  latency_ms      DECIMAL(9,3) NOT NULL DEFAULT 0,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ose_decision (trade_date, candle_ts),
  KEY idx_ose_decision_outcome (outcome, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ose_transitions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cycle_id      CHAR(36) NULL,
  trade_uid     CHAR(36) NULL,
  from_state    VARCHAR(32) NOT NULL,
  to_state      VARCHAR(32) NOT NULL,
  trigger_event VARCHAR(48) NOT NULL,
  reason        VARCHAR(256) NULL,
  illegal       TINYINT(1) NOT NULL DEFAULT 0,
  ts_ms         BIGINT UNSIGNED NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ose_trans_ts (ts_ms),
  KEY idx_ose_trans_trade (trade_uid, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- §17.1. One row per trading day. `halted` is NOT auto-clearing and MUST NOT be
-- cleared by a restart (§17.6).
CREATE TABLE IF NOT EXISTS ose_stats (
  trade_date         DATE NOT NULL,
  trades_today       INT UNSIGNED NOT NULL DEFAULT 0,
  consecutive_losses INT UNSIGNED NOT NULL DEFAULT 0,
  realised_pnl_p     INT NOT NULL DEFAULT 0,
  gross_pnl_p        INT NOT NULL DEFAULT 0,
  charges_p          INT NOT NULL DEFAULT 0,
  win_count          INT UNSIGNED NOT NULL DEFAULT 0,
  loss_count         INT UNSIGNED NOT NULL DEFAULT 0,
  scratch_count      INT UNSIGNED NOT NULL DEFAULT 0,
  cycles             INT UNSIGNED NOT NULL DEFAULT 0,
  entries            INT UNSIGNED NOT NULL DEFAULT 0,
  halted             TINYINT(1) NOT NULL DEFAULT 0,
  halt_reason        VARCHAR(256) NULL,
  halted_at          DATETIME NULL,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                                      ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

The shared `orders` table (unchanged by this engine) carries the §12.3 key:

```sql
client_ref      VARCHAR(64) NOT NULL,   -- OS-<uid>-<CE|PE>-<attempt>-<stage>[-R<n>]
broker_order_id VARCHAR(48) NULL,       -- Kotak nOrdNo
ose_trade_id    INT UNSIGNED NULL,
status          ENUM('PENDING','PLACING','WORKING','FILLED','PARTIAL',
                     'CANCELLED','REJECTED','UNKNOWN') NOT NULL DEFAULT 'PENDING',
UNIQUE KEY uk_orders_client_ref (client_ref)
```

`UNIQUE(client_ref)` is the entire idempotency guarantee in one index. Dropping it
removes the only thing preventing a duplicate naked short.

## 19.2 Synchronous Writes

Only three writes block the engine:

1. `ose_trades` INSERT with `status='OPEN'` plus the `ose_guard` claim — **before** the
   entry order is placed. If this write fails, no order is placed. This guarantees no
   position can exist without a durable record.
2. `ose_trades` UPDATE to `status='CLOSED'` — after the exit fill.
3. `ose_stats` UPSERT — after every counter mutation.

Everything else (`ose_decisions`, `ose_transitions`, order status updates) goes through
the async queue. Depth `> OSE_QUEUE_WARN_DEPTH (1000)` → `warn`; `> OSE_QUEUE_MAX_DEPTH
(5000)` → drop oldest and `error`. **The queue never blocks a decision cycle** — losing
a decision row is bad; missing a stop is worse.

## 19.3 Retention

`ose_decisions` and `ose_transitions` are high-volume. Partition monthly, retain 24
months, archive to cold storage thereafter. `ose_trades` and `orders` are retained
indefinitely.

## 19.4 Required migration — `ose_decisions` `[KOTAK]`

The `ose_decisions` definition in §19.1 adds two columns that the currently deployed
`db/schema.sql` does not have:

```sql
low_confidence  TINYINT(1)   NOT NULL DEFAULT 0,   -- §7.8
tick_count      INT UNSIGNED NOT NULL DEFAULT 0,   -- §7.8 — samples in the bucket
```

They are not optional. `tick_count` is the leading indicator behind
`engine_candle_tick_count` and `engine_low_confidence_ratio` (§21.4), which are how a
degrading Kotak sampler is detected *before* it starts costing entries and missed stops
— and a metric with no persisted history cannot answer "was it always like this?"
after the fact. Without them, §25.8's acceptance criterion (a recorded distribution of
samples per bucket that the desk accepts) is unmeasurable.

Two edits are required, and **both**, because `CREATE TABLE IF NOT EXISTS` will not
alter a table that already exists on a deployed database:

1. Add the columns to the `ose_decisions` statement in `db/schema.sql`, positioned after
   `synthetic`.
2. Add an idempotent patch block to `db/migrate.js`, in the same style as the existing
   ones:

```sql
ALTER TABLE ose_decisions ADD COLUMN low_confidence TINYINT(1)   NOT NULL DEFAULT 0 AFTER synthetic;
ALTER TABLE ose_decisions ADD COLUMN tick_count     INT UNSIGNED NOT NULL DEFAULT 0 AFTER low_confidence;
```

guarded by an `information_schema.COLUMNS` existence check so a re-run is a no-op. Until
both land, the `ose_decisions` writer MUST NOT reference either column — a spec that is
ahead of its schema produces an engine that halts on its first decision row, which is a
worse failure than the missing metric.

---

# 20. Error Handling and Recovery

## 20.1 Principle

**No module may terminate the process.** The only permitted process exits are (a)
boot-time config/schema validation failure and (b) an explicit operator stop.
Everything else degrades to `HALTED`.

## 20.2 Error Taxonomy

| Class | Examples | Response |
|---|---|---|
| **Transient** | socket reset before send, 429, rate-bucket refusal, Kotak 502 on a read | Retry with backoff (§20.4) |
| **Data** | corrupt chain, missing candle, unparseable quote row | Skip cycle, log, continue |
| **Business** | order rejected, insufficient margin, off-tick price | No trade; count toward the rejection breaker |
| **Uncertain `[KOTAK]`** | timeout or 5xx **after** an order request left | Never retry. §12.3.2 recovery, then `HALT` |
| **Auth `[KOTAK]`** | 401/403 from any Kotak call | Latch EXPIRED once; §31.4 |
| **Integrity** | stop invariant violated, illegal transition, unknown broker position | `HALT` immediately |
| **Fatal-at-boot** | bad config, DB unreachable, holiday file missing, `NEO_POLL_MS=0` in production | Exit non-zero |

`Uncertain` and `Auth` are v4.0 additions. They correspond exactly to
`BrokerUncertainError` and `BrokerAuthError` in `src/core/errors.js`, and the mapping
is one-to-one by design: an error class that does not name its response is a class the
caller will guess at.

## 20.3 Specific Handlers

| Condition | Handling |
|---|---|
| Missing candle (1) | Synthesise (§7.6); never tradable |
| Missing candles (≥2) | Flat → suspend scanning until 3 real candles; in position → `EXIT_FEED_GAP` |
| Duplicate candle | Drop, count, continue |
| Late sample | Drop, count, `warn` |
| Low-confidence candle | Emitted, stored, `tradable = false` (§7.8) |
| Chain timeout | `NO_ENTRY(CHAIN_STALE)`; `CHAIN_STALE_HALT = 5` consecutive → `HALT` |
| One quote batch fails | Gap in the chain, not a failed snapshot; continue with what answered |
| Kotak 503 "No available server" | A gateway routing refusal, not an outage and not "no data" — see §32.2 |
| Feed silent > `FEED_DOWN_EXIT_MS` while in position | `EXIT_FEED_GAP` |
| Kotak REST timeout on an order | §12.3.2 idempotent recovery — **never** blind retry |
| Order rejection | §12.4; 3 consecutive → `HALT(REPEATED_REJECTION)` |
| 401 on any call | `markExpired` (latched once), §31.4 |
| Fill far from request | `|fill − request| > SEVERE_SLIPPAGE_POINTS` → log `SEVERE_SLIPPAGE`, **continue with the actual fill**, alert |
| Unhandled exception in a cycle | `failSafe()` (§20.5) |

Slippage handling continues rather than aborts: the position exists at the price it
exists at, every target and stop derives from the fill, and refusing a fill the exchange
has already given us would leave an untracked short — the one thing worse than a bad
price.

## 20.4 Retry Policy

Exponential backoff with full jitter, applied **only** to the transient class:

```
delay(n) = random(0, min(BASE * 2^n, MAX))
BASE = 200 ms, MAX = 5000 ms, maxAttempts = 5
```

**Order placement is exempt.** It uses the idempotent protocol of §12.3.2 and never
blind backoff, because backoff assumes the retry is safe and on Kotak it is not.

## 20.5 Fail-Safe Handler

```js
async function failSafe(ctx, err) {
  log.error({ evt: 'CYCLE_EXCEPTION', cycleId: ctx.cycleId,
              err: serialiseError(err), state: state.current });
  metrics.incr('cycle_exceptions');

  if (activeTrade) {
    await exitEngine.forceExit(activeTrade, 'EXIT_ENGINE_ERROR');
  }
  if (metrics.cycleExceptionsInWindow(GUARD_WINDOW_MS) >= CYCLE_EXCEPTION_LIMIT) {
    risk.halt('REPEATED_CYCLE_EXCEPTIONS');
  }
}
```

`process.on('uncaughtException')` and `process.on('unhandledRejection')` route to the
same handler and additionally `HALT`. They are a last line of defence, not a
control-flow mechanism.

## 20.6 Startup Reconciliation (Normative)

Every boot, before any trading, in `RECONCILING`:

```
1. Load ose_stats for today. If halted -> HALTED, stop.
2. SELECT * FROM ose_trades WHERE status = 'OPEN'
3. Fetch Kotak positions (/quick/user/positions) and the order book (/quick/user/orders)
4. Match — by (tradingSymbol, side, net qty), because there is no client order id:
   a. DB open trade + matching broker position  -> resume POSITION_MANAGEMENT
   b. DB open trade + NO broker position        -> closed while we were down;
                                                   reconstruct the exit from the order
                                                   book / order history; mark CLOSED;
                                                   update ose_stats; -> IDLE
   c. NO DB open trade + broker position exists -> HALT(UNKNOWN_POSITION). NEVER
                                                   auto-close an unrecognised position.
   d. Two broker rows fit one DB trade          -> HALT(AMBIGUOUS_POSITION)
   e. Neither                                   -> IDLE
5. Cancel dangling open orders whose client_ref starts with `OS-`.
```

Case (c) is deliberately manual: auto-closing a position the engine does not understand
is more dangerous than holding it under operator supervision. Case (d) is new in v4.0
and exists only because Kotak's book cannot be queried by our own key.

Step 5 is scoped by the `OS-` prefix so an order belonging to a sibling engine on the
same account can never be cancelled by this engine's boot.

---

# 21. Logging and Observability

## 21.1 Format

Structured JSON, one object per line, at `info` in production. Log writing MUST be
asynchronous and MUST NOT sit in the synchronous decision path.

**Implementation — a correction to v3.0.** v3.0 named `pino`. This platform logs through
`winston` (`src/core/logger.js`), with a readable console transport and daily-rotated
file transports, and the engine shares it with its two sibling engines. Introducing a
second logging library for one module would split the log stream an operator has to
read during an incident, which costs more than the throughput difference is worth. The
normative requirement is the *behaviour* — structured, one object per line,
asynchronous, never in the decision path — not the library. Winston's file transports
MUST be configured non-blocking; a synchronous write in a decision cycle is a §23.3
violation regardless of which library performs it.

## 21.2 Mandatory Fields

```json
{
  "ts": 1730000000123,
  "level": "info",
  "evt": "ENTRY_VALIDATED",
  "cycleId": "01927...",
  "tradeUid": "01927...",
  "symbol": "NIFTY25AUG24500PE",
  "state": { "from": "SCANNING", "to": "ENTRY_READY" },
  "reason": "SELL_PE",
  "execMs": 8.42,
  "env": "production",
  "mode": "LIVE"
}
```

`tradeUid` is `null` when no trade is in scope. `cycleId` correlates every line produced
within one decision cycle — the primary debugging handle.

**Never logged:** `NEO_API_TOKEN`, the session token, `sid`, MPIN, TOTP, or any
`Authorization` / `Auth` header value. A logged session token is a credential leak with
trading authority attached. The serialiser redacts these keys by name, and a unit test
asserts the redaction.

## 21.3 Event Catalogue

```
MARKET:   CANDLE_SEALED, CANDLE_SYNTHETIC, CANDLE_LOW_CONFIDENCE, CANDLE_DUPLICATE,
          SAMPLE_LATE, FEED_GAP, FEED_CONNECTED, FEED_DISCONNECTED, POLL_DEGRADED
CHAIN:    CHAIN_FETCHED, CHAIN_STALE, CHAIN_CORRUPT, CHAIN_FIELDS_UNAVAILABLE,
          QUOTE_FILTER_SELECTED
STRIKE:   STRIKE_CANDIDATES, STRIKE_SELECTED, NO_LIQUID_STRIKE, FILTER_SKIPPED
TREND:    TREND_EVALUATED, TREND_UNDETERMINED
ENTRY:    ENTRY_VALIDATED, ENTRY_REJECTED, NO_OPTION_CANDLE
ORDER:    ORDER_PLACED, ORDER_FILLED, ORDER_PARTIAL, ORDER_REJECTED, ORDER_CANCELLED,
          ORDER_UNKNOWN, ORDER_AMBIGUOUS, ORDER_ADOPTED, SEVERE_SLIPPAGE
POSITION: POSITION_OPENED, POSITION_EVALUATED, TARGET_EXTENDED, STOP_TRAILED
EXIT:     EXIT_TRIGGERED, EXIT_FILLED, EXIT_FAILED, EXIT_STOP_GUARD
RISK:     RISK_REJECTED, COOLDOWN_STARTED, COOLDOWN_ENDED, HALT, DAY_RESET
BROKER:   SESSION_ESTABLISHED, SESSION_EXPIRED, RATE_LIMITED, GATEWAY_503
SYSTEM:   STATE_TRANSITION, ILLEGAL_TRANSITION, CYCLE_OVERRUN, CYCLE_EXCEPTION,
          RECONCILE_START, RECONCILE_RESULT, BOOT, SHUTDOWN
```

## 21.4 Metrics

Prometheus exposition format, served on `GET /metrics`, **bound to localhost only** —
it is the one HTTP surface besides `/health` that §27 permits. No metrics module exists
yet; building it is a prerequisite for the §21.5 alerts, which are otherwise
unimplementable.

```
engine_cycle_latency_ms          histogram
engine_cycles_total              counter{outcome}
engine_trades_total              counter{result}
engine_active_position           gauge  (0|1)
engine_consecutive_losses        gauge
engine_halted                    gauge  (0|1)
engine_feed_lag_ms               gauge
engine_candle_tick_count         histogram{series}   # [KOTAK] samples per bucket
engine_low_confidence_ratio      gauge               # [KOTAK]
engine_order_latency_ms          histogram{purpose}
engine_late_samples_total        counter
engine_rate_bucket_available     gauge               # [KOTAK] §30
engine_quote_requests_total      counter{filter}
engine_broker_session_active     gauge  (0|1)
engine_db_queue_depth            gauge
```

`engine_candle_tick_count` and `engine_low_confidence_ratio` exist because on this
broker they are the leading indicators of every downstream problem: a falling sample
count precedes untradable candles, missed stops and skipped entries, and it falls
silently.

## 21.5 Alerts

| Alert | Condition | Severity |
|---|---|---|
| Engine halted | `engine_halted == 1` | **critical, page** |
| Exit failed | `EXIT_FAILED` | **critical, page** |
| Unknown position | `HALT(UNKNOWN_POSITION)` | **critical, page** |
| Broker session expired with a position open | `SESSION_EXPIRED && active_position == 1` | **critical, page** |
| Feed down in position | `feed_lag_ms > 10000 && active_position == 1` | **critical, page** |
| Order ambiguous | `ORDER_AMBIGUOUS` | **critical, page** |
| Premium safety fired alone | §16.2.4 | warning |
| Low-confidence ratio | `> 0.30` for 5 min | warning |
| Rate bucket starved | `rate_bucket_available < 1` for 30 s | warning |
| p99 latency breach | `> 100 ms` for 5 min | warning |
| Cycle overruns | `> 3` in 60 s | warning |
| DB queue backing up | `db_queue_depth > 1000` | warning |

---

# 22. Open Specification Items (`[MUST-CONFIRM]`)

Development may begin on all modules, but **the engine MUST NOT run in `LIVE` mode
until every item below is signed off** and its id recorded in `settings.ose.confirmed`.
`settings.load()` reads that register, the boot log prints the unsigned items, and
`LIVE` refuses to start while any remain. The register is data, not prose, precisely so
the engine can enforce this sentence rather than merely state it.

| # | Item | § | Proposed default | Status |
|---|---|---|---|---|
| 1 | Liquidity thresholds (OI, volume, depth, spread) | §9.2 | As listed | open — entangled with #10/#13 |
| 2 | Position size — lots per trade | §12.2 | `1` lot | open |
| 3 | Multi-level target advancement within one candle | §14.3 | One level per candle | open |
| 4 | Stop uses candle `high`; target uses `close` | §15.4 | As specified | open |
| 5 | Premium Safety Exit vs Initial Stop distinction | §16.2.4 | Backstop, as specified | open |
| 6 | Loss on gross or net P&L | §17.3 | Net (incl. charges) | open |
| 7 | Trading permitted on expiry day | §8.2 | Not permitted | open |
| 8 | Session windows and square-off time | §17.4 | As listed | open |
| 9 | `MAX_HOLD_CANDLES` | §16.2 | `24` candles (120 s) | open |
| 10 | **Broker identity and API capabilities** | §7, §28 | **Kotak Neo** | **RESOLVED — see below** |
| 11 | `indexMinTicks` / `optionMinTicks` — how few samples is too few | §7.8 | `3` / `2` | **new in v4.0** |
| 12 | The sampled-stop guard on the priority-0 timer | §16.4 | Enabled | **new in v4.0** |
| 13 | `liquidityMode` default under the account's real entitlement | §9.2.1 | `STRICT` | **new in v4.0** |
| 14 | Who performs the daily interactive login, and by when | §31.2 | Operator, by 09:00 IST | **new in v4.0** |
| 15 | Behaviour when the session expires with a position open | §17.6, §31.4 | HALT + page; hold under supervision | **new in v4.0** |
| 16 | Margin: pre-check per order, or absorb the rejection | §12.6 | Absorb; one boot-time check only | **new in v4.1** |
| 17 | PAPER fill model, and what it cannot evidence | §12.7 | Pessimistic limit/next-sample model, as specified | **new in v4.1** |

## 22.1 Item 10 — resolved, and what it costs

**Broker: Kotak Neo.** 5-second option candles ARE buildable, but not from a tick
stream. The resolution carries three consequences that are themselves the new items
11–13, and each is a real reduction in what the engine can promise:

| v3.0 assumed | Kotak Neo provides | Consequence |
|---|---|---|
| A streaming tick feed | An HSM socket that often streams nothing, plus REST quotes at ~1/s | Candles are **sampled**: ≤5 observations per 5 s bucket, sometimes 1. Item #11. |
| Full chain with depth and OI | `ltp` reliably; OI/volume/depth only on richer entitlements that many accounts are refused | Filters 3–8 of §9.2 may be unrunnable. Items #1, #13. |
| A client order id on place-order | No client identifier at all | Idempotency moves entirely into our DB (§12.3); ambiguity is resolved by symbol/side/qty matching or by halting. |

None of these is a defect to be fixed later. They are the terms on which this engine can
run on this broker, and the desk signs off on them or the engine does not go live.

---

# 23. Performance Budget

## 23.1 Target

End-to-end decision latency `< 100 ms` at p99, measured from `CANDLE_SEALED` to
`ORDER_PLACED`.

## 23.2 Budget Allocation

| Stage | Budget (p99) |
|---|---|
| Candle seal + append | 2 ms |
| Chain snapshot (cached; never fetched inside a cycle) | 5 ms |
| Strike filter + rank | 10 ms |
| Trend evaluation | 1 ms |
| Entry validation | 1 ms |
| Risk gate | 1 ms |
| Synchronous `ose_trades` INSERT + `ose_guard` claim | 15 ms |
| Rate-bucket take + `jData` serialise + Kotak REST dispatch | 50 ms |
| Slack | 15 ms |
| **Total** | **100 ms** |

**`[KOTAK]`** The 50 ms order-dispatch budget is the *engine's* share, not Kotak's
round trip. `TIMEOUT_MS = 15000` on the HTTP client governs the broker's response, and
that wait happens **after** `ORDER_PLACED` is recorded — the budget measures the time to
get the order out of the door, which is the only part the engine controls.

## 23.3 Rules

- No synchronous filesystem or network I/O in a cycle. `fs.*Sync`, `execSync` and
  blocking DB drivers are banned by lint.
- No unbounded allocation per cycle. Candle buffers and candidate arrays are pre-sized.
- Chain snapshots are cached and shared; never fetched inside a cycle.
- JSON serialisation of large objects happens in the async log path, not inline.
- GC pressure monitored via `perf_hooks`; sustained old-gen growth is a release blocker.

## 23.4 Memory

Steady-state RSS target `< 300 MB`. A 24-hour soak (§25.6) must show a flat heap after
warm-up, `< 5%` drift.

---

# 24. Coding Standards

## 24.1 Structure

```
src/
  ose/
    constants.js        # §5.2 — compiled-in, plus the MUST_CONFIRM register
    settings.js         # §5.1 — the `ose` settings row, validated and frozen
    trend.js            # §10 — pure
    entry.js            # §11 — pure
    ladder.js           # §14, §15 — pure
    strikes.js          # §9
    chain.js            # §8
    exits.js            # §16
    risk.js             # §17
    orders.js           # §12
    machine.js          # §18
  market/
    quoteSource.js      # §7.1 sampler + §29 entitlement probe
    candleBuilder.js    # §7.2–§7.8
    instrumentMaster.js # §8.1 scrip master, §7.10 index addressing
  broker/
    neoClient.js        # §28 — raw Kotak HTTP, the ONLY place that speaks jData
    neoSession.js       # §30, §31 — rate bucket, 401 latch, encrypted session
  execution/
    orderRouter.js      # §12.3 client_ref, claim, three-way classification
    reconciler.js       # §12.3.2, §20.6 — book matching without a client id
  core/                 # money, time, errors, crypto, rateLimiter, logger
test/
  unit/ integration/ replay/ fixtures/
scripts/
  ose-replay.js  ose-reconcile.js  ose-reset-halt.js  diagnose-spot.js
```

## 24.2 Rules

- **SOLID, with weight on Dependency Inversion — read precisely.** Every module is
  constructed with its collaborators injected at the composition root; no module
  `require()`s another at call time, and no module reaches for a singleton. What v4.0
  does **not** mean by this is an interface per implementation: §1.3 forbids a broker
  abstraction, so `OrderManager` takes a concrete `router` and `broker` and is tested by
  injecting the mock or paper one. DI here buys testability and an explicit dependency
  graph; it is not a licence to add a second implementation of anything.
- **Purity**: `trend.js`, `entry.js` and `ladder.js` are pure functions. No `Date.now()`,
  no I/O, no logging. Time is always a parameter.
- **Immutability**: candles and quotes are frozen. `ActiveTrade` is the only mutable
  aggregate, mutated only by the Position Manager, Target Engine and Trailing Stop.
- **Integer paise everywhere.** Rupees exist only inside `toJData` and quote parsing.
- **`null`, never `0`, for absent broker fields** (§3.9).
- **Typed errors**: `TransientError`, `DataError`, `BusinessError`, `IntegrityError`,
  `BrokerRejectedError`, `BrokerUncertainError`, `BrokerAuthError`. Never
  `throw new Error('...')` from a module.
- **No magic numbers** outside `constants.js` and settings.
- `===` only; no implicit coercion; async/await throughout.

## 24.3 Enforcement

ESLint with:
- `no-restricted-imports` preventing cross-module deep imports
- `no-restricted-syntax` banning `Math.random`, `Date.now` inside pure modules,
  `fs.*Sync`, and **`Number(` applied to a possibly-null quote field** in
  `src/ose/**` and `src/market/**`
- `no-floating-promises`
- Complexity ceiling `10`, file length ceiling `400` lines

CI gates: lint, `tsc --checkJs`, unit coverage `>= 90%` on the pure modules and
`>= 80%` overall, determinism test, replay regression. All must pass to merge.

---

# 25. Testing Requirements

## 25.1 Unit Tests

Table-driven, exhaustive, for every pure function.

**Trend Engine** — clear up / clear down; `d1==0, d2!=0`; `d1==0, d2==0, d3!=0`; all
three zero → `null`; fewer than 3 candles → `null`; `trend_via` recorded correctly.

**Entry Validator** — `close` exactly equal to `bullishMid` → rejected (strict
inequality); exactly equal to `bearishMid` → rejected; doji → rejected on both sides;
trend/signal conflict → rejected.

**Trailing Stop** — monotonicity across a 10-level ladder; `trailingStopEnabled=false`
→ the stop never moves; an attempted increase → `IntegrityError`.

**Target Ladder** — close exactly at target → advances; close 4 points beyond →
advances exactly one level; a **low-confidence** candle beyond target → does **not**
advance (§14.3).

**`[KOTAK]` Candle builder** — absolute bucket alignment; two builders started a second
apart produce identical bars; first bucket discarded; one silent bucket → synthetic and
not tradable; two → `FEED_GAP`; repeated identical LTP counts as samples; a late sample
never mutates a sealed bar; `tickCount < minTicks` → `lowConfidence && !tradable`.

**`[KOTAK]` Quote parsing** — every field spelling in `QUOTE_KEYS` maps correctly;
nested `ohlc` and `depth` payloads flatten; a missing field yields `null`, **never `0`**
(this test is the executable form of §3.9); `ltp: 0` is treated as absent.

**`[KOTAK]` Order mapping** — `toJData` produces exactly Kotak's field set with rupee
strings; an off-tick price never reaches the wire; `client_ref` format is stable for a
given trade/stage/revision.

## 25.2 Property Tests (`fast-check`)

- `∀ candle: ¬(close > bullishMid ∧ close < bearishMid)` — §11.3 mutual exclusivity
- `∀ trade sequence: stopPrice` is monotone non-increasing
- `∀ quote set: strikeSelector` returns the same symbol across 1,000 shuffles of input
  order — including sets where `oi`/`bid`/`ask` are `null` on every row
- `∀ state, event: state.to()` either transitions per the table or throws — never
  silently no-ops
- **`[KOTAK]`** `∀ sample sequence: candles(samples) === candles(shuffle(samples within
  their buckets))` for OHLC aggregation order-independence, except `close`, which is
  order-dependent by definition and asserted separately

## 25.3 Integration Tests

Against a **mock Kotak** implementing §28's wire contract exactly — `jData` form
encoding, `stat: 'Ok' | 'Not_Ok'`, `nOrdNo`, the book's inconsistent key spellings, and
the 503-HTML gateway page. Coverage:

- Happy path: entry → target extensions → trail → stop exit
- Partial fill then cancel; cancel losing the race to a fill
- Entry rejection ×3 → `HALT(REPEATED_REJECTION)`
- Exit rejection ×3 → `HALT(EXIT_FAILED)`
- **Order timeout after send → `UNKNOWN` → recovery adopts from the book**
- **Order timeout after send → book never shows it → `HALT(ORDER_AMBIGUOUS)`**
- **The mock never resends an order the engine already sent** — asserted by counting
  place-order calls, which is the executable form of §12.3
- 401 mid-session, flat → `IDLE`; 401 mid-session, in position → `HALT` + page
- **The HSM socket permanently silent, REST sampler only** (the production case)
- Rate bucket exhausted before an entry → pre-send refusal → row back to `PENDING`
- `ltp`-only entitlement under `STRICT` → no trades, `CHAIN_FIELDS_UNAVAILABLE` logged
  once; under `LENIENT` → trades with `skipped` recorded
- Chain timeout ×5 → `HALT`
- **Partial fill, and every rejection path — mock only.** §12.7 records that PAPER
  simulates neither, so these are exercised here or nowhere: partial then cancel,
  partial then cancel-fails → `HALT(CANCEL_FAILED)`, margin rejection ×2 →
  `HALT(MARGIN_EXHAUSTED)`, off-tick rejection.
- Boot margin check fails → engine starts `IDLE`, does not halt, does not scan (§12.6)
- All 13 exit reasons fired at least once

## 25.4 Determinism Test (Gate)

```
1. Load a recorded session (sealed candles + chain snapshots) from test/fixtures/
2. Run the engine in replay mode, capture the ordered decision log
3. Compute SHA-256 of the canonicalised decision log
4. Assert it equals the committed golden hash
5. Run again with shuffled internal map insertion order — the hash MUST be identical
```

Fixtures are **sealed candles**, not raw polls (§3.1). Any change to the hash requires
an explicit, reviewed golden-file update with justification.

## 25.5 Historical Replay

`scripts/ose-replay.js` drives the engine from recorded Kotak data at 1×, 100× or max.
Minimum acceptance: **20 trading days** with zero `IntegrityError`, zero illegal
transitions, zero unhandled exceptions.

**`[KOTAK]`** Recordings MUST come from this broker's sampler, at the production
`NEO_POLL_MS`. A replay over tick-resolution data from any other source would
systematically overstate fill quality and understate missed stops (§15.4), and is not
evidence about this system.

## 25.6 Soak Test

24-hour continuous run against a replaying feed. Pass: flat heap after warm-up, p99
cycle latency `< 100 ms` throughout, zero crashes, DB queue never exceeds 1,000, and
**`[KOTAK]`** the rate bucket never starves the order path.

## 25.7 Failure Injection

Chaos suite injecting: WS silence, REST 500s, the 503 HTML page, REST timeouts before
and after send, duplicate rows, out-of-order samples, DB unavailability, clock skew,
session expiry at every state. Pass criteria: the engine ends every scenario either flat
or `HALTED` — **never with an untracked position**.

## 25.8 Paper Trading

Minimum **10 consecutive trading days** with `mode = PAPER` against the live Kotak feed
with real order simulation. Acceptance: zero `HALT` events attributable to engine
defects, reconciliation clean on every boot, and **`[KOTAK]`** a recorded distribution
of `engine_candle_tick_count` that the desk accepts as sufficient evidence for the stop
resolution of §15.4.

---

# 26. Deployment and Production Operations

## 26.1 Environments

| Env | Feed | Broker | Mode | DB |
|---|---|---|---|---|
| development | recorded replay | mock Kotak | PAPER | local MySQL |
| testing | recorded replay | mock Kotak | PAPER | CI ephemeral |
| staging | live Kotak feed | live Kotak, PAPER orders | PAPER | staging MySQL |
| production | live Kotak feed | live Kotak | LIVE | production MySQL |

**`[KOTAK]`** There is no Kotak sandbox that simulates fills. Staging therefore uses the
*live* Kotak session for market data and simulates execution locally. Staging consumes
real rate-limit budget on the same account unless a separate UCC is provisioned —
provisioning one is strongly recommended and is an operations decision, not an engine
one.

## 26.2 Runtime

- Node.js LTS, pinned exact version, `package-lock.json` committed, `npm ci` only.
- Supervised by `systemd`/PM2 with `Restart=on-failure`, `RestartSec=5`,
  `StartLimitBurst=3`. Exceeding the burst leaves the process down — a crash-looping
  trading engine must stay down.
- **`chrony` mandatory.** Offset `> 250 ms` from NTP is a boot refusal in production and
  a runtime alert. On Kotak this is not hygiene: the local clock *is* the sample
  timestamp (§7.2), so clock drift directly corrupts candle bucketing.
- Deployed in-region for the Kotak endpoint to minimise round-trip latency.

## 26.3 Daily Lifecycle

```
08:45  process starts -> BOOTING; scrip master syncs; holiday check
08:50  OPERATOR performs the Kotak login (mobile + UCC + TOTP, then MPIN)   [KOTAK]
       -> SESSION_ESTABLISHED -> RECONCILING -> IDLE
09:15  Market open; quote sampler warm; candle series building
09:20  FIRST_ENTRY_TIME -> SCANNING
15:10  NO_NEW_ENTRY_TIME; scanning stops, management continues
15:15  SQUARE_OFF_TIME; forced flat
15:35  DB queue drains, daily summary emitted, process stops
```

The engine is **not** run overnight. A stop at 15:35 and a start at 08:45 bounds the
process lifetime to a single session and eliminates an entire class of day-rollover
bugs — and matches the Kotak session's own daily lifetime, which cannot outlive the day
regardless (§31.3).

**`[KOTAK]`** The 08:50 step is manual and is the single point at which a trading day
can silently fail to begin. Alerting MUST fire if `engine_broker_session_active == 0` at
09:10 on a trading day. `[MUST-CONFIRM #14]`.

## 26.4 Health Checks

`GET /health` (localhost only):

```json
{
  "status": "OK|DEGRADED|HALTED",
  "state": "SCANNING",
  "brokerSession": "ACTIVE|EXPIRED|DISCONNECTED",
  "quoteFilter": "ltp",
  "feedLagMs": 42,
  "candleTickCountP50": 3,
  "rateBucketAvailable": 5.2,
  "dbConnected": true,
  "activePosition": false,
  "tradesToday": 7,
  "consecutiveLosses": 1,
  "unconfirmedMustConfirm": [11, 12, 13],
  "uptimeSec": 12045
}
```

## 26.5 Kill Switch

Creating `$OSE_KILL_SWITCH_FILE` causes the engine, within `1000 ms`:

1. To exit any open position at MARKET (`EXIT_KILL_SWITCH`)
2. To cancel all `OS-` orders
3. To enter `HALTED`

The file is polled by the priority-0 timer, independent of the candle feed, so it works
even when market data has stopped — which is exactly the situation an operator most
needs it in. **MUST be tested before every production release.**

**`[KOTAK]`** The kill switch cannot close a position without a live Kotak session. If
the session is expired the engine still halts and cancels nothing, logs
`KILL_SWITCH_NO_SESSION` at `critical`, and the operator squares off from the Kotak
terminal directly. The runbook says so in one line, at the top.

## 26.6 Halt Reset

Clearing `HALTED` requires an operator to:

1. Confirm flat **via the Kotak terminal**, not via the engine
2. Run `scripts/ose-reset-halt.js --date YYYY-MM-DD --reason "..."`, which records the
   reset in `ose_transitions`
3. Restart the process

There is no API and no automatic path to clear a halt.

## 26.7 Release Process

1. All CI gates green (§24.3)
2. Determinism golden hash unchanged, or the change reviewed and justified
3. 20-day replay regression: trade-by-trade diff against the previous release, every
   difference explained
4. Staging paper-trade for 3 sessions
5. **Every `[MUST-CONFIRM]` id present in `settings.ose.confirmed`** (§22)
6. Two-person approval (tech lead + desk)
7. Deploy outside market hours only
8. First live session at minimum size with an operator present

Rollback is by redeploying the previous artefact. There are no in-place hotfixes to a
running engine during market hours.

## 26.8 Backup and DR

MySQL: automated daily full backup plus binlog, retained 30 days, restore tested
monthly. If the DB is unreachable at boot the engine refuses to start (§20.2) — trading
without a durable audit trail is not permitted, and on this broker the DB *is* the
idempotency mechanism (§12.3), so trading without it is trading without duplicate
protection.

---

# 27. Out of Scope

Explicitly excluded from v4.0 and forbidden in the v4.0 codebase:

BANKNIFTY / multi-index · **any second broker, and any broker abstraction built to hold
one** · performance-analytics reporting · trade-replay UI · AI/ML parameter optimisation ·
notification service (alerting is via the metrics/log pipeline) · risk dashboard · HA
clustering or failover · option buying · hedged/multi-leg structures · positional or
overnight holding · **order placement of any kind from a request handler** — every
mutation goes through the Order Manager.

## 27.1 The web-UI exclusion is deliberately overridden `[KOTAK]` `[PLATFORM]`

v3.0 and v4.0 excluded "a web dashboard or any HTTP UI beyond `/health` and `/metrics`".
**That exclusion is withdrawn in v4.1, for this deployment only, and the reasoning is
recorded here rather than left as a silent divergence.**

The rule was written for the standalone single-purpose process §4.3 describes. This
engine is not that: it is one of three sharing a Kotak account, a MySQL database and an
operator, and the other two each have a page. In that setting the exclusion makes the
system *less* safe, not more —

- §5.1's settings, including `liquidityMode` and the §22 sign-off register that gates
  LIVE, would be changeable only by editing a JSON column with SQL;
- §11.5's decision log — the whole point of writing a row per non-trade — would be
  readable only by hand;
- §29's entitlement report, which is the difference between "the market offered nothing"
  and "this account can never pass the filter", would live only in a boot log line.

What is **not** relaxed:

| Rule | Status |
|---|---|
| The web tier writes intent and reads state | **Unchanged.** `src/http/oseRoutes.js` places no order, cancels none, and never calls Kotak. |
| No control the engine does not read | **Enforced.** The page has no Start/Stop, because this engine reads no intent flag. A button the engine ignores is how a dashboard comes to read STOP while a live engine keeps selling — the defect `test/engineIntent.test.js` exists to prevent. |
| The kill switch stays a file | **Unchanged** (§26.5). It is polled on the priority-0 timer so it works when market data has stopped; an HTTP endpoint would not. |
| `HALTED` has no API path | **Unchanged** (§26.6). The page displays the halt and the runbook; only `scripts/ose-reset-halt.js` clears it. |

Cross-process state reaches the page through the `ose_state` flag, written by the engine
on the safety timer (not the candle cycle — a stopped feed is precisely when the page
most needs to keep updating). The `atMs` stamp on it is load-bearing: without it the page
cannot distinguish "the engine says nothing is tradable" from "the engine is not
running", and those need opposite responses from an operator.

---

# 28. Kotak Neo Adapter Contract `[KOTAK]`

Everything in this section is Kotak vocabulary and lives behind
`src/broker/neoClient.js`. No other module speaks it.

## 28.1 Endpoints

| Purpose | Method | Path |
|---|---|---|
| Login step 1 | POST | `{loginUrl}/login/1.0/tradeApiLogin` |
| Login step 2 | POST | `{loginUrl}/login/1.0/tradeApiValidate` |
| Place order | POST | `{baseUrl}/quick/order/rule/ms/place` |
| Cancel order | POST | `{baseUrl}/quick/order/cancel` |
| Order book | GET | `{baseUrl}/quick/user/orders` |
| Order history | POST | `{baseUrl}/quick/order/history` |
| Positions | GET | `{baseUrl}/quick/user/positions` |
| Margin check | POST | `{baseUrl}/quick/user/check-margin` |
| Quotes | GET | `{baseUrl}/script-details/1.0/quotes/neosymbol/{seg\|tok[,…]}/{filter}` |

`baseUrl` is **per-user and returned by login step 2**. It is not `NEO_API_BASE`;
`NEO_API_BASE` is only the fallback when the login response omits one.

## 28.2 Headers — three different conventions

| Call class | Headers |
|---|---|
| Login step 1 | `Authorization: <API token>` (**plain, no `Bearer`**), `neo-fin-key`, JSON body |
| Login step 2 | the above plus `Auth: <viewToken>`, `sid: <viewSid>` |
| Trading calls | `Auth: <sessionToken>`, `Sid: <sid>`, `neo-fin-key`; body form-encoded |
| **Quotes** | `Authorization: <API token>` **and nothing else** — no `neo-fin-key`, no `Auth`, no `Sid`. **Sending them makes it fail.** |

The quotes exception is not a documented feature; it is observed behaviour and the
reason quotes live in their own function rather than going through `call()`.

## 28.3 Wire format for orders

Trading endpoints are `application/x-www-form-urlencoded` with a single field
`jData=<url-encoded JSON>` — not a JSON body.

| jData | Meaning | Engine value |
|---|---|---|
| `es` | exchange segment | `nse_fo` |
| `ts` | trading symbol | from the scrip master, verbatim |
| `tt` | transaction type | `S` (entry) / `B` (exit) |
| `pt` | price type | `L` (entry) / `MKT` (exit) |
| `pr` | price, **rupees as string** | `entryPrice / 100` (entry), `0` (market) |
| `tp` | trigger price | `0` |
| `qt` | quantity | `lots * lotSize` |
| `pc` | product | `MIS` |
| `rt` | retention | `DAY` |
| `mp` | market protection | `0` |
| `am` | AMO | `NO` |
| `dq` | disclosed qty | `0` |
| `pf` | — | `N` |

This table and `toJData` are the **only** place rupees exist above the transport.

## 28.4 Responses

- Place order: `{ stat: 'Ok', nOrdNo }` or `{ stat: 'Not_Ok', emsg, stCode }`. Anything
  that is not `stat === 'Ok'` **with** an `nOrdNo` is a rejection.
- Quotes: an array, or `{ data: [...] }`. Rows echo the instrument under several
  different key names depending on segment and filter — match by token across all
  spellings, and fall back to request order only when the row count matches the batch
  size exactly.

## 28.5 Error classification — the three outcomes

```
no response at all
  ├─ request had NOT left  -> rejected   (safe: nothing happened)
  └─ request HAD left      -> uncertain  (the order MAY be live)
HTTP 401 / 403             -> auth       (session dead; latch EXPIRED once)
HTTP >= 500
  ├─ request had NOT left  -> rejected
  └─ request HAD left      -> uncertain  ("never processed" and "processed then
                                          crashed" are indistinguishable from here)
other 4xx / stat:'Not_Ok'  -> rejected
```

`sent: true` is passed by exactly the calls that mutate state — place and cancel. That
one boolean is what turns a timeout into an uncertain outcome rather than a retryable
one, and §12.3 is built on it.

## 28.6 Order-book normalisation

Kotak's book uses short, inconsistent keys and spells status several ways. One
normaliser owns the vocabulary:

```
brokerOrderId ← nOrdNo | norenordno | orderId | ordNo
status        ← /reject/ → REJECTED · /cancel/ → CANCELLED
                /complete|filled|traded|executed/ → FILLED
                /open|pending|trigger|modif|replac/ → WORKING
filledQty     ← fldQty | filledQty | fillshares
avgPrice      ← avgPrc | avgPrice | flprc | prc
```

A `WORKING` row with `0 < filledQty < totalQty` is normalised to `PARTIAL` here, once,
rather than at three call sites.

## 28.7 What this adapter MUST NOT grow

No order call outside `placeOrder` / `cancelOrder`. No modify-order (the engine cancels
and re-places; a modify would need its own idempotency story). No basket endpoints. No
second broker behind the same interface.

---

# 29. Kotak Neo Entitlement Matrix and Degraded Modes `[KOTAK]`

## 29.1 The filter probe

The quote filter is a **path segment**, so an unrecognised one is not an ignored
parameter — it is a route that does not exist, and Kotak answers those with an HTML
`HTTP 503 — No available server to handle this request`, which looks like an outage and
is really a 404 wearing the wrong number.

The probe therefore runs **baseline first**:

1. Try `ltp`. This is the filter the engine runs on and the one this account class is
   reliably entitled to. Proving it works gives a known-good baseline.
2. Then try `full`, `quote`, `market_depth`, `depth`, `ohlc` as an optional upgrade.
   Every failure here is *expected* and MUST NOT be reported as "the quote request is
   failing" — a refused upgrade is a fact about entitlement, not an error.
3. Keep the first candidate that answers **and still carries a price**.

The price precondition matters: Kotak's filters are **mutually exclusive, not
cumulative** — `ohlc` returns the day's four prices and no LTP; `depth` returns the book
and no LTP. Both look "richer" by field count, and selecting either would trade the one
number the whole platform runs on for some extra columns.

The probe runs **once per process**. Re-probing per poll would triple the request rate
against a budget shared with order placement, to re-learn a fact that does not change
during a session. If the *baseline* fails, the decision is **not** latched — that is
connectivity, not entitlement, and latching a decision made during an outage would leave
the engine degraded until restart.

## 29.2 The matrix

| Filter settled on | Available | §9.2 filters runnable | Engine behaviour |
|---|---|---|---|
| `ltp` (typical retail) | LTP only | 1–2 | `STRICT`: no strike ever selected, `CHAIN_FIELDS_UNAVAILABLE` logged once, engine visibly idle. `LENIENT`: selection on premium alone, every skipped filter recorded per trade. |
| `ohlc` | day OHLC, no LTP | — | **Rejected by the probe.** Never selected: no price. |
| `depth` | book, no LTP | — | **Rejected by the probe.** Never selected: no price. |
| `quote` / `full` (if entitled) | LTP + OI + volume + best bid/ask | 1–8 | The specification as written runs in full. |

The boot log states which row applies, in one line, with the fields it will and will not
have. `/health` repeats it. A column the broker never sends is labelled unavailable once,
at the top, rather than as a table full of dashes an operator has to interpret.

## 29.3 The rule that must never be broken

An absent field is `null`. Not `0`. Not `-1`. Not "assume liquid". `Number(null) === 0`,
and a chain where every strike reports zero open interest reads as "nobody holds these",
which is a lie a filter will act on. §3.9, §8.4 and §9.2.1 are three views of this one
rule, and the unit test in §25.1 is its executable form.

---

# 30. Rate-Limit Budget `[KOTAK]`

Kotak's limit is **per account**, not per process or per connection. `NEO_RPS = 8` is
the token-bucket refill rate; every broker call takes a token before it goes, and a
pre-send refusal is a `RateLimitedError` — safe to retry, because nothing left.

## 30.1 Steady-state allocation

| Consumer | Cadence | Requests/s |
|---|---|---|
| Index quote (`nse_cm\|Nifty 50`) | 1000 ms | 1.0 |
| Option chain, ±20 strikes = 82 instruments @ batch 25 | every 5000 ms, 4 requests | 0.8 |
| Held / candidate option sampling (folded into the chain batch where possible) | 1000 ms | 0.0–1.0 |
| Order book poll while an order is working | 750 ms, only when working | 0.0–1.3 |
| **Engine subtotal** | | **~1.8–4.1** |
| Read-only terminal, if a browser has it open | 1000 ms | +1.0–2.0 |
| **Headroom reserved for order placement and cancels** | | **≥ 3.0** |

## 30.2 Rules

1. **The order path is never starved.** If the bucket cannot serve a placement the cycle
   produces no trade and says so; it never queues behind a chain refresh.
2. `scanRange` is the primary lever. Raising it from ±20 to ±50 takes the chain from 4
   requests to 9 per refresh and eats the headroom. The settings validator MUST reject a
   `scanRange` whose implied steady-state exceeds half of `NEO_RPS`.
3. The read-only terminal and the engine **add**, they do not share. Running the
   terminal during a live session is an operational choice with a rate cost; §26.1's
   recommendation of a separate UCC for staging exists for the same reason.
4. `engine_rate_bucket_available` is monitored; sustained starvation is a warning alert
   and a signal to reduce `scanRange`, not to raise `NEO_RPS` beyond what Kotak grants.

---

# 31. Session Lifecycle and the Daily Login `[KOTAK]`

## 31.1 The two-step login

```
1. tradeApiLogin(mobile, ucc, totp)  -> viewToken + viewSid   (short-lived)
2. tradeApiValidate(mpin)            -> sessionToken + sid + per-user baseUrl
```

**MPIN and TOTP are never persisted.** They are the second factor; storing them would
defeat the point of having one. The view token from step 1 stays in process memory and
never travels to a browser and back; it expires after 5 minutes, after which the flow
must restart with a fresh TOTP.

## 31.2 Who logs in, and when

The TOTP makes this interactive. An operator performs the login on the Broker page
before the session — proposed by **09:00 IST** (`[MUST-CONFIRM #14]`). Until then the
engine sits in `IDLE` with `brokerSession: DISCONNECTED`, scans nothing, and places
nothing.

Alerting MUST fire if `engine_broker_session_active == 0` at 09:10 on a trading day.
This is the single point at which a trading day can silently fail to begin, and the
failure mode is indistinguishable from a quiet market unless something watches for it.

## 31.3 Storage

`sessionToken` and `sid` are encrypted at rest with AES-256-GCM under `TOKEN_ENC_KEY`
and stored in `broker_account`. A rotated key must not take the engine down — an
undecryptable stored session logs a warning and asks for a fresh login rather than
crashing. The session cannot outlive the trading day; there is no refresh token and no
silent renewal.

## 31.4 Expiry — the latch

On a dead session **every** poll, order and quote fails with a 401 simultaneously.
Writing `EXPIRED` on each one buries the first and only informative failure under a
hundred identical rows. So:

- `markExpired` is **latched**: the DB write, the `error` log and the `expired` event
  happen exactly once. Subsequent 401s update in-memory state silently.
- Every broker call funnels its 401 through the same latch, so the row is written by
  whoever noticed first.

Engine response:

| State | Response |
|---|---|
| Flat | → `IDLE`. Scanning stops. Operator re-logs in; `RECONCILING` runs again before trading resumes. |
| **In position** | `HALT(SESSION_EXPIRED)` + **critical page**. The engine cannot exit without a session. The position is held under operator supervision and squared off from the Kotak terminal if the login cannot be restored. `[MUST-CONFIRM #15]` |

The second row is the one honest limit of this design: there is no engine-side mitigation
for "the broker stopped accepting us while we were short". The mitigations are
operational — an operator present during the session, the alert in §21.5, and the
terminal as the manual exit path.

---

# 32. Kotak Failure Catalogue `[KOTAK]`

Observed behaviours that look like something they are not. Each has cost debugging time
and each has a test.

## 32.1 The index quotes empty, not missing

`nse_cm|26000` returns HTTP 200 and `[]`. Every layer above reports "no price" and none
is wrong. **Quote the index by name** (§7.10). Symptom: spot, ATM, the whole trend
series and every entry disappear at once, with no error anywhere.

## 32.2 The 503 that is really a 404

An unrecognised quote filter is an unroutable path, and Kotak answers with an HTML page
carrying `HTTP 503 — No available server to handle this request`. It reads as an
outage. It means "that filter does not exist for you". The probe's baseline-first order
(§29.1) exists to keep these off the critical path, and the error describer reduces the
page to its one meaningful sentence rather than dumping markup into a status field.

## 32.3 The socket that subscribes and says nothing

The HSM gateway accepts subscriptions and streams nothing on many accounts — no error,
no close. Any design that waits for the socket to fail waits forever. The REST sampler
always runs (§7.1).

## 32.4 Whitespace in the API token

`NEO_API_TOKEN` goes raw into an `Authorization` header. An embedded newline from a
copy-paste makes the gateway reject every request with an opaque error. Config strips
whitespace aggressively — deliberately, not defensively.

## 32.5 Nested quote payloads

`ohlc` and `depth` filters nest their data (`row.ohlc.open`, `row.depth.buy[0].price`)
instead of flattening it. Read flat-only, an `ohlc` row looks empty — which is how a
filter that works gets classified as one that does not.

## 32.6 The book that hides a partial fill

A `WORKING` row with `fldQty > 0` is a partial fill the status did not mention.
Normalised in one place (§28.6).

## 32.7 Two orders that look identical

Same symbol, side and quantity are indistinguishable in Kotak's book. The engine refuses
to guess and halts (§12.3.2, §20.6 case d). This is the direct cost of having no client
order id, and it is priced in rather than papered over.

---

## Revision History

| Version | Date | Change | Author |
|---|---|---|---|
| 2.0 | — | Initial technical design | — |
| 3.0 | 2026-08-01 | Expanded to production specification: precise numeric rules; integer-paise arithmetic; candle sealing and gap semantics; idempotent order protocol; startup reconciliation; MySQL schema; error taxonomy; state transition table; performance budget; determinism gate; production operations. 10 `[MUST-CONFIRM]` items raised. | — |
| 4.0 | 2026-08-01 | **Bound to Kotak Neo as the sole broker.** Resolved `[MUST-CONFIRM #10]` and rewrote every rule that depended on an idealised broker: §7 replaced the assumed tick feed with the REST sampler and introduced sample/tradable semantics; §8.4 and §9.2 separated "field is wrong" from "field was never sent" and added `liquidityMode`; §12.3 replaced the non-existent `clientOrderId` with the `client_ref` + claim + DB-truth protocol and the three-outcome classification; §16.4 added the sampled-stop guard; §19 aligned to the shipped `ose_*` schema; §20.6 added ambiguous-position handling; §28–§32 added the adapter contract, entitlement matrix, rate budget, session lifecycle and failure catalogue. Five new `[MUST-CONFIRM]` items (#11–#15). Section numbering §1–§27 preserved so existing code cross-references remain valid. No new business features. | — |
| 4.1 | 2026-08-01 | Gap closure, no rule changes to any shipped module. Specified four areas v3.0 and v4.0 left silent: §12.6 margin policy (absorb the rejection; one boot-time check; `HALT(MARGIN_EXHAUSTED)` on two consecutive), §12.7 PAPER fill semantics and the three things paper cannot evidence, §17.3.1 the charges arithmetic that feeds the net-P&L circuit breaker, §19.4 the `ose_decisions` migration the §19.1 schema requires. Corrected §21.1 to name Winston rather than v3.0's `pino`, restored §21.4's Prometheus/`/metrics` exposition and §24.2's Dependency-Inversion rule with the no-second-implementation carve-out. Two new `[MUST-CONFIRM]` items (#16–#17). | — |
| 4.1a | 2026-08-01 | Implementation landed: `src/ose/engine.js` (§4.2 cycle, §13 management, §16.4 timer, §20.6 boot), `src/ose/snapshot.js` (§8.3), `src/oseEngine.js` (composition root, shared `zoption-engine` leader lock), the `ose_decisions` migration of §19.4, the `MUST_CONFIRM` register synced to 17, and `exits.onTimer` extended with the §16.4 stop guard. §27.1 records the deliberate withdrawal of the web-UI exclusion. 47 OSE tests added; 452 pass repo-wide. Still outstanding before LIVE: metrics/`/metrics`, `ose-reset-halt.js`, `ose-replay.js`, the determinism golden hash, the 20-day replay regression, 10 paper sessions, and all 17 sign-offs. | — |

**Sign-off required before LIVE enablement** (all 17 `[MUST-CONFIRM]` ids present in
`settings.ose.confirmed`):

| Role | Name | Date | Signature |
|---|---|---|---|
| Technical Lead | | | |
| Trading Desk | | | |
| Risk | | | |
| DevOps | | | |
