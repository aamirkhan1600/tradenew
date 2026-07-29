# zoption — NIFTY Option Offset Scalper
## Project Plan

Version: 1.0 · Date: 2026-07-28 · Status: **Draft for approval**

Source documents:

| Doc | Role |
|---|---|
| `doc/flow.md` (v3.0) | **Authoritative** — candle-based entry, locked strike |
| `doc/NIFTY Option Offset Scalper.pdf` (v2.0 SDD) | System architecture, risk, DB, API, dashboard |
| `doc/Candle-Based Entry Engine.pdf` | Candle engine detail (§18) |
| `doc/Candle-Based Entry Engine (1).pdf` | Candle engine, earlier draft |

Two decisions were taken before writing this plan:

1. **`zoption` is a standalone app** — its own Node/Express/EJS/MySQL codebase,
   its own database and port, inside `zoption/`. Proven code from the sibling
   `premium-range-trader` is *adapted by copy*, not imported. The live
   premium-range engine is never touched.
2. **Candles are built from live ticks** — the Neo WebSocket stream for the two
   locked strikes is aggregated into OHLC bars in-process and persisted. No
   dependency on a broker intraday-history API.

---

> **This is the spec of record — how the source documents were reconciled.**
> For a description of what the system actually does end to end, read
> [`HOW-IT-WORKS.md`](HOW-IT-WORKS.md).

# 1. What is being built

A single-instrument, single-account NIFTY option **selling scalper**. One trade
cycle:

```
select expiry  →  select CE & PE strike  →  LOCK
      →  wait for that option's own candle to CLOSE
      →  SELL LIMIT at (candle close + offset)
      →  unfilled? cancel, wait for the NEXT candle close, requote
      →  filled? BUY target at (sell price − target); SL and timeout armed
      →  closed  →  UNLOCK  →  next cycle
```

The defining constraint, repeated in every document: **the initial SELL price is
derived only from a completed candle of the option contract itself.** Live ask,
live bid, LTP and tick price are never inputs to that number. Everything in the
architecture below exists to make that guarantee auditable rather than merely
intended.

---

# 2. Spec reconciliation

The four documents disagree in seven places. These are the rulings this plan
builds to. **Each one needs a yes from you before M5 starts** — they are cheap to
change now and expensive later.

### R1 — Entry price source: candle close, not ask *(v3.0 over v2.0)*

The v2.0 SDD §10 says `Sell Price = Ask + Offset`. flow.md v3.0 and both candle
PDFs say `Closed Candle Close + Offset` and explicitly forbid ask. **v3.0 wins.**
The v2.0 offset engine section is superseded in full.

### R2 — Requote timing: next candle, not immediate *(v3.0 over v2.0)*

v2.0 §11: pending > 10s → cancel → recalculate → place again, immediately.
v3.0: pending > `pendingTimeout` → cancel → **wait for the next candle close** →
recalculate → place. **v3.0 wins.** Between the cancel and the next close the leg
sits idle with no working order. That idle gap is intentional — it is what "never
chase the market" means mechanically.

### R3 — Premium validation uses LTP as a *gate*, never as a *price*

v2.0 §9 requires reading live premium before every order; v3.0 forbids LTP.
These are reconcilable and both are kept:

- **Gate (allowed):** before sending, check live LTP is inside
  `[targetPremium ± premiumTolerance]`, that a quote exists and is fresh, and
  that the computed limit is not absurd versus the market. Fail → skip this
  candle, log `PREMIUM_GATE_REJECT`, wait for the next close.
- **Price (forbidden):** the limit price is `candle.close + sellOffset` and is
  never adjusted by, blended with, or clamped to LTP.

Enforced structurally: `calculateSellPrice(candle, offset)` is a pure function
whose signature has no access to a quote object. A unit test asserts it.

### R4 — Entry is candle-driven; **exits are tick-driven**

The candle-only rule governs the *entry* price. Stop-loss, target and timeout are
risk controls and must react at tick speed — v2.0 §13 says "premium rises →
SL hit → market BUY", not "wait for the candle". So:

| Decision | Trigger | Order type |
|---|---|---|
| Initial SELL | closed candle only | LIMIT `close + offset` |
| Requote SELL | closed candle only | LIMIT `newClose + offset` |
| Target BUY | resting at broker from the moment of fill | LIMIT `sell − target` |
| Stop-loss BUY | live tick crosses the stop | MARKET |
| Timeout BUY | wall clock ≥ `positionTimeout` | MARKET |

> R9 extends the last three rows: the target is re-priced on each index
> confirmation, the stop trails, and a trend reversal is a fourth exit trigger.
> The entry rows are untouched.

### R5 — Target is a resting order; the engine runs OCO

"Immediately Create BUY Order" (candle PDF) means a real BUY LIMIT resting at the
broker — it fills faster and survives an engine restart. But a resting target plus
an engine-fired SL is a double-exit race. Rule: **the engine must cancel the
resting target and confirm the cancel before sending any SL or timeout market
buy.** If the cancel fails because the target already filled, the position is
flat — log `TARGET_WON_RACE` and stop. This is the single most dangerous code path
in the system and gets its own test suite.

### R6 — Strike lock is per *cycle*, covering both legs

v3.0: "Position Closed → UNLOCK STRIKE → START NEXT CYCLE". With `tradeMode:
BOTH` there are two legs under one lock. Ruling: **the lock releases only when
both CE and PE are flat with no working orders.** A leg that closes early waits
(state `LEG_DONE`) rather than re-entering on the locked strike. Rationale: it
preserves "strike selected only once per trade cycle" literally, and it keeps the
two legs' exposure windows aligned.

**`cycleScope: PER_LEG` is the implemented alternative.** A leg that finishes a
round trip goes straight back to `WAIT_CANDLE` on its **own locked strike**
instead of waiting in `DONE` for its partner. Higher trade frequency, at R6's
stated cost: the strike ages against a moving spot, because nothing re-selects it
while the legs keep re-entering on it.

Three things bound that, and they are the reason this is safe to switch on:

- **The risk gate is consulted on every re-arm**, not only at cycle open —
  otherwise PER_LEG would be a hole straight through the daily loss limit, the
  cooldown and the session window, with a leg re-entering all afternoon on a
  cycle that passed the gate once, hours earlier. `riskManager.js` always said
  `canEnter()` is consulted "before a cycle opens **and before a leg arms**";
  until now the second half was not true of anything.
- **`cycleMaxAge`** (default 900s) caps how long a locked strike may keep being
  re-used. Past it the leg declines to re-arm, both legs drain to `DONE`, the
  cycle closes and a fresh strike is selected against the current spot.
- **`legEntryTimeout`** still applies to the re-armed leg, whose stand-down clock
  restarts on each re-arm.

`attemptSeq` deliberately does **not** reset across round trips: it is part of
`client_ref`, so restarting it would make the next entry collide with the round
trip that just finished — the same failure the target ladder's revision exists to
prevent, and `place()` would return the old *filled* order instead of sending.

A leg that declines to re-arm stays `DONE` for the rest of the cycle even if the
blocking condition clears — with **one exception**, because that exception was
costing a whole side of the market.

**Reviving a stood-down leg.** With the trend filter and `tradeMode: BOTH`, the
refused leg stands down as `NO_ENTRY` (R8a). Under PER_LEG nothing would ever
bring it back: a leg only re-arms after a completed round trip, and this one
never had one. So a CE that stood down at 09:33 under a bullish index would sit
out the rest of the cycle — up to `cycleMaxAge` — while the index turned bearish
and the market ran its way. Measured on the state machine: 19 PE round trips and
zero CE, through a reversal.

So a `NO_ENTRY` leg whose side the index now permits re-arms, through the *same*
gates as any other re-arm (risk, `cycleMaxAge`, square-off). Only `NO_ENTRY` —
a leg that stood down via `SQUAREOFF` or `HALT` means something else entirely and
is never revived by a market opinion.

**Only under PER_LEG.** Under `BOTH_LEGS` the recovery is the cycle itself: the
stood-down leg lets the cycle close within seconds and the next one arms both
legs on a freshly selected strike, which beats reviving a leg onto a strike that
was chosen for the opposite trend.

#### Which scope to run with the trend filter

`BOTH_LEGS` and a one-sided filter interact badly. The permitted leg takes one
round trip, then idles until its blocked partner's `legEntryTimeout` expires,
because the cycle cannot re-select until both legs are `DONE`. Simulated over ten
minutes of bullish index: **1 round trip under `BOTH_LEGS`, 19 under
`PER_LEG`.** The settings validator now says which of the two you are getting.

### R7 — `positionTimeout: 60` vs `candleTimeframe: "1m"` is a live conflict

Both are defaults in the same config block. A position opened mid-candle and
timed out at 60s will, in the large majority of cases, exit on TIMEOUT before
target or stop has had a fair chance — the strategy would mostly be measuring its
own timeout. This is flagged, not fixed: the numbers are yours. The engine will
log a startup warning when `positionTimeout < 3 × candleSeconds`.

### R8 — The index trend filter gates the *side*, never the *price*

`doc/update-point.md` adds a NIFTY trend filter on top of the candle engine: the
last three completed **5-second index candles** decide whether an entry is
allowed and which side may take it. It reconciles with R1 the same way R3 does —
by separating a gate from a price:

- **Gate (allowed):** classify the last three index bars. All three strong
  bullish → **PE only**. All three strong bearish → **CE only**. Mixed, neutral,
  a combined range over `trendMaxRangePoints`, shrinking ranges, or a bar too
  thin to have measured anything → **skip this candle**, log
  `TREND_GATE_REJECT`, wait for the next option close.
- **Price (forbidden):** the limit is still `optionCandle.close + sellOffset`.
  The document is explicit — *"the Option Candle is still used only for
  calculating the SELL price"*.

Enforced structurally, like R3: `trendFilter.verdict()` returns
`{ allowCE, allowPE, … }` and no price field; the boolean reaches
`legMachine.reduce` as `event.trendOk`, so the machine is never handed an index
price it could use. The index runs on its **own** `CandleBuilder`, separate from
the option series, so an index bar cannot be mistaken for a tradable one.

Two points of the source document do not survive contact with this feed and were
resolved with the operator:

- The quality score's **volume** term is dropped — the Kotak tick stream is
  LTP-only and there is no volume to read. The score is out of 5 (body ≥ 70%
  = +2, opposing wick < 15% = +1, close at the extreme = +2) and the document's
  threshold of 5 is unchanged, so a textbook candle still passes.
- **Thin bars.** At 5 seconds on the REST quote fallback a quiet bar can hold two
  samples, and a "60% body" drawn from two samples describes the poller. A bar
  under `trendMinTicks` is `NO_DATA` and blocks the window.

The filter ships **off** (`trendFilter: false`) and is inert when off.

#### R8a — a leg that cannot enter must stand down

R6 releases the strike lock only when **both** legs are `DONE`. A one-sided trend
filter breaks that: with `tradeMode: BOTH` and a bullish index, the PE trades and
finishes while the CE is refused on every candle close — so it never reaches
`DONE`, the lock never releases, and the engine sits on an ageing strike until
the square-off. One trade, then nothing, for the rest of the session.

`legEntryTimeout` (default 180s) fixes it: a leg that has been in `WAIT_CANDLE`
for that long without entering goes `DONE` with reason **`NO_ENTRY`** — no order,
no position, nothing to book — and the cycle closes and re-selects a strike
against the spot as it now is. The clock is stamped on every transition *into*
waiting and is deliberately **not** reset by a gate rejection; a refused candle
that restarted the timer would let a permanently blocked leg reset its own
deadline forever. A requote or a broker rejection *does* reset it: a leg that is
trading is not a leg that is stuck.

`legEntryTimeout: 0` disables the rule, and that combination with the trend
filter and `tradeMode: BOTH` is a **hard validation error**, not a warning — it
is the deadlock above, spelled out.

This also fixes a pre-existing version of the same stall: a leg whose premium
gate kept failing held the cycle in exactly the same way, which was survivable
only because the premium band drifts back on its own.

> `cycleScope: PER_LEG` is now implemented (see R6) and is the other answer to
> this deadlock: under it the trading leg keeps re-entering while the blocked one
> stands down, and the cycle closes once the trading leg stops. The two compose —
> `legEntryTimeout` releases the blocked leg either way.

### R9 — Dynamic target and trailing stop *(supersedes the fixed target in R4)*

`doc/traling-traget -stoploss.md` replaces "take one point and leave" with "let
the winner run while the index keeps confirming". The same 3×5s verdict that
gated the entry now also drives the position:

| Consecutive confirmations | Target |
|---|---|
| 1st | 1 point *(already the resting target — no move)* |
| 2nd / 3rd / 4th | 2 / 3 / 4 points |
| 5th+ | **no target at all** — trail until reversal |

Priced off the **fill**, never the live premium — the same reasoning as R1. A
level recomputable from the audit log months later beats one that depended on a
tick nobody recorded. The ladder also refuses to walk a target *backwards*: a
configuration with `target` wider than `dynamicTargetStep` would otherwise shrink
a winner on the first confirmation.

**The trailing stop** is `best + trailGap`, where `best` is the cheapest the
premium has been. It engages only once the position is `trailStart` in profit —
without that, the first tick clamps the stop a hair above entry and noise takes
the trade out — and it **never widens**. This is the document's own arithmetic:
best 18.80 → stop 19.30, best 18.00 → stop 18.50, which also lands inside its
"protect 50–70% of the unrealized" rule.

**Exits** are the reversal (the verdict no longer favours the leg's side), the
trailed stop, and `positionTimeout`. The maximum hold **outranks the ladder**: a
trailing winner is still a naked short, and an uncapped holding time is a
different risk profile than the one the rest of the engine was built for.

Two readings of the source document were resolved:

- Its "trend score → target" table is dropped in favour of the confirmations
  ladder above. The two are alternatives, and the score scale it assumes (3–7+)
  is not the 0–5 scale R8 settled on.
- Its "premium closes against you for 2 consecutive 5s candles" exit is **not**
  implemented: it would need a third candle series at 5s over the option tokens,
  and the trailing stop already covers the same ground on every tick rather than
  waiting for two closes.

#### The part that can lose money: `TARGET_MOVING`

Moving a target is a cancel followed by a place, so it goes through **the same
confirmed-cancel door as an exit** (R5). `TARGET_MOVING` is a state of its own
because that one door now leads to two different places, and conflating them is
how a leg ends up with a resting BUY *and* a market BUY — its short bought back
twice, leaving it naked long.

The rule: every exit trigger stays live in `TARGET_MOVING` — stop, timeout,
square-off, reversal — but records itself as `pendingExit` instead of sending an
order. When the cancel confirms, **a pending exit outranks the replacement**: the
leg exits and no new target is placed. A target that fills mid-move is a flat
position, not an error, from `TARGET_MOVING` exactly as from `EXITING`.

`EXIT_MARKET` still has exactly **one** construction site in `legMachine.js`, and
`test/invariants.js` I3 asserts it, plus a new companion asserting no event in
`POSITION_OPEN` can emit `PLACE_TARGET` without cancelling first.

Two more consequences of repricing a resting order, both found by audit:

- **Each rung needs its own idempotency key.** `client_ref` was
  `zo-<cycle>-<leg>-<attempt>-<stage>`, and `attemptSeq` only moves on a new
  SELL — so every rung of one ladder produced the *same* key, `place()` found
  the cancelled predecessor and returned it, and the leg would believe it held a
  target that did not exist at the broker. The key now carries a revision
  (`…-TARGET-R3`) derived from the confirmation count, so rungs differ while a
  *retry* of one rung still collapses onto a single order.
- **`positions.target_p` follows the ladder.** It was written once at the fill,
  so the trades page reported the level a position opened with rather than the
  one it was working.

#### R9a — a wedged EXITING leg must be re-driven

Pre-existing, and R9 multiplies the exposure by cancelling far more often. The
clock dispatches **nothing** to `EXITING`, and `SQUARE_OFF` from `EXITING` is a
no-op — so a leg whose target cancel came back ambiguous, or whose exit market
order failed to send, held a live naked short with no exit in flight, past the
close, forever. The comment claiming "the next clock retries the cancel" was
simply false.

`_recoverStuck` now re-drives both cases every 5s. It reads the ORDERS TABLE
rather than the in-memory leg to decide whether an order is missing: resending a
market buy that is already working buys the short back twice and leaves the
account naked long, which is worse than the wedge it is fixing. `_resume` also
re-attaches an adopted leg to its live orders, which it previously did not do at
all — every adopted leg came back believing it held none.

All of it ships **off** (`dynamicTarget: false`, `exitOnReversal: false`).

---

# 3. Gaps in the spec

Items the engine needs that no document supplies. Defaults are assumed so work is
not blocked; each is a one-line config change.

| # | Gap | Assumed default | Why it matters |
|---|---|---|---|
| G1 | **Quantity.** No `lots` or `qty` field exists anywhere. | `lots: 1`, `qty = lots × lotSize` from instrument master | Nothing can be ordered without it. |
| G2 | **Trading window.** No start/stop time. | `sessionStart: "09:20"`, `sessionEnd: "15:10"` IST | Selling into the 09:15 open or the 15:25 close is a distinct risk profile. |
| G3 | **Hard square-off.** Not specified. | `squareOffAt: "15:15"` — market-buy everything, disable for the day | A short option carried past close is an uncapped overnight risk. Non-negotiable in my view. |
| G4 | **Naked or hedged?** All docs describe naked short selling. | Naked | Margin per lot is ~10× a hedged spread's, and loss is unbounded until the SL fires. Confirm this is intended. |
| G5 | **Max cycles/day.** Not specified. | `maxCyclesPerDay: 0` (unlimited) | A ₹1 target with a ₹2 stop needs a high hit rate; unlimited cycles amplify both directions. |
| G6 | **Tick size rounding.** Not specified. | Round limit prices to 0.05 (NSE option tick) | `12.40 + 0.20 = 12.60` is fine; `12.43 + 0.20` is not a valid price and the order is rejected. |
| G7 | **Partial fills.** Not specified. | Treat any partial fill as an open position of the filled qty; cancel the remainder; size the target/SL to filled qty | A 2-lot order filling 1 lot with no rule is a silent naked leg. |
| G8 | **Cooldown after SL** is `300` in v2.0 §18 config but `15 minutes` in §16 text. | 300s (the config value) | — |
| G9 | **NIFTY weekly expiry weekday** changed with recent NSE circulars. | Never hardcode a weekday; `CURRENT_WEEKLY` = the nearest expiry present in that day's instrument master | A hardcoded Thursday silently trades the wrong contract. |

---

# 4. Architecture

Two processes over one MySQL database, mirroring the proven split next door.

```
Browser ──REST + Socket.IO──► Express app  (src/app.js, port 4100)
                                    │  reads DB, writes settings, start/stop flags
                                    ▼
                              MySQL (zoption)
                                    ▲
                                    │  owns every order, owns the WS
                              Engine  (src/engine.js)  ── single instance
                                    │
        ┌───────────────────────────┼────────────────────────────┐
        ▼                           ▼                            ▼
  Neo WebSocket              Neo REST (orders)            Instrument master
```

**The engine is the only process that places orders.** The web tier writes intent
(`start`, `stop`, `pause`, settings) and reads state. This makes the double-order
question answerable by inspection: there is exactly one writer.

### Module map (`zoption/src/`)

```
config/index.js          env access, required() throws on missing critical vars

core/
  logger.js              winston, daily rotation, one line per state transition
  db.js                  mysql2 pool, query()
  money.js               integer paise arithmetic — NO floats touch a price
  time.js                IST market clock, candle boundary alignment
  errors.js              RateLimitedError, AuthError, AmbiguousOrderError

broker/
  neoClient.js           TOTP login → MPIN/OTP validate → orders, quotes, book
  neoSession.js          encrypted token store, relogin-on-401 (once, not per call)
  rateLimiter.js         token bucket shared by REST + quote polling

market/
  instrumentMaster.js    daily download, NIFTY chain, expiry list, strike ladder, lot size
  ticker.js              WS bridge, subscribe/resubscribe, heartbeat, reconnect
  candleBuilder.js  ★    tick → OHLC per (token, timeframe); emits candle:closed
  quoteCache.js          last tick per token, with staleness age

strategy/
  expirySelector.js      CURRENT_WEEKLY | NEXT_WEEKLY | MONTHLY | MANUAL
  strikeSelector.js      ATM | ATM_OFFSET | PREMIUM
  strikeLock.js          acquire/release, DB-backed so a restart cannot double-lock
  legMachine.js     ★    PURE state machine — (state, event) → (state, actions)
  scalperEngine.js       wires ticker + candles + orders into legMachine
  riskManager.js         daily P&L, consecutive loss, cooldown, market-move pause

execution/
  orderRouter.js    ★    idempotent place/cancel; claimForPlacement; markUnknown
  positionManager.js ★   target / SL / timeout with OCO cancel-before-exit
  reconciler.js          order-book poll, fill detection, orphan recovery on boot

http/                    routes, controllers, socket server, auth
```

★ = novel to this project. Everything unstarred has a working reference
implementation next door to adapt.

### The candle builder, in detail

This is the piece that does not exist anywhere yet and it carries the whole
strategy.

- One `CandleBuilder` per `(token, timeframe)`. Timeframes 15s/30s/1m/3m/5m.
- Boundaries are **absolute wall-clock**, aligned to the IST session — a 1m bar
  is 10:15:00.000–10:15:59.999, not "60s after I subscribed". Two builders
  started a second apart must produce byte-identical bars.
- A bar closes on the **first tick at or after the boundary**, and also on a
  timer, so a dead-quiet strike still closes its bar on time.
- **The first bar after subscribe is partial and is discarded.** Its open is
  wherever the stream happened to start. The engine waits for one fully-observed
  bar before its first SELL — a documented, logged delay of up to one timeframe.
- A bar with **zero ticks** is emitted as a flat bar (`o=h=l=c=` previous close)
  and marked `synthetic: true`. **Synthetic bars never trigger an entry** — the
  close is stale by definition and offsetting from it is fiction.
- Every closed bar is written to `candles`. The dashboard chart and every
  post-mortem read the same rows the engine decided on.

### Money handling

All prices are **integers in paise** end to end. `12.40` is `1240`. Rounding to
the 0.05 tick happens once, at the boundary where a price becomes an order, and
that function is the only place `Math.round` appears in pricing code. A float
premium multiplied by a lot size and compared against a rupee limit is how P&L
silently drifts; the parent project already learned this and `money.js` comes
across with its tests.

### Order safety

Kotak Neo's place-order has no client order id, so a retry after a network error
is indistinguishable from a new order. Three-way handling, carried over from the
sibling project because it is correct and hard-won:

- **Pre-send failure** (rate limiter rejected, no HTTP call made) → reset to
  PENDING, safe to retry.
- **Ambiguous failure** (timeout, ECONNRESET, 5xx — the order *may* be live) →
  mark `UNKNOWN`, **never resend**, surface for reconciliation. The reconciler
  matches it against the order book on the next poll.
- **Confirmed failure** (broker rejected with a code) → mark FAILED, log, next
  candle.

`orderRouter.claimForPlacement(id)` atomically moves an order `PENDING →
PLACING`; a second run sees a non-PENDING row and refuses. This is what makes a
restart mid-flight safe.

---

# 5. Data model

`db/schema.sql`, all `CREATE TABLE IF NOT EXISTS`, with idempotent patch blocks in
`db/migrate.js` for anything added to a deployed table.

| Table | Purpose | Notes beyond the v2.0 SDD §19 sketch |
|---|---|---|
| `users` | login | JWT auth |
| `broker_account` | Neo credentials + session | tokens AES-256-GCM at rest; MPIN/TOTP never persisted |
| `instruments` | daily master | `(underlying, expiry, strike, option_type)` unique; `lot_size`, `tick_size`, `freeze_qty` |
| `settings` | the config block | one row per profile, versioned; engine reads at cycle start, never mid-cycle |
| `cycles` | **new** — one row per strike lock | `expiry, ce_token, pe_token, locked_at, unlocked_at, unlock_reason` |
| `legs` | **new** — CE/PE leg within a cycle | `state`, `attempt_seq`, `candle_id` that triggered entry |
| `candles` | **new** — persisted OHLC | `(token, timeframe, bucket_start)` unique; `tick_count`, `synthetic` |
| `orders` | every order | `client_ref` unique (`zo-<cycle>-<leg>-<attempt>-<stage>`), `status`, `filled_qty`, `filled_price`, `unknown_reason` |
| `positions` | open/closed exposure | `entry`, `exit`, `target`, `sl`, `qty`, `pnl_paise`, `exit_reason` |
| `daily_stats` | risk state | `realized_pnl`, `trade_count`, `consecutive_losses`, `cooldown_until`, `disabled_reason` |
| `events` | audit trail | every state transition: `cycle_id, leg, from_state, to_state, reason, payload, ts_ms` |

`events` is not a nice-to-have. "Maintain complete audit logs for every state
transition" appears in the engineering rules of three separate documents, and
after a bad day it is the only way to answer *why did it sell there*.

---

# 6. Configuration

Merged from all four documents, with the reconciliations and gaps folded in.
New or changed keys marked.

```jsonc
{
  "symbol": "NIFTY",
  "expiryMode": "CURRENT_WEEKLY",     // | NEXT_WEEKLY | MONTHLY | MANUAL
  "manualExpiry": null,
  "tradeMode": "BOTH",                // | CE | PE

  // ---- selection (runs once per cycle) ----
  "strikeMode": "PREMIUM",            // | ATM | ATM_OFFSET
  "atmOffset": 2,
  "targetPremium": 12,
  "premiumTolerance": 2,

  // ---- entry: candle only ----
  "entryMode": "OPTION_CANDLE_CLOSE",
  "priceSource": "CANDLE_CLOSE",
  "candleTimeframe": "1m",            // 5s | 15s | 30s | 1m | 3m | 5m
  "sellOffset": 1.0,
  "useLiveAsk": false,                // asserted at boot; true => refuse to start
  "useLiveBid": false,
  "useLTP": false,
  "lockStrike": true,
  "reQuoteOnNextCandle": true,
  "pendingTimeout": 10,
  "legEntryTimeout": 180,             // R8a, new — a leg that never gets
                                      // permission stands down (NO_ENTRY) so the
                                      // cycle can unlock. 0 = never.

  // ---- the NIFTY index trend filter (R8, new) ----
  // Decides WHETHER a side may sell. Never contributes a price.
  "trendFilter": false,               // ships off; inert when off
  "trendTimeframe": "5s",
  "trendConfirmBars": 3,              // all must agree
  "trendMinTicks": 4,                 // fewer = the bar measured nothing
  "trendBodyPct": 60,                 // classification: body share of range
  "trendCloseNearPct": 25,            // classification: close near the extreme
  "trendMaxRangePoints": 10,          // COMBINED across the window, not per bar
  "trendMomentum": true,              // skip when the bars' ranges keep shrinking
  "trendStrongBodyPct": 70,           // score: the +2 body term
  "trendWickPct": 15,                 // score: the +1 wick and +2 extreme terms
  "trendMinScore": 5,                 // out of 5, every bar; 0 = direction only

  // ---- exits: tick driven ----
  // The documents say 1.0 / 2.0. Shipped as 1.5 / 1.5 — losing two to win one
  // needs a 67% hit rate, and on a zero-brokerage plan that is a risk/reward
  // choice, not a charges one. See doc/HOW-IT-WORKS.md §12.
  "target": 1.5,
  "stopLoss": 1.5,
  "positionTimeout": 60,               // outranks the ladder, always

  // ---- dynamic target and trailing stop (R9, new) ----
  "dynamicTarget": false,              // ships off
  "dynamicTargetStep": 1.0,            // points added per confirmation
  "dynamicTargetMax": 4,               // past this: no target, trail only
  "trailStart": 0.5,                   // profit before the trail engages
  "trailGap": 0.5,                     // stop = best premium + this; 0 = no trail
  "exitOnReversal": false,             // leave when the index trend turns

  // ---- sizing (G1, new) ----
  "lots": 1,

  // ---- session (G2, G3, new) ----
  "sessionStart": "09:20",
  "sessionEnd":   "15:10",
  "squareOffAt":  "15:15",

  // ---- risk ----
  "maxOpenCE": 1,
  "maxOpenPE": 1,
  "marketMovePause": 40,              // NIFTY points…
  "marketMoveWindow": 30,             // …within this many seconds
  "cooldownAfterSL": 300,
  "maxDailyLoss": 3000,
  "maxDailyProfit": 5000,
  "maxConsecutiveLoss": 3,
  "maxCyclesPerDay": 0,               // 0 = unlimited (G5, new)

  // ---- cycle scope (R6, new) ----
  "cycleScope": "BOTH_LEGS",          // | PER_LEG
  "cycleMaxAge": 900,                 // PER_LEG: how long one locked strike may
                                      // keep being re-used. 0 = forever.

  // ---- mode ----
  "mode": "PAPER"                     // | LIVE   (new — see M4)
}
```

---

# 7. State machine

`legMachine.js` is a pure function: `(state, event, ctx) → { state, actions[] }`.
No I/O, no clock, no network. Time and prices arrive as events. This is what
makes the strategy testable without a broker, and it is the difference between a
suite that runs in 200ms and one that needs a live market.

```
                       IDLE
                        │ cycle armed, strike locked, subscribed
                        ▼
              WAIT_CANDLE_CLOSE ◄──────────────────────┐
                        │ candle:closed (real, not synthetic)
                        ▼                              │
                  PREMIUM_GATE ──reject──────────────► │
                        │ pass                         │
                        ▼                              │
                 PLACE_SELL_LIMIT                      │
                        │                              │
                        ▼                              │
                   SELL_WORKING                        │
                   │        │                          │
      pendingTimeout│        │fill                     │
                   ▼        ▼                          │
              CANCEL_SELL   POSITION_OPEN              │
                   │            │                      │
                   └────────────┼──── cancel ok ───────┘
                                │        (wait for NEXT close — R2)
                                │
              ┌─────────────────┼──────────────────┐
              │ target fill     │ tick ≥ SL        │ timeout / square-off
              ▼                 ▼                  ▼
         CLOSED_TARGET   CANCEL_TARGET → EXIT_MARKET → CLOSED_SL / CLOSED_TIMEOUT
              │                                     │
              └──────────────────┬──────────────────┘
                                 ▼
                             LEG_DONE
                                 │ both legs done (R6)
                                 ▼
                          UNLOCK → next cycle
```

Every arrow writes one `events` row.

---

# 8. Milestones

Single developer, working days. Sequential unless noted.

### M0 · Skeleton and spec freeze — 2d
Repo scaffold, `package.json`, config module, logger, db pool, `schema.sql` +
`migrate.js`, `.env.example`, empty Express app on 4100.
**Also: you sign off §2 and §3.**
✅ `npm run migrate` is idempotent; `npm start` serves a health page.

### M1 · Broker connectivity — 3d
`neoClient` (TOTP → MPIN/OTP → session), `neoSession` with encrypted tokens and
relogin-on-401, rate limiter, instrument master download + parse, expiry list and
strike ladder for NIFTY, quotes endpoint.
✅ A script prints today's NIFTY expiries, the ATM strike, and the live premium of
one CE with its lot size.

### M2 · Market data and the candle engine — 3d  ← *the technical core*
WS ticker with reconnect/resubscribe, quote cache with staleness, `candleBuilder`
with aligned boundaries, partial-first-bar discard, synthetic-bar marking, and
persistence to `candles`.
✅ Subscribe to two strikes for 30 minutes; every 1m bucket has exactly one row;
boundaries align to the wall clock; two builders started seconds apart agree
bar-for-bar; replaying a recorded tick file reproduces the same bars byte for
byte.

### M3 · Selection and lock — 2d
`expirySelector`, `strikeSelector` (all three modes), `strikeLock` backed by a DB
row so a restart cannot double-lock.
✅ Given a spot and a chain, each mode picks the documented strike; PREMIUM mode
with no strike in tolerance returns *no trade* rather than a nearest guess.

### M4 · Order layer and **paper mode** — 4d
`orderRouter` with `claimForPlacement`, the three-way failure handling, tick-size
rounding, and `client_ref` idempotency. `reconciler` polling the order book.
A `PAPER` broker adapter that fills a limit order when a real tick trades through
it, using the real tick stream.

> The v2.0 SDD lists paper trading under *future enhancements*. It belongs here
> instead. A strategy whose entry depends on candle boundaries and whose exits
> depend on a 60-second clock cannot be validated by reading code, and validating
> it with real money at ₹1 a trade is the expensive way to find the bugs. Paper
> mode costs about a day and pays for itself the first time it catches a
> boundary-alignment error.

✅ Paper mode round-trips an order; a killed process mid-place leaves exactly one
order after reconcile; an injected timeout produces `UNKNOWN` and never a resend.

### M5 · Entry state machine — 4d
`legMachine` (pure), `scalperEngine` wiring, the premium gate, requote-on-next-
candle, `PLACE_SELL_LIMIT` fed only by `calculateSellPrice(candle, offset)`.
✅ Unit suite drives the machine through fill, no-fill-requote, gate reject,
synthetic bar, and WS gap paths with zero I/O. A static-analysis test asserts no
quote/LTP symbol is reachable from the pricing function.

### M6 · Position manager and cycle restart — 3d
Resting target on fill, tick-driven SL, timeout, **OCO cancel-before-exit (R5)**,
partial-fill handling (G7), unlock and next cycle, hard square-off (G3).
✅ Forced race tests: target fills during SL cancel → no second order, position
flat, `TARGET_WON_RACE` logged. Square-off flattens everything and disables.

### M7 · Risk controls — 2d
Daily loss/profit cut-off, consecutive-loss cooldown, market-move pause
(40 pts / 30s), max open per leg, session window, `maxCyclesPerDay`.
✅ Each limit is provably enforced by a test that trips it and asserts no further
entry is attempted while positions keep being managed.

### M8 · Dashboard and API — 3d
The v2.0 §20 API surface (`/start /stop /pause /status /settings /orders
/positions /logs /pnl`), Socket.IO push, EJS dashboard with the §21 widgets:
live NIFTY, expiry, ATM, locked strike, current premium, working orders, open
position, today's P&L, risk state, WS status, API latency — plus a candle chart
rendered from the `candles` rows the engine actually decided on.
✅ Start/stop from the browser; the strike lock, the triggering candle and the
computed limit are visible in real time.

### M9 · Paper soak and go-live — 3d + 1 week soak
Five sessions in `PAPER` against the live tick stream. Then one session `LIVE` at
`lots: 1` with `maxDailyLoss` set to something you would not mind losing.
✅ Paper P&L reconciles against a manual replay of the `candles` and `events`
tables; no `UNKNOWN` orders; no unexplained state transitions.

**Total: ~29 working days ≈ 6 calendar weeks**, plus the soak.

### Mapping to the SDD's own phases

| SDD phase | Milestones |
|---|---|
| Phase 1 — login, WS, instruments, scanner | M1, M2, M3 |
| Phase 2 — strike, offset, orders, positions | M4, M5, M6 |
| Phase 3 — target, SL, risk, dashboard | M6, M7, M8 |
| Phase 4 — analytics, reporting, notifications | post-M9 backlog |

---

# 9. Testing

`node --test`, no framework. Three layers:

1. **Pure unit** — `money`, `time`/boundaries, `calculateSellPrice`,
   `strikeSelector`, `legMachine`. Milliseconds, no I/O, run on every save.
2. **Recorded-tick replay** — a captured session of raw WS frames replayed
   through `candleBuilder` and the engine. Deterministic, catches boundary and
   ordering bugs, and is the regression net when the candle code is touched.
3. **Fault injection** — timeout mid-place, WS drop mid-candle, 401 mid-order,
   process kill between claim and send, target/SL race. Each has a named test.

Three invariants get dedicated tests because a violation costs money:

- **I1** — no order is ever placed at a price derived from a quote, tick or LTP.
- **I2** — no cycle ever has two working SELL orders on one leg.
- **I3** — no exit market-buy is sent while a target order is still working.

---

# 10. Risks

| Risk | Impact | Handling |
|---|---|---|
| **Slippage eats the edge.** ₹1 target, ₹2 stop, ~₹0.05 tick, plus brokerage, STT on the sell, exchange and stamp charges. **Brokerage is the swing factor** — see the note below this table. | Strategy is unprofitable even when the logic is perfect | Charges model built into P&L; the engine reports **net**, never gross, and warns at boot when the target does not cover modelled breakeven. Decide viability from paper results, on net numbers. |
| **Limit at close+offset may rarely fill.** Selling above the market only fills if the premium rises into it. | Few entries, or entries only when the market moves against you | Instrument the fill rate from M5. It is the first metric to read in M9. |
| **Naked short with a market-order stop.** A gap through the SL fills far worse than the SL price. | Loss exceeds `stopLoss` × lot | G4 asks whether hedging is wanted. `maxDailyLoss` is the backstop, and it must be set to a real number, not the ₹3000 placeholder. |
| **WS gap during a bar.** Missing ticks silently distort the close the engine trades on. | Wrong entry price | `tick_count` per bar; bars below a threshold are marked low-confidence and skipped for entry. |
| **Neo session expiry mid-session.** | Orders fail, position unmanaged | Relogin-on-401 marks EXPIRED once and re-auths; if re-auth fails with a position open, alert loudly and keep retrying — never silently stop managing. |
| **Sub-minute timeframes.** 15s/30s bars make every latency in the chain material. | Entries on stale closes | Ship 1m first. Enable 15s/30s only after M9 shows the round trip fits inside a bar. |
| **Single engine instance.** Two engines would double every order. | Duplicate positions | DB `engine_locks` row with a heartbeat; a second instance refuses to start. |

### The brokerage plan changes the verdict

Brokerage is a **flat fee per order**, so it dominates the cost of a small trade
and the breakeven *move* in premium points scales as roughly 1/quantity. Which
plan the account is on therefore decides whether a ₹1 target is a strategy or a
rounding error:

| Plan | Breakeven on 1 NIFTY lot | Against a ₹1 target |
|---|---|---|
| ₹20 per order | ~0.75 points | Most of the edge is gone; a "win" can be a realised loss |
| Zero brokerage | ~0.03 points | Comfortable — cost is purely proportional to turnover |

The configured account runs **zero brokerage** (`CHG_BROKERAGE_PER_ORDER=0`),
which is the favourable column. Two consequences:

- The original concern that a one-point target cannot cover its own costs does
  **not** apply at this schedule. Breakeven is a few paise.
- Breakeven stops scaling with size, so `lots` becomes a pure risk decision
  rather than a cost-efficiency one.

Both cases are asserted in `test/money.test.js`, and the charge schedule is
pinned in the test harness rather than read from `.env` — otherwise changing
plans would silently change what the suite claims to verify.

---

# 11. What I need from you

Blocking before M5 (the entry logic):

1. **§2 rulings R1–R7** — approve, or tell me which flip.
2. **G1 `lots`**, **G3 square-off time**, **G4 naked vs hedged**, **G5 max cycles**.
3. **R7** — reconsider `positionTimeout: 60` against `candleTimeframe: "1m"`.

Not blocking, needed by M1: Kotak Neo credentials for a **non-trading or
minimally-funded account** for development.

---

*Nothing in this plan has been built yet. `zoption/` currently contains only
`doc/`.*
