# Parallel Entry Validation Engine
## EMA Trend + 3-Candle Trend + Midpoint Validation

**Version:** 1.0
**Purpose:** Single-pass validation engine
**Execution:** Every completed 5-second NIFTY candle

---

# Objective

Instead of running:

1. EMA Trend Engine
2. 3-Candle Trend Engine
3. Midpoint Validation

one after another,

all three validations are executed from the **same completed candle**.

This reduces processing time and guarantees every validation uses the identical market snapshot.

---

# Execution Flow

```text
                5 Second Candle Closed
                         │
                         ▼
        Load Required Historical Candles
                         │
                         ▼
      ┌───────────────────────────────────┐
      │                                   │
      │      Parallel Validation Engine    │
      │                                   │
      │  ┌─────────────┐                  │
      │  │ EMA Engine  │                  │
      │  └─────────────┘                  │
      │                                   │
      │  ┌─────────────┐                  │
      │  │ 3 Candle    │                  │
      │  │ Trend       │                  │
      │  └─────────────┘                  │
      │                                   │
      │  ┌─────────────┐                  │
      │  │ Midpoint    │                  │
      │  │ Validation  │                  │
      │  └─────────────┘                  │
      │                                   │
      └───────────────────────────────────┘
                         │
                         ▼
           Merge Validation Results
                         │
                         ▼
             Final Entry Decision
```

> **Implementation status, 2026-08-02.**
>
> The parallel requirement is **met** — all three validations run off the same
> completed candle in one cycle, from one read of the index buffer, with one EMA
> computation. `src/ose/validation.js` is the merge step and returns this
> document's Validation Output Object; the engine acts on that object rather than
> on a separate set of checks.
>
> **Thread A / B / C is deliberately not implemented.** Measured on a full
> 720-bar buffer:
>
> ```
> 3-candle trend                    0.562 µs
> EMA 9/20 (two full passes)       18.275 µs
> midpoint validation               0.802 µs
> all three, sequential            19.639 µs
> slowest alone (perfect parallel) 18.275 µs   ->  best case saves 1.4 µs
> ```
>
> One 5-second candle is 5,000,000 µs, so the whole merge costs **0.0004%** of
> the budget. A `worker_threads` round trip costs 100–1000× the theoretical
> saving, would add shared-state hazards to the money path, and would break the
> determinism gate. The advantages this document lists — single read, one EMA
> per cycle, no duplicate calculation, identical snapshot, one decision object —
> are delivered by the structure, not by threads.

---

# Input Data

The engine loads only once.

Required data:

Latest Closed Candle

Previous Candles

EMA9

EMA20

Last 3 Completed Candles

Current Close

Current High

Current Low

Current Open

No module reloads data independently.

---

# Step 1

Calculate EMA Values

```
EMA9

EMA20
```

Output

```
EMA9 = value

EMA20 = value
```

---

# Step 2

Run EMA Trend Validation

Rules

Bullish

```
EMA9 > EMA20

AND

Close > EMA9
```

Bearish

```
EMA9 < EMA20

AND

Close < EMA9
```

Otherwise

```
SIDEWAYS
```

Output

```
EMA Result

Bullish

Bearish

Sideways
```

---

# Step 3

Run 3 Candle Trend

> **RESOLVED 2026-08-02 — this section is SUPERSEDED by `newdoc/update.md` §10.**
>
> The rules below (Higher High + Higher Low + Higher Close) are **not** what the
> engine implements, and the desk has confirmed that §10 wins. `src/ose/trend.js`
> stays as it is: close drift across the window, with a midpoint tie-break and
> then a newest-candle tie-break.
>
> The two rules are not interchangeable. Measured over 20,000 generated 3-candle
> windows:
>
> | | BULLISH | BEARISH | no verdict |
> |---|---|---|---|
> | This section (HH+HL+HC) | 3,800 | 4,010 | **12,188** |
> | `src/ose/trend.js` (§10) | 9,932 | 10,066 | 0 |
>
> They **agree 39.1%** of the time and never point in opposite directions — the
> entire disagreement is that HH+HL+HC returns *no verdict* where §10 always has
> one. Adopting it would cut entry opportunities by roughly 60%, and since §10.3
> makes `null` a trend break for an open position, it would also exit far more
> often. That is a different strategy, not a tidier statement of this one.
>
> Everything else in this document is implemented — see the note under
> *Execution Flow*.

Using

```
Candle 1

Candle 2

Candle 3
```

Bullish

```
Higher High

Higher Low

Higher Close
```

Bearish

```
Lower High

Lower Low

Lower Close
```

Output

```
Bullish

Bearish

Undetermined
```

---

# Step 4

Run Midpoint Validation

Current Candle

```
Bullish Mid

(Open + High)/2

Bearish Mid

(Open + Low)/2
```

Bullish

```
Close > Bullish Mid
```

Bearish

```
Close < Bearish Mid
```

Output

```
PASS

FAIL
```

---

# Step 5

Merge Results

Now compare all three outputs.

Example

```
EMA

Bullish

3 Candle

Bullish

Midpoint

PASS
```

Result

```
VALID ENTRY
```

---

Another example

```
EMA

Bullish

3 Candle

Bearish

Midpoint

PASS
```

Result

```
EMA_TREND_CONFLICT
```

---

Another

```
EMA

Bullish

3 Candle

Bullish

Midpoint

FAIL
```

Result

```
NO_ENTRY
```

---

Another

```
EMA

Sideways

3 Candle

Bullish

Midpoint

PASS
```

Result

```
EMA_SIDEWAYS
```

---

# Final Decision Matrix

| EMA | 3-Candle | Midpoint | Result |
|------|-----------|----------|--------|
| Bullish | Bullish | PASS | SELL PE |
| Bearish | Bearish | PASS | SELL CE |
| Bullish | Bearish | PASS | Reject |
| Bearish | Bullish | PASS | Reject |
| Sideways | Any | Any | Reject |
| Any | Undetermined | Any | Reject |
| Bullish | Bullish | FAIL | Reject |
| Bearish | Bearish | FAIL | Reject |

---

# Internal Flow

```text
Decision Cycle Start
        │
        ▼
Load Candle Data
        │
        ▼
Calculate EMA9
Calculate EMA20
        │
        ▼
──────────────────────────────────────
Execute Together
──────────────────────────────────────

Thread A

EMA Trend

Thread B

3 Candle Trend

Thread C

Midpoint Validation

──────────────────────────────────────
        │
        ▼
Wait Until All Complete
        │
        ▼
Merge Results
        │
        ▼
Final Validation
        │
        ▼
Entry Allowed?
        │
     Yes │ No
         │
         ▼
 Reject Trade
         │
        Yes
         │
         ▼
Strike Selection
         │
         ▼
Risk Engine
         │
         ▼
SELL Order
```

---

# Validation Output Object

```json
{
  "emaTrend": "BULLISH",
  "threeCandleTrend": "BULLISH",
  "midpoint": true,
  "entryAllowed": true,
  "side": "SELL_PE",
  "reason": "VALID_ENTRY"
}
```

---

# Advantages

- Single historical data read.
- One EMA calculation per cycle.
- One deterministic decision for each 5-second candle.
- Lower CPU usage.
- Lower latency.
- Easier unit testing.
- No duplicate calculations.
- Every validation uses the exact same candle snapshot.
- Produces a single decision object consumed by Strike Selection and the Risk Engine.