For your Option Selling Auto Trading Platform, I would not design it as a generic trading engine. Instead, build it around Premium Range Selling + Hedge + Arm Trigger + Offset + Target + SL.

Strategy Overview
Market Data
   │
   ▼
Zerodha WebSocket
(Index + Option LTP)

   │
   ▼
Premium Scanner

   │
   ▼
Find Option in Premium Range

Example

Sell Premium Range

35 - 45

↓

Find

38.25 CE

OR

41.10 PE

↓

Select Best Strike

↓

Buy Hedge

↓

Wait for Arm Price

↓

Offset Trigger

↓

Sell Main Option

↓

Monitor

↓

Target

SL

Time Exit

↓

Exit Both Legs
Strategy Configuration
Strategy Name

BNF Premium Selling

Underlying

BANKNIFTY

Trade Type

SELL

Option Type

CE
PE
Both

Premium Range

Minimum Premium

35

Maximum Premium

45

Arm Price

40

Offset

0.50

Target

2 Points

Stoploss

5 Points

Lots

2

Hedge Distance

10 Strike

OR

Premium Based

10 Rupees

Entry Time

09:20

Last Entry

14:30

Square Off

15:20
Entry Logic
Receive Live Option Chain

↓

Find Premium

35 - 45

↓

Multiple Strikes Found

38300 CE

38

38350 CE

41

38400 CE

44

↓

Nearest to Arm Price

40

↓

Selected Strike

38350 CE
Hedge Selection

After strike selection

Sell

38350 CE

Premium

40

↓

Find Hedge

38450 CE

Premium

10

↓

Buy Hedge First

↓

Confirm Filled

↓

Sell Main Option

Execution Order (Very Important)

Buy Hedge

↓

Filled

↓

Sell Main Leg

↓

Filled

↓

Strategy Active

Never sell before the hedge is confirmed.

Arm Price Logic

Example

Selected Premium

41

Arm Price

40

Offset

0.50

Price Movement

41

40.70

40.30

40.00

↓

ARMED

39.90

40.10

40.30

40.50

↓

SELL

The strategy only sells after the option first reaches the arm price and then reverses upward by the offset.

Order Execution
BUY Hedge

↓

Kotak

↓

Success

↓

SELL Main

↓

Kotak

↓

Success

↓

Store Trade
Trade Table
Trade ID

Strategy ID

Sell Symbol

Sell Strike

Sell Price

Hedge Symbol

Hedge Strike

Hedge Buy Price

Target

Stoploss

Status

Order IDs
Live Monitoring

Every tick from Zerodha

Current Premium

↓

Compare Sell Price

↓

Target Hit?

↓

Yes

↓

Buy Back Sell Leg

↓

Sell Hedge

↓

Trade Complete

OR

Current Premium

↓

SL Hit?

↓

Yes

↓

Buy Back Sell Leg

↓

Sell Hedge

↓

Trade Complete
Exit Sequence
Sell Position

+

Hedge Position

↓

Exit Sell Leg

↓

Filled

↓

Exit Hedge

↓

Filled

↓

Completed
Premium Scanner

Every second

BANKNIFTY

↓

Option Chain

↓

Strike

38100

Premium

72

Ignore

----------------

38200

Premium

54

Ignore

----------------

38300

Premium

44

Accept

----------------

38350

Premium

41

Accept

----------------

38400

Premium

38

Accept

----------------

38500

Premium

28

Reject
Strategy State Machine
IDLE

↓

SCANNING

↓

STRIKE FOUND

↓

HEDGE BUYING

↓

HEDGE FILLED

↓

ARM WAIT

↓

OFFSET WAIT

↓

SELL EXECUTED

↓

POSITION OPEN

↓

TARGET

or

STOPLOSS

↓

EXIT

↓

FINISHED
Complete Trading Flow
Market Open
     │
     ▼
Login Zerodha
     │
     ▼
Login Kotak Neo
     │
     ▼
Download Instrument Master
     │
     ▼
Subscribe Index + Option Chain
     │
     ▼
Live Premium Scanner
     │
     ▼
Find Option Between Min & Max Premium
     │
     ▼
Select Strike Closest to Configured Arm Price
     │
     ▼
Select Hedge Strike
     │
     ▼
Place BUY Hedge Order (Kotak)
     │
     ▼
Hedge Filled?
     │
     ├── No → Retry / Cancel Strategy
     │
     └── Yes
           │
           ▼
Monitor Selected Option LTP
           │
           ▼
LTP Touches Arm Price
           │
           ▼
Strategy = ARMED
           │
           ▼
LTP Reverses by Offset
           │
           ▼
Place SELL Order (Kotak)
           │
           ▼
Position Open
           │
           ▼
Live LTP Monitoring (Zerodha)
           │
     ┌─────┴───────────────┐
     ▼                     ▼
Target Hit            Stop Loss Hit
     │                     │
     ▼                     ▼
Buy Back Sell Leg     Buy Back Sell Leg
     │                     │
     ▼                     ▼
Exit Hedge            Exit Hedge
     │                     │
     └──────────┬──────────┘
                ▼
          Trade Completed
Suggested Enterprise Features for Your Existing Project

Since you're building an enterprise-grade platform, I would also add:

Premium Range Scanner (₹20–30, ₹30–40, ₹40–50, etc.)
Automatic Hedge Finder (strike distance or premium-based)
CE/PE/Both mode
One-click strategy templates
Multiple strategies running simultaneously
Strategy queue (if one strategy is active, others wait)
Daily max loss and max profit limits
Max trades per day
Re-entry rules after target or stop-loss
Order recovery if Kotak order status is delayed
Live strategy state dashboard (SCANNING → HEDGE → ARMED → OPEN → EXIT)
Complete audit logs for every LTP tick, arm event, offset trigger, order request, broker response, and exit decision.

This architecture matches the premium-selling workflow you've described and integrates cleanly with your existing Node.js + Express + EJS + MySQL project while using Zerodha only for market data and Kotak Neo exclusively for order execution.