# The trading terminal

Implementation notes for `doc/index-option-chaine.md` — the three-module NIFTY
terminal at **`/terminal`**.

This document exists to answer two questions the specification does not: what
was built differently from what it asked for, and which numbers on the screen
are real measurements as opposed to models of a last traded price. Both answers
matter more than usual here, because a screen that looks confident about a
number it invented is worse than one that shows nothing.

---

## 1. Where it deviates from the specification, and why

### Stack

The specification names React, TypeScript, Redux Toolkit, TailwindCSS and Redis.
zoption is Express + EJS + MySQL with no build step, and the platform-level
instruction in `CLAUDE.md` is explicit that new infrastructure must not reach for
Redis. Rewriting a working console as a single-page application to satisfy a
stack list would have thrown away the auth, the layout, the socket channel and
the operational story, and bought nothing a trader can see.

So the terminal is built in the existing stack. One dependency from the list was
genuinely worth adopting:

| Specified | Built | Why |
|---|---|---|
| TradingView Lightweight Charts | **adopted** (`lightweight-charts@5`) | It is the chart engine. Writing one would be worse in every respect. |
| React / Redux / Tailwind | plain scripts on a `window.Z` namespace, CSS variables | No build step to keep working; the page is six files and one origin. |
| Redis | the existing MySQL + socket.io push | Platform constraint, and there is nothing here a cache would speed up. |
| Socket.IO | **as specified** | Already the app's push channel. |

Lightweight Charts is served out of `node_modules` at `/static/vendor/…` rather
than from a CDN, because the app's Content-Security-Policy allows scripts from
`'self'` only. That is deliberate: a trading terminal that stops drawing because
somebody else's CDN is having a bad day is not a terminal.

### Endpoints

Every documented endpoint exists. `/option/chart/history` is served both at the
path the specification gives and under `/api`, so neither the document nor the
convention is wrong.

| Specified | Path |
|---|---|
| `GET /api/chart/history` | as written |
| `GET /api/options/chain` | as written |
| `GET /option/chart/history` | as written, **and** `/api/option/chart/history` |
| ws `index_tick` | as written |
| ws `option_chain_update` | as written |
| ws `option_tick` | as written |

Added, because the page needs them: `GET /api/options/expiries`,
`GET /api/terminal/status`, and the client→server socket events
`terminal:join` / `terminal:chain` / `terminal:option` / `terminal:leave`.

---

## 2. What the broker actually sends

This is the section to read before trusting a column.

**Kotak's Trade API has no historical-candles endpoint.** There is no backfill.
A fresh install opens a chart with nothing in it, and it fills in as the terminal
runs. Every response from `/api/chart/history` carries a `note` saying so when it
returns nothing, because an empty chart is otherwise indistinguishable from a
broken one. Bars are persisted at `5s` and `1m` (see `src/market/history.js`),
and every wider timeframe is rebuilt from those on read — so history does
accumulate across sessions, subject to `CANDLE_RETENTION_DAYS`.

**The quote filter is discovered, not assumed.** The engine asks Kotak for `ltp`
and nothing else, because that is the one filter this account class is reliably
granted. The chain needs more, so `src/market/quoteSource.js` probes
`full → quote → market_depth → depth → ohlc → ltp` once per process and keeps the
first that answers with anything beyond a last price. What that probe found is
reported to the browser, and the banner above the chain says which columns are
live.

**Columns that never arrive render as `—`, never as `0`.** The header of a field
the broker does not send is struck through. This is enforced at three layers
(`neoClient.readQuoteFull`, `chainAnalytics`, the table renderer) and is covered
by tests, because it is the single easiest way for this screen to lie: an OI
column full of zeros looks like a chain nobody holds.

### Greeks and implied volatility are modelled

Kotak sends **no** greeks and **no** IV. Every Δ, Γ, Θ, V, ρ and IV in this
terminal is solved from the last traded price by `src/market/greeks.js` —
Black-Scholes, European, no dividend, at `TERMINAL_RISK_FREE_RATE`. That is the
right model for NIFTY index options, which are European and cash-settled.

Three consequences a trader must carry:

1. **Garbage in, garbage out.** On a far strike whose last print was twenty
   minutes ago, the IV and every greek from it describe twenty minutes ago. The
   premium panel shows a `stale` tag once the price has not changed for a minute.
2. **A solvable IV is not a meaningful one.** A tick-floor quote on a dead strike
   often solves at something like 300%. That is arithmetically correct and
   practically noise, and it is why the chain's "highest IV" highlight reliably
   points at the least liquid strike on the board. Treat it as a pointer to look,
   not a signal to act.
3. **Unsolvable means null.** A price the model cannot reach at any volatility
   between 0.5% and 500% — below the no-arbitrage floor, or above the 500% price
   — returns `null` rather than a boundary value, because a boundary printed in a
   table gets read as a measurement.

The greeks are checked against the textbook reference set (S=100, K=100, T=1,
r=5%, σ=20% → call 10.4506, put 5.5735, Δ 0.6368) and against put-call parity in
`test/greeks.test.js`.

### "Volume" is a tick count

Kotak's quote feed on this account class carries no traded quantity. The volume
histogram, the volume-spike highlight and the volume ratio all count **price
updates per bar**. That is a real measure of activity and it is not exchange
volume. It is labelled `ticks` in the chart legend and spelled out in the premium
panel's volume card rather than being quietly presented as `vol`.

### "Chg OI" may be a session baseline

Where Kotak sends a previous-day open interest, `oiChange` is the day's change.
Where it does not, the feed establishes a baseline at its first snapshot of the
trading day and the banner says the column is measured from there instead. The
payload carries `oiChangeSource: 'broker' | 'session'` so the difference is
never silent.

---

## 3. How it runs

### The feed lives in the web process

Everywhere else in zoption, the web tier does not talk to the broker. The
terminal is the second documented exception (the first is the interactive login),
and it is a narrow one: **it reads quotes and never places, cancels or modifies
anything.** There is no control on the page that reaches the engine.

The alternative — putting the feed in the engine — would make a read-only chart
depend on the trading process being up, so `npm start` alone would show a
terminal with no prices in it.

### It is lazy, because it is not free

The feed opens a **second** market-data socket and a **second** quote poller
against the same Kotak account as the engine. Kotak's rate limit is per account
and the two processes hold separate token buckets, so the budgets **add**:

```
engine:    its own poll                    ~1 req/s
terminal:  ticker  (index + one option)    ~1 req/s
           index   (its own request)       ~1 req/s   ← never batched with strikes
           strikes (±10 = 42 tokens)       ~2 req/s   (batched by NEO_QUOTE_BATCH)
           India VIX (every 10th poll)     ~0.1 req/s
                                           --------
                                           ~4 of the 8 per second per process
```

**The index gets its own request on purpose.** It used to ride in the same
batched list as the forty strikes, which failed two ways: the whole poll was
skipped when the strike ladder was empty (a fresh install whose master has not
been synced — so no chain meant no spot either), and batching by 25 put the index
behind eighteen strikes, so one gateway complaint about the by-name VIX entry
took the spot price down with it on every poll. The spot is the one instrument
the entire screen depends on; nothing else is allowed to knock it out.

So nothing starts until a browser opens `/terminal`, and everything stops about
45 seconds after the last one closes. `TERMINAL_MAX_RANGE` caps how wide the
ladder can be asked to go, because ±50 strikes would be 202 instruments — nine
requests a second, taken from the budget the order path needs.

### When there is no spot price

`GET /api/terminal/status` carries a `spotProblem` field that names the cause,
and the terminal shows it in the header where the change figure would be. The
five it distinguishes:

| `spotProblem` says | Fix |
|---|---|
| the terminal feed is not running | open `/terminal`; check the broker session |
| the Kotak session was rejected | log in again on the Broker page |
| no NIFTY index instrument | sync instruments on the Broker page |
| the broker answers but sends no price | the market is closed, or the wrong addressing (see below) |
| Kotak is refusing the quote request (HTTP 503) | the gateway, not the broker — see below |

### HTTP 503 "No available server to handle this request"

This is a **gateway** error, not a data one: Kotak had nothing to route the call
to. It arrives as an HTML page, which the feed reduces to its one useful
sentence before it reaches a status field or a toast. Three causes, in order of
likelihood:

1. **The quote service is not up.** Kotak takes market-data endpoints down
   outside trading hours and during maintenance. If `ltp` itself 503s, try again
   inside 09:15–15:30 IST on a weekday before changing anything.
2. **The filter is not a route.** The quote filter is a PATH SEGMENT
   (`/quotes/neosymbol/<seg|tok>/<filter>`), so an unrecognised name is a 404
   wearing a 503. `ltp` answering while the richer names 503 is normal and
   nothing is wrong.
3. **`NEO_API_TOKEN` is stale.** The quotes path authenticates with that token
   *alone* — no `Sid`, no `Auth`, no `neo-fin-key` — so a stale token fails here
   while order placement keeps working, because they use different headers.

`node scripts/diagnose-spot.js` tries every filter and prints which of the three
it is.

**The probe order was a contributing bug.** It used to try the richest filters
first, which fired a burst of unroutable requests before reaching the one that
works — and any 503 from those was then reported as the reason the spot price
was missing. It now establishes `ltp` (the filter the engine already runs on)
*first*, then attempts richer names as an optional upgrade whose failure is
expected and never recorded as an error. Repeated gateway refusals also back the
poll off to a maximum of one minute rather than re-asking every second, because
hammering a gateway that says "no available server" spends the same per-account
rate limit the order path needs.

### An index is quoted by NAME, not by its token

This one cost a working platform, so it is worth stating precisely. Verified
against the live gateway:

```
nse_cm|26000      -> HTTP 200,  []                                        <- the master's own token
nse_cm|Nifty 50   -> HTTP 200,  {"exchange_token":"Nifty 50","ltp":"24317.15"}
nse_fo|65867      -> HTTP 200,  {"exchange_token":"65867","ltp":"23.20"}  <- options are fine by token
```

The empty array is what makes it invisible. The gateway does not refuse and does
not error — it answers successfully with nothing, so every layer above reports
"no price for this instrument" and not one of them is wrong.

`instrumentMaster.indexInstrument` used to prefer the stored numeric token and
treat the name as a degraded fallback for an unsynced master. That was exactly
backwards: once the cash master synced, the index became **unquotable**, taking
the spot price, the ATM, the terminal's whole index panel and — because the
trend filter's bar series is built from index ticks — every entry the engine
could ever make. The numeric token is still returned as `exchangeToken`, because
the binary WebSocket feed addresses instruments that way; the two transports
genuinely disagree and only the REST path is proven on this account class.

`db/migrate.js` re-keys any index candles already stored under the numeric token.

### The richer filters are mutually exclusive, and they nest

```
ltp    -> { exchange_token, ltp }
ohlc   -> { exchange_token, ohlc:  { open, high, low, close } }
depth  -> { exchange_token, depth: { buy: [ … ], sell: [ … ] } }
```

Each returns **only** its own block; there is no combined response, and `full`
and `quote` return nothing at all. So an `ohlc` row carries no last traded price
— which means "richer by field count" is not the same as "better". `isRich()`
therefore requires a price as a precondition before treating a filter as an
upgrade, or the probe would trade the one number the platform runs on for a few
extra columns.

```bash
node scripts/diagnose-spot.js       # asks the gateway directly, prints raw rows
```

That script quotes the index by stored token, by name and by every alias, across
every candidate filter, and prints the **raw** reply rows. The failure is usually
in the shape of the answer rather than in an error — a 200 carrying a row whose
keys nobody recognises looks exactly like a 200 carrying nothing.

### Synthetic spot, when the index cannot be quoted at all

Some accounts are entitled to F&O quotes but not to the cash segment the index
lives in. Rather than show an em-dash forever, the feed derives the level from
the chain by **put-call parity**:

```
C − P = S − K·e^(−rT)      so      S = C − P + K·e^(−rT)
```

This is an identity, not a model — NIFTY options are European and cash-settled,
so it holds exactly, and `test/greeks.test.js` proves it recovers the spot at
every strike from deep ITM to deep OTM. In practice the estimate is taken from
the five strikes with the smallest |C − P| (nearest the money, where both legs
are liquid) and the **median** is used, so one stale leg costs nothing.

It is labelled `synthetic` everywhere it appears — `spotSource` on the chain
payload and on `/api/terminal/status`, a `derived` pill next to the price, and a
line in the header saying where it came from. That labelling is not decoration:
the greeks are then solved against a spot derived from the same premiums, which
is mildly self-referential. It is good enough to place the ATM, shape the chain
and drive the moneyness colouring. It is not something to trade a delta off.

A real quote always wins, and the synthetic only stands in when none has arrived
for ten seconds — otherwise a brief gateway hiccup would swap a quoted index for
a derived one and leave it there for the rest of the session. Synthetic prices
are **not** fed to the candle builders, so nothing derived is ever persisted as
the index's stored history.

### One implementation of every indicator

`src/shared/indicators.js` and `src/shared/patterns.js` are UMD modules: Node
requires them, Express serves them at `/static/shared/…`, and `node --test`
exercises the same code the browser runs. Two copies of an EMA is two answers to
"what did the 9 cross", and there is no way afterwards to tell which one the
operator was looking at.

### Buckets are absolute, on both sides

The server stores closed bars; the browser extends the bar in progress from the
tick stream. Both align buckets to **IST midnight** (`Z.bucketStart` mirrors
`src/core/time.js`), so the bar being drawn and the bar being stored are the same
bar. If those ever disagree the symptom is a candle that visibly jumps on
reload — check the two offsets first.

`CHART_TIMEFRAMES` (5s…1d) is deliberately a *separate* map from the strategy's
`TIMEFRAMES` (5s…5m). Adding `1h` to the latter would silently make
`candleTimeframe: 1h` a legal engine configuration, and an entry priced off an
hourly close is a different strategy, not a preference.

---

## 4. Module coverage

**Module 1 — index chart.** Nine timeframes; candles / OHLC / line / area;
EMA 9-20-50-200, VWAP, SuperTrend, ATR, RSI, MACD, ADX, Bollinger, opening
range, pivots, CPR, previous H/L/C; volume pane; crosshair readout showing OHLC,
activity and every enabled indicator **at the hovered bar**; live info panel;
`+` / `−` / `R` / `Space` shortcuts.

Drawing tools (horizontal, trend, rectangle, risk/reward, long, short, arrow,
text) are a canvas overlay — Lightweight Charts is a rendering library and ships
none. Drawings are stored as **(time, price)** pairs and re-projected on every
redraw, which is what keeps a trend line attached to its two bars through a
scroll, a zoom, a timeframe change and tomorrow's reload. They persist in
`localStorage` per chart.

**Module 2 — option chain.** One-second refresh; weekly/monthly expiry selector
from the instrument master; ±5 / ±10 / ±20 windows that re-centre as the money
moves; the full column list folded into groups (Greeks, Bid/Ask,
Intrinsic/Time, Rho) so it fits a laptop; ATM/ITM/OTM shading; the specified
heat map; volume-spike flagging against the chain's median; filters; five sort
orders; and the summary panel — spot, ATM, PCR, max pain, VIX, lot size, total
and net OI. Max pain is computed as stated (weighted intrinsic payout minimised
over every candidate settlement), not by the ITM-OI shortcut. Clicking a premium
charts it below.

**Module 3 — premium chart.** Its own timeframe / type / indicator set;
contract info; a live greeks card that says how the numbers were obtained;
premium statistics (high, low, average, model theta *and* observed drift,
velocity, momentum); volume analysis with buying/selling pressure; candle
patterns; six alerts evaluated on **closed** bars; and a read-only trade overlay
drawing the engine's own entry, average, target and stop when it happens to hold
that contract.

**Not built:** the "Future Enhancements" list (market depth / DOM, OI heatmap
animation, strategy builder, multi-chart layout, greeks surface, AI
recommendations, replay, backtesting, order flow, institutional activity) — the
specification lists these as future work. Market depth in particular would need
a quote filter this account may not be entitled to; `quoteSource` already reads
`bid`/`ask` where they arrive.

**Trading signals on the index chart** (buy/sell/exit markers) have the
rendering path in place (`PriceChart.setMarkers`) but nothing feeds it: the
engine's signals are per-option-contract, and drawing them on the index would
put a marker at a price the trade never happened at. They appear on the premium
chart as the trade overlay instead, which is the same information at the price
it occurred.

---

## 5. Configuration

```
TERMINAL_CHAIN_MS=1000          # the chain refresh from the specification
TERMINAL_STRIKE_RANGE=10        # ±strikes around the money
TERMINAL_MAX_RANGE=20           # the hard cap the API clamps to
TERMINAL_RISK_FREE_RATE=6.5     # percent, for the Black-Scholes solve
TERMINAL_VIX=true               # quote India VIX by name alongside the chain
```

India VIX is asked for by **name** (`nse_cm|India VIX`) rather than by token,
because it is not in Kotak's F&O master and this platform never trades it. Turn
`TERMINAL_VIX` off if the gateway refuses the by-name form.

---

## 6. Files

```
src/core/time.js               CHART_TIMEFRAMES, baseTimeframeFor
src/market/history.js          stored bars, widened on read
src/market/greeks.js           Black-Scholes, greeks, implied vol
src/market/chainAnalytics.js   max pain, PCR, OI build-up, extremes
src/market/quoteSource.js      the filter probe and batched snapshots
src/market/terminalFeed.js     the lazy feed: ticker, chain poll, candles
src/market/terminal.js         the process singleton
src/shared/indicators.js       UMD — server and browser
src/shared/patterns.js         UMD — server and browser
src/broker/neoClient.js        readQuoteFull, quoteCoverage
src/http/routes.js             the terminal endpoints
src/http/socket.js             the terminal room
views/terminal.ejs             the layout
public/terminal.css            the styles, both themes
public/terminal/*.js           core, drawings, chart, chain, premium, app
test/greeks.test.js            reference values and parity
test/indicators.test.js        properties, not magic numbers
test/chainAnalytics.test.js    the zero-versus-unknown rules
test/terminalData.test.js      timeframes, aggregation, patterns, quotes
```
