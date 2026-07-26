# Full flow

Every path through the system, end to end, with the file and function that owns
each step. Read alongside [`ARCHITECTURE.md`](ARCHITECTURE.md), which explains
*why* the shapes are what they are.

---

## 0. Processes

```
┌─────────────────────────┐         ┌──────────────────────────┐
│  npm start   (web)      │         │  npm run engine (trading)│
│  src/app.js             │         │  src/engine.js           │
│  · UI + JSON API        │         │  · leader lock           │
│  · broker logins        │         │  · 1s tick loop          │
│  · strategy CRUD        │         │  · ALL order placement   │
└───────────┬─────────────┘         └────────────┬─────────────┘
            │                                    │
            └──────────► MySQL ◄─────────────────┘
                    the only channel
```

The web tier never places an order. The engine never serves a request. Neither
holds the other's state in memory.

---

## 1. Boot

### Web (`src/app.js`)
1. `src/config` reads and **validates** every environment value; a missing
   `TOKEN_ENC_KEY` or a `JWT_SECRET` under 32 chars exits with a list rather
   than failing later.
2. `db.healthCheck()` — refuses to start against an unreachable database.
3. Express: helmet CSP (self-only, no CDN), JSON body cap 256 kB, cookie parser,
   static files, `auth.loadUser`, routes, error handler.
4. A 6-hour timer purges `strategy_events` past `EVENT_RETENTION_DAYS`.

### Engine (`src/engine.js`)
1. Same config + database checks.
2. `feed.attach()` for every user with a live Kite session, so the first tick has
   prices rather than an empty cache.
3. `supervisor.start()` — one immediate tick (fail fast), then every
   `ENGINE_TICK_MS`.
4. A 6-hour timer purges events and `tick_history`.
5. `uncaughtException` → **exit**. With money in the market the safe move is to
   die and be restarted into reconciliation, not to limp on.

---

## 2. Sign-in

```
GET  /login          authController.showLogin    first run? offer registration
POST /register       authController.register     FIRST account only, then closed
POST /login          authController.login        scrypt verify, constant-time
                     auth.issue()                JWT in an httpOnly SameSite=Lax cookie
```

An unknown email and a wrong password return the same message — distinguishing
them tells an attacker which accounts exist. Both routes are rate-limited to 20
attempts per 15 minutes.

---

## 3. Connecting the brokers *(daily)*

### Zerodha — market data
```
POST /api/brokers/zerodha/credentials   api_key + api_secret, AES-256-GCM at rest
    ↓
GET  kite.zerodha.com/connect/login     operator approves, is redirected back
    ↓
POST /api/brokers/zerodha/connect       { requestToken }
     kiteClient.generateSession()       sha256(api_key + request_token + api_secret)
     probeZerodha()                     ── TWO checks, not one ──
        /user/profile   → is the token alive?
        /quote/ltp      → may it read prices?   ← the paid subscription
     repo.brokers.saveZerodhaSession()  status CONNECTED
     feed.attach()                      ticker up immediately
```

The two-stage probe exists because they fail independently: without the
market-data subscription the login succeeds and the ticker then answers a bare
`403 Authentication failed`, which is indistinguishable from an expired token
and is **not** fixed by logging in again.

### Kotak Neo — execution
```
POST /api/brokers/kotak/connect   { mobile, ucc, totp, mpin }
     neoClient.tradeApiLogin()     → view token + sid
     neoClient.tradeApiValidate()  → session token, sid, per-user baseUrl
     repo.brokers.saveKotakSession()
```
Both legs run in one request because a TOTP is valid for ~30 seconds. **TOTP and
MPIN are never written anywhere** — they go out of scope when the handler returns.

### Instruments — the bridge
```
POST /api/instruments/sync
     repo.instruments.now()              cutoff from the DATABASE clock
     instrumentStore.syncZerodha()       NFO + BFO options, NSE + BSE index rows
     instrumentStore.syncKotak()         nse_fo + bse_fo, 1980-epoch expiry decode
     repo.instruments.pruneStale(cutoff) drop contracts neither master listed
     repo.instruments.refreshTradableFlags()
```

Both sides write into **one row** keyed on `(underlying, expiry_date, strike,
option_type)`. Only a row with both brokers' tokens is `tradable`; the scanner
refuses everything else, because a strike it can quote but not order is a trap.

---

## 4. Creating a strategy

```
POST /api/strategies
     strategyConfig.normalise()   drop unknown keys, coerce types
     repo.instruments.lotSize()
     strategyConfig.validate()    → 400 with the first problem
```

Validation rejects configurations that are *inert* rather than merely unusual:

| Rule | Why |
| --- | --- |
| `armPrice` inside `[premiumMin, premiumMax]` | outside it, the strategy arms instantly or never |
| `hedgePremium < premiumMin` | a hedge as dear as the short inverts the spread |
| session windows inside 09:15–15:30 IST | outside there are no quotes; a square-off after the close never fires |
| target above breakeven *(when `coverCharges` is off)* | otherwise a "win" is a realised loss |

`GET /api/strategies/economics` prices the round trip live as the form is typed.

---

## 5. The tick — one pass of the engine

`supervisor.tick()`, every `ENGINE_TICK_MS`:

```
1. repo.locks.acquire('engine', id, ttl)     am I the leader?
      not acquired → stand by, do nothing
2. repo.flags.isTradingHalted()              kill switch
3. syncRunners()                             adopt DB changes
4. per user, SERIALLY:
      feed.attach(userId)                    ticker (null if the session is dead)
      kotakSession(userId)                   cached 60s
      holder = first runner in an EXPOSED state      ← the position queue
      for each runner by (queue_priority, id):
          runner.tick({ hasPositionSlot: !holder || holder.id === runner.id })
```

Strategies are never ticked in parallel: they share a broker rate limit and one
position book, and interleaving order placement with position reads would make
fill-price differencing wrong.

### Inside `runner.tick()`

```
loadFacts()      open trade, daily stats, spot, short quote (with its AGE)
  ↓
claimSquareOff() atomic — an operator override jumps the state machine
  ↓
decide(facts)    PURE. no clock, no database, no broker
  ↓  action === SCAN?  → runScan(), rebuild facts, decide again
applyOutcome()   perform exactly ONE action
  ↓
persist()  +  audit()
```

---

## 6. The trade, state by state

```
IDLE / SCANNING
   ├─ not a trading day / feed down / outside the window   → stay
   ├─ halted / risk gate / cooldown / queued               → stay, with the reason
   └─ scanner.findCandidate()
         selectStrike : OTM, tradable, fresh quote, premium in range,
                        NEAREST the arm price, ties to the farther strike
         selectHedge  : same type, further OTM, cheaper than the short,
                        by strike distance or by premium
      ↓
STRIKE_SELECTED
   └─ action PLACE_HEDGE                                    ← INVARIANT 1
      ↓
HEDGE_PENDING  ── orderRouter.place(BUY hedge) ──┐
   │                                             │ rejected → IDLE + cooldown
   │                                             │ uncertain → UNKNOWN, reconcile
   └─ placed → repo.trades.open()  status HEDGE_OPEN
      ↓
HEDGE_OPEN → ARM_WAIT
   ├─ past lastEntry / squareOff / armTimeout → EXIT_HEDGE (unwind the lone hedge)
   ├─ quote stale                             → hold
   └─ ltp ≤ armPrice                          → ARMED, record the low
      ↓
OFFSET_WAIT
   ├─ track the low since arming
   ├─ same abandonment guards
   └─ ltp ≥ trigger        ARM: armPrice + offset   (the doc's rule)
                           LOW: lowSinceArmed + offset
      ↓
SHORT_PENDING ── orderRouter.place(SELL short) ──┐
   │                                             │ failed → unwind the hedge
   └─ filled
        money.resolveTargetPoints()   ← target computed from the REAL fills and
        target = fill − points          never below the four-leg breakeven
        stop   = fill + stoploss
      ↓
POSITION_OPEN
   ├─ ltp ≤ target      → EXIT_SHORT (target)
   ├─ ltp ≥ stop        → EXIT_SHORT (stoploss)
   ├─ squareOff reached → EXIT_SHORT (time)      ← fires even on a stale quote
   └─ quote stale       → hold; target and stop are NOT evaluated
      ↓
EXIT_SHORT ── BUY back the short ──┐             ← INVARIANT 2
   │                               ├─ rejected  → back to POSITION_OPEN, hedge KEPT
   │                               └─ uncertain → HALTED, NEEDS_ATTENTION
   └─ filled
      ↓
EXIT_HEDGE ── SELL the hedge ──
   money.tradePnl()  both legs + all four legs of charges
   riskManager.applyTradeResult()  →  daily_stats
   riskManager.nextEntryAllowedAt() →  cooldown, or the rest of the IST day
      ↓
COMPLETE → IDLE
```

---

## 7. Placing one leg

`orderRouter.place()`:

```
1. repo.orders.reserve()      INSERT with a UNIQUE client_order_id
                              s<id>-<YYYY-MM-DD>-a<attempt>-<stage>
                              duplicate → adopt the existing row, never resend
2. claimForSend()             NEW → SENDING, conditional; one winner
3. kill switch                opening orders only; exits always pass
4. paper mode?                write a PLACED row and stop — same shape as live
5. rate limiter               refusal here is PRE-SEND, so a retry is safe
6. position book BEFORE
7. neoClient.placeOrder()
      BrokerRejectedError  → REJECTED   nothing is live
      BrokerUncertainError → UNKNOWN    may be live — NEVER resent
      BrokerAuthError      → mark the session expired, rethrow
8. position book AFTER
9. fill = Δamount / Δquantity          ← this order's fill, not the day's average
```

---

## 8. Recovery after a restart

```
state ∈ {HEDGE_PENDING, SHORT_PENDING, EXIT_SHORT, EXIT_HEDGE}
   → decide() returns RECONCILE and refuses to advance
   → reconciler.resolveOrders()
        exactly one broker order matches (token, side, qty)  → adopt it
        none, and the position is flat                       → never placed
        none, but the position suggests a fill               → NEEDS_ATTENTION
        several match                                        → NEEDS_ATTENTION
   → no trade row, but orders were PLACED                    → HALTED (orphan)
   → verifyTradeLegs() against the broker's position book:
        short open → POSITION_OPEN
        hedge only → ARM_WAIT
        neither    → HALTED, NEEDS_ATTENTION
```

Positions are deliberately **not** squared off on shutdown. A restart is not a
reason to exit at market.

---

## 9. Operator controls

| Control | Path | Effect |
| --- | --- | --- |
| Halt trading | `POST /api/halt` | blocks opening orders; **exits always pass** |
| Square off | `POST /api/strategies/:id/square-off` | own columns, claimed atomically; exits via the normal leg order |
| Disable | `POST /api/strategies/:id/toggle` | no new entries; an open position is still managed to its exit |
| Test connection | `POST /api/brokers/zerodha/verify` | two-stage probe, reports which stage failed |

---

## 10. What the operator sees

| Page | Refresh | Shows |
| --- | --- | --- |
| `/` Live | 1.5 s | engine heartbeat, both broker states, per-strategy state rail, open legs, today's P&L |
| `/strategies` | on demand | CRUD, templates, live round-trip cost |
| `/trades` | 10 s | both legs of every trade, charges, net |
| `/events` | 5 s | the full audit trail, filterable |
| `/brokers` | 5 s | connections, instrument bridge coverage |

Every state transition, arm, offset trigger, order and exit decision is written
to `strategy_events` with the price that caused it.

---

## 11. Daily routine

1. `/brokers` → Zerodha login *(token expires ~06:00 IST)*
2. `/brokers` → Kotak login
3. `/brokers` → **Sync instruments**, confirm the bridged count
4. `/strategies` → enable
5. `/` → watch

Both processes must be running. `npm start` alone gives a console where nothing
ever trades.
