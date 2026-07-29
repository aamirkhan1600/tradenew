the correct trading flow is Candle-Based Entry with Locked Strike, not live Ask-price entry. The documents consistently specify:

Strike is selected only once.
CE & PE strikes are locked until the trade is closed.
The engine waits for the option contract's own candle to close (not the NIFTY index candle).
Entry price is calculated as Closed Candle Close + Configured Offset.
Live Ask, Live Bid, and LTP must never be used for the initial SELL price.
If the order is not filled, wait for the next completed candle before recalculating and placing a new SELL order.

Below is the final Markdown document.

# NIFTY Option Offset Scalper
## Final Candle-Based Entry Engine (Locked Strike)

Version: 3.0

---

# Objective

Build a deterministic NIFTY option selling engine that:

- Selects expiry only once
- Selects CE & PE strike only once
- Locks the selected strike
- Waits for the selected option's candle to close
- Uses the candle Close price as the entry reference
- Adds the configured offset
- Places a SELL LIMIT order
- Never uses Live Ask/Bid/LTP for the initial entry

---

# Trading Flow

Market Open
        │
        ▼
Download Instrument Master
        │
        ▼
Select Expiry
        │
        ▼
Select CE & PE Strike
        │
        ▼
LOCK Strike
        │
        ▼
Subscribe Selected CE & PE
        │
        ▼
Wait for Selected Option Candle Close
        │
        ▼
Read Candle Close Price
        │
        ▼
SELL Price = Candle Close + Offset
        │
        ▼
Place SELL LIMIT
        │
        ▼
Filled?
 ├─────────────── No
 │
 │ Cancel Pending Order
 │
 │ Wait For NEXT Candle Close
 │
 │ Read New Candle Close
 │
 │ SELL = New Close + Offset
 │
 └──────────────► Place SELL Again
        │
        ▼
Yes
        │
        ▼
Create BUY Target
        │
        ▼
Position Manager
        │
        ▼
Target / Stoploss / Timeout
        │
        ▼
Trade Closed
        │
        ▼
Unlock Strike
        │
        ▼
Start New Cycle

---

# Strike Selection

Expiry is selected only once.

Strike is selected only once.

Example

NIFTY Spot

25135

↓

ATM

25150

ATM Offset = +2

Selected CE = 25250

Selected PE = 25050

Once selected

LOCK_STRIKE = TRUE

No strike switching is allowed until the trade is completely closed.

---

# Candle Source

The candle must belong to the selected OPTION CONTRACT.

Never use:

- NIFTY Index Candle
- Spot Candle
- Future Candle

Correct example:

Instrument

NIFTY 31 JUL 25250 CE

Time

10:15

Open 12.10

High 12.60

Low 11.90

Close 12.40

The Close price becomes the reference price.

---

# Entry Price Formula

SELL PRICE

=

Closed Candle Close

+

Configured Offset

Example

Closed Candle

12.40

Offset

1.00

SELL LIMIT

13.40

---

# Entry Rules

Use only

✅ Closed Candle Close

Never use

❌ Live Ask

❌ Live Bid

❌ LTP

❌ Tick Price

The initial SELL order must always use the completed candle's Close.

---

# Pending Order Logic

If SELL order is not filled within the configured timeout:

Pending Order

↓

Cancel Order

↓

Wait For Next Candle Close

↓

Read New Close Price

↓

SELL = New Close + Offset

↓

Place New SELL LIMIT

Never modify the order every tick.

---

# Target Logic

SELL Filled

↓

BUY TARGET

=

SELL Price

-

Configured Target

Example

SELL

13.40

Target

1.00

BUY TARGET

12.40

---

# Stop Loss

Example

SELL

13.40

Premium rises

15.40

↓

SL Hit

↓

Market BUY

↓

Trade Closed

---

# Position Timeout

If neither Target nor Stoploss is hit

Trade Open

↓

Maximum Hold Time

↓

Exit Position

↓

Reason = TIMEOUT

---

# Recommended Candle Timeframe

Supported

- 15 Seconds
- 30 Seconds
- 1 Minute
- 3 Minutes
- 5 Minutes

Recommended

1 Minute

---

# Configuration

```json
{
  "symbol": "NIFTY",
  "entryMode": "OPTION_CANDLE_CLOSE",
  "expiryMode": "CURRENT_WEEKLY",
  "tradeMode": "BOTH",
  "strikeMode": "PREMIUM",
  "lockStrike": true,
  "priceSource": "CANDLE_CLOSE",
  "useLiveAsk": false,
  "useLiveBid": false,
  "useLTP": false,
  "sellOffset": 1.0,
  "target": 1.0,
  "stopLoss": 2.0,
  "pendingTimeout": 10,
  "positionTimeout": 60,
  "reQuoteOnNextCandle": true,
  "candleTimeframe": "1m"
}
```

---

# State Machine

SELECT_EXPIRY

↓

SELECT_STRIKE

↓

LOCK_STRIKE

↓

WAIT_OPTION_CANDLE_CLOSE

↓

READ_CLOSE_PRICE

↓

CALCULATE_SELL_PRICE

↓

PLACE_SELL_LIMIT

↓

ORDER_FILLED ?

NO

↓

WAIT_NEXT_CANDLE

↓

READ_NEW_CLOSE

↓

NEW_SELL_PRICE

↓

PLACE_SELL_LIMIT

YES

↓

CREATE_BUY_TARGET

↓

POSITION_MANAGER

↓

TARGET / SL / TIMEOUT

↓

POSITION_CLOSED

↓

UNLOCK_STRIKE

↓

START_NEXT_TRADE

---

# Engineering Rules

- Select expiry once per trade cycle.
- Select strike once per trade cycle.
- Lock CE & PE strikes immediately after selection.
- Never change strike while a pending order or open position exists.
- Build candles from the selected option contract only.
- Wait for the option candle to close before calculating entry.
- Entry Price = Closed Candle Close + Offset.
- Never use Live Ask, Live Bid, LTP, or Tick Price for the initial SELL order.
- Recalculate entry only after the next completed candle if the previous order expires.
- Do not chase the market.
- Maintain complete audit logs for every state transition.