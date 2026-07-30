# zoption — NIFTY Option Offset Scalper

An option-selling engine implementing [`doc/flow.md`](doc/flow.md) v3.0 and the
v2.0 SDD: **candle-based entry with a locked strike.**

> The initial SELL price always comes from a **completed candle of the option
> contract itself**, plus a configured offset. Live ask, live bid, LTP and tick
> price are never inputs to that number.

That single rule shapes the architecture, and it is enforced structurally rather
than by convention: `calculateSellPrice(candle, offset)` takes two arguments, no
quote object is reachable from it, and `test/invariants.test.js` fails the build
if that stops being true.

Three documents, three jobs:

| | |
|---|---|
| **[`doc/HOW-IT-WORKS.md`](doc/HOW-IT-WORKS.md)** | **Start here.** What the system actually does, end to end — processes, the data path, the state machine, the trend filter, the target ladder, the OCO door, order safety, config, operations, invariants. |
| [`doc/PROJECT_PLAN.md`](doc/PROJECT_PLAN.md) | The spec of record: where the source documents contradict each other and how each was resolved (R1–R9a). Read §2 before changing entry or exit logic. |
| `doc/flow.md`, `doc/update-point.md`, `doc/traling-traget -stoploss.md` | The source specifications, as written. |

---

## The strategy in one screen

```
select expiry ──▶ select CE & PE strike ──▶ LOCK
                                             │
                          ┌──────────────────┴──────────────────┐
                          ▼  CE LEG                    PE LEG   ▼
            wait for THAT contract's candle to close
                          │
                 SELL LIMIT = close + offset
                          │
              ┌───────────┴───────────┐
         not filled                filled
              │                        │
     cancel, wait for the        BUY target = fill − target
     NEXT close, requote         stop = fill + stopLoss
              │                        │
              └───────────▶  target │ stop │ timeout
                                     │
                          ┌──────────┴──────────┐
                          ▼  both legs flat     ▼
                            UNLOCK ──▶ next cycle
```

Two rules that are easy to lose in a refactor and expensive to lose in a session:

1. **A pending order is cancelled and then waits for the next candle.** It is not
   requoted immediately. The idle gap with no working order is what "never chase
   the market" means mechanically.
2. **The resting target is cancelled, and the cancel confirmed, before any exit
   market order is sent.** If the cancel comes back "already executed", the
   target won and the position is flat — sending the exit anyway would open a
   naked long.

---

## Getting started

```bash
npm install
cp .env.example .env          # then fill in the values below
npm run migrate               # creates the database, schema and a PAPER profile
npm start                     # web console  -> http://localhost:4100
npm run engine                # trading process — required for anything to execute
```

**Both processes are needed.** `npm start` alone gives you a console where
nothing ever trades.

Then, in the browser:

1. **Broker** → sign in with mobile + UCC + TOTP, then the MPIN.
2. **Broker** → *Sync now* (or `node scripts/sync-instruments.js`).
3. **Settings** → check the numbers. It ships in `PAPER` mode.
4. **Dashboard** → *Start*.

### Required environment

| Variable | Notes |
|---|---|
| `TOKEN_ENC_KEY` | 64 hex chars. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `JWT_SECRET` | 32+ chars |
| `NEO_API_TOKEN` | NEO App → Invest → Trade API → Your Applications. Used raw in the header — no `Bearer` |
| `DB_*` | MySQL 8 / MariaDB |

Keep real values in `.env`, which is gitignored. `.env.example` is committed.

---

## Architecture

Two processes over one MySQL database.

```
Browser ──REST + Socket.IO──► Express app (src/app.js, :4100)
                                    │  writes intent, reads state
                                    ▼
                              MySQL (zoption)
                                    ▲
                                    │  owns the socket, owns every order
                              Engine (src/engine.js) ── single instance
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
   Neo WebSocket              Neo REST orders            Instrument master
```

**The engine is the only process that places an order.** The web tier writes
`start` / `stop` / `pause` and settings; it never touches a trading endpoint. So
"how many things can place an order?" is answerable by reading one file.

**The engine opens no cycle until the intent flag says `RUN`.** Start / Stop /
Pause write `engine_intent`; the engine reads it on every clock. An unset or
unrecognised value means STOP, which is what the dashboard already displays for
one — so a freshly migrated install trades nothing until Start is pressed. STOP
and PAUSE both block new entries and **neither abandons an open position**:
timeouts, targets, stops and the square-off keep running, because walking away
from a live naked short is not a risk control.

A DB-backed leader lock means a second engine refuses to start rather than
doubling every order.

The web tier reaches the broker in exactly two places, both read-or-login and
neither able to reach an order: the interactive TOTP login, and the market
terminal's quote feed (below).

### The market terminal

`/terminal` is a read-only NIFTY index chart, live option chain and option
premium chart — the three modules of `doc/index-option-chaine.md`. It is lazy:
its market-data socket and its one-second chain poll start when a browser opens
the page and stop about 45 seconds after the last one closes, because they spend
the same per-account Kotak rate limit the engine's order path needs.

Two things about it are worth knowing before reading a number off it, and both
are covered properly in **`doc/terminal.md`**:

- **Every greek and every IV is modelled from the last traded price.** Kotak
  sends none. On a stale far strike they describe whenever that strike last
  traded.
- **"Volume" is a tick count.** Kotak's quote feed carries no traded quantity on
  this account class, so the histogram counts price updates per bar. Anything the
  broker genuinely does not send renders as `—`, never as `0`.

There is also no historical-candles endpoint at Kotak, so the charts start empty
on a fresh install and fill in as the terminal runs.

### Where the interesting code is

| Path | What it carries |
|---|---|
| `src/market/candleBuilder.js` | tick → OHLC. Absolute IST buckets, partial-first-bar discard, synthetic bars |
| `src/strategy/legMachine.js` | the state machine — **pure**, no I/O, no clock |
| `src/strategy/scalperEngine.js` | where the pure parts meet the world |
| `src/execution/orderRouter.js` | idempotency and the three-way failure rule |
| `src/execution/reconciler.js` | fills, UNKNOWN resolution, boot recovery |
| `src/core/money.js` | integer paise, charges, net P&L |
| `src/market/terminalFeed.js` | the terminal's lazy quote feed — read-only, viewer-counted |
| `src/market/greeks.js` | Black-Scholes: the greeks Kotak does not send |
| `src/shared/indicators.js` | one indicator implementation, run by both the server and the browser |

### Four decisions inside the candle builder

- **Buckets are absolute**, aligned to IST midnight. A 1m bar is
  10:15:00.000–10:15:59.999. Two builders started a second apart produce
  byte-identical bars, so a restart cannot silently change entries.
- **The first bar is discarded.** Its open is wherever the stream happened to
  start. The engine therefore waits up to one timeframe before its first sell —
  a real, logged delay.
- **A bar with no ticks is synthetic and never traded.** Offsetting from a close
  that is a minute stale is fiction.
- **A bar closes on time, not on the next tick.** Otherwise an illiquid strike
  wedges the leg indefinitely.

### Order safety

Kotak's place-order has no client order id, so a retry after a network error is
indistinguishable from a new order. Two mechanisms, then a three-way rule:

- `orders.client_ref` is UNIQUE — `zo-<cycle>-<leg>-<attempt>-<stage>`.
- `claimForPlacement` atomically moves `PENDING → PLACING`; only the first
  caller wins.

| Failure | Meaning | Action |
|---|---|---|
| **Pre-send** | the rate limiter refused; nothing left the process | reset to `PENDING`, safe to retry |
| **Rejected** | the broker answered "no" | mark `REJECTED`, do not retry unchanged |
| **Uncertain** | timeout / reset / 5xx after send — it MAY be live | mark `UNKNOWN`, **never resend**; the reconciler resolves it |

The third case is the one that costs money.

---

## Paper mode

Ships in `PAPER`. Orders are simulated against the **live tick stream** through
the same `orderRouter`, the same reconciler and the same OCO path as live — a
paper mode that shortcut the order layer would validate the strategy while
leaving the dangerous code untested.

The fill model is deliberately pessimistic: a limit fills at its own price and
never better, and a market order fills at the *next* tick rather than the last
one seen. Paper results should still be read as an optimistic bound.

---

## Testing

```bash
npm test        # 235 tests, no database, no broker, ~1s
```

Three invariants get dedicated tests because a violation costs money:

- **I1** — no order is priced from a quote, tick, ask, bid or LTP.
- **I2** — a leg never has two working SELL orders.
- **I3** — no exit market order is sent while a target is still working.

The terminal's maths is tested against things that can be looked up rather than
against itself: the greeks against the textbook reference set and put-call
parity, the indicators against properties (an EMA of a constant is that constant,
an RSI of an unbroken advance is 100), and the chain analytics against the
zero-versus-unknown rule that keeps a missing broker field from rendering as a
real number.

The charge schedule is pinned in `test/helpers.js` rather than read from `.env`,
so the suite tests the model rather than whichever brokerage plan the operator
is on.

## Scripts

```bash
node scripts/sync-instruments.js   # sync the master, print expiries and the chain
node scripts/diagnose-master.js    # probe Kotak's scrip-master endpoint variants
node scripts/diagnose-spot.js      # why the terminal has no index price
node scripts/diagnose-engine.js    # why the scalper is not trading (the DB-side gates)
node scripts/dry-run.js            # walk the entry path with live quotes, open nothing
npm run backfill                   # download index history from Yahoo into candles
npm run backtest -- NIFTY 5m 60    # replay the trend filter over stored history
```

### History and backtesting

Kotak has no historical-candles endpoint, so `npm run backfill` imports index
history from Yahoo Finance — 1m for a week, 5m/15m/1h for two months, daily for
a decade. That fills the terminal's index chart and makes the index trend filter
replayable.

**Yahoo carries no NSE option data at all** — verified against the live API, not
assumed. Your entry price comes from the option contract's own closed candle, so
entries, targets, stops and P&L cannot be backtested from it at any price.
Option premium history accumulates only while `npm run engine` or the terminal
is running. `npm run backtest` replays the real trend filter over index history
and reports honestly which of the two it had. Full detail, including a real
finding about the volatility ceiling not surviving a timeframe change, is in
**`doc/history.md`**.

---

## Two things worth knowing before a live session

**Charges decide whether this works.** A ₹1 target is 20 ticks. On a
per-order-brokerage plan the round-trip cost on one NIFTY lot is a large share
of that, and every "winning" trade can book a realised loss. On a zero-brokerage
plan the cost is proportional to turnover and the target has real room. The
engine reports **net** P&L everywhere and warns at boot if the configured target
does not cover the modelled breakeven. Decide viability from paper results, on
net numbers.

**The fill rate is the first metric to read.** A limit above the market only
fills if the premium rises into it. Instrumented from the first release; check it
before anything else.

## Known limits

- No exchange-holiday calendar. A holiday presents as a silent feed rather than a
  wrong-day trade, but the honest fix is a calendar.
- `15s` / `30s` timeframes are supported but should stay unused until a session
  proves the WebSocket actually streams — on a REST-only account a 15-second bar
  is built from roughly 15 samples and its high and low are understated.
- Single account, single instrument. Multi-account and the other three indices
  are carried in the instrument master but not wired up.
- Kotak's Trade API has no historical-candles endpoint. `npm run backfill`
  imports INDEX history from Yahoo to cover that; option premiums have no such
  source and accumulate only while this platform is running, which is also the
  hard limit on what can be backtested. See `doc/history.md`.
- The terminal's greeks, IV and "volume" are modelled or proxied rather than
  quoted, because the broker sends none of them. `doc/terminal.md` §2 is the
  section to read before acting on those columns.
