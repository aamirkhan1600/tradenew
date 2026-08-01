# The Price-Filter Engine

The implementation of [`doc/new.md`](new.md) — *NIFTY Option Selling Engine v2.0:
Live Price Position Filter + Dynamic Exit Engine + Premium-Based Option
Selection*.

It is a **second, complete engine** beside the offset scalper, not a mode of it.
Its own route, its own settings profile, its own trade lifecycle, its own daily
risk state, its own process:

```bash
npm run migrate     # creates its tables and seeds its settings profile
npm start           # the console  ->  http://localhost:4100/pfe
npm run pfe         # the trading process — REQUIRED for anything to execute
```

> **`npm run pfe` and `npm run engine` take the same leader lock.** One account,
> two strategies that both sell naked options — exactly one of them may be live
> at a time, and the second one to start refuses rather than doubling the
> exposure the margin was sized for.

---

## Why a second engine and not a flag

The two strategies disagree about what a good configuration is, and the
disagreement is not cosmetic:

| | offset scalper | price-filter engine |
|---|---|---|
| what decides the side | candle SHAPE — body share of range, close near the extreme, a quality score | candle STRUCTURE — higher highs and higher lows |
| entry permission | one verdict, at the candle close | a verdict **and** the live price against that bar's midpoint, re-checked every bar |
| target / stop | 1.5 / 1.5 — a coin flip to break even | 1.0 / 2.0, with a ladder that is meant to earn the difference back |
| strike | ATM, ATM±n, or the premium nearest a target | ranked out of 100 across five liquidity terms |
| holding time | 60s default, one round trip per cycle | 60–90s hard ceiling |
| positions at once | one CE and one PE | exactly one, enforced by a unique index |

Sharing one settings row would mean one of them silently running on the other's
numbers. `target` alone means something different in each.

---

## The flow

```
                       every completed 5s NIFTY candle
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
        Module 3 — structure              Module 4 — price position
        HH+HL / LH+LL over 3 bars         bullish mid = (O+H)/2
        bullish → PE, bearish → CE        bearish mid = (O+L)/2
                    └───────────────┬───────────────┘
                                    ▼  both must agree
                       Module 2 — scan the chain
                       premium ₹12–30 → liquidity → rank → best
                                    │
                                    ▼   ARMED (the strike is held)
                    wait for THAT contract's own candle to close
                                    │
                       Module 5 — SELL LIMIT = close + offset
                                    │
                        ┌───────────┴───────────┐
                   not filled                 filled
                        │                        │
              cancel, wait for the       Module 6 — target 1pt, stop 2pt
              NEXT close, requote                 │
                        │           ┌─────────────┴──────────────┐
                        └──ARMED    ▼ every 5s index candle      ▼ every tick
                            Module 7 — filter still ok?      trailing stop
                                    │                        premium safety
                       ┌────────────┴────────────┐           liquidity
                       ▼ yes                     ▼ no
              Module 8 — target ladder     Module 10 — exit now
              1 → 2 → 3 → 4 → trail
                                    │
                                    ▼
                       Module 11 — wait 2 candles, rescan
```

---

## Where the code is

| Path | What it carries | Pure? |
|---|---|---|
| `src/pfe/direction.js` | Module 3 — higher highs / higher lows | ✅ |
| `src/pfe/priceFilter.js` | Modules 4, 7 — the two mids and the four questions they answer | ✅ |
| `src/pfe/scanner.js` | Module 2 — premium band, liquidity gates, the score out of 100 | ✅ |
| `src/pfe/exitRules.js` | Modules 5, 6, 8, 9, 10 — pricing, ladder, trail, exit predicates | ✅ |
| `src/pfe/machine.js` | the state machine and the OCO door | ✅ |
| `src/pfe/settings.js` | the `pfe` profile, its validation and its economics | |
| `src/pfe/engine.js` | where the pure parts meet the world | |
| `src/pfeEngine.js` | the process (`npm run pfe`) | |
| `src/http/pfeRoutes.js` | `/pfe`, `/pfe/settings`, `/api/pfe/*` | |
| `views/pfe.ejs` | the live console | |
| `views/pfeSettings.ejs` | every setting, grouped by the module it comes from | |

Five of the eight are pure functions with no I/O, no clock and no network, which
is why the whole decision table runs in a couple of milliseconds in
`test/pfe*.test.js`.

---

## Three things the document does not say, and what was done instead

### 1. Kotak sends almost none of the liquidity data

`doc/new.md` asks for open interest above 100,000, volume above 10,000, more
than 100 lots on each side of the book and a spread inside ₹0.20. On a retail
Trade API entitlement Kotak answers only the `ltp` quote filter — no OI, no
volume, no depth. `src/market/quoteSource.js` probes for something richer once,
at boot, and reports what it settled on.

So every check has **three** outcomes — PASS, FAIL and UNKNOWN — and
`liquidityMode` decides what UNKNOWN means:

- **LENIENT** (default) — the check is skipped and recorded. The strike is
  chosen on the checks that could actually be made, usually the premium alone.
  The Price Filter page says so on every scan, in the row under the table.
- **STRICT** — UNKNOWN counts as FAIL. Correct, and on an `ltp`-only account it
  means nothing is ever selected. That is the honest answer to "I require a
  liquidity filter", and both the settings page and the boot log say it out loud
  so it does not look like a quiet market.

A missing field is **never** coerced to zero. `Number(null)` is 0, and a chain
where every strike reports zero open interest does not read as "the broker sent
nothing", it reads as "nobody holds these".

### 2. The score has to be relative

"Rank remaining contracts" is a comparison, and an absolute ceiling for open
interest would be different on every expiry and every index. Four of the five
terms are therefore scored against the best in the same scan; the premium term
is absolute, because the document names an ideal band (₹15–25) and that band is
the point.

A term nobody in the scan has data for is dropped and the total rescaled over
what remains — so an `ltp`-only account still gets a meaningful ranking out of
the premium term instead of every contract scoring 20/100. `componentsUsed` on
the result and the columns on the page say which terms counted.

### 3. The trailing gap in the worked example is not constant

Module 9's example is

```
entry 20.00, stop 22.00
best 19.20 → 20.20     (gap 1.00)
best 18.50 → 19.30     (gap 0.80)
best 17.80 → 18.40     (gap 0.60)
```

which is a gap that tightens by 0.20 on every trail. That is implemented
literally: `trailGap` starts at 1.00, `trailTighten` takes 0.20 off it on each
trail that moves the stop, and `trailMinGap` floors it at 0.40. The shipped
defaults reproduce those three numbers exactly, and `trailTighten: 0` gives a
plain fixed-gap trail instead.

`test/pfeExitRules.test.js` asserts the example line by line.

---

## The invariants

Four have dedicated tests because a violation costs money.

- **I1** — no order price is derived from a live quote. `calculateSellPrice`
  takes a candle and an offset; it has an arity of two and the test greps its
  body for the words `ltp`, `quote`, `bid`, `ask` and `tick`.
- **I2** — a trade never has two working SELL orders. There is exactly one
  `PLACE_SELL` construction site and it is reachable only from `ARMED`, checked
  against every other state.
- **I3** — no exit market order is sent while a target is still working. There
  is exactly one `EXIT_MARKET` construction site and it sits behind
  `TARGET_CANCELLED`; every exit trigger is driven through the machine to prove
  it cancels first and sends nothing.
- **I4** — a round trip is booked exactly once, even if the broker reports the
  same fill twice.

And two enforced by the database rather than by remembering:

- `pfe_guard.open_key` is a unique index that permits exactly one live trade.
- `orders.client_ref` is unique, and this engine's keys are namespaced `PF-`
  against the scalper's `ZO-`, so cycle 7 and pfe trade 7 cannot collide.

---

## Reading the console

`/pfe` polls `GET /api/pfe/status` once a second. Six things are worth knowing
before acting on it:

- **Engine / heartbeat.** "the pfe process is not running" and "nothing is
  tradable" need completely different actions, so they never render the same
  way. The tile shows the age of the engine's last heartbeat.
- **Structure** is Module 3's verdict and which side it permits.
- **Bullish mid / bearish mid** are Module 4's two numbers. The whole strategy
  is the current index price against those.
- **Nothing is being selected** appears only while the engine is refusing every
  scan, with the most recent reason. This is the answer to "why is nothing
  trading" and it exists because every individual refusal is silent.
- **Last scan** is the ranked table, with each score component as a percentage.
  An em-dash is a component the broker sent no data for — never a zero.
- **P&L is net.** On a one-point first rung most of the gross is charges.

---

## Economics, stated once

On one NIFTY lot a round trip costs roughly 0.75 points of premium at a
₹20-per-order brokerage. The document's 1.0 target against a 2.0 stop therefore
needs to be right around seven times in ten before that is even considered, and
charges are paid in full on winners and losers alike.

**The ladder is the entire answer to that**, which is why `dynamicTarget`
defaults to ON here and why turning it off produces a warning. The settings page
prints both numbers — the first rung and the full four-rung ladder — because
quoting only the first understates the strategy and quoting only the last
flatters it.

Decide viability from paper results, on net numbers, with the fill rate read
first: a limit above the market only fills if the premium rises into it.

---

## Known limits

- The liquidity filter and the liquidity exit are only as good as the broker's
  quote entitlement. On `ltp` alone the filter degrades to a premium band and
  the liquidity exit cannot fire at all; both say so rather than pretending.
- "Volume collapse" is detectable only as "no new volume since entry", because
  cumulative volume cannot fall.
- 5-second bars on a REST-only quote path hold about five samples. The
  `trendMinTicks` / `optionMinTicks` guards refuse to measure structure from
  fewer, and `settings.validate` warns when the configured floor is above what
  the poll cadence can deliver.
- Single account, NIFTY only. BANKNIFTY is carried in the instrument master but
  not wired up, matching `doc/new.md`'s own "future version".
- No exchange-holiday calendar. A holiday presents as a silent feed.
