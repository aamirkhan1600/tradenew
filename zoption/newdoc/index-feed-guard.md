# The index-feed sanity check

| | |
|---|---|
| Engine | `src/ose/spotGuard.js` — pure, no I/O, no clock |
| Wired in | `src/ose/engine.js` `_evaluateEntry()`, `scripts/ose-preflight.js` |
| Settings | `spotCheckEnabled`, `spotCheckMaxDivergencePoints`, `spotCheckMinPairs` |
| Tests | `test/oseSpotGuard.test.js` (15), plus 3 engine-wiring tests |
| Outcome | `SPOT_DIVERGENCE` in the decision log and the `/ose` tally |

---

## 1. What happened

On **2026-08-02** this account's Kotak gateway answered `nse_cm|Nifty 50` with:

```json
{"exchange_token":"Nifty 50","display_symbol":"Nifty 50-IN","exchange":"nse_cm","ltp":"25117.5500"}
```

The index was at **24383.60**. A 734-point lie, served with an HTTP 200 and no
error anywhere. It was not a parsing bug — the raw payload is above.

The engine builds its entire index candle series from that number, so the
3-candle trend, both midpoints, the EMA9/EMA20 filter and `strikes.moneyness()`
all inherited it. `moneyness()` computes `atmStrike = round(spot / 50) * 50`, so
the at-the-money strike came out at **25100 instead of 24400** — marking every CE
in the sellable band as in-the-money and unsellable, and misreporting the
distance of every PE.

**Nothing in the system noticed.** That is the part worth fixing. A feed that
fails loudly is an operational annoyance; one that fails silently with a
plausible-looking number is how an engine sells the wrong strike all morning.

Both existing safety nets were blind:

* **`ose-preflight.js`** read its spot with `SELECT close_p FROM ose_decisions
  WHERE trade_date = ?` — wrong column name (`nifty_close_p`), and a placeholder
  with nothing bound. It threw `Unknown column` on every run and a bare
  `.catch(() => null)` swallowed it, so preflight silently fell through to the
  `candles` table and reported on data the engine does not use. It printed
  **0 FAIL, "Ready"** straight through the error.
* **`diagnose-spot.js`** treats any price as success. It printed *"The gateway
  DOES quote the index"* while the number was 734 points wrong.

## 2. Why not `ltp` against `ohlc.close`

The obvious check — compare the two fields the same gateway serves for the same
instrument — is wrong, and it is written into the module header so nobody
"simplifies" back to it:

* During live hours `ohlc.close` is the **previous** session's close, so `ltp`
  legitimately differs from it by the whole of today's move. The check would fire
  on every trending day and be switched off within a week.
* On this account the OHLC block is itself unreliable: it reported
  open 24615.40 / high 25429.15 / low 24262.55 for a session whose real values
  were 24361.45 / 24429.40 / 24299.70. Only `close` happened to be right, and a
  guard resting on one accidentally-correct field is not a guard.

## 3. What it does instead

Put-call parity, over the chain the engine is about to select from:

```
C − P = S − K·e^(−rt)        over a near expiry, e^(−rt) ≈ 1
  =>  S ≈ K + (C − P)
```

Every strike quoting **both** legs is an independent estimate of the spot. The
guard takes the **median** across them and compares it to the sealed index close.

Three reasons this is the right instrument rather than merely a second one:

* it **moves with the market**, so a real 3% day does not trip it;
* it is denominated in the same prices the strike selector ranks on — if the
  chain and the index disagree, the engine is by definition about to select
  against a market it cannot see;
* it needs only `ltp` on options, which is all this entitlement serves.

**Median, not mean.** Near the money the estimates are extremely tight — 24381 to
24384 across a dozen strikes on the live chain. Far out of the money, where a leg
may not have traded for hours, a stale `ltp` produces estimates hundreds of
points wide; 23854, 24050 and 23922 all appeared in the same snapshot. A mean
follows those. The median ignores them and needs no threshold of its own to.

Measured against the live chain on the day of the failure — with the scan window
deliberately centred on the **wrong** spot — the median came back at **24382.10**
against a true 24383.60. Accurate to 1.5 points while the feed was out by 735.

## 4. What it does when it fires

Blocks **new entries only**, and writes one `SPOT_DIVERGENCE` decision row per
refused cycle. The alert is logged at error level **once per episode**, not once
every five seconds: a wrong feed does not repair itself, and 720 identical lines
an hour would bury the one that matters. The decision-log tally on `/ose` is what
counts the refusals.

It deliberately does **not** halt. A halt needs a script and a restart to clear,
and a false positive at 09:20 on a Monday would be more expensive than the
refusal it protects against.

An open position keeps being managed, because its stop, target and premium floor
are read from the option contract's own candle and are unaffected by a wrong
index level. **The §13.3 position-validity filter is affected**, and that limit is
stated rather than papered over: a divergent feed makes it unreliable in both
directions, so an operator seeing `SPOT_DIVERGENCE` with a position open should
square off from the Kotak terminal rather than wait.

An **unmeasurable** chain (fewer than `spotCheckMinPairs` both-legged strikes) is
`SPOT_UNKNOWN` and does *not* block. A thin chain is already the business of
`CHAIN_CORRUPT` and `NO_LIQUID_STRIKE`; stopping the engine twice for one fault
helps nobody, and a guard that refuses whenever it cannot measure would refuse on
every quiet open.

## 5. Configuration

| Key | Default | |
|---|---|---|
| `spotCheckEnabled` | `true` | Ships ON. |
| `spotCheckMaxDivergencePoints` | `100` | Index points. Parity over a near expiry is worth single-digit points; the failure was 734. |
| `spotCheckMinPairs` | `5` | Below this the chain has no opinion and says so. |

Named `spotCheck*` and **not** `spotGuard*`, to stay distinct from
`stopGuardEnabled` (§16.4) — a completely different mechanism about a completely
different risk. Two settings one letter apart get read wrong exactly once, at the
worst possible moment.

No `[MUST-CONFIRM]` entry was added. The register gates LIVE mode, and this is a
defect fix that fails toward *not* trading rather than a specification ambiguity
— adding one would re-block LIVE for a desk that has already signed off all 19.
Raise it as #20 if you would rather the 100-point band carried a formal sign-off.

## 6. Verified against the live failure

```
$ node scripts/ose-preflight.js
FAIL  index feed agrees with the chain — feed 25117.55 vs 41 strikes pricing it
      at 24381.85 — out by 735.70 points. DO NOT TRADE: the strike selector will
      pick from the wrong part of the chain.

spot 25117.55, at-the-money strike 25100, band ₹30–40
WARN  CE candidate — none in band (41 rejected; first: premium 298.35 outside 30–40)
PASS  PE candidate — NIFTY2680424200PE @ 30.10, 900 pts OTM

1 FAIL, 6 WARN → NOT READY        (exit code 1, so it gates a start script)
```

The two candidate lines are the damage made visible: `24200PE` is reported as
900 points out of the money when it is really 183, and every CE is rejected as
too expensive because the selector is ranking around 25100.

## 7. Monday

Re-run `node scripts/ose-preflight.js` after the login and before 09:20. If the
feed check FAILs, the engine will refuse entries on its own — but the fault is at
the broker, and the fix is operational: re-login, or trade from the terminal.

---

# 8. The synthetic index — `src/ose/syntheticIndex.js`

The guard's other half. The guard says *"do not trade, the index is wrong"*; this
says *"here is what the index actually is"*.

## What it does

Every strike quoting **both** legs prices the index by put-call parity. The
median across the near-money ones is a level derived from the instruments the
engine is about to trade — the ones that were still telling the truth on
2026-08-02 while the cash-segment index was 734 points stale.

It uses `spotGuard.impliedSpot` rather than its own arithmetic. That is not
tidiness: the guard is what decides the feed is wrong, and if the two computed
the index differently the engine could switch to a source the guard then
rejected.

## Why the legs are subscribed, not read off the chain snapshot

The obvious implementation — recompute on the chain's 5-second refresh —
produces **one index sample per 5-second bucket**. A bar built from one sample
has `open == high == low == close`, so §11.2's midpoints collapse onto the close,
`close > bullishMid` is never true, and the engine would never take an entry
again. It would look like it was running.

So the legs ride in the **ticker's one-second poll**, in the same batched request
the index and the held contract already use. Twelve legs on a `NEO_QUOTE_BATCH`
of 25 costs **no extra HTTP request** — a test asserts that headroom, because if
the default ever grew past the batch it would silently become a second request
per second against a shared rate budget.

## Measured against the real failure

```
legs picked   : 25000, 25050, 25100, 25150, 25200, 25250   (centred on the WRONG 25117.55)
one request   : 12 instruments   ->   12 answered

SYNTHETIC INDEX : 24384.10
quoted feed     : 25117.55
true (Yahoo)    : 24383.60
error vs true   : 0.50 points
```

Half a point — with the window centred 700 points from the money, on deep-ITM
puts, because parity is an identity and holds at every strike. That tolerance is
what lets it bootstrap at all: the only spot available the first time it runs is
the one under suspicion.

## The switch, and what it costs

`syntheticIndexMode`:

| | |
|---|---|
| `AUTO` | ships. Use the quoted index; derive while it disagrees; switch back when it agrees |
| `OFF` | never derive — a divergent feed just stops the engine, the behaviour before this existed |
| `FORCE` | always derive. For proving the path, not for a session |

**A source change throws the candle buffer away.** The two sources were 734
points apart; splicing one series onto the other puts a 734-point step in the
middle of it, and the trend engine and the EMA both read that step as the most
violent move of the session and act on it. A gap in the record is recoverable; a
fabricated move is not.

The cost is honest and large: **~105 seconds of `EMA_WARMING_UP` after every
switch, in each direction**. A feed that flaps would spend its session warming
up, which is why the switch is decided on the settled spot check rather than on
one cycle's opinion.

## Two deliberate asymmetries

- **A stale leg is dropped, not averaged.** A call that ticks while its put does
  not moves `C − P` for a reason that is not the index. Any strike whose legs are
  not both fresh within two poll intervals is discarded outright.
- **Too few fresh strikes returns `null`, not a number.** Null feeds nothing to
  the candle builder, which shows up as a thin or absent bar. A zero would be a
  price, and would be traded on.

## What it records

`ose_decisions.index_source` — `FEED` or `CHAIN` — on **every** row. "Was this
trade decided on a derived index" is not a question to be answering from log
timestamps a month later.

While the source is `CHAIN` the spot check is **skipped**, and says so. Comparing
a chain-derived level against the chain it came from can only ever agree; running
it would be a check that always passes wearing the name of one that means
something. `_maintainIndexSource` is what watches the quoted feed in that mode.

## The limitation worth stating

The strategy's 5-second candle **shape** — the highs and lows §11.2 takes its
midpoints from, and the closes the EMA runs on — becomes a function of option
premiums rather than of the index. Parity is exact, but option prints are
discrete and arrive at their own pace, so the derived path is not the index's
path. That has not been validated against live tape, and `AUTO` exists so it is
only reached when the alternative is not trading at all.
