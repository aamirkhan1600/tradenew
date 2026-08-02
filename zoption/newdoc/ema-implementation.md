# EMA Trend Confirmation Engine — as built

The *description*, against `newdoc/ema.md` (the *specification*). Where the two
could drift, the code wins and this file is wrong.

| | |
|---|---|
| Specification | `newdoc/ema.md` |
| Engine | `src/ose/ema.js` — pure, no I/O, no clock |
| Averages | `src/shared/indicators.js` — the same module the chart draws with |
| Wired in | `src/ose/engine.js` (entry gate), `src/ose/exits.js` (exit rule) |
| Settings | `src/ose/settings.js`, page at `/ose/settings` |
| Tests | `test/oseEma.test.js` (29), plus 4 engine-wiring tests in `test/oseEngine.test.js` |
| Register | `[MUST-CONFIRM #18]` and `#19` in `src/ose/constants.js` |

---

## 1. Where it sits

```
5s NIFTY candle sealed
        │
        ▼
  EMA9 / EMA20            src/ose/ema.js      evaluate()
        │
        ▼
  EMA TREND FILTER  ──── refuse ───►  one decision row, cycle over
        │
        ▼
  3-Candle Trend Engine   src/ose/trend.js
        │
        ▼
  EMA vs trend agreement ─ refuse ─►  EMA_TREND_CONFLICT
        │
        ▼
  Midpoint validation     src/ose/entry.js
        │
        ▼
  Strike selection → risk → SELL
```

The filter runs **before** anything expensive. A cycle it refuses spends no chain
refresh, no strike ranking and no rate-limit budget — `test/oseEngine.test.js`
asserts that by making the chain throw and checking the cycle never reaches it.

It can only ever **refuse**. Nothing in `src/ose/ema.js` selects a strike, prices
an order or opens a position.

---

## 2. The rules, and what each one became

### Entry

| ema.md | As built |
|---|---|
| `EMA9 > EMA20 AND Close > EMA9` → BULLISH | Both halves required. One half alone is `NO_CONFIRM`, not a weaker yes. |
| `EMA9 < EMA20 AND Close < EMA9` → BEARISH | Same, mirrored. |
| BULLISH → allow SELL PE · BEARISH → allow SELL CE | `sideFor()`, identical to the mapping `src/ose/trend.js` already makes. |
| `EMA Direction ≠ 3 Candle Trend` → reject | `gate()`. An **undetermined** 3-candle verdict is a conflict too — a filter that waves through an absent counterparty is not a filter. |

### Sideways — the three rules that needed numbers

`ema.md` states all three in words and gives a value for none. Each became a
setting, defaulted from a constant, and all four are `[MUST-CONFIRM #18]`.

| ema.md | Setting | Default | Note |
|---|---|---|---|
| `EMA9 == EMA20` | `emaFlatPoints` | **0.25 index points** | Read literally the equality fires **never** on floating averages. The rule only exists because a band was chosen — this is the consequential number. |
| `EMA crossover has just occurred` | `emaCrossCooldownCandles` | **2 candles** | Refuses the crossover candle and the one after it. |
| `Price moving repeatedly above and below EMA9` | `emaChopFlips` / `emaChopLookback` | **3 in 6** | Counts side-changes of the close against EMA9. |

Precedence when more than one applies: flat → fresh crossover → chop. The flat
band is checked first because when the averages are indistinguishable nothing
else means anything — a "crossover" between two lines 0.05 points apart is noise
wearing the name of a signal.

### Exit

`ema.md`: *exit when EMA9 crosses back through EMA20 against the position.*

Implemented on the **state**, not the crossover edge — `[MUST-CONFIRM #19]`.

A crossover is visible on exactly one candle, and §4.2 **drops** a candle that
seals while the previous cycle is still running. An edge-triggered exit can
therefore be missed outright, leaving a naked short open on an inverted thesis.
Reading the relationship cannot be missed: once EMA9 is on the wrong side it
stays there until it crosses back.

It cannot fire early either — an entry required the averages separated the other
way, with a flat band and a cooldown on top, so the only route to an adverse
separation is the crossover the document names. The exit reason says *"crossed …
on this candle"* only when it did; otherwise it says the structure no longer
holds.

Two deliberate asymmetries against the entry path:

* **the flat band is not applied.** Entry demands evidence; holding demands none.
* **a warming-up verdict does not close a position.** The trend engine treats its
  own silence as a break; this one must not, or every position would close the
  moment the ring buffer was rebuilt after a restart.

Ordering inside `exits.onCandle()`: the crossover is at **4b** — after the stop,
the premium safety exit, liquidity and max-hold, before the §13.3 validity
filter. Money-safety ordering is unchanged: a candle spanning both the stop and
the crossover still books the stop.

---

## 3. Warm-up — the surprising part

**EMA20 first exists on the 20th completed candle, and the crossover test needs
the one before it, so the first candle this engine can express an opinion about
is the 21st.**

At 5 seconds that is **105 seconds of no entries** after the process starts or
the feed comes back. The decision log reads `EMA_WARMING_UP` throughout. That is
the filter working, not a stalled feed — it is said on the boot line, on the
preflight, on the settings page and in the tile on `/ose`.

Market opens 09:15 and the first entry is 09:20, so a process up before the open
is warm with 39 candles to spare. A **mid-session restart costs two minutes**.

---

## 4. Configuration

Six new keys on the `ose` settings profile. `npm run migrate` backfills them into
an existing profile; keys an operator has already set are never touched.

| Key | Default | |
|---|---|---|
| `emaFilterEnabled` | `true` | ema.md calls the entry filter mandatory. |
| `emaExitOnCrossover` | `true` | §Position Exit Rule. |
| `emaFlatPoints` | `0.25` | Index points. |
| `emaCrossCooldownCandles` | `2` | |
| `emaChopLookback` | `6` | |
| `emaChopFlips` | `3` | `0` turns the chop rule off. |

The periods themselves (9 and 20) are **not** tunable: `EMA_FAST` / `EMA_SLOW` in
`src/ose/constants.js`. ema.md names them in its title, its formulas, its rules
and its summary table — a different pair is a different filter.

Validation refuses a chop threshold that can never be reached (`emaChopFlips`
above `emaChopLookback - 1`), because a rule that cannot fire is worse than one
that is off: nothing says so. Everything else is warned about rather than
refused, including both switches being turned off.

All six are in the settings **fingerprint**, so retuning them takes effect on the
running engine within one safety-timer tick — held back, as always, until an open
position closes.

---

## 5. What it records

`ose_decisions` gains four columns, written on **every** row including the ones
the EMA filter did not decide — a column only populated on refusals cannot answer
"what were the averages doing when it *did* trade".

| Column | |
|---|---|
| `ema9_p`, `ema20_p` | `DECIMAL(14,4)`, fractional paise, **unrounded** until the storage boundary. Rounding two averages independently before subtracting can flip the sign of the difference, and that difference is the crossover. |
| `ema_trend` | `BULLISH` / `BEARISH` / `SIDEWAYS` / `NO_CONFIRM` / `WARMING_UP` |
| `ema_via` | `EMA_ALIGNED` / `EMA_FLAT` / `EMA_CHOP` / `EMA_FRESH_CROSS` / `EMA_CLOSE_AGAINST_9` / `EMA_WARMING_UP` |

`NULL` on rows written before the filter existed, and that null is left as null —
a zero EMA is a price, not a missing reading. Anything comparing before and after
must split on it rather than coalesce it.

Four new decision outcomes, distinct on purpose so the `/ose` tally can separate
them: `EMA_WARMING_UP`, `EMA_SIDEWAYS`, `EMA_FILTER_FAIL`, `EMA_TREND_CONFLICT`.

One new exit reason: `EXIT_EMA_CROSS`, recorded distinctly from
`EXIT_TREND_BREAK`. The count of trades the EMA closed before the 3-candle engine
noticed is the only measure of what this filter contributes.

The entry snapshot (both averages, the separation, the crossover age and the flip
count) is also written into `ose_trades.select_detail.ema`, because the exit is
judged against the same two averages and *"how far apart were they when this was
sold"* is the first question asked of a position the crossover closed.

---

## 6. Running it

```bash
npm run migrate            # adds the four columns and the six settings keys
npm test                   # 514 tests
node scripts/ose-preflight.js
node scripts/ose-selftest.js
node scripts/ose-replay.js --minutes 60 --drift 0.4 --trades
```

Preflight reports the filter's state, its thresholds and how long the warm-up
costs. The replay is the cheapest way to see the filter's effect on trade count
before a live session — its outcome tally now includes the four EMA refusals.

## 7. Tuning it, after the first session

The `EMA_SIDEWAYS` and `EMA_TREND_CONFLICT` counts on `/ose` are the direct
measure of what the filter costs. Read them against `ENTRY_TAKEN` before changing
anything:

* **`EMA_SIDEWAYS` dominates, few entries** — the flat band is probably too wide
  for the day's range. Halve `emaFlatPoints` first; it is the only one of the
  three whose effect scales with volatility.
* **`EMA_SIDEWAYS` with `EMA_CHOP` in the detail column** — `emaChopFlips` is
  strict for the tape. `4 in 6` is the next step, not `0`.
* **`EMA_TREND_CONFLICT` dominates** — the two filters genuinely disagree, which
  is the filter doing its job. This is not a number to tune away.
* **`EXIT_EMA_CROSS` never appears** — the 3-candle trend break and the §13.3
  validity filter are faster in this configuration, which is expected. It earns
  its place on the candle the cycle drops.
