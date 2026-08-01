# NIFTY Option Selling Engine — Technical Design Document

**Version:** 3.0 (Production Specification)
**Supersedes:** v2.0
**Status:** Approved for Production Development
**Audience:** Technical Lead, Senior Backend Engineers, QA, DevOps, Risk

**Scope note:** This document expands v2.0 to production-implementation depth. No new business features have been introduced. Every rule here either (a) restates v2.0, (b) makes a v2.0 rule numerically precise, or (c) is marked `[MUST-CONFIRM]` where v2.0 was silent and production cannot proceed without a decision. Section 22 lists all `[MUST-CONFIRM]` items in one place.

**Disclaimer:** This is a software design document. It specifies deterministic system behaviour only. It is not trading advice and makes no claim about profitability. Capital deployment requires independent validation by the trading desk and compliance with exchange and broker regulations.

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

---

# 1. Purpose and Scope

## 1.1 Purpose

Build a fully automated intraday NIFTY option-selling engine that selects contracts, validates entries, manages open positions and exits trades with zero manual intervention, using NIFTY 5-second candles as the sole decision source.

## 1.2 In Scope

- NIFTY index only
- 5-second candle timeframe only
- Option selling only (short CE, short PE)
- Single active position at a time
- Intraday only — no overnight carry
- Single broker, single account

## 1.3 Explicitly Out of Scope

BANKNIFTY, multi-index, multi-broker, web dashboard, analytics UI, notifications, ML parameter tuning, HA clustering. These remain future enhancements and **must not** appear in the v3.0 codebase, not even as stubs, feature flags or dead branches. Any pull request introducing them is rejected at review.

---

# 2. Definitions and Notation

| Term | Definition |
|---|---|
| **Tick** | Minimum price increment. NIFTY options: `0.05`. All prices sent to the broker MUST be exact multiples of the tick. |
| **Point** | One unit of option premium (₹1.00 per unit of the contract). All targets and stops in this document are in premium points, not index points. |
| **Candle** | A 5-second OHLC bucket. `ts` = bucket open time, epoch milliseconds, IST-aligned. |
| **Completed candle** | A candle that has been *sealed* per §7.3. Only completed candles may be read by any decision module. |
| **Decision cycle** | The processing triggered by exactly one newly sealed NIFTY candle. |
| **Reference price** | The `close` of the latest completed NIFTY candle. The engine has no other notion of "current price". |
| **Position premium** | The `close` of the latest completed *option* candle for the held contract. |
| **Short P&L** | `pnl_points = entry_price − position_premium`. Positive = profit (premium decayed). |
| **MUST / MUST NOT / SHOULD** | RFC 2119 interpretation. `MUST` items are testable acceptance criteria. |

**Rounding rule (normative).** Two helpers exist and only these two:

```
floorToTick(p)  = Math.floor(round(p / TICK, 8)) * TICK
ceilToTick(p)   = Math.ceil (round(p / TICK, 8)) * TICK
```

All monetary values are handled as **integer paise** (`price_paise = round(price * 100)`) inside the engine. Floating-point arithmetic on prices is forbidden. Conversion to rupees happens only at the logging and broker-adapter boundary.

---

# 3. Design Principles (Normative)

These are acceptance criteria, not aspirations.

1. **Determinism.** Given an identical ordered sequence of completed candles and option-chain snapshots, the engine MUST produce a byte-identical sequence of decisions. Verified by the determinism test in §25.4.
2. **Completed data only.** No module may read an unsealed candle, a live LTP, a live bid or a live ask for any *decision*. Live quotes may be used only for (a) broker order routing mechanics and (b) reconciliation.
3. **Single active trade.** The engine MUST reject any entry attempt while `activeTrade !== null`. Enforced by a single guard in the Risk Engine, not by scattered checks.
4. **Event-driven, single-threaded.** One Node.js event loop. No `child_process`, no worker threads, no `Atomics`. State is confined to one thread by construction, which is how "thread-safe state updates" (v2.0 §10) is satisfied.
5. **No discretionary logic.** No branch may depend on wall-clock time except the session windows in §17.4, on randomness, on `Math.random()`, on map/object iteration order, or on any unstable sort.
6. **Stateless between candles except trade state.** The only mutable state surviving a decision cycle is: `EngineState`, `ActiveTrade`, `RiskCounters`, and the bounded candle ring buffers. Everything else MUST be recomputed.
7. **Module independence.** Modules communicate only through the interfaces in §6. No module imports another module's internals. Enforced by lint rule (§24.3).
8. **Fail closed.** Any unhandled condition results in *no trade* or *exit*, never in an unprotected position.

---

# 4. Runtime Architecture

## 4.1 Data Flow

```
                    ┌──────────────────┐
                    │  Broker Feed     │  (WebSocket)
                    └────────┬─────────┘
                             │ ticks
                             ▼
                    ┌──────────────────┐
                    │ Market Data      │  seals 5s candles
                    └────────┬─────────┘
                             │ CandleSealed(NIFTY)
                             ▼
                    ┌──────────────────┐
                    │ Decision Cycle   │  orchestrator (§4.2)
                    └────────┬─────────┘
             ┌───────────────┼───────────────┐
             ▼               ▼               ▼
     ┌──────────────┐ ┌────────────┐ ┌──────────────┐
     │ Option Chain │ │ Trend      │ │ Position     │
     │              │ │ Engine     │ │ Manager      │
     └──────┬───────┘ └─────┬──────┘ └──────┬───────┘
            ▼               ▼               ▼
     ┌──────────────┐ ┌────────────┐ ┌──────────────┐
     │ Strike       │ │ Entry      │ │ Target /     │
     │ Selection    │ │ Validator  │ │ Trail / Exit │
     └──────┬───────┘ └─────┬──────┘ └──────┬───────┘
            └───────┬───────┘               │
                    ▼                       ▼
             ┌─────────────┐         ┌─────────────┐
             │ Risk Engine │◄────────┤ Exit Engine │
             └──────┬──────┘         └──────┬──────┘
                    ▼                       ▼
             ┌────────────────────────────────────┐
             │        Order Manager               │
             └────────────────┬───────────────────┘
                              ▼
                    ┌──────────────────┐
                    │ Broker Adapter   │  (REST + WS)
                    └──────────────────┘
```

## 4.2 Decision Cycle Orchestrator

Exactly one entry point. Pseudocode is normative:

```js
async function onNiftyCandleSealed(candle) {
  const t0 = hrtimeMs();
  const ctx = { cycleId: uuidv7(), candle, ts: candle.ts };

  try {
    if (!risk.isSessionOpen(candle.ts))      return finish(ctx, 'SESSION_CLOSED');
    if (risk.isHalted())                      return finish(ctx, 'HALTED');

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

**Reentrancy.** `onNiftyCandleSealed` MUST NOT overlap with itself. A cycle-in-progress flag drops any candle sealed while a cycle runs; the dropped candle is logged as `CYCLE_OVERRUN` and counted. More than `3` overruns in a rolling 60s window triggers `HALTED` (§17.6).

## 4.3 Process Topology

Single Node.js process. No horizontal scaling — the single-active-trade invariant cannot be safely distributed. High availability is explicitly out of scope (§27).

---

# 5. Configuration Contract

## 5.1 Tunable Configuration

These are the **only** values an operator may change. They live in `config/strategy.json`, are loaded once at boot, validated against a JSON Schema, and frozen (`Object.freeze`, deep).

| Key | Value | Unit | Validation |
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

## 5.2 Non-Tunable Constants

Business logic constants live in `src/constants.js`, are compiled in, and changing them is a code change requiring review and a full regression run. They are **not** in any config file and **not** environment variables.

```js
export const TICK               = 5;        // paise
export const TREND_LOOKBACK     = 3;        // completed candles
export const CANDLE_MS          = 5000;
export const MAX_CANDLE_HISTORY = 720;      // 1 hour ring buffer
```

Liquidity thresholds (§9.2) and session times (§17.4) are also non-tunable constants but are `[MUST-CONFIRM]` — see §22.

## 5.3 Environment Configuration

Infrastructure-only, never business logic. Supplied via environment variables, validated at boot, process exits non-zero if invalid.

```
NODE_ENV                 = development | testing | staging | production
BROKER_API_KEY           = <secret>
BROKER_API_SECRET        = <secret>
BROKER_REST_BASE_URL     = https://...
BROKER_WS_URL            = wss://...
MYSQL_HOST / PORT / USER / PASSWORD / DATABASE
LOG_LEVEL                = debug | info | warn | error
TRADING_MODE             = PAPER | LIVE
KILL_SWITCH_FILE         = /var/run/nifty-engine/HALT
```

`TRADING_MODE=LIVE` in `NODE_ENV != production` MUST cause the process to refuse to start.

---

# 6. Domain Model and Interfaces

Types are given in TypeScript syntax for precision. If the implementation is plain JavaScript, these MUST be mirrored as JSDoc typedefs and checked with `tsc --checkJs`.

## 6.1 Core Types

```ts
type Paise = number;          // integer
type CandleTs = number;       // epoch ms, multiple of 5000

interface Candle {
  readonly symbol: string;
  readonly ts: CandleTs;      // bucket open
  readonly open:  Paise;
  readonly high:  Paise;
  readonly low:   Paise;
  readonly close: Paise;
  readonly volume: number;
  readonly tickCount: number; // ticks aggregated; 0 => synthetic (§7.5)
  readonly synthetic: boolean;
}

type Trend = 'BULLISH' | 'BEARISH';
type OptionType = 'CE' | 'PE';

interface OptionQuote {
  readonly symbol: string;       // broker tradingsymbol
  readonly strike: number;
  readonly optionType: OptionType;
  readonly expiry: string;       // YYYY-MM-DD
  readonly ltp: Paise;
  readonly bid: Paise;
  readonly ask: Paise;
  readonly bidQty: number;
  readonly askQty: number;
  readonly oi: number;
  readonly volume: number;
  readonly snapshotTs: number;   // epoch ms of chain fetch
}

interface StrikeCandidate {
  readonly quote: OptionQuote;
  readonly score: number;        // 0..1, 6-dp rounded
  readonly components: {
    oiNorm: number; volNorm: number; depthNorm: number; spreadNorm: number;
  };
}

interface ActiveTrade {
  readonly tradeId: string;          // uuidv7
  readonly symbol: string;
  readonly optionType: OptionType;
  readonly strike: number;
  readonly side: 'SELL';
  readonly qty: number;              // lots * lotSize
  readonly entryPrice: Paise;        // actual fill VWAP
  readonly requestedPrice: Paise;
  readonly entryTs: number;
  readonly entryCandleTs: CandleTs;
  readonly entryTrend: Trend;
  targetLevel: number;               // 1,2,3,... mutable
  targetPrice: Paise;                // mutable
  stopPrice: Paise;                  // mutable, monotone non-increasing
  candlesHeld: number;               // mutable
  mfePoints: number;                 // max favourable excursion, mutable
}
```

## 6.2 Module Interfaces

```ts
interface IMarketData {
  onCandleSealed(cb: (c: Candle) => Promise<void>): void;
  lastN(symbol: string, n: number): readonly Candle[];   // newest last
  latest(symbol: string): Candle | null;
  subscribeOption(symbol: string): Promise<void>;
  unsubscribeOption(symbol: string): Promise<void>;
}

interface IOptionChain {
  snapshot(ts: number): Promise<readonly OptionQuote[]>;  // cached, §8.3
}

interface IStrikeSelector {
  select(quotes: readonly OptionQuote[], type: OptionType): StrikeCandidate | null;
}

interface ITrendEngine {
  evaluate(candles: readonly Candle[]): Trend | null;     // null = tie, §10.3
}

interface IEntryValidator {
  validate(candle: Candle, trend: Trend): EntryDecision;
}

interface IOrderManager {
  placeEntry(req: EntryRequest): Promise<OrderResult>;
  placeExit(trade: ActiveTrade, reason: ExitReason): Promise<OrderResult>;
  reconcile(): Promise<ReconcileReport>;
}

interface IRiskEngine {
  isSessionOpen(ts: number): boolean;
  isHalted(): boolean;
  canOpenTrade(ts: number): RiskVerdict;
  onTradeClosed(trade: ClosedTrade): void;
  halt(reason: string): void;
}
```

All modules are constructed with explicit dependency injection in `src/bootstrap.js`. No module performs `require()` of another module at call time, and no singletons/global state exist outside the composition root.

---

# 7. Market Data Module

## 7.1 Responsibilities

Subscribe to the NIFTY index feed and to the option symbol of the active position; aggregate raw ticks into 5-second candles; seal candles; expose immutable history.

## 7.2 Bucketing

```
bucketTs(tickTs) = Math.floor(tickTs / 5000) * 5000
```

Tick timestamps come from the **exchange/broker feed**, never from local wall clock. Local clock is used only for the seal timer and for detecting feed staleness.

## 7.3 Sealing Rule (Normative)

A bucket `B` is sealed at the **earlier** of:

1. Arrival of the first tick with `bucketTs > B`, or
2. Expiry of a timer set to `B + CANDLE_MS + SEAL_GRACE_MS`, where `SEAL_GRACE_MS = 400`.

Once sealed, `B` is frozen (`Object.freeze`) and emitted exactly once. Any tick arriving for a sealed bucket is a **late tick**: it is discarded, counted in `metrics.lateTicks`, and logged at `warn`. It MUST NOT mutate the sealed candle and MUST NOT re-trigger a cycle.

## 7.4 Duplicate Candles

Candle identity is `(symbol, ts)`. The module maintains `lastSealedTs` per symbol. Any sealed candle with `ts <= lastSealedTs` is dropped with reason `DUPLICATE_CANDLE`. This makes the pipeline idempotent under feed replay.

## 7.5 Missing Candles

If a bucket receives zero ticks, no real candle exists. Behaviour:

- **Gap of 1 candle:** emit a synthetic candle where `open = high = low = close = previous.close`, `volume = 0`, `tickCount = 0`, `synthetic = true`. This preserves the "one candle = one decision cycle" invariant.
- **Gap of 2 or more candles:** do **not** synthesise. Emit `FEED_GAP`. The engine transitions per §20.3: if flat → `SCANNING` is suspended until `TREND_LOOKBACK` real candles have accumulated; if in position → immediate exit (`EXIT_FEED_GAP`).

Synthetic candles are usable by the Trend Engine and Entry Validator (a doji at the previous close will naturally fail both entry conditions, since `close == bullishMid == bearishMid` requires strict inequality). They are flagged in all logs.

## 7.6 History

Ring buffer of `MAX_CANDLE_HISTORY = 720` candles per subscribed symbol. Fixed allocation at boot — no growth, satisfying the "memory stable" requirement. `lastN()` returns a frozen array view; callers MUST NOT mutate.

## 7.7 Option Candles

The engine subscribes to option-level ticks only for:
- the single selected candidate awaiting entry, and
- the currently held contract.

Option candles are sealed by the same rules. **Entry price (§12) and all position P&L (§13) are computed from sealed option candle closes, never from LTP/bid/ask.** If the option feed produces a gap of 2+ candles while a position is open, the Exit Engine fires `EXIT_OPTION_FEED_GAP` immediately.

---

# 8. Option Chain Module

## 8.1 Responsibilities

Fetch, parse and normalise the current-expiry NIFTY option chain into `OptionQuote[]`.

## 8.2 Expiry Selection

Nearest expiry with `expiryDate >= today`. On expiry day, the same-day expiry is used until session close. `[MUST-CONFIRM #7]` — whether trading is permitted on expiry day at all (premium behaviour differs materially).

## 8.3 Caching

The chain is fetched at most once per `CHAIN_REFRESH_MS = 5000` and cached. A decision cycle calls `snapshot(ts)`; if the cached snapshot's age `<= 5000ms` it is returned, otherwise a fetch is triggered. The fetch is **non-blocking with respect to the cycle**: if no fresh snapshot is available within `CHAIN_TIMEOUT_MS = 800`, the cycle returns `NO_ENTRY(CHAIN_STALE)`. The engine never waits on the network inside a decision cycle beyond this bound.

An in-flight fetch is deduplicated — concurrent callers share the same promise.

## 8.4 Validation

A quote is discarded if any of these hold:

```
ltp <= 0
bid <= 0 || ask <= 0
ask < bid
oi < 0 || volume < 0
expiry missing or unparseable
strike not a multiple of 50
snapshot age > 5000 ms
```

If more than `40%` of quotes are discarded, the whole snapshot is rejected as `CHAIN_CORRUPT` and the cycle produces no entry.

---

# 9. Strike Selection Module

## 9.1 Inputs and Outputs

Input: validated `OptionQuote[]`, and a requested `OptionType`. Output: the single highest-ranked `StrikeCandidate`, or `null`.

Selection is computed **independently for CE and PE**. The Trend Engine determines which side is requested (§11.4). This ordering matches the v2.0 architecture diagram (Strike Selection precedes Trend Engine in the pipeline) while ensuring only the tradeable side is acted upon.

## 9.2 Hard Filters (applied in this order, all must pass)

| # | Filter | Rule |
|---|---|---|
| 1 | Type | `quote.optionType === requestedType` |
| 2 | Premium | `premiumMin <= ltp <= premiumMax` (₹15–₹25, inclusive) |
| 3 | Open Interest | `oi >= MIN_OI` |
| 4 | Volume | `volume >= MIN_VOLUME` |
| 5 | Bid depth | `bidQty >= MIN_BID_QTY` |
| 6 | Ask depth | `askQty >= MIN_ASK_QTY` |
| 7 | Absolute spread | `(ask − bid) <= MAX_SPREAD_ABS` |
| 8 | Relative spread | `(ask − bid) / ((ask + bid) / 2) <= MAX_SPREAD_PCT` |

Proposed constants — `[MUST-CONFIRM #1]`:

```js
MIN_OI          = 500_000;   // contracts
MIN_VOLUME      = 100_000;   // contracts, cumulative for the day
MIN_BID_QTY     = 5 * LOT;
MIN_ASK_QTY     = 5 * LOT;
MAX_SPREAD_ABS  = 50;        // paise = ₹0.50
MAX_SPREAD_PCT  = 0.03;      // 3%
```

If zero candidates survive, return `null` → `NO_ENTRY(NO_LIQUID_STRIKE)`.

## 9.3 Ranking

Min-max normalisation across the **surviving** candidate set. If the set has a single member, all norms are `1.0` (except spread, `0.0`).

```
oiNorm     = (oi     − minOI)  / (maxOI  − minOI)          // 0 if maxOI  == minOI
volNorm    = (vol    − minVol) / (maxVol − minVol)
depth      = min(bidQty, askQty)
depthNorm  = (depth  − minDepth) / (maxDepth − minDepth)
spreadNorm = (spread − minSpread) / (maxSpread − minSpread)

score = 0.40*oiNorm + 0.30*volNorm + 0.20*depthNorm + 0.10*(1 − spreadNorm)
score = round(score, 6)
```

## 9.4 Deterministic Tie-Break

Sorting MUST be total and stable. Comparator, applied in order until non-zero:

1. `score` descending
2. `oi` descending
3. `volume` descending
4. `spread` ascending
5. `strike` ascending
6. `symbol` ascending (lexicographic, `String.prototype.localeCompare` with `'en'` locale and `{ numeric: false }`)

Step 6 guarantees a unique winner for identical inputs. Never rely on `Array.prototype.sort` stability alone.

---

# 10. Trend Engine

## 10.1 Input

The latest `TREND_LOOKBACK = 3` completed NIFTY candles: `C1` (oldest), `C2`, `C3` (latest). If fewer than 3 exist, return `null`.

## 10.2 Classification Rule (Normative)

v2.0 mandates a binary Bullish/Bearish output with no sideways state. The deterministic rule:

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

## 10.3 Perfect-Tie Handling

`null` is **not** a "sideways" classification — it means trend is *undetermined for this cycle*. The engine treats it as `NO_ENTRY(TREND_UNDETERMINED)` and takes no action. It does **not** carry forward a previous trend, because carry-forward would make the engine's output depend on history beyond the 3-candle window, violating §3.6.

For an open position, `null` from the Trend Engine counts as **trend break** and triggers exit (§16.2). Fail-closed.

## 10.4 Purity

`ITrendEngine.evaluate` is a pure function: no I/O, no clock access, no instance state. This makes it trivially unit-testable and is the single largest contributor to reproducibility.

---

# 11. Entry Validation Engine

## 11.1 Input

The latest completed NIFTY candle `C` and the trend from §10.

## 11.2 Midpoints

```
bullishMid = (C.open + C.high) / 2      // integer paise, floor
bearishMid = (C.open + C.low)  / 2      // integer paise, floor
```

Division uses `Math.floor` on integer paise. Both midpoints are computed from the *same* candle whose close is the reference price.

## 11.3 Conditions

```
SELL PE  requires  C.close >  bullishMid
SELL CE  requires  C.close <  bearishMid
```

Strict inequality. Note these are mutually exclusive by construction (a close cannot simultaneously exceed `(O+H)/2` and fall below `(O+L)/2` unless `O == H == L`, in which case both fail). Therefore no conflict-resolution rule is needed, and a test MUST assert this property (§25.2).

## 11.4 Confluence with Trend

Both the trend and the midpoint condition must agree:

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
}
```

Every rejection is logged with the full decision object. Silent rejections are forbidden — the audit trail must explain every non-trade.

---

# 12. Order Management Module

## 12.1 Entry Price Derivation

```
optionClose  = latest sealed option candle close for the selected symbol
rawPrice     = optionClose + entryOffset          // + ₹0.10, = +10 paise
entryPrice   = floorToTick(rawPrice)
```

`floorToTick` (not round-half-up) is used so a SELL limit is never placed *above* the derived level, which would silently reduce fill probability beyond spec. With `TICK = 5` paise and `offset = 10` paise, `rawPrice` is already tick-aligned whenever `optionClose` is; the floor is defensive.

If no sealed option candle exists for the candidate (subscription just started), the cycle returns `NO_ENTRY(NO_OPTION_CANDLE)`. **The engine MUST NOT substitute LTP.** This is the most commonly violated rule in implementations of this spec and MUST have a dedicated test.

## 12.2 Order Parameters

```
side          = SELL
orderType     = LIMIT
price         = entryPrice
quantity      = LOT_SIZE * LOTS          // [MUST-CONFIRM #2]
product       = MIS (intraday)
validity      = DAY
tag           = tradeId (first 20 chars)
clientOrderId = tradeId                  // idempotency key
```

## 12.3 Idempotency

Every order carries `clientOrderId = tradeId`. On any ambiguous failure (timeout, 5xx, socket reset), the Order Manager MUST NOT blindly retry. It MUST:

1. Wait `ORDER_SETTLE_MS = 500`
2. Query the broker order book filtered by `clientOrderId`
3. If found → adopt that order's state
4. If not found → retry **once** with the same `clientOrderId`
5. If still ambiguous → `HALT(ORDER_AMBIGUOUS)` and page the operator

## 12.4 Fill Handling

| Outcome | Handling |
|---|---|
| **Full fill** | `entryPrice` set to fill VWAP. → `POSITION_OPEN` |
| **Partial fill**, order still open at `ENTRY_FILL_TIMEOUT_MS = 3000` | Cancel remainder. Position = filled qty. → `POSITION_OPEN`. Log `PARTIAL_FILL`. |
| **Partial fill**, cancel fails | `HALT(CANCEL_FAILED)`, attempt market exit of filled qty |
| **No fill** at `ENTRY_FILL_TIMEOUT_MS` | Cancel. → `COOLDOWN`. Not counted as a trade in `maxTradesPerDay`, not counted as a loss. |
| **Rejected** | Log broker reason. → `COOLDOWN`. Three consecutive rejections → `HALT(REPEATED_REJECTION)`. |

`ActiveTrade.entryPrice` is always the **actual fill VWAP**, never the requested price. All targets and stops derive from it. `requestedPrice` is retained for slippage analysis.

## 12.5 Exit Orders

Exits are **MARKET** orders. Rationale: a limit exit can go unfilled, which breaks the guarantee that a stop-loss actually stops loss. This is a deliberate asymmetry with entries and is normative.

Exit orders carry `clientOrderId = tradeId + '-X'`. If an exit order is rejected or unfilled after `EXIT_FILL_TIMEOUT_MS = 2000`, the Order Manager retries as MARKET up to `3` times, then `HALT(EXIT_FAILED)` with a critical page. An unhedged unclosable short is the highest-severity incident this system can produce.

---

# 13. Position Manager

## 13.1 Trigger

Runs on every sealed NIFTY candle while a position is open. Also runs on every sealed **option** candle for the held symbol, for stop/target evaluation only (§13.4).

## 13.2 Per-Cycle Recomputation

```
trend      = trendEngine.evaluate(marketData.lastN('NIFTY', 3))
bullishMid = (C.open + C.high) / 2
bearishMid = (C.open + C.low)  / 2
premium    = latest sealed option candle close for trade.symbol
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

Failure of either condition → `POSITION_INVALID` → Exit Engine with reason `EXIT_FILTER_FAIL` or `EXIT_TREND_BREAK`.

**Design note:** this is a strict, unforgiving filter. Because midpoint break is evaluated fresh each candle against a *new* candle's own midpoints, an ordinary consolidation candle will invalidate the position. This is intentional per v2.0 ("Position Filter fails → exit immediately") and is the dominant driver of the strategy's short holding period. Flagged for desk awareness, not for change.

## 13.4 Evaluation Order

Within a cycle, checks run in this fixed order and the **first** match wins:

1. Hard stop / trailing stop hit (§15)
2. Premium safety exit (§16.2.4)
3. Liquidity deterioration (§16.2.5)
4. Maximum holding time (§16.2.6)
5. Position validity filter (§13.3)
6. Target reached → extend (§14)

Stops are evaluated before targets so that a candle which touches both resolves conservatively (loss booked), matching the fail-closed principle. This ordering MUST be asserted by a unit test with a candle that spans both levels.

---

# 14. Dynamic Target Engine

## 14.1 Ladder

For a short position, profit accrues as premium falls.

```
level 1: targetPrice = entryPrice − 1 point
level 2: targetPrice = entryPrice − 2 points
level k: targetPrice = entryPrice − k points
```

`1 point = 100 paise`.

## 14.2 Extension Rule

On a sealed option candle where `premium <= trade.targetPrice`:

```
trade.targetLevel += targetExtensionPoints          // +1
trade.targetPrice  = trade.entryPrice − (trade.targetLevel * 100)
stopModule.onTargetAchieved(trade)                  // §15.2
```

The position is **not** closed on target achievement — the target is extended and the stop is tightened. Exit occurs only via the Exit Engine. This is the core of the "let winners run" behaviour in v2.0 §5.8.

## 14.3 Confirmation Semantics

"Each successful confirmation" (v2.0) is defined as: **a sealed option candle whose close is at or beyond the current target price.** Intra-candle wicks do not confirm. One candle may advance the ladder by at most one level, even if the close is 4 points beyond — this preserves the one-decision-per-candle invariant. `[MUST-CONFIRM #3]` if the desk instead wants immediate multi-level advancement.

## 14.4 Ladder Cap

The ladder is uncapped. Since the maximum theoretical profit on a short at entry `E` is `E` points (premium → 0), the ladder is naturally bounded by `floor(entryPrice / 100)`. At `entryPrice <= 100 paise` (₹1), the Exit Engine force-closes with `EXIT_PREMIUM_FLOOR` — below ₹1 the spread makes further holding uneconomic.

---

# 15. Trailing Stop Module

## 15.1 Initial Stop

```
trade.stopPrice = entryPrice + (initialStopPoints * 100)     // entry + 2 points
```

For a short, the stop is *above* entry (premium rising = loss).

## 15.2 Trailing Rule

When target level `k` is achieved (§14.2):

```
candidateStop = entryPrice − ((k − 1) * 100)
trade.stopPrice = min(trade.stopPrice, candidateStop)
```

Resulting progression:

| Target level achieved | New stop | Locked-in |
|---|---|---|
| — (entry) | `entry + 2` | −2 pts (max loss) |
| 1 | `entry + 0` | breakeven |
| 2 | `entry − 1` | +1 pt |
| 3 | `entry − 2` | +2 pts |
| k | `entry − (k−1)` | +(k−1) pts |

## 15.3 Monotonicity Invariant (Normative)

```
assert(newStop <= currentStop)      // for a SHORT, stop only moves DOWN
```

`min()` enforces this structurally. The assertion is retained in production code (not stripped in release builds) and a violation raises `HALT(STOP_INVARIANT_VIOLATION)`. This directly implements "Never increase stop loss" (v2.0 §5.9).

## 15.4 Trigger Evaluation

Stop is hit when a **sealed option candle** satisfies:

```
candle.high >= trade.stopPrice
```

`high`, not `close`, because a stop must respect intra-candle adverse movement. This is the single documented exception to "close-only" evaluation, and it exists because using `close` would systematically understate realised losses in backtests versus live. Targets, by contrast, use `close` (§14.3) — conservative in both directions.

`[MUST-CONFIRM #4]` — desk sign-off on the high/close asymmetry.

## 15.5 Disabled Mode

If `trailingStopEnabled === false`, `stopPrice` remains at `entry + initialStopPoints` for the life of the trade. Target extension still operates.

---

# 16. Exit Engine

## 16.1 Responsibility

Sole owner of position closure. No other module may call `placeExit`. The Exit Engine receives an `ExitReason` and executes a MARKET exit (§12.5).

## 16.2 Exit Conditions

| # | Reason | Trigger | Priority |
|---|---|---|---|
| 1 | `EXIT_STOP_HIT` | sealed option candle `high >= stopPrice` | 1 |
| 2 | `EXIT_PREMIUM_SAFETY` | `premium >= entryPrice + (premiumSafetyExitPoints * 100)` | 2 |
| 3 | `EXIT_LIQUIDITY` | held contract fails §9.2 filters 3–8 on the current chain snapshot | 3 |
| 4 | `EXIT_MAX_HOLD` | `candlesHeld >= MAX_HOLD_CANDLES` | 4 |
| 5 | `EXIT_FILTER_FAIL` | midpoint condition fails (§13.3) | 5 |
| 6 | `EXIT_TREND_BREAK` | trend flipped or `null` (§13.3) | 5 |
| 7 | `EXIT_PREMIUM_FLOOR` | `premium <= 100` paise | 1 |
| 8 | `EXIT_FEED_GAP` | NIFTY feed gap ≥ 2 candles | 0 |
| 9 | `EXIT_OPTION_FEED_GAP` | option feed gap ≥ 2 candles | 0 |
| 10 | `EXIT_SESSION_END` | `now >= SQUARE_OFF_TIME` | 0 |
| 11 | `EXIT_KILL_SWITCH` | kill-switch file present (§26.5) | 0 |
| 12 | `EXIT_RISK_HALT` | Risk Engine halts mid-position | 0 |

Priority 0 conditions are evaluated on a `1000 ms` timer independent of the candle cycle, because they must fire even if the candle feed has stopped.

### 16.2.4 Premium Safety Exit — clarification

v2.0 lists both `Initial Stop Loss = 2 points` and `Premium Safety Exit = 2 points`. These are numerically identical at entry, so condition 2 is redundant with condition 1 *until the stop trails below entry*. Its purpose thereafter is as an absolute backstop: it fires on a **2-point adverse move from entry regardless of trailing state**, protecting against a stop that failed to evaluate.

Because trailing only tightens (§15.3), condition 2 can only fire before the first target is achieved, at which point it coincides with condition 1. It is retained as defence-in-depth and is expected never to be the sole trigger in production. Any occurrence where it fires *without* condition 1 also firing indicates a stop-evaluation bug and MUST raise a `warn`-level alert.

`[MUST-CONFIRM #5]` — confirm this reading, or supply the intended distinct semantics.

## 16.3 Post-Exit Sequence

```
1. Await fill confirmation (or HALT per §12.5)
2. Compute realised P&L from fill VWAP
3. Persist ClosedTrade  (§19.2)
4. riskEngine.onTradeClosed(closedTrade)
5. marketData.unsubscribeOption(trade.symbol)
6. activeTrade = null
7. state.to('COOLDOWN')
8. cooldown.start(reentryWaitCandles)
```

Steps 1–7 MUST be atomic with respect to new candle cycles: the cycle-in-progress flag remains held throughout.

---

# 17. Risk Engine

## 17.1 Tracked Counters

```ts
interface RiskCounters {
  tradingDate: string;          // YYYY-MM-DD IST
  tradesToday: number;
  consecutiveLosses: number;
  openPositions: number;        // 0 or 1
  realisedPnlPoints: number;
  halted: boolean;
  haltReason: string | null;
}
```

Counters are persisted after every mutation (§19.3) and reloaded on boot. They reset at the first cycle whose IST date differs from `tradingDate` — never on a timer, so a restart mid-day does not reset limits.

## 17.2 Pre-Trade Gate

`canOpenTrade()` returns the **first** failing verdict:

```
1. halted                                  -> REJECT(HALTED)
2. !isSessionOpen(ts)                      -> REJECT(SESSION_CLOSED)
3. ts >= NO_NEW_ENTRY_TIME                 -> REJECT(ENTRY_WINDOW_CLOSED)
4. openPositions >= maxOpenTrades          -> REJECT(MAX_OPEN_TRADES)
5. tradesToday >= maxTradesPerDay          -> REJECT(MAX_TRADES_PER_DAY)
6. consecutiveLosses >= maxConsecutiveLosses -> REJECT(MAX_CONSECUTIVE_LOSSES) + halt()
7. cooldown active                         -> REJECT(COOLDOWN)
                                           -> ALLOW
```

## 17.3 Loss Definition

A closed trade is a **loss** when `realisedPnlPoints < 0`. Exactly zero is a scratch: it resets nothing and increments nothing except `tradesToday`. `[MUST-CONFIRM #6]` — whether brokerage/STT/slippage should be included in the loss determination. Recommendation: yes, use net P&L, since a gross-scratch trade is a net loss and the consecutive-loss circuit breaker should reflect economic reality.

## 17.4 Session Windows — `[MUST-CONFIRM #8]`

v2.0 does not specify session times. Production cannot run without them. Proposed constants (IST):

```js
MARKET_OPEN        = '09:15:00';
FIRST_ENTRY_TIME   = '09:20:00';   // skip opening 5 candles of noise
NO_NEW_ENTRY_TIME  = '15:10:00';
SQUARE_OFF_TIME    = '15:15:00';   // forced flat
MARKET_CLOSE       = '15:30:00';
```

`SQUARE_OFF_TIME` is enforced by the priority-0 timer, not the candle cycle.

## 17.5 Cooldown

After every closed trade, `COOLDOWN` lasts `reentryWaitCandles = 2` **sealed NIFTY candles** (10 seconds). Counting is by candle, not by clock, so a feed pause extends the cooldown rather than skipping it. Cancelled/unfilled entries also enter cooldown (§12.4) but do not consume `tradesToday`.

## 17.6 Halt

`halt(reason)` is terminal for the session:

```
1. If a position is open -> Exit Engine, reason EXIT_RISK_HALT
2. state.to('HALTED')
3. Cancel all open orders
4. Unsubscribe all option feeds
5. Persist counters with halted = true
6. Emit CRITICAL log + operator alert
7. Refuse all further entries until manual reset (§26.6)
```

`HALTED` is not auto-clearing. It requires an operator action and MUST NOT be cleared by a process restart.

## 17.7 Trading Calendar

The engine MUST NOT trade on exchange holidays. A holiday list is loaded from `config/holidays.json` and validated at boot; a missing or stale (past year-end) list causes refusal to start in `production`. Weekend detection is by IST day-of-week.

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
| `BOOTING` | config + DB + broker ready | — | `RECONCILING` |
| `RECONCILING` | reconcile clean, flat | — | `IDLE` |
| `RECONCILING` | reconcile found open position | position matches persisted trade | `POSITION_MANAGEMENT` |
| `RECONCILING` | reconcile found *unknown* position | — | `HALTED` |
| `RECONCILING` | reconcile failed | — | `HALTED` |
| `IDLE` | session open | `!halted` | `SCANNING` |
| `SCANNING` | candle sealed | entry validated + risk allows | `ENTRY_READY` |
| `SCANNING` | candle sealed | any rejection | `SCANNING` |
| `ENTRY_READY` | order placed | — | `ORDER_PENDING` |
| `ORDER_PENDING` | filled / partial | — | `POSITION_OPEN` |
| `ORDER_PENDING` | rejected / timeout / cancelled | — | `COOLDOWN` |
| `POSITION_OPEN` | first management cycle | — | `POSITION_MANAGEMENT` |
| `POSITION_MANAGEMENT` | any exit condition | — | `EXIT_PENDING` |
| `EXIT_PENDING` | exit filled | — | `COOLDOWN` |
| `EXIT_PENDING` | exit failed ×3 | — | `HALTED` |
| `COOLDOWN` | `reentryWaitCandles` elapsed | session open, `!halted` | `SCANNING` |
| `COOLDOWN` | session closed | — | `IDLE` |
| *any* | `halt()` | — | `HALTED` |
| `HALTED` | manual reset | operator action | `BOOTING` |

Any event/state pair not in this table is an `ILLEGAL_TRANSITION`: it is logged at `error`, ignored, and increments a counter. Three in a session → `HALTED`.

## 18.3 Transition Logging

Every transition emits:

```json
{
  "evt": "STATE_TRANSITION",
  "cycleId": "...", "tradeId": "...",
  "from": "SCANNING", "to": "ENTRY_READY",
  "trigger": "ENTRY_VALIDATED",
  "guardResults": { "risk": "ALLOW", "entry": "SELL_PE" },
  "ts": 1730000000000, "latencyMs": 12.4
}
```

## 18.4 Implementation

A single explicit transition table, not scattered `if` statements. `state.to(next, ctx)` validates against the table and throws on illegal transitions. The state object is the only place `currentState` is mutated.

---

# 19. Persistence Layer

MySQL 8.0. Purpose: audit trail, crash recovery and risk-counter durability — **not** hot-path decision data. No decision path performs a synchronous DB read. All writes are fire-and-forget with a bounded queue, except the three marked *synchronous* below, which must complete before the engine proceeds.

## 19.1 Schema

```sql
CREATE TABLE trades (
  trade_id            CHAR(36)     NOT NULL PRIMARY KEY,
  trading_date        DATE         NOT NULL,
  symbol              VARCHAR(64)  NOT NULL,
  option_type         ENUM('CE','PE') NOT NULL,
  strike              INT          NOT NULL,
  expiry              DATE         NOT NULL,
  qty                 INT          NOT NULL,
  entry_trend         ENUM('BULLISH','BEARISH') NOT NULL,
  requested_price     INT          NOT NULL,   -- paise
  entry_price         INT          NOT NULL,   -- paise, fill VWAP
  entry_ts            BIGINT       NOT NULL,
  entry_candle_ts     BIGINT       NOT NULL,
  exit_price          INT          NULL,
  exit_ts             BIGINT       NULL,
  exit_reason         VARCHAR(48)  NULL,
  candles_held        INT          NOT NULL DEFAULT 0,
  max_target_level    INT          NOT NULL DEFAULT 0,
  mfe_points          DECIMAL(8,2) NOT NULL DEFAULT 0,
  final_stop_price    INT          NULL,
  gross_pnl_paise     INT          NULL,
  charges_paise       INT          NULL,
  net_pnl_paise       INT          NULL,
  status              ENUM('OPEN','CLOSED','ERROR') NOT NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                     ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_date_status (trading_date, status),
  INDEX idx_status (status)
) ENGINE=InnoDB;

CREATE TABLE orders (
  order_id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  trade_id            CHAR(36)     NOT NULL,
  client_order_id     VARCHAR(64)  NOT NULL,
  broker_order_id     VARCHAR(64)  NULL,
  purpose             ENUM('ENTRY','EXIT') NOT NULL,
  side                ENUM('BUY','SELL') NOT NULL,
  order_type          ENUM('LIMIT','MARKET') NOT NULL,
  requested_price     INT          NULL,
  requested_qty       INT          NOT NULL,
  filled_qty          INT          NOT NULL DEFAULT 0,
  avg_fill_price      INT          NULL,
  status              VARCHAR(32)  NOT NULL,
  broker_message      VARCHAR(512) NULL,
  placed_ts           BIGINT       NOT NULL,
  settled_ts          BIGINT       NULL,
  UNIQUE KEY uq_client_order (client_order_id),
  INDEX idx_trade (trade_id),
  CONSTRAINT fk_orders_trade FOREIGN KEY (trade_id) REFERENCES trades(trade_id)
) ENGINE=InnoDB;

CREATE TABLE decisions (
  decision_id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  cycle_id            CHAR(36)     NOT NULL,
  trading_date        DATE         NOT NULL,
  candle_ts           BIGINT       NOT NULL,
  nifty_open          INT NOT NULL,
  nifty_high          INT NOT NULL,
  nifty_low           INT NOT NULL,
  nifty_close         INT NOT NULL,
  synthetic           TINYINT(1) NOT NULL DEFAULT 0,
  trend               ENUM('BULLISH','BEARISH','NONE') NOT NULL,
  bullish_mid         INT NOT NULL,
  bearish_mid         INT NOT NULL,
  outcome             VARCHAR(48) NOT NULL,   -- ENTRY_TAKEN / rejection reason
  selected_symbol     VARCHAR(64) NULL,
  selection_score     DECIMAL(9,6) NULL,
  latency_ms          DECIMAL(8,3) NOT NULL,
  INDEX idx_date_ts (trading_date, candle_ts)
) ENGINE=InnoDB;

CREATE TABLE state_transitions (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  cycle_id      CHAR(36) NULL,
  trade_id      CHAR(36) NULL,
  from_state    VARCHAR(32) NOT NULL,
  to_state      VARCHAR(32) NOT NULL,
  trigger_event VARCHAR(48) NOT NULL,
  reason        VARCHAR(256) NULL,
  ts            BIGINT NOT NULL,
  INDEX idx_ts (ts)
) ENGINE=InnoDB;

CREATE TABLE risk_state (
  trading_date        DATE         NOT NULL PRIMARY KEY,
  trades_today        INT          NOT NULL DEFAULT 0,
  consecutive_losses  INT          NOT NULL DEFAULT 0,
  realised_pnl_paise  INT          NOT NULL DEFAULT 0,
  halted              TINYINT(1)   NOT NULL DEFAULT 0,
  halt_reason         VARCHAR(256) NULL,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                     ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
```

## 19.2 Synchronous Writes

Only three writes block the engine:

1. `trades` INSERT with `status='OPEN'` — **before** the entry order is placed. If this write fails, no order is placed. This guarantees no position can exist without a durable record.
2. `trades` UPDATE to `status='CLOSED'` — after exit fill.
3. `risk_state` UPSERT — after every counter mutation.

Everything else (`decisions`, `state_transitions`, order updates) goes through the async queue. Queue depth > `1000` → `warn`; > `5000` → drop oldest and `error`. The queue never blocks a decision cycle.

## 19.3 Retention

`decisions` and `state_transitions` are high-volume (~4,300 decision rows/day at 5s candles over 6 hours). Partition monthly, retain 24 months, archive to cold storage thereafter. `trades` and `orders` are retained indefinitely.

---

# 20. Error Handling and Recovery

## 20.1 Principle

**No module may terminate the process.** The only permitted process exits are: (a) boot-time config/schema validation failure, and (b) an explicit operator stop. Everything else degrades to `HALTED`.

## 20.2 Error Taxonomy

| Class | Examples | Response |
|---|---|---|
| **Transient** | socket reset, 429, 502, timeout | Retry with backoff (§20.4) |
| **Data** | corrupt chain, missing candle, bad tick | Skip cycle, log, continue |
| **Business** | order rejected, insufficient margin | No trade; count toward rejection breaker |
| **Integrity** | stop invariant violated, illegal transition, unknown broker position | `HALT` immediately |
| **Fatal-at-boot** | bad config, DB unreachable, holiday file missing | Exit non-zero |

## 20.3 Specific Handlers

| Condition | Handling |
|---|---|
| Missing candle (1) | Synthesise (§7.5) |
| Missing candles (≥2) | Flat → suspend scanning until 3 real candles; In position → `EXIT_FEED_GAP` |
| Duplicate candle | Drop, count, continue |
| Late candle | Drop, count, continue |
| Chain timeout | `NO_ENTRY(CHAIN_STALE)`; 5 consecutive → `HALT` |
| Broker WS disconnect | Auto-reconnect with backoff; if in position and down > `10s` → `EXIT_FEED_GAP` |
| Broker REST timeout | §12.3 idempotent recovery |
| Order rejection | §12.4 |
| Price mismatch (fill far from request) | If `|fill − request| > 2 points` → log `SEVERE_SLIPPAGE`, continue with actual fill, alert |
| Unhandled exception in cycle | `failSafe()` (§20.5) |

## 20.4 Retry Policy

Exponential backoff with full jitter, applied only to **transient** classes:

```
delay(n) = random(0, min(BASE * 2^n, MAX))
BASE = 200 ms, MAX = 5000 ms, maxAttempts = 5
```

Order placement is exempt — it uses the idempotent single-retry protocol of §12.3, never blind backoff retries.

## 20.5 Fail-Safe Handler

```js
async function failSafe(ctx, err) {
  log.error({ evt: 'CYCLE_EXCEPTION', cycleId: ctx.cycleId,
              err: serialiseError(err), state: state.current });
  metrics.incr('cycle_exceptions');

  if (activeTrade) {
    await exitEngine.forceExit(activeTrade, 'EXIT_ENGINE_ERROR');
  }
  if (metrics.cycleExceptionsInWindow(60_000) >= 3) {
    risk.halt('REPEATED_CYCLE_EXCEPTIONS');
  }
}
```

`process.on('uncaughtException')` and `process.on('unhandledRejection')` route to the same handler and additionally `HALT`. They exist as a last line of defence, not as a control-flow mechanism.

## 20.6 Startup Reconciliation (Normative)

Every boot, before any trading, in `RECONCILING`:

```
1. Load risk_state for today. If halted -> HALTED, stop.
2. SELECT * FROM trades WHERE status = 'OPEN'
3. Fetch broker positions + order book
4. Match:
   a. DB open trade + matching broker position  -> resume POSITION_MANAGEMENT
   b. DB open trade + NO broker position        -> position closed while down;
                                                   reconstruct exit from order book;
                                                   mark CLOSED; -> IDLE
   c. NO DB open trade + broker position exists -> HALT(UNKNOWN_POSITION). Never
                                                   auto-close an unrecognised position.
   d. Neither                                   -> IDLE
5. Cancel any dangling open orders tagged by this engine.
```

Case (c) is deliberately manual. Auto-closing a position the engine does not understand is more dangerous than holding it under operator supervision.

---

# 21. Logging and Observability

## 21.1 Format

Structured JSON, one object per line, to stdout. `pino` at `info` in production. Log writing MUST be asynchronous and MUST NOT be in the synchronous decision path (use `pino.destination` with `sync: false`).

## 21.2 Mandatory Fields

Every log line carries:

```json
{
  "ts": 1730000000123,
  "level": "info",
  "evt": "ENTRY_VALIDATED",
  "cycleId": "01927...",
  "tradeId": "01927...",
  "symbol": "NIFTY24D1224500PE",
  "state": { "from": "SCANNING", "to": "ENTRY_READY" },
  "reason": "SELL_PE",
  "execMs": 8.42,
  "env": "production",
  "mode": "LIVE"
}
```

`tradeId` is `null` when no trade is in scope. `cycleId` correlates every line produced within one decision cycle — this is the primary debugging handle.

## 21.3 Event Catalogue

```
MARKET:   CANDLE_SEALED, CANDLE_SYNTHETIC, CANDLE_DUPLICATE, CANDLE_LATE, FEED_GAP,
          FEED_CONNECTED, FEED_DISCONNECTED
CHAIN:    CHAIN_FETCHED, CHAIN_STALE, CHAIN_CORRUPT
STRIKE:   STRIKE_CANDIDATES, STRIKE_SELECTED, NO_LIQUID_STRIKE
TREND:    TREND_EVALUATED, TREND_UNDETERMINED
ENTRY:    ENTRY_VALIDATED, ENTRY_REJECTED
ORDER:    ORDER_PLACED, ORDER_FILLED, ORDER_PARTIAL, ORDER_REJECTED,
          ORDER_CANCELLED, ORDER_AMBIGUOUS, SEVERE_SLIPPAGE
POSITION: POSITION_OPENED, POSITION_EVALUATED, TARGET_EXTENDED, STOP_TRAILED
EXIT:     EXIT_TRIGGERED, EXIT_FILLED, EXIT_FAILED
RISK:     RISK_REJECTED, COOLDOWN_STARTED, COOLDOWN_ENDED, HALT, DAY_RESET
SYSTEM:   STATE_TRANSITION, ILLEGAL_TRANSITION, CYCLE_OVERRUN, CYCLE_EXCEPTION,
          RECONCILE_START, RECONCILE_RESULT, BOOT, SHUTDOWN
```

## 21.4 Metrics

Prometheus, exposed on `/metrics` (bound to localhost only).

```
engine_cycle_latency_ms          histogram
engine_cycles_total              counter{outcome}
engine_trades_total              counter{result}
engine_active_position           gauge  (0|1)
engine_consecutive_losses        gauge
engine_halted                    gauge  (0|1)
engine_feed_lag_ms               gauge
engine_order_latency_ms          histogram{purpose}
engine_late_ticks_total          counter
engine_db_queue_depth            gauge
```

## 21.5 Alerts

| Alert | Condition | Severity |
|---|---|---|
| Engine halted | `engine_halted == 1` | **critical, page** |
| Exit failed | `EXIT_FAILED` log | **critical, page** |
| Unknown position | `HALT(UNKNOWN_POSITION)` | **critical, page** |
| Feed down in position | `feed_lag_ms > 10000 && active_position == 1` | **critical, page** |
| p99 latency breach | `p99(cycle_latency) > 100ms` for 5 min | warning |
| Cycle overruns | `> 3` in 60s | warning |
| DB queue backing up | `db_queue_depth > 1000` | warning |

---

# 22. Open Specification Items (`[MUST-CONFIRM]`)

Development may begin on all modules, but **the engine MUST NOT be enabled in `LIVE` mode until every item below is signed off** by the trading desk and recorded in this document's revision history.

| # | Item | Section | Proposed default |
|---|---|---|---|
| 1 | Liquidity threshold constants (OI, volume, depth, spread) | §9.2 | As listed in §9.2 |
| 2 | Position size — lots per trade | §12.2 | `1` lot |
| 3 | Multi-level target advancement within one candle | §14.3 | One level per candle |
| 4 | Stop uses candle `high`; target uses `close` | §15.4 | As specified |
| 5 | Premium Safety Exit vs Initial Stop Loss distinction | §16.2.4 | Backstop, as specified |
| 6 | Loss defined on gross or net P&L | §17.3 | Net (incl. charges) |
| 7 | Trading permitted on expiry day | §8.2 | Not permitted |
| 8 | Session windows and square-off time | §17.4 | As listed in §17.4 |
| 9 | `MAX_HOLD_CANDLES` (v2.0 references max holding time but gives no value) | §16.2 | `24` candles (120 s) |
| 10 | Broker identity and API capabilities (5s option candles available?) | §7.7 | — |

Item 10 is a **hard blocker**: if the broker cannot supply option-level tick data sufficient to build 5-second option candles, §12.1 and §13.2 are unimplementable as written and the spec requires revision.

---

# 23. Performance Budget

## 23.1 Target

End-to-end decision latency `< 100 ms` at p99, measured from `CANDLE_SEALED` to `ORDER_PLACED`.

## 23.2 Budget Allocation

| Stage | Budget (p99) |
|---|---|
| Candle seal + append | 2 ms |
| Chain snapshot (cached) | 5 ms |
| Strike filter + rank | 10 ms |
| Trend evaluation | 1 ms |
| Entry validation | 1 ms |
| Risk gate | 1 ms |
| Synchronous `trades` INSERT | 15 ms |
| Order serialise + broker REST dispatch | 50 ms |
| Slack | 15 ms |
| **Total** | **100 ms** |

## 23.3 Rules

- No synchronous filesystem or network I/O in a cycle. `fs.readFileSync`, `execSync` and blocking DB drivers are banned by lint rule.
- No unbounded allocation per cycle. Candle buffers and candidate arrays are pre-sized.
- Chain snapshots are cached and shared; never fetched inside a cycle.
- JSON serialisation of large objects happens in the async log path, not inline.
- GC pressure monitored via `perf_hooks`; sustained old-gen growth is a release blocker.

## 23.4 Memory

Steady-state RSS target `< 300 MB`. A 24-hour soak test (§25.6) must show flat heap after warm-up, with `< 5%` drift.

---

# 24. Coding Standards

## 24.1 Structure

```
src/
  bootstrap.js            # composition root — the ONLY place with `new`
  constants.js
  config/
    schema.json
    loader.js
  domain/                 # pure types + pure functions, zero I/O
    candle.js
    trend.js              # ITrendEngine impl — pure
    entryValidator.js     # pure
    targetLadder.js       # pure
    trailingStop.js       # pure
  modules/
    marketData/
    optionChain/
    strikeSelector/
    orderManager/
    positionManager/
    exitEngine/
    riskEngine/
  infra/
    brokerAdapter/
    mysql/
    logger.js
    metrics.js
  state/
    stateMachine.js
    transitions.js
  orchestrator.js
test/
  unit/ integration/ replay/ fixtures/
scripts/
  replay.js  reconcile.js  reset-halt.js
```

## 24.2 Rules

- **SOLID**, with special weight on Dependency Inversion: every module depends on an interface, never on a concrete class.
- **Immutability**: candles and quotes are frozen. `ActiveTrade` is the only mutable aggregate and is mutated only by Position Manager, Target Engine and Trailing Stop.
- **Purity**: everything in `domain/` is a pure function. No `Date.now()`, no I/O, no logging. Time is always passed in as a parameter.
- **No magic numbers** outside `constants.js` and `config/`.
- **Error handling**: typed error classes (`TransientError`, `DataError`, `BusinessError`, `IntegrityError`) driving the taxonomy in §20.2. Never `throw new Error('...')` from a module.
- **No `any`**, no implicit coercion, `===` only.
- Async/await throughout; no raw promise chains, no callbacks except the broker SDK boundary.

## 24.3 Enforcement

ESLint with:
- `no-restricted-imports` preventing cross-module deep imports (`modules/*/internal/**`)
- `no-restricted-syntax` banning `Math.random`, `Date.now` inside `src/domain/**`, `fs.*Sync`, `localStorage`
- `no-floating-promises`
- Complexity ceiling `10`, file length ceiling `400` lines

CI gates: lint, `tsc --checkJs`, unit coverage `>= 90%` on `src/domain/**` and `>= 80%` overall, determinism test, replay regression. All must pass to merge.

---

# 25. Testing Requirements

## 25.1 Unit Tests

Every pure function in `domain/` gets exhaustive table-driven tests. Mandatory cases:

**Trend Engine**
- Clear up / clear down
- `d1 == 0`, `d2 != 0` → tie-break 1
- `d1 == 0`, `d2 == 0`, `d3 != 0` → tie-break 2
- All three zero → `null`
- Fewer than 3 candles → `null`

**Entry Validator**
- `close` exactly equal to `bullishMid` → rejected (strict inequality)
- `close` exactly equal to `bearishMid` → rejected
- Doji (`O==H==L==C`) → rejected on both sides
- Trend/signal conflict → rejected

**Trailing Stop**
- Monotonicity across a 10-level ladder
- `trailingStopEnabled = false` → stop never moves
- Attempted stop increase → `IntegrityError`

**Target Ladder**
- Close exactly at target → advances
- Close 4 points beyond target → advances exactly one level

## 25.2 Property Tests

Using `fast-check`:

- `∀ candle: ¬(close > bullishMid ∧ close < bearishMid)` — mutual exclusivity (§11.3)
- `∀ trade sequence: stopPrice` is monotone non-increasing
- `∀ quote set: strikeSelector` returns the same symbol for the same input across 1,000 shuffles of input order (order-independence)
- `∀ state, event: state.to()` either transitions per the table or throws — never silently no-ops

## 25.3 Integration Tests

Against a mock broker implementing the full adapter contract, covering:
- Happy path entry → target extensions → trail → stop exit
- Partial fill then cancel
- Entry rejection
- Exit rejection ×3 → `HALT`
- Feed disconnect while in position
- Chain timeout
- All 12 exit reasons fired at least once

## 25.4 Determinism Test (Gate)

```
1. Load a recorded session (ticks + chain snapshots) from test/fixtures/
2. Run the engine in replay mode, capture the ordered decision log
3. Compute SHA-256 of the canonicalised decision log
4. Assert it equals the committed golden hash
5. Run again with shuffled internal map insertion order — hash MUST be identical
```

Any change to this hash requires an explicit, reviewed golden-file update with justification. This is the primary defence of §3.1.

## 25.5 Historical Replay

A replay harness (`scripts/replay.js`) drives the engine from recorded tick data at configurable speed (1×, 100×, max). Minimum acceptance: **20 trading days** of replay with zero `IntegrityError`, zero illegal transitions, zero unhandled exceptions.

## 25.6 Soak Test

24-hour continuous run against a replaying feed. Pass criteria: flat heap after warm-up, p99 cycle latency `< 100ms` throughout, zero crashes, DB queue never exceeds 1,000.

## 25.7 Failure Injection

Chaos suite that randomly injects: WS disconnects, REST 500s, REST timeouts, duplicate ticks, out-of-order ticks, DB unavailability, clock skew. Pass criteria: engine ends every scenario either flat or `HALTED` — **never** with an untracked position.

## 25.8 Paper Trading

Minimum **10 consecutive trading days** in `TRADING_MODE=PAPER` against the live feed with real order simulation. Reviewed by the desk before any `LIVE` promotion. Acceptance requires: zero `HALT` events attributable to engine defects, and reconciliation clean on every boot.

---

# 26. Deployment and Production Operations

## 26.1 Environments

| Env | Feed | Broker | Mode | DB |
|---|---|---|---|---|
| development | recorded replay | mock | PAPER | local MySQL |
| testing | recorded replay | mock | PAPER | CI ephemeral |
| staging | live feed | broker sandbox | PAPER | staging MySQL |
| production | live feed | live broker | LIVE | production MySQL |

Each environment has an independent config file and independent secrets. Config is never shared across environments; promotion is by artefact, not by config edit.

## 26.2 Runtime

- Node.js LTS, pinned exact version, `package-lock.json` committed, `npm ci` only.
- Process supervised by `systemd` with `Restart=on-failure`, `RestartSec=5`, `StartLimitBurst=3`. Exceeding the burst limit leaves the process down — a crash-looping trading engine must stay down.
- Time sync via `chrony`; clock offset `> 250ms` from NTP is a boot refusal in production and an alert at runtime.
- Deployed in the same region as the broker endpoint to minimise round-trip latency.

## 26.3 Daily Lifecycle

```
08:45  systemd starts engine -> BOOTING -> RECONCILING
08:50  Health check green; holiday check passed
09:15  Market open, state -> IDLE -> SCANNING at 09:20
15:10  NO_NEW_ENTRY_TIME; scanning stops, management continues
15:15  SQUARE_OFF_TIME; forced flat
15:35  Engine drains DB queue, emits daily summary, stops
```

The engine is **not** run overnight. A cron-driven stop at 15:35 and start at 08:45 bounds the process lifetime to a single trading session, eliminating an entire class of day-rollover bugs.

## 26.4 Health Checks

`GET /health` (localhost only) returns:

```json
{
  "status": "OK|DEGRADED|HALTED",
  "state": "SCANNING",
  "feedLagMs": 42,
  "dbConnected": true,
  "brokerConnected": true,
  "activePosition": false,
  "tradesToday": 7,
  "consecutiveLosses": 1,
  "uptimeSec": 12045
}
```

## 26.5 Kill Switch

Creating the file at `$KILL_SWITCH_FILE` causes the engine, within `1000 ms`:

1. To exit any open position at MARKET (`EXIT_KILL_SWITCH`)
2. To cancel all open orders
3. To enter `HALTED`

The file is polled by the priority-0 timer, independent of the candle feed, so it works even when market data has stopped. This is the operator's guaranteed intervention path and MUST be tested before every production release.

## 26.6 Halt Reset

Clearing `HALTED` requires an operator to:

1. Confirm flat via the broker terminal (not via the engine)
2. Run `scripts/reset-halt.js --date YYYY-MM-DD --reason "..."`, which records the reset in `state_transitions`
3. Restart the process

There is no API or automatic path to clear a halt.

## 26.7 Release Process

1. All CI gates green (§24.3)
2. Determinism golden hash unchanged, or change reviewed and justified
3. 20-day replay regression: trade-by-trade diff against the previous release, every difference explained
4. Staging paper-trade for 3 sessions
5. Two-person approval (tech lead + desk)
6. Deploy outside market hours only
7. First live session at minimum size with an operator present

Rollback is by redeploying the previous artefact; there are no in-place hotfixes to a running engine during market hours.

## 26.8 Backup and DR

MySQL: automated daily full backup plus binlog, retained 30 days, restore tested monthly. If the DB is unreachable at boot, the engine refuses to start (§20.2 fatal-at-boot) — trading without a durable audit trail is not permitted.

---

# 27. Out of Scope

Explicitly excluded from v3.0 and forbidden in the v3.0 codebase:

BANKNIFTY / multi-index · multi-broker abstraction beyond the single adapter interface · web dashboard or any HTTP UI beyond `/health` and `/metrics` · performance-analytics reporting · trade-replay UI · AI/ML parameter optimisation · notification service (alerting is via the metrics/log pipeline, not the engine) · risk dashboard · HA clustering or failover · option buying · hedged/multi-leg structures · positional or overnight holding.

---

## Revision History

| Version | Date | Change | Author |
|---|---|---|---|
| 2.0 | — | Initial technical design | — |
| 3.0 | 2026-08-01 | Expanded to production specification: precise numeric rules for trend, entry, target ladder and trailing stop; integer-paise arithmetic; candle sealing and gap semantics; idempotent order protocol; startup reconciliation; MySQL schema; error taxonomy; state transition table; performance budget; determinism gate; production operations. No new business features. 10 `[MUST-CONFIRM]` items raised. | — |

**Sign-off required before LIVE enablement:**

| Role | Name | Date | Signature |
|---|---|---|---|
| Technical Lead | | | |
| Trading Desk | | | |
| Risk | | | |
| DevOps | | | |