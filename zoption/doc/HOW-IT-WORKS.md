# zoption — how it works

**NIFTY option offset scalper.** One reference for the whole system as it stands.

The source documents in this folder are the *specification*; `PROJECT_PLAN.md` is
the *reconciliation* of them (rulings R1–R9a). This document is the *description*
— what the code actually does, and why each load-bearing decision is the way it
is. Where the two could drift, the code wins and this file is wrong.

- Spec of record: `doc/PROJECT_PLAN.md`
- Source docs: `doc/flow.md`, `doc/update-point.md`,
  `doc/traling-traget -stoploss.md`, the two PDFs

---

## 1. What it does, in one paragraph

Sell a NIFTY option, buy it back a point or two lower, many times a day. The
entry price comes from a **completed candle of the option contract itself** —
`close + offset` — never from a live ask, bid or LTP. A strike is selected once
per cycle and locked until the legs are flat. Optionally, NIFTY's own 5-second
candles gate *which side* may sell, and a dynamic target ladder lets a winner run
while that trend keeps confirming. Everything else — stops, timeouts, the
square-off — reacts at tick speed.

The strategy is unusually exposed to costs: a one-point target on one lot is
mostly charges. Every P&L number the engine acts on is **net**.

---

## 2. Processes and boundaries

Two processes over one MySQL database. They never call each other.

```
        browser
           │  HTTP + socket.io
           ▼
    ┌──────────────┐        writes intent, reads state
    │  npm start   │  ──────────────────────────────────┐
    │  src/app.js  │                                    │
    └──────────────┘                                    ▼
                                                   ┌─────────┐
    ┌──────────────┐   reads intent, writes state   │  MySQL  │
    │ npm run      │  ─────────────────────────────►└─────────┘
    │   engine     │                                    ▲
    │ src/engine.js│                                    │
    └───────┬──────┘                                    │
            │  the ONLY process that places an order    │
            ▼                                           │
      Kotak Neo  ◄── ticks / order book ────────────────┘
```

- **`src/app.js`** — Express + EJS. Validates input, writes settings and the
  start/stop intent, renders state. It never touches the broker's trading
  endpoints. The one exception is the interactive login, because a TOTP has to be
  typed by a human.
- **`src/engine.js`** — holds the WebSocket, builds the candles, runs the state
  machine, sends the orders. It takes a **leader lock** (`engine_locks`) before
  doing any of that and refuses to start if another engine holds it. Two engines
  against one account would double every order, which on a naked short is the
  worst outcome the system can produce.

`npm start` alone gives you a UI where nothing ever trades.

---

## 3. The data path

```
Kotak WS ──┐
           ├─► Ticker ──┬─► CandleBuilder (option, candleTimeframe) ─► 'candle'
REST poll ─┘            │                                                 │
   (fallback)           ├─► CandleBuilder (index, trendTimeframe) ─► trendFilter
                        │                                                 │
                        ├─► RiskManager.recordSpot                        │
                        └─► TICK events ────────────────────┐             │
                                                            ▼             ▼
                                                    ┌────────────────────────┐
                       Reconciler ─── fills ───────►│   legMachine.reduce()  │
                       (polls the order book)       │   PURE: no I/O, no     │
                       clock ─── timeouts ─────────►│   clock, no network    │
                                                    └───────────┬────────────┘
                                                                │ actions
                                                                ▼
                                                        OrderRouter ─► broker
```

**Two separate candle series, deliberately different objects.** The option series
prices entries; the index series only ever decides *whether* a side may trade.
Keeping them in different `CandleBuilder` instances means an index bar cannot be
mistaken for a tradable one anywhere downstream.

### The candle builder (`src/market/candleBuilder.js`)

Four load-bearing decisions:

1. **Buckets are absolute, aligned to IST midnight** — a bar labelled 10:15
   covers 10:15:00.000–10:15:59.999, not "60 seconds after I subscribed". Two
   builders started a second apart produce byte-identical bars, so a restart
   cannot silently change the strategy's entries.
2. **The first bar is discarded.** Its open is wherever the tick stream happened
   to start, so it describes the subscription, not the market. The engine waits
   up to one full timeframe before its first entry — a real, logged delay.
3. **A bar with no ticks is synthetic and never traded.** It is emitted for chart
   continuity, flagged, and refused by the machine. Offsetting from a close that
   is a minute stale is fiction.
4. **A bar closes on time, not on the next tick.** A timer closes the bucket even
   if the strike goes silent — otherwise an illiquid strike wedges a leg
   indefinitely, which is exactly when you least want the engine stuck.

`tradable = !synthetic && tickCount >= minTicks` is the single flag the engine
reads.

---

## 4. A cycle, start to finish

```
   risk gate passes, ticker healthy
              │
              ▼
   select expiry ── once ──┐
   select strike ── once ──┤   selectors.js, pure
              │            │
              ▼            │
        LOCK STRIKE  ◄─────┘   cycle_guard makes this exclusive
              │
              ▼
   subscribe CE + PE + spot; point the candle builders at them
              │
              ▼
        ARM both legs
              │
              ▼
   ┌──► WAIT_CANDLE ──── option candle closes ────┐
   │         ▲                                    │
   │         │                    tradable? premium gate? trend gate?
   │         │                                    │
   │         │                          all yes ──┴──► SELL LIMIT
   │         │                                          close + offset
   │         │                                             │
   │    unfilled past pendingTimeout: cancel,              │
   │    wait for the NEXT close — never chase              │
   │         └────────────────────────────────────────── filled
   │                                                       │
   │                                                       ▼
   │                                              POSITION_OPEN
   │                                    target resting, stop held by the engine
   │                                                       │
   │            ┌──────────────┬───────────────┬───────────┴────────┐
   │            ▼              ▼               ▼                    ▼
   │        target hit   trailed stop     trend reversed        timeout
   │            │              │               │                    │
   │            └──────────────┴───────┬───────┴────────────────────┘
   │                                   ▼
   │                                 DONE
   │                                   │
   └─── PER_LEG: re-arm ───────────────┤
                                       │  BOTH_LEGS: wait for the other leg
                                       ▼
                          both legs DONE → UNLOCK → new cycle
```

### Selection (`src/strategy/selectors.js`)

Pure functions over the chain, run **exactly once** per cycle and unreachable
from the state machine.

- **Expiry** — from the dates the instrument master actually carries. Never a
  hardcoded weekday: NSE has moved expiry day more than once, and a hardcoded
  Thursday silently trades the wrong contract.
- **Strike** — `ATM`, `ATM_OFFSET` (n steps out on each side), or `PREMIUM` (the
  strike whose live premium sits nearest `targetPremium`, inside the tolerance
  band). If nothing is inside the band the answer is **no trade**, not the
  nearest miss — a configured constraint is not a suggestion. The ladder step is
  read from the chain, not assumed to be 50.

`PREMIUM` mode reads live prices to *choose a contract*. That is selection, not
pricing; the entry price still comes from a closed candle. R3 keeps the two
apart, and `calculateSellPrice(candle, offset)` has no parameter through which a
quote could reach it.

### The lock

`cycles` holds the chosen contracts; `cycle_guard` has a `UNIQUE` index on a
column that is `1` while open and `NULL` once closed. MySQL treats NULLs as
distinct, so two engines racing to open a cycle produce one winner and one
duplicate-key error rather than two locked strikes.

---

## 5. The leg state machine (`src/strategy/legMachine.js`)

`(leg, event, cfg) → { state, patch, actions }`. **Pure**: no I/O, no clock, no
network. Time and prices arrive as events. This is what makes the strategy
testable without a broker, and the difference between a suite that runs in 200ms
and one that needs a live market.

| State | Meaning |
|---|---|
| `IDLE` | nothing armed |
| `WAIT_CANDLE` | armed, waiting for a tradable closed candle |
| `SELL_WORKING` | a SELL LIMIT is live at the broker |
| `SELL_CANCELLING` | cancel sent, awaiting confirmation |
| `POSITION_OPEN` | short filled, target resting, stop held by the engine |
| `TARGET_MOVING` | target cancelled to be **replaced**, not exited |
| `EXITING` | target cancel confirmed (or in flight), market exit coming |
| `DONE` | flat for this cycle |

### Entry price — the rule the file exists to enforce

```js
calculateSellPrice(candle, sellOffsetPaise)   // a candle and an offset. Nothing else.
```

There is no third parameter, and no quote, tick, ask, bid or LTP is reachable
from it. Every source document forbids pricing an entry from live data; making it
*structurally impossible* is stronger than remembering not to, and
`test/invariants.test.js` asserts it by reading the source.

### Two gates, both booleans

A candle can be refused before it prices anything. Both gates are computed in the
engine and arrive as `gateOk` / `trendOk` — the machine is never handed the
number behind either.

- **Premium gate** — is there a fresh quote, and (in `PREMIUM` mode) is the live
  premium still inside the band? Fail → `PREMIUM_GATE_REJECT`, wait for the next
  close.
- **Trend gate** — does the index permit this side right now? Fail →
  `TREND_GATE_REJECT`.

### The requote rule

Unfilled past `pendingTimeout` → cancel → **wait for the next candle close** →
reprice → place again. Not an immediate requote. Between the cancel and the next
close the leg sits idle with no working order, and that idle gap is intentional:
it is what "never chase the market" means mechanically (R2).

---

## 6. The index trend filter (optional, `trendFilter`)

`doc/update-point.md`. NIFTY's last three completed **5-second** candles decide
whether an entry is allowed and which side may take it.

Each bar is measured, not coloured — a bar that opens 25100, closes 25102 and
ranges 25 points is "technically bullish" and describes nothing:

| Bar state | Condition |
|---|---|
| `NO_DATA` | synthetic, or fewer than `trendMinTicks` ticks |
| `STRONG_BULLISH` | `close > open`, body ≥ 60% of range, close within 25% of the high |
| `STRONG_BEARISH` | mirrored |
| `NEUTRAL` | everything else |

The window is then judged in order — the first rule that trips wins:

1. any bar `NO_DATA` → **skip**
2. `max(high) − min(low)` across the three bars > 10 points → **skip**
   (combined, not per bar — large moves pull back)
3. the three bars disagree, or any is neutral → **skip** (cases 3–6 of the
   document's table)
4. the ranges shrink monotonically → **skip** (momentum fading)
5. any bar scores under 5/5 → **skip**
6. otherwise: bullish → **PE only**, bearish → **CE only**

The quality score is out of 5 — body ≥ 70% (+2), opposing wick < 15% (+1), close
at the extreme (+2). The source document's fourth term, *volume higher than
previous*, is **dropped**: this feed is LTP-only and carries no volume, so it is
absent rather than faked from a proxy.

A verdict expires with its bar (5s + a small grace for the two builders' 250ms
sweeps). A stale permission is worse than none.

**`WARMING_UP` and `NO_DATA` are not reversals.** They are an absence of
information, not a change of direction — closing a live short on one would hand
the market a free exit every time a bar goes quiet.

### The thin-bar guard

At 5 seconds on the REST fallback (1/sec, repeated prices suppressed) a quiet bar
can hold 2–3 samples, and a "60% body" from three samples describes the poller,
not the market. Bars under `trendMinTicks` are `NO_DATA` and block. If the trend
state sits on `NO_DATA` all session, the socket is not streaming and the
threshold needs lowering — the settings validator warns about this at boot when
`NEO_POLL_MS` cannot supply enough samples.

---

## 7. Position management

### Fixed brackets (always)

On fill: `target = fill − target`, `stop = fill + stopLoss`. The target is a
**resting BUY LIMIT at the broker** — it fills faster and survives a restart. The
stop is held by the engine and fires on a tick.

Priced off the price actually **filled** at, not the price asked for: a limit
that filled better keeps the improvement, and one that filled worse does not have
its target quietly moved.

### The dynamic target ladder (optional, `dynamicTarget`)

`doc/traling-traget -stoploss.md`. While the index keeps confirming the trend
that justified the entry, the target is pushed further out instead of banking one
point:

| Consecutive confirmations | Target |
|---|---|
| 1st | 1 point — already the resting target, no move |
| 2nd / 3rd / 4th | 2 / 3 / 4 points |
| 5th+ | **no target at all** — trail until reversal |

Priced off the fill, never the live premium, so a level is recomputable from the
audit log months later. The ladder also refuses to move a target *backwards*: a
config with `target` wider than `dynamicTargetStep` would otherwise shrink a
winner on the first confirmation.

### The trailing stop

`stop = best premium + trailGap`, where `best` is the cheapest the premium has
been. It engages only once `trailStart` in profit — without that, the first tick
clamps the stop a hair above entry and noise takes the trade out — and it **never
widens**. This reproduces the source document's own arithmetic: best 18.80 → stop
19.30, best 18.00 → stop 18.50.

A worked run, 20.00 short, defaults:

```
fill 20.00        target 19.00  stop 22.00  conf 0
confirm #2        target 18.00  stop 22.00  conf 2
premium 19.20     target 18.00  stop 19.70
premium 18.80     target 17.00  stop 19.30
premium 18.00     target 16.00  stop 18.50
confirm #5        target   —    stop 18.50   trail-only
index REVERSES  → MARKET BUY at 17.80

2.20 points, where a fixed target books 1.00
```

### Exits

| Trigger | Mechanism | Order |
|---|---|---|
| Target | resting at the broker | LIMIT, already there |
| Stop-loss | live tick crosses the (possibly trailed) stop | MARKET |
| Trend reversal | the verdict no longer permits this side | MARKET |
| Timeout | `positionTimeout` since the fill | MARKET |
| Square-off | past `squareOffAt` | MARKET |

**The maximum hold outranks the ladder.** A trailing winner is still a naked
short, and an uncapped holding time is a different risk profile than the one the
rest of the engine was built for.

Not implemented from the source document: *"premium closes against you for 2
consecutive 5s candles"*. It needs a third candle series at 5s over the option
tokens, and the trailing stop already covers the same ground on every tick rather
than waiting for two closes.

---

## 8. The OCO door — the most dangerous path

A resting target plus an engine-fired stop is a double-exit race. Buy the short
back twice and the account is **naked long**.

> **The rule.** The resting target MUST be cancelled, and the cancel CONFIRMED,
> before any exit market order is sent.

`TARGET_MOVING` goes through the same door for the same reason — moving a target
is a cancel followed by a place, and between them the position is protected only
by the engine-held stop. So every exit trigger stays live in that state but
records itself as `pendingExit` instead of sending. When the cancel confirms:

```
cancel confirmed
      │
      ├── an exit is owed?  ──► EXIT_MARKET, and the replacement target is
      │                          ABANDONED  (RETARGET_ABANDONED)
      │
      └── no ─────────────────► place the replacement (or nothing, trail-only)
```

Three outcomes of a cancel, and all three are handled:

- **`CANCELLED` / `GONE`** — proceed.
- **`ALREADY_FILLED`** — the target won the race; the position is flat. Send
  nothing. This is precisely the case where sending anyway opens the naked long.
- **`FAILED`** — genuinely ambiguous. Do **not** exit; the target may still be
  working. Retry the cancel (§9).

Enforced structurally: `EXIT_MARKET` has exactly **one** construction site in the
whole state machine, inside the confirmed-cancel branch, and `test/invariants`
asserts the count by reading the source. A companion test asserts no event in
`POSITION_OPEN` can emit `PLACE_TARGET` without cancelling first.

---

## 9. Order safety (`src/execution/orderRouter.js`)

Kotak's place-order carries **no client order id**, so a retry after a network
error is indistinguishable from a new order. Two mechanisms stand between that
and a duplicate position:

1. **`orders.client_ref` is UNIQUE** —
   `zo-<cycle>-<CE|PE>-<attempt>-<stage>[-R<revision>]`. The same logical order
   can only ever be inserted once.
   - `attemptSeq` separates entry attempts, and **never resets on a PER_LEG
     re-arm** — restarting it would make the next round trip's entry collide with
     the previous one.
   - `revision` separates rungs of the target ladder. Without it every rung
     collides, `place()` returns the cancelled predecessor, and the leg believes
     it holds a target that does not exist at the broker.
2. **`claimForPlacement`** atomically moves the row `PENDING → PLACING`. Only the
   first caller wins.

### The three-way failure rule

| Failure | Meaning | Action |
|---|---|---|
| **Pre-send** | the rate limiter refused; nothing left the process | reset to `PENDING`, safe to place again |
| **Rejected** | the broker answered "no", with a reason | mark `REJECTED`; retrying unchanged fails identically |
| **Uncertain** | timeout, reset socket, 5xx *after* send | mark `UNKNOWN`. **Never resend, never retry.** The reconciler resolves it against the book |

The third is the one that costs money.

### Stuck-leg recovery

The clock dispatches nothing to `EXITING`, and `SQUARE_OFF` from `EXITING` is a
no-op — so a leg whose cancel came back ambiguous, or whose exit order failed to
send, would hold a live naked short with no exit in flight, past the close,
forever. `_recoverStuck` re-drives both cases every 5s.

It reads the **orders table**, not the in-memory leg, to decide whether an order
is missing: resending a market buy that is already working is worse than the
wedge it fixes.

### The reconciler (`src/execution/reconciler.js`)

The broker's order book is the truth. One loop solves three problems: fill
detection (nothing else tells us a resting limit filled), `UNKNOWN` resolution,
and boot recovery. Matching is by broker order id; an `UNKNOWN` row has no id, so
those match on symbol/side/qty within a time window and anything ambiguous is
left for a human. Guessing here is worse than not knowing.

---

## 10. Cycle scope — how a leg gets back to work

| | `BOTH_LEGS` (default) | `PER_LEG` |
|---|---|---|
| A finished leg | waits in `DONE` for its partner | re-arms on its **own locked strike** |
| Strike unlocks | when both legs are flat | when both legs finally stop |
| Strike freshness | re-selected every cycle | ages until `cycleMaxAge` |
| Trade frequency | lower | much higher |

**`PER_LEG` consults the risk gate on every re-arm**, not only at cycle open.
Without that it would be a hole straight through the daily loss limit, the
cooldown and the session window — a leg re-entering all afternoon on a cycle that
passed the gate once, hours earlier.

Three things bound the ageing: the risk gate, `cycleMaxAge` (default 900s), and
`legEntryTimeout`.

### With the trend filter, scope matters enormously

A one-sided filter and `BOTH_LEGS` interact badly: the permitted leg takes one
round trip, then idles until its blocked partner's `legEntryTimeout` expires,
because the cycle cannot re-select until both legs are `DONE`. Simulated over ten
minutes of bullish index:

```
BOTH_LEGS →  1 round trip
PER_LEG   → 19 round trips
```

The settings validator says which of the two you are getting.

### Standing down and coming back

A leg that cannot enter — refused by the trend filter, or by the premium gate —
stands down after `legEntryTimeout` with `exitReason = NO_ENTRY`. No order, no
position, nothing booked. This is what stops one blocked leg from holding the
strike lock for the rest of the session.

Under `PER_LEG` a stood-down leg is **revived** when the index turns to permit its
side, through the same gates as any other re-arm. Only `NO_ENTRY` — a leg that
stood down via `SQUAREOFF` or `HALT` means something else and is never revived by
a market opinion. Under `BOTH_LEGS` there is no revival: the cycle closes within
seconds and the next one arms both legs on a *freshly selected* strike, which
beats reviving onto a strike chosen for the opposite trend.

---

## 11. Risk (`src/strategy/riskManager.js`)

One rule shapes the file: **a risk control stops entries, it does not abandon an
open position.** Nothing here can stop a target, a stop-loss or a square-off.
Halting entries is a risk control; walking away from a live naked short is not.

`canEnter()` is consulted before a cycle opens **and before a leg arms**, and
blocks on: `TRADING_HALTED`, outside the session window, too close to the
square-off to hold a full position, the day disabled, a cooldown after a stop,
`maxDailyLoss` / `maxDailyProfit` (both disable the day), `maxConsecutiveLoss`
(a cooldown, not a disable — three losses is a signal, not proof the day is
over), `maxCyclesPerDay`, and a NIFTY excursion over `marketMovePause` inside
`marketMoveWindow`.

The market-move check is a ring of spot samples, not first-vs-last, so a round
trip (up 40, back down) inside the window still trips it — that is a volatile
market, which is the thing being detected.

---

## 12. Money (`src/core/money.js`)

**Every price is an integer in paise.** 12.40 is 1240. Nothing is a float: a
premium multiplied by a lot size and compared against a rupee limit is exactly
where P&L silently drifts. Rupees exist at two edges only — where an operator
types a number, and where one is displayed.

`roundToTickPaise` is the **only** rounding boundary between a computed price and
an order. An off-tick limit is rejected outright by the exchange.

Brokerage is a **flat fee per order**, so a round trip's cost is dominated by a
constant and the breakeven *move* scales as roughly 1/qty:

```
1 lot  (75)  → ~0.75 points to break even
2 lots (150) → ~0.40 points
```

Against a 1.00-point target, that is most of the edge. Gross P&L on this strategy
is misleading by roughly the size of the target itself, so **`net_pnl_p` is what
the risk manager reads and the dashboard shows**. The engine logs a warning at
boot if the configured target does not cover the round trip.

---

## 13. Configuration

One row in `settings`, read at cycle start and never mid-cycle — changing an
offset under a working order would produce a trade neither the old nor the new
config describes. The API refuses a write while a cycle is open.

```jsonc
{
  "symbol": "NIFTY",
  "expiryMode": "CURRENT_WEEKLY",   // NEXT_WEEKLY | MONTHLY | MANUAL
  "manualExpiry": null,
  "tradeMode": "BOTH",              // CE | PE

  // selection — runs once per cycle
  "strikeMode": "PREMIUM",          // ATM | ATM_OFFSET
  "atmOffset": 2,
  "targetPremium": 12,
  "premiumTolerance": 2,

  // entry — candle only
  "entryMode": "OPTION_CANDLE_CLOSE",
  "priceSource": "CANDLE_CLOSE",
  "candleTimeframe": "1m",          // 5s | 15s | 30s | 1m | 3m | 5m
  "sellOffset": 1.0,
  "useLiveAsk": false,              // true => the engine REFUSES to start
  "useLiveBid": false,
  "useLTP": false,
  "lockStrike": true,
  "reQuoteOnNextCandle": true,
  "pendingTimeout": 10,
  "legEntryTimeout": 180,           // stand down if never permitted to enter
  "cycleMaxAge": 900,               // PER_LEG: how long one strike is re-used

  // index trend filter — gates the SIDE, never the price
  "trendFilter": false,
  "trendTimeframe": "5s",
  "trendConfirmBars": 3,
  "trendMinTicks": 4,
  "trendBodyPct": 60,
  "trendCloseNearPct": 25,
  "trendMaxRangePoints": 10,        // COMBINED across the window
  "trendMomentum": true,
  "trendStrongBodyPct": 70,         // score: +2
  "trendWickPct": 15,               // score: +1 and +2
  "trendMinScore": 5,               // out of 5, every bar; 0 = direction only

  // exits — tick driven
  "target": 1.0,
  "stopLoss": 2.0,
  "positionTimeout": 60,            // outranks the ladder, always

  // dynamic target and trailing stop
  "dynamicTarget": false,
  "dynamicTargetStep": 1.0,
  "dynamicTargetMax": 4,            // past this: no target, trail only
  "trailStart": 0.5,
  "trailGap": 0.5,                  // 0 = no trailing
  "exitOnReversal": false,

  "lots": 1,
  "sessionStart": "09:20",
  "sessionEnd": "15:10",
  "squareOffAt": "15:15",

  // risk
  "maxOpenCE": 1,
  "maxOpenPE": 1,
  "marketMovePause": 40,            // NIFTY points…
  "marketMoveWindow": 30,           // …within this many seconds
  "cooldownAfterSL": 300,
  "maxDailyLoss": 3000,
  "maxDailyProfit": 5000,
  "maxConsecutiveLoss": 3,
  "maxCyclesPerDay": 0,             // 0 = unlimited

  "cycleScope": "BOTH_LEGS",        // PER_LEG
  "mode": "PAPER"                   // LIVE
}
```

Everything optional ships **off**. An upgrade never switches on a feature that
changes what a trade is worth.

**Settings that are refused, not ignored.** `useLiveAsk/Bid/LTP: true` and
`lockStrike: false` are not preferences the engine can honour — they are requests
for a different strategy, so it stops rather than quietly doing something else.
The trend filter with `tradeMode: BOTH` and `legEntryTimeout: 0` is also a hard
error: that combination deadlocks the cycle.

Environment (`src/config/index.js`, `required()` throws on a missing critical
var): DB, `JWT_SECRET`, `TOKEN_ENC_KEY` (64 hex — AES-256-GCM for broker session
tokens at rest; MPIN and TOTP are **never** persisted), `NEO_*` (API base, token,
WS URL, `NEO_POLL_MS`, rate limit), `ENGINE_TICK_MS`, `CANDLE_MIN_TICKS`,
`CHG_*` (the charge schedule), retention days.

---

## 14. Data model

| Table | Holds |
|---|---|
| `settings` | the config blob, one row per profile |
| `instruments` | the master, synced each session |
| `cycles` + `cycle_guard` | one strike lock; the guard makes it exclusive |
| `legs` | one row per CE/PE within a cycle — live state, `confirmations` |
| `candles` | persisted OHLC, both series |
| `orders` | every order, `client_ref` UNIQUE |
| `positions` | one completed round trip, gross / charges / **net** |
| `daily_stats` | the risk state of one trading day |
| `events` | the audit trail |
| `engine_locks` | leader election |
| `system_flags` | start/stop intent, `trend_state` |

Prices are `INT` paise throughout; nothing is a `FLOAT`.

**The audit trail is the point.** Every state transition, every gate rejection,
every order and every trend verdict change is a row in `events`. A transition
that is not in that table did not happen. Index bars are persisted alongside
option bars so a post-mortem reads the exact rows the engine decided from, rather
than a chart drawn later from a second source that would eventually disagree.

Useful event kinds: `STRIKE_LOCKED`, `SELL_PRICED`, `PREMIUM_GATE_REJECT`,
`TREND_GATE_REJECT`, `TREND_STATE`, `TARGET_LADDER`, `TRAIL_STOP`,
`TREND_REVERSAL`, `RETARGET_ABANDONED`, `NO_ENTRY`, `REARMED`, `LEG_REVIVED`,
`REARM_DECLINED`, `EXIT_RETRY`, `TARGET_WON_RACE`, `TRADE_CLOSED`,
`STRIKE_UNLOCKED`.

---

## 15. Running it

```bash
npm run migrate     # create the DB, apply schema.sql, patch, seed, back-fill
npm start           # the web app on PORT (default 3000)
npm run engine      # the trading process — REQUIRED for anything to trade
npm test            # 178 unit tests; no database, no broker
```

Order of operations on a fresh machine: `migrate` → `npm start` → log in to Kotak
on `/brokers` (TOTP, then MPIN) → sync instruments → set your config on
`/settings` → `npm run engine`.

**The engine's boot sequence**: take the leader lock → load and validate settings
→ wait for a Kotak session (polls rather than exiting; an engine that dies
because nobody had logged in yet is one you have to babysit) → sync the
instrument master (falls back to the stored one if the sync fails but rows exist)
→ reconcile → adopt any open cycle → arm.

**Restart behaviour.** An open position is **not** closed on shutdown —
flattening on a SIGTERM would turn a routine deploy into a market order at
whatever the spread happens to be. The position is recorded, and the next boot
reconciles first, then adopts the cycle and re-attaches each leg to its live
orders.

Pages: `/` dashboard (locked strike, legs, trend tile, live audit trail), 
`/settings`, `/trades`, `/events`, `/brokers`.

---

## 16. The invariants

These are the ones whose violation costs money. Each has a dedicated test,
several of them structural — they read the source and assert its shape, because a
well-meaning refactor is how they break.

| | Invariant | Enforced by |
|---|---|---|
| **I1** | No order is priced from a quote, tick, ask, bid or LTP | `calculateSellPrice(candle, offset)` has no parameter for one |
| **I2** | A leg never has two working SELL orders; every logical order has one key | `client_ref` UNIQUE + `claimForPlacement` |
| **I3** | No exit market order while a target is still working | one `EXIT_MARKET` site, inside the confirmed-cancel branch |

Plus: an uncertain placement is never retried; only a pre-send rate limit resets
an order to `PENDING`; the trend filter's verdict carries no price field.

---

## 17. Known gaps

- **No exchange holiday calendar.** A holiday presents as a silent feed rather
  than a wrong-day trade — the engine needs a live price before it will trade —
  but a calendar is the honest fix.
- **Naked shorts.** All source documents describe naked selling. Margin per lot
  is ~10× a hedged spread's and loss is unbounded until the stop fires.
- **The adverse-close exit** from `doc/traling-traget -stoploss.md` is not
  implemented (§7).
- **Single account, single strategy instance.** The leader lock enforces it.
- **The 5-second index series depends on a streaming socket.** On the REST
  fallback most bars will fail the thin-bar guard and the filter will block
  everything. Watch `TREND_STATE` on the first session.
