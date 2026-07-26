# Architecture

Design notes for Premium Range Trader. The user-facing guide is
[`../README.md`](../README.md); this document explains *why* the pieces are
shaped the way they are.

---

## 1. The central constraint: two brokers, no shared identifier

Zerodha has the better feed. Kotak Neo is where the account is. So the platform
quotes from one and orders on the other — and immediately hits the problem that
defines its data model:

* Zerodha's ticker addresses an option by a numeric `instrument_token`
* Kotak's order API needs its own `pSymbol` token plus a trading symbol
* **Nothing links them.** No shared id, no cross-reference, no mapping service.

The only thing both brokers agree on is what the contract *is*. So that is the
join key:

```sql
(underlying, expiry_date, strike, option_type)
```

Both instrument masters are ingested into a single `instruments` table from
opposite sides. A row with both sides populated is `tradable`; anything else is
quotable-but-not-orderable (or the reverse) and **the scanner refuses to select
it**. That refusal matters: without it a strategy would find a perfect strike,
arm on it, and then discover at the moment of execution that it cannot be
ordered.

`/api/instruments/bridge` reports coverage so a bad sync is visible before it
costs a trade rather than after.

---

## 2. Pure core, impure shell

The strategy's decision logic is a pure function:

```js
decide({ state, config, session, market, candidate, trade, runtime, risk, halted, now })
  → { next, action, reason, patch }
```

No clock, no database, no broker, no randomness. The runner gathers the facts,
calls `decide`, performs the one action that comes back, and writes down what
happened.

This split is not stylistic. It is what makes the specification's own worked
example executable as a test:

```js
// 41 → 40.70 → 40.30 → 40.00 [ARMED] → 39.90 → 40.10 → 40.30 → 40.50 [SELL]
assert.deepEqual(seen, [ARM_WAIT, ARM_WAIT, ARM_WAIT, OFFSET_WAIT,
                        OFFSET_WAIT, OFFSET_WAIT, OFFSET_WAIT, SHORT_PENDING]);
```

The same applies to the scanner (`selectStrike` / `selectHedge` over a chain
snapshot), the risk gates, and the charge maths. Everything that decides money
is testable without a market.

**Pure:** `strategy/stateMachine.js`, `strategy/scanner.js`,
`strategy/riskManager.js`, `strategy/config.js`, `core/money.js`, `core/time.js`

**Impure:** `strategy/strategyRunner.js`, `strategy/supervisor.js`,
`execution/*`, `market/*`, `brokers/*`, `repositories/*`

---

## 3. Two processes

| Process | Owns | Restartable |
| --- | --- | --- |
| `src/app.js` | UI, JSON API, broker logins, config | freely |
| `src/engine.js` | every order, all strategy state | with care |

They communicate **only through the database**. The web tier never calls a
broker's order API and never holds strategy state in memory. A wedged HTTP
request, a deploy, or a crash from a malformed body cannot touch a live
position.

Operator actions that need the engine — square-off, for instance — are written
as a flag on the strategy row and picked up on the next tick. That is slower
than a direct call by up to one second, and correct under every failure mode a
direct call would not survive.

---

## 4. Place at most once

Kotak's place-order API carries **no client reference**. A resend after a
timeout creates a second live order that cannot be distinguished from the first.
Four layers prevent that:

1. **A row is inserted before anything is sent**, with a `UNIQUE` constraint on
   `(user_id, client_order_id)`. The key is deterministic:
   ```
   s<strategyId>-<YYYY-MM-DD>-a<attemptSeq>-<stage>
   ```
   The same stage of the same attempt can never produce two orders — the
   *database* refuses it, which is the only check that survives a process
   restart or a second engine.

2. **`NEW → SENDING` is a conditional UPDATE.** Only one caller wins the claim.

3. **Failures are classified**, and only one class is retryable:

   | Outcome | Meaning | Action |
   | --- | --- | --- |
   | `BrokerRejectedError` | the broker said no | nothing is live; react |
   | `RateLimitedError` | refused *locally*, before sending | safe to retry |
   | `BrokerUncertainError` | request left, no answer came back | **never resend** |

4. **The reconciler** resolves the uncertain ones against the broker's order
   book — see §6.

Fill prices come from the position book *differenced across the order*, not from
the pre-trade quote. The broker reports a day-cumulative average; using it
directly would contaminate every trade after the first.

---

## 5. The two hedge invariants

These are the reason the state machine has as many states as it does.

**Invariant 1 — the hedge goes on first.**
`STRIKE_SELECTED → HEDGE_PENDING → HEDGE_OPEN → ARM_WAIT`. The short cannot be
reached without passing through a confirmed hedge. If the short is then
rejected, `unwindLoneHedge` sells the hedge back and the attempt is recorded
`ABORTED`.

There is a test asserting that no state outside the hedged path will ever
produce a `PLACE_SHORT` action, even with the price sitting exactly on the
trigger.

**Invariant 2 — the hedge comes off last.**
`POSITION_OPEN → EXIT_SHORT → EXIT_HEDGE`. If the buy-back fails, the hedge is
**not** sold: it is the only thing capping the loss on a short that is still
live. The strategy returns to `POSITION_OPEN` and retries.

The same rule covers the case the doc does not discuss — a hedge that filled but
whose arm price never arrived. At `lastEntryTime`, `squareOffTime` or
`armTimeoutSec`, the lone hedge is unwound rather than carried.

---

## 6. Recovery

Restarting mid-trade is normal, not exceptional. Three mechanisms:

**In-flight states.** `HEDGE_PENDING`, `SHORT_PENDING`, `EXIT_SHORT` and
`EXIT_HEDGE` mean the process died between "about to send" and "know the
answer". `decide` returns `RECONCILE` for all four and refuses to advance until
the broker has been asked.

**Order matching.** Kotak has no client reference, so an `UNKNOWN` order is
matched on `(token, side, qty)` against the day's order book, excluding
cancelled and rejected rows. Broker timestamp formats vary too much to narrow it
further, so this is a heuristic and is treated as one:

* exactly one candidate → adopt the broker's order id
* zero candidates, flat position → it never landed; mark not placed
* zero candidates, position suggests a fill → **flag for a human**
* several candidates → **flag for a human**

Guessing wrong here means either abandoning a live short or double-closing one,
so an ambiguous match sets `NEEDS_ATTENTION` and halts the strategy.

**Position truth.** After reconciling, the recovered state comes from the
broker's position book, not from our last written state.

---

## 7. Concurrency

**One engine trades.** A DB-backed leader lock, refreshed every tick. Standby
engines observe and take over within `ENGINE_LOCK_TTL_MS` if the leader stops
heartbeating. Two engines would race to place the same orders, and the
per-order key would not save us because each would maintain its own attempt
sequence.

**One position per user.** The doc's "if one strategy is active, others wait".
Whoever already holds exposure keeps the slot; otherwise the lowest
`queue_priority` wins.

**Serial ticks.** Strategies run one after another, never in parallel. They
share a broker rate limit and a position book, and interleaving order placement
with position reads would make fill-price differencing wrong.

**Disabling never abandons.** A strategy disabled mid-trade keeps being managed
to its exit; only new entries stop.

---

## 8. Charges are a first-class concern

`core/money.js` exists because of one fact: a hedged round trip is four orders,
brokerage is flat per order, so the breakeven *move* scales as `1/quantity`.

The doc's default — a 2-point target on 2 BANKNIFTY lots — is ₹60 gross against
~₹97 of charges. **A losing trade that reports as a win.**

Handled in four places:

1. defaults ship above breakeven (5 points target, 12 stop);
2. `coverCharges` recomputes the target from the *actual fills* at entry and
   raises it to clear the round trip plus a buffer, so changing `lots` cannot
   silently invalidate it;
3. the strategy form prices the round trip live;
4. with `coverCharges` off, an under-breakeven target is a save-time error.

When the target is lifted, an audit event records the configured value, the
value used, the breakeven and the charges — the decision is never silent.

---

## 9. Staleness

A price with no age attached is dangerous. Every quote carries `ageMs`, and:

* the scanner will not select a strike whose quote is older than
  `maxQuoteAgeMs`;
* the arm and offset triggers will not fire on a stale quote;
* **target and stop are not evaluated on a stale quote** — acting on a
  minutes-old print can exit at a level that no longer exists;
* **the square-off time fires regardless** — the alternative is carrying an
  intraday position past the close because the feed went quiet.

The ticker also watches its own heartbeat: Kite sends one about every second, so
silence past the timeout means a half-open socket. It is torn down and
reconnected rather than left to go quietly stale, which for a feed is the
difference between "no data" and "wrong data".

---

## 10. Why a REST poll runs alongside the WebSocket

The ticker only pushes when a price *changes*. An illiquid far strike can go
minutes without a tick — but the scanner needs a value for every candidate on
every pass, and a strike with no price is silently excluded. That would quietly
bias selection toward whatever happens to be trading, which is not the
selection rule the doc specifies. `/quote/ltp` tops up the gap; one HTTP call
covers 200 instruments.

---

## 11. Two Zerodha failure modes that look identical

Kite Connect separates "may this token log in" from "may this token read
prices", and only the first is free. Without the market-data subscription:

* `/user/profile` succeeds — the token really is valid
* `/quote/ltp` returns `Insufficient permission for that call.`
* the WebSocket returns a bare `403 {"status":"error","message":"Authentication failed."}`

That 403 is indistinguishable from an expired token at the socket layer, and
the two have opposite fixes: one is solved by logging in again, the other never
will be. Three consequences in the design:

1. **The ticker names both causes** in its failure message rather than
   asserting the more likely one, and points at the two-stage check.
2. **`connect` and `verify` probe both stages** — profile *and* a real quote.
   Checking only the profile is how a broken setup gets reported as healthy;
   the platform would then sit in `SCANNING` all session with no explanation.
3. **An auth failure latches.** The ticker reports once and stops; retrying a
   rejected token forever produces nothing but a wall of identical warnings,
   and `feed.attach` refuses to rebuild a ticker for a session already marked
   `EXPIRED`/`ERROR` — otherwise the engine's per-tick attach would recreate it
   once a second.

## 12. Stale instrument rows are a safety problem

A row in `instruments` carrying both brokers' tokens looks perfectly tradable to
the scanner, whether or not the contract still exists. An expired series, a
delisted strike, or a row left behind by a test would all be selectable — and
the fake Kotak token would then be sent as a real order.

So a successful sync **prunes option rows neither master listed**, guarded two
ways: the prune only runs if the Zerodha sync returned a plausible number of
rows (a truncated download must not empty the universe), and the cutoff comes
from the *database's* clock, not the application's, because `synced_at` is set
with `NOW()` on the server.

## 13. What is not built

Stated plainly rather than left to be discovered:

* **No backtester.** `tick_history` records the monitored legs, which is enough
  to explain a trade after the fact but not to replay a full chain.
* **No multi-account fan-out.** The schema is per-user throughout, but nothing
  distributes one signal across several broker accounts.
* **No live-API verification.** The Kotak order path and Kite ticker are written
  to the documented contracts and unit-tested against synthetic frames, but have
  not placed a real order or received a real tick. Paper mode first.
* **No exchange holiday calendar.** There is no reliable free source, and a
  stale hardcoded list is worse than an explicit one — holidays are configured
  per strategy.
* **No partial-fill handling.** Orders are market orders on liquid index
  options and are treated as all-or-nothing. A partial fill would be visible in
  `orders.filled_qty` but is not currently acted on.
