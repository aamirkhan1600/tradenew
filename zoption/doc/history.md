# Historical data, and what can be backtested with it

Implementation notes for `doc/hisotry.md` — the Yahoo Finance history source.

Read §1 before planning anything. It is the constraint that governs everything
else, and it is a fact about the data rather than a limitation of this code.

---

## 1. Yahoo has no NSE option data. None.

Checked against the live API, not assumed:

```
options('^NSEI')            -> 0 expirations, 0 calls, 0 puts
NIFTY26AUG24500CE.NS        -> No data found, symbol may be delisted
^NSEI250806C24500           -> No data found, symbol may be delisted
```

This matters because of what your strategy is. `doc/PROJECT_PLAN.md` §2 R1, and
every source document, say the same thing: **the sell price is the OPTION
contract's own closed candle plus an offset.** Not the index. Not a model. That
one contract's own printed premium.

So:

| Can be backfilled and replayed | Cannot, at any price |
|---|---|
| The index chart (module 1 of the terminal) | Option premium history |
| The **index trend filter** — a pure function of index bars | Entry fills, targets, stops |
| India VIX | Realised P&L, win rate, charges |

There is no workaround that is honest. Synthesising premiums from the index with
Black-Scholes would produce a P&L number, and that number would be a measurement
of the volatility assumption rather than of the strategy — on a **one-point
offset with a 1.5-point target**, the model error is several times the entire
edge being tested. This codebase will not do that.

**Option premium history accumulates only while this platform is running.**
`npm run engine` records it; so does the terminal, for whatever it is tracking.
That is the only path to a full P&L backtest, and it starts the day you start
recording.

---

## 2. What Yahoo does give, measured

Retention, probed against the live API rather than taken from the docs:

| Interval | Available | Aligned to this platform's buckets? |
|---|---|---|
| `1m` | ~5 trading days | ✅ exactly |
| `2m` | ~10 days | (no stored timeframe) |
| `5m` | ~30–60 days | ✅ exactly |
| `15m` | ~45–60 days | ✅ exactly |
| `30m` | ~45 days | (no stored timeframe) |
| `60m` | ~2 years | ❌ **100% misaligned** |
| `1d` | decades | ❌ stamped 09:15, not midnight |

Symbols: `NIFTY → ^NSEI`, `BANKNIFTY → ^NSEBANK`, `INDIAVIX → ^INDIAVIX`,
`FINNIFTY → ^CNXFIN`, `SENSEX → ^BSESN`. A raw Yahoo symbol (`RELIANCE.NS`) is
passed through, so the service is not limited to the four indices this strategy
trades.

An **index has no traded volume**, so every bar comes back `volume: 0`. That is
not a gap in the download; there is no such number.

### The 09:15 problem

This is the one thing in the import that is not mechanical.

**NSE sessions start at 09:15 IST, which is not on an hour boundary.** Yahoo
bars follow the exchange session, so its hourly bars run 09:15–10:15,
10:15–11:15. This platform's buckets are absolute — aligned to IST midnight, so
09:00–10:00 — because the candle builder depends on that for two builders
started a second apart to produce identical bars (`src/core/time.js`).

Those are **different bars**, not the same bar labelled differently. So:

- `1m`, `5m`, `15m` are imported at their own interval — they already land on
  the right boundaries.
- `1h` is downloaded as **five-minute** bars and folded locally into absolute
  buckets, using the same `aggregate()` the charts use. A stored hour and a
  chart-rebuilt hour are then identical by construction.
- `1d` is downloaded daily and its timestamp **snapped** to IST midnight. Here
  the content genuinely is the same — one bar, one session — and only the label
  moves, so snapping is lossless.

Anything that still fails the alignment check is **rejected and counted**, never
snapped. A silent snap would turn "the source moved to a different session grid"
into a chart that is quietly wrong, and the >50%-rejected alarm would never fire.

---

## 3. Using it

```bash
node scripts/backfill-history.js                 # NIFTY, the default plan
node scripts/backfill-history.js BANKNIFTY
node scripts/backfill-history.js NIFTY 1d 3650   # one timeframe, N days
node scripts/backfill-history.js NIFTY --purge   # drop imported bars first
```

The default plan pulls `1m` (7d), `5m` (60d), `15m` (60d), `1h` (60d) and `1d`
(10y). It prints what it downloaded, stored, already held and rejected, then the
stored coverage per timeframe.

**Safe to re-run.** `candles` is insert-or-ignore on `(token, timeframe,
bucket_start)`, so a bucket this platform recorded from its own tick stream
always wins over a downloaded one. A backfill fills gaps; it cannot revise
history the engine traded on.

### Recorded and downloaded bars are distinguishable

`candles.source` is `LIVE` or `BACKFILL`. This is not bookkeeping —
`tick_count` is **meaningless** on a downloaded bar (an exchange-aggregated bar
has no sample count), so anything deciding "did this bar measure something" must
gate on `source`, not on `tick_count`. `--purge` removes only `BACKFILL` rows.

### The API

The three endpoints `doc/hisotry.md` specifies, mounted in the existing app
rather than as a second server:

```
GET  /api/quote/:symbol
GET  /api/history/:symbol?interval=1d&start=2024-01-01&end=2024-12-31
GET  /api/search?q=reliance
POST /api/history/backfill      { symbol, timeframe?, days? }
```

```bash
curl -b cookies.txt 'http://localhost:4100/api/history/NIFTY?interval=5m&start=2026-07-01'
curl -b cookies.txt 'http://localhost:4100/api/quote/INDIAVIX'
curl -b cookies.txt 'http://localhost:4100/api/search?q=nifty'
curl -b cookies.txt -X POST 'http://localhost:4100/api/history/backfill' \
     -H 'content-type: application/json' -d '{"symbol":"NIFTY","timeframe":"1d","days":3650}'
```

All require the session cookie, like every other `/api` route.

---

## 4. The backtest

```bash
node scripts/backtest.js                      # NIFTY, 1m, last 30 days
node scripts/backtest.js NIFTY 5m 60
node scripts/backtest.js NIFTY 5m 60 --sweep  # grid the thresholds
```

It replays the **real** `src/strategy/trendFilter.js`, unmodified, over stored
index bars and reports:

- the **verdict histogram** — which rule is doing the blocking;
- the **signal rate** — a filter that permits 0.05% of bars has not made the
  strategy selective, it has turned it off;
- **follow-through** — for each permission, whether the index then moved the
  permitted way over the next N bars.

Follow-through measures the **index**. The strategy sells option premium, and
the path from "the index kept rising" to "the call I sold decayed" runs through
delta, theta and the spread — none of which are in this data. A good hit rate
means the directional read is sound. It is not a P&L result and must not be
read as one.

### The timeframe trap, and a real finding

`trendMaxRangePoints` is a span across the **whole** confirmation window. At the
configured 5-second bars, 3 bars is 15 seconds and 10 points is a sensible
ceiling on "the move is already made". Replayed on 1-minute bars the same 3 bars
are 3 **minutes**, and NIFTY covers 10 points in 3 minutes routinely.

Measured on real downloaded history with the shipped defaults:

```
1m:  HIGH_VOLATILITY 879/1494 (59%),  0 signals
5m:  HIGH_VOLATILITY 298/298 (100%),  0 signals
```

The replay detects this, says so, and offers a **√time-equivalent** ceiling
(volatility scales with the square root of time) — it does **not** apply it.
Silently substituting a threshold and then reporting the numbers is how a
backtest ends up measuring something the operator never configured. With the
equivalent ceiling on 40 days of 5-minute bars:

```
span  confirm  signals   rate     hit    avg move
  10        3        0  0.00%       —          —     <- as configured, at 5m
  77        2       17  0.81%   52.9%      +7.25
  77        3        1  0.05%   100%      +25.75     <- one signal proves nothing
 154        2       19  0.91%   57.9%     +12.87
```

Two things to take from that. The filter is **extremely** selective — under 1%
of bars even with a widened ceiling. And a three-bar confirmation at coarse
timeframes reduces it to a handful of signals, which is far too thin to conclude
anything from; the script marks any row under 30 signals as `(thin)` rather than
letting a 100% hit rate on one trade look like an edge.

**None of this is a verdict on the live 5-second setup.** Yahoo's finest
interval is a minute, so the replay tests the filter's *logic*, not the filter
as it runs. Only live 5-second recordings can do that, and the replay reports
which kind of bar it used (`LIVE`, `BACKFILL` or `MIXED`).

---

## 5. Files

```
src/market/yahoo.js            the YahooFinanceService class, validation, intervals
src/market/backfill.js         Yahoo bars -> candles, alignment, folding, snapping
src/market/history.js          reads an exact stored series before rebuilding from a base
src/backtest/trendReplay.js    the replay and the threshold sweep
scripts/backfill-history.js    the import CLI
scripts/backtest.js            the replay CLI
test/backfill.test.js          validation, alignment, folding, the reject reasons
test/trendReplay.test.js       the harness — direction, scoring, no silent threshold changes
db/schema.sql                  candles.source (LIVE | BACKFILL)
```

## 6. A note on the dependency

`yahoo-finance2@3` declares `engines.node >= 20` but its runtime check wants
Node 22, and this project runs on Node 20.11. Every call used here — `chart`,
`quote`, `search` — was verified working. The library's per-call stderr warning
is captured and re-emitted **once**, through the logger, at first use. If
downloads start failing, upgrading Node is the first thing to try.
