# NIFTY Option Selling Engine
## Live Price Position Filter + Dynamic Exit Engine + Premium-Based Option Selection

**Version:** 2.0  
**Status:** Production Ready  
**Timeframe:** 5-Second NIFTY Candle  
**Trading Style:** Intraday Option Selling (Premium Scalping)

---

# Objective

Build a fully automated option-selling engine that:

- Selects the best option contract automatically
- Uses NIFTY 5-second candles as the master trend filter
- Validates every entry
- Dynamically manages the position
- Extends targets only while momentum continues
- Trails stop loss automatically
- Exits immediately when trend weakens

The strategy follows a single rule:

> **The latest completed 5-second NIFTY candle is the Single Source of Truth for the entire trade lifecycle.**

---

# Complete Trading Flow

```text
Market Open
      │
      ▼
Download Option Chain
      │
      ▼
Select Strike Based on Premium
      │
      ▼
Validate Option Liquidity
      │
      ▼
Wait for Entry Signal
      │
      ▼
Live Price Position Filter
      │
      ▼
PASS ?
      │
 ┌────┴─────┐
 │          │
No         Yes
 │          │
Skip      Place SELL Order
             │
             ▼
Target = 1 Point
SL = 2 Points
             │
             ▼
Every Completed 5s Candle
             │
             ▼
Recalculate Trend Filter
             │
             ▼
Trend Valid?
       │
 ┌─────┴─────┐
 │           │
No          Yes
 │           │
Exit     Increase Target
             │
             ▼
      Trail Stop Loss
             │
             ▼
      Wait Next Candle
```

---

# Module 1 — Market Selection

Supported Indices

- NIFTY 50
- BANKNIFTY (Future Version)

Trading Hours

```text
Start

09:16

Last Entry

15:10

Force Exit

15:20
```

---

# Module 2 — Automatic Option Selection

## Objective

Automatically select the safest option contract for selling.

No manual strike selection.

---

# Premium Selection Rules

Preferred Premium Range

```text
₹12 – ₹30
```

Ideal Range

```text
₹15 – ₹25
```

Avoid

```text
Premium < ₹10
```

Reason

- Very low premium
- Poor reward
- High gamma risk

Avoid

```text
Premium > ₹40
```

Reason

- High volatility
- Large stop loss
- Large swings

---

# Strike Selection Logic

Every scan:

1. Download live option chain.

2. Separate

```text
CE

PE
```

3. Filter by premium.

Example

```text
Premium

₹12–₹30
```

4. Remove illiquid strikes.

5. Rank remaining contracts.

6. Select best strike.

---

# Liquidity Filter

Minimum Open Interest

```text
100,000
```

Minimum Volume

```text
10,000
```

Bid Quantity

```text
>100
```

Ask Quantity

```text
>100
```

Bid Ask Spread

```text
≤ ₹0.20
```

Reject contracts with

- Wide spread
- Low volume
- Low OI
- Frozen quotes

---

# Strike Ranking Score

Example Score

```text
Score

=

Liquidity Score

+

OI Score

+

Volume Score

+

Spread Score

+

Premium Score
```

Highest score wins.

---

# Module 3 — Trend Direction Filter

Read the latest **three completed 5-second NIFTY candles**.

Bullish

```text
Higher High

Higher Low

Bullish Close
```

Bearish

```text
Lower High

Lower Low

Bearish Close
```

Only trade in the direction of the active trend.

---

# Module 4 — Entry Validation

Latest completed candle

Read

```text
Open

High

Low

Close
```

---

## Bullish Mid

```text
(Open + High)

/

2
```

---

## Bearish Mid

```text
(Open + Low)

/

2
```

---

# SELL PE Entry

Allowed only if

```text
Current Price

>

Bullish Mid
```

Otherwise

```text
Skip
```

---

# SELL CE Entry

Allowed only if

```text
Current Price

<

Bearish Mid
```

Otherwise

```text
Skip
```

---

# Module 5 — Order Placement

Entry Price

```text
Last Completed Option Candle Close

+

Configured Offset
```

Example

```text
Close

20.00

Offset

0.10

SELL

20.10
```

Never use

- Live ask price
- Live LTP
- Partial candle values

---

# Module 6 — Initial Risk

Example

```text
SELL

20.00
```

Initial Target

```text
19.00
```

Initial Stop

```text
22.00
```

Risk Reward

```text
Risk

2 Points

Reward

1 Point
```

---

# Module 7 — Live Position Filter

Every completed

```text
5-second candle
```

Recalculate

```text
Bullish Mid

Bearish Mid

Current Price
```

---

# Continue SELL PE

Continue only if

```text
Current Price

>

Bullish Mid
```

---

# Continue SELL CE

Continue only if

```text
Current Price

<

Bearish Mid
```

Otherwise

```text
Exit Immediately
```

---

# Module 8 — Dynamic Target Engine

Every successful confirmation extends profit target.

| Confirmation | Target |
|--------------|--------|
| Entry | 1 Point |
| First Confirmation | 2 Points |
| Second Confirmation | 3 Points |
| Third Confirmation | 4 Points |
| Fourth+ | Trail Until Exit |

Example

```text
SELL

20.00

↓

19

↓

18

↓

17

↓

Trail
```

---

# Module 9 — Dynamic Trailing Stop

Initial

```text
22
```

Premium

```text
19.20
```

Trail

```text
20.20
```

Premium

```text
18.50
```

Trail

```text
19.30
```

Premium

```text
17.80
```

Trail

```text
18.40
```

Rule

```text
Stop Loss

Never Moves Backward
```

Allowed

```text
22

↓

20.2

↓

19.3

↓

18.4
```

Not Allowed

```text
18.4

↓

19.5
```

---

# Module 10 — Exit Conditions

Exit immediately if any condition is true.

## Position Filter Fails

SELL PE

```text
Current Price

≤

Bullish Mid
```

SELL CE

```text
Current Price

≥

Bearish Mid
```

---

## Trend Break

Last three candles no longer maintain

Bullish

```text
Higher High

Higher Low
```

Bearish

```text
Lower High

Lower Low
```

---

## Trailing Stop Hit

```text
Exit
```

---

## Maximum Holding Time

```text
60–90 Seconds
```

---

## Premium Safety Exit

Exit if option premium increases against the position by

```text
2 Points
```

even if the trend filter has not yet failed.

---

## Liquidity Exit

Exit immediately if

- Bid disappears
- Spread exceeds ₹0.50
- Volume collapses

---

# Module 11 — Re-entry Rules

After an exit

Wait for

```text
Minimum

2 completed candles
```

Then

- Recalculate trend
- Select a fresh strike
- Revalidate liquidity
- Apply full entry logic again

Never re-enter immediately.

---

# Module 12 — Risk Management

Maximum simultaneous positions

```text
1
```

Maximum trades/day

```text
30
```

Maximum consecutive losses

```text
5
```

Daily loss limit

```text
Configurable
```

Daily profit target

```text
Configurable
```

If any limit is reached

```text
Stop Trading
```

---

# Final Decision Engine

```text
Market Open
      │
      ▼
Download Option Chain
      │
      ▼
Premium Filter
      │
      ▼
Liquidity Filter
      │
      ▼
Select Best CE / PE
      │
      ▼
Generate Entry Signal
      │
      ▼
5s Live Position Filter
      │
      ▼
PASS ?
      │
 ┌────┴────┐
 │         │
No        Yes
 │         │
Skip      SELL
             │
             ▼
Target = 1
SL = 2
             │
             ▼
Every Completed 5s Candle
             │
             ▼
Position Filter Valid?
      │
 ┌────┴──────┐
 │           │
No          Yes
 │           │
Exit     Increase Target
             │
             ▼
      Trail Stop Loss
             │
             ▼
Wait Next Candle
```

---

# Core Philosophy

The strategy uses a single decision framework across the entire trade lifecycle.

The **Live Price Position Filter** determines:

- ✅ Which option contract to trade (after premium and liquidity filtering)
- ✅ Whether a trade can be entered
- ✅ Whether the trade remains valid
- ✅ Whether the profit target should be extended
- ✅ Whether the stop loss should be tightened
- ✅ Whether the position should be exited immediately

Combined with automatic premium-based strike selection and strict liquidity rules, this creates a fast, disciplined option-selling engine designed for capturing small, high-probability premium moves while minimizing exposure to reversals and poor-quality contracts.