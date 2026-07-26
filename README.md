# Premium Range Trader

An option-selling auto-trading platform implementing
[`doc/Option Selling Auto Trading Platform.md`](doc/Option%20Selling%20Auto%20Trading%20Platform.md):
**premium-range selling with a protective hedge, an arm price and an offset trigger.**

> **Zerodha Kite supplies market data. Kotak Neo executes every order.**
> There is no order endpoint anywhere under `src/brokers/zerodha`, and that
> absence is deliberate — it makes the guarantee auditable rather than merely
> intended.

---

## The strategy in one screen

```
scan the chain for a premium inside [min, max]
        │
        ▼  pick the strike nearest the arm price
BUY THE HEDGE FIRST ──────────► confirmed
        │
        ▼  wait for the premium to FALL to the arm price
      ARMED
        │
        ▼  wait for it to REVERSE UP by the offset
SELL THE SHORT
        │
        ▼  monitor
   target │ stoploss │ square-off time
        │
        ▼  BUY BACK THE SHORT, then SELL THE HEDGE
     closed
```

Two invariants hold at every step:

1. **The hedge goes on first.** The short is sent only after the hedge order is
   confirmed. If the short then fails, the hedge is unwound rather than left as
   a stray long.
2. **The hedge comes off last.** On exit the short is bought back first. If that
   fails, the hedge is *kept* — it is the only thing capping the loss — and the
   engine retries.

---

## Getting started

```bash
npm install
cp .env.example .env          # then fill in the values below
npm run migrate               # creates the database and every table
npm start                     # web console      -> http://localhost:4000
npm run engine                # trading process  -> required for anything to execute
```

Both processes are needed. `npm start` alone gives you a console where nothing
ever trades.

### Zerodha requires a paid market-data subscription

Kite Connect has two separate things you can lack, and they fail very
differently:

Market data is entitled **separately from API access**, and the three scopes
fail independently:

| Scope | Endpoints | Symptom when missing |
| --- | --- | --- |
| Session | `/user/profile` | every call fails — the token is dead |
| API access | `/user/margins`, `/orders`, `/portfolio/*` | those calls fail |
| **Market data** | `/quote/*`, `wss://ws.kite.trade` | **only quotes fail** |

A real example from this project's own audit: profile, margins, positions and
the order book all returned `success`, while `/quote/ltp` returned
`PermissionException — Insufficient permission for that call.` and the ticker
answered a bare `403 Authentication failed`.

That 403 is indistinguishable from an expired token at the socket layer, so the
platform never guesses: whenever the ticker fails it runs the REST probe in
`src/brokers/zerodha/diagnose.js`, records the specific cause, and shows it on
the Brokers page. **Test connection** runs the same probe on demand.

Market data is enabled per app in the Kite developer console
(`developers.kite.trade`). Logging in again cannot fix it.

### Minimum `.env`

| Variable | Why |
| --- | --- |
| `DB_*` | MySQL / MariaDB connection |
| `JWT_SECRET` | session cookie signing — 32+ random chars |
| `TOKEN_ENC_KEY` | exactly 64 hex chars; AES-256 key for broker tokens at rest |
| `KITE_API_KEY`, `KITE_API_SECRET` | from developers.kite.trade |
| `NEO_API_TOKEN` | NEO App → Invest → Trade API → Your Applications |

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"  # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # TOKEN_ENC_KEY
```

The config module validates all of this at boot and refuses to start with a
clear list of what is missing, rather than failing hours later mid-session.

### First run

1. Open `http://localhost:4000` — the first account you create becomes the owner
   and registration then closes.
2. **Brokers** → save your Kite API key and secret, complete the Kite login, and
   log in to Kotak (mobile, UCC, TOTP, MPIN).
3. **Brokers** → *Sync instruments*. Confirm the bridged count is healthy.
4. **Strategies** → create one from a template. Everything starts in `paper`.
5. **Live** → watch the state rail.

---

## Daily routine

The Kite access token expires around **06:00 IST**, so each trading day:

1. Log in to Zerodha (**Brokers**).
2. Log in to Kotak (**Brokers**).
3. Sync instruments — contracts are added and expire daily.
4. Enable the strategies you want.

The engine can run continuously; it simply reports "feed down" until step 1 is
done, and refuses to open new positions in that state rather than trading blind.

---

## Read this before going live

A hedged round trip is **four orders** — hedge buy, short sell, short buy-back,
hedge sell — and brokerage is a flat fee per order. The cost is therefore
dominated by a constant, so the breakeven *move* scales as roughly `1/quantity`:

| Size (BANKNIFTY) | Round-trip cost | Breakeven move |
| --- | --- | --- |
| 1 lot (15) | ~₹94 | **~6.3 points** |
| 2 lots (30) | ~₹97 | **~3.2 points** |
| 5 lots (75) | ~₹105 | **~1.4 points** |

The specification's example uses a **2-point target on 2 lots**. That is ₹60
gross against ~₹97 of charges — **a losing trade even when it wins**.

The platform handles this rather than leaving it as a trap:

* defaults ship at **5 points target / 12 points stop**, above breakeven at the
  default size;
* `coverCharges` (on by default) recomputes the target from the *actual fills*
  at entry and raises it to clear the round trip plus a buffer;
* the strategy form prices the round trip live as you type;
* turning `coverCharges` off makes an under-breakeven target a **save-time
  error**, not a silent one.

The integration run demonstrates it end to end: a configured 2-point target is
lifted to 4.05 points, turning a −₹37 "win" into +₹24.

---

## Layout

```
db/schema.sql          every table, one file
db/migrate.js          idempotent migration runner

src/config/            all environment access, validated at boot
src/core/              logger, db, crypto, errors, IST time, charge maths
src/brokers/zerodha/   Kite REST + binary ticker  (MARKET DATA ONLY)
src/brokers/kotak/     Neo REST                   (EXECUTION ONLY)
src/market/            instrument bridge, feed registry
src/execution/         order router (at-most-once), reconciler
src/strategy/          config, scanner, state machine, risk  ← all PURE
                       runner, supervisor                    ← the I/O shell
src/repositories/      every SQL statement in the app
src/http/              routes, controllers, middleware
views/                 EJS console
test/                  unit tests for the pure core
scripts/               integration run against a live database
```

The strategy's decision logic is a **pure function** — `decide(facts) → action`
— with no clock, database or broker inside it. That is what makes the doc's own
worked example runnable as a test.

---

## Commands

```bash
npm run migrate      # apply the schema (safe to re-run)
npm start            # web console
npm run engine       # trading engine (leader-locked; several may run)
npm run dev          # console under nodemon
npm run dev:engine   # engine under nodemon
npm test             # 62 unit tests, no database needed
npm run test:e2e     # full trade through the real code path (needs the DB)
```

---

## Safety

| Concern | How it is handled |
| --- | --- |
| Double orders | `client_order_id` is UNIQUE per user and inserted *before* sending — the check survives a restart or a second engine |
| Unknown outcomes | A timeout after send is `UNKNOWN`, never resent; the reconciler resolves it against the broker's book |
| Ambiguous recovery | Several matching broker orders → the trade is flagged `NEEDS_ATTENTION`, never guessed |
| Two engines | A DB leader lock with heartbeat; a dead leader's claim expires and another takes over |
| Stale prices | Target and stop are not evaluated on a quote older than `maxQuoteAgeMs`; the square-off time still fires |
| Kill switch | Blocks opening orders; exits always pass, so halting can never trap a position |
| Secrets | Broker tokens AES-256-GCM at rest; TOTP and MPIN are forwarded once and never stored |
| Bad config | An arm price outside the scan range, an inverted spread or an under-breakeven target are refused at save time |

Full design notes: [`doc/ARCHITECTURE.md`](doc/ARCHITECTURE.md).

---

## Status

Verified working: the state machine, scanner, charge model and tick parser are
covered by 62 unit tests, and `npm run test:e2e` drives a complete trade —
scan → hedge → arm → offset → short → target → exit — through the real runner,
order router, database and audit trail.

Not yet exercised against live broker APIs: the Kotak order path and the Kite
ticker have been written to the documented contracts but have not placed a real
order or received a real tick. **Run in `paper` mode first**, confirm the audit
trail matches what you expect, and only then switch a strategy to `live`.
#   t r a d e n e w  
 