# EMA Trend Confirmation Engine

## EMA 9 + EMA 20 Filter for NIFTY Option Selling Engine

**Version:** 1.0
**Module:** EMA Trend Filter
**Status:** Production Ready
**Timeframe:** 5-Second NIFTY Candle

---

# Objective

The EMA Trend Confirmation Engine acts as the **first trend filter** before any trade is evaluated.

Its purpose is to:

* Filter weak market conditions.
* Confirm short-term trend direction.
* Prevent trades during sideways movement.
* Improve entry quality.
* Work together with the existing 3-Candle Trend Engine.

The engine **does not generate buy or sell signals**.

It only confirms whether trading is allowed.

---

# Engine Position

```text
5 Second NIFTY Candle Closed
        │
        ▼
Calculate EMA 9
        │
        ▼
Calculate EMA 20
        │
        ▼
EMA Trend Filter
        │
        ▼
3 Candle Trend Engine
        │
        ▼
Midpoint Validation
        │
        ▼
Strike Selection
        │
        ▼
Risk Validation
        │
        ▼
SELL Order
```

---

# EMA Calculation

## EMA 9

Uses the latest completed **9** NIFTY 5-second candles.

Formula

```
EMA = Previous EMA + Multiplier × (Close − Previous EMA)

Multiplier = 2 / (9 + 1)

Multiplier = 0.20
```

---

## EMA 20

Uses the latest completed **20** NIFTY 5-second candles.

Formula

```
EMA = Previous EMA + Multiplier × (Close − Previous EMA)

Multiplier = 2 / (20 + 1)

Multiplier = 0.095238
```

---

# Data Source

Only use:

* Completed NIFTY 5-Second Candles
* Candle Close Price

Never use:

* Live Tick
* LTP
* Partial Candle
* Bid/Ask Price

---

# Bullish EMA Condition

A bullish trend exists only if:

```
EMA9 > EMA20

AND

Current Close > EMA9
```

Result

```
EMA Trend = BULLISH
```

---

# Bearish EMA Condition

A bearish trend exists only if:

```
EMA9 < EMA20

AND

Current Close < EMA9
```

Result

```
EMA Trend = BEARISH
```

---

# Sideways Market

Reject trade when:

```
EMA9 == EMA20

OR

Price is moving repeatedly above and below EMA9

OR

EMA crossover has just occurred
```

Result

```
NO TRADE
```

---

# EMA Crossover Detection

## Bullish Crossover

```
Previous EMA9 <= Previous EMA20

AND

Current EMA9 > Current EMA20
```

---

## Bearish Crossover

```
Previous EMA9 >= Previous EMA20

AND

Current EMA9 < Current EMA20
```

---

# Trade Rules

## Allow SELL PE

```
EMA Trend = BULLISH

AND

3 Candle Trend = Bullish

AND

Midpoint Filter = PASS
```

---

## Allow SELL CE

```
EMA Trend = BEARISH

AND

3 Candle Trend = Bearish

AND

Midpoint Filter = PASS
```

---

# Reject Trade

Reject immediately if:

```
EMA Trend = SIDEWAYS

OR

EMA Filter = FAIL

OR

EMA Direction ≠ 3 Candle Trend
```

---

# Position Exit Rule

Exit immediately when:

```
Bullish Trade

EMA9 crosses below EMA20
```

OR

```
Bearish Trade

EMA9 crosses above EMA20
```

---

# Decision Flow

```text
New 5 Second Candle Closed
        │
        ▼
Calculate EMA 9
        │
        ▼
Calculate EMA 20
        │
        ▼
Compare EMA9 & EMA20
        │
        ▼
Bullish ?
        │
      Yes
        │
        ▼
3 Candle Bullish ?
        │
      Yes
        │
        ▼
Midpoint Break ?
        │
      Yes
        │
        ▼
SELL PE
```

```text
New 5 Second Candle Closed
        │
        ▼
Calculate EMA 9
        │
        ▼
Calculate EMA 20
        │
        ▼
Compare EMA9 & EMA20
        │
        ▼
Bearish ?
        │
      Yes
        │
        ▼
3 Candle Bearish ?
        │
      Yes
        │
        ▼
Midpoint Break ?
        │
      Yes
        │
        ▼
SELL CE
```

---

# Implementation Requirements

* Timeframe: **5-Second NIFTY Candle**
* Use only completed candles.
* Recalculate EMA9 and EMA20 after every new completed candle.
* EMA calculations must run before the Trend Engine.
* No trade should be evaluated if the EMA filter fails.
* EMA values should be stored in memory for fast access.
* All EMA calculations must be deterministic and use historical completed candle data only.

---

# Module Summary

| Component        | Description                                   |
| ---------------- | --------------------------------------------- |
| Timeframe        | 5 Seconds                                     |
| Indicator        | EMA 9                                         |
| Indicator        | EMA 20                                        |
| Data Source      | Completed Candle Close                        |
| Bullish Rule     | EMA9 > EMA20 & Close > EMA9                   |
| Bearish Rule     | EMA9 < EMA20 & Close < EMA9                   |
| Sideways Rule    | EMA9 ≈ EMA20 or recent crossover              |
| Entry Filter     | Mandatory                                     |
| Exit Trigger     | EMA9/EMA20 crossover                          |
| Trading Decision | SELL CE / SELL PE only after EMA confirmation |
        