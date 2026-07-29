Yes. Since your goal is capturing only 1 premium point, a dynamic target + trailing stop is much better than a fixed 1-point target. If the trend continues, you should let the winner run instead of exiting immediately.

Dynamic Target & Trailing Stop Engine
Trade Flow
Entry Signal
      │
      ▼
Sell Option
      │
      ▼
Target = 1 Point
SL = 2 Points
      │
      ▼
Monitor Last 3 Completed
5s NIFTY Candles
      │
      ▼
Trend Continues?
      │
 ┌────┴────┐
 │         │
No        Yes
 │         │
 ▼         ▼
Exit    Increase Target
         &
         Trail SL
Stage 1 – Initial Trade

Example

Sell Price = 20.00

Initial Target = 19.00

Initial SL = 22.00
Stage 2 – Trend Continues

After entry, continuously evaluate the last 3 completed 5-second NIFTY candles.

Bullish Trend (PE Sell)
↑
↑
↑

or

Bearish Trend (CE Sell)
↓
↓
↓

If the trend remains unchanged:

Increase Target

Start Trailing Stop
Dynamic Target Levels
Consecutive 3-Candle Confirmations	Target
First	1 Point
Second	2 Points
Third	3 Points
Fourth	4 Points
Fifth+	Trail Until Reversal

Instead of taking profit immediately, the bot extends the target while the market continues in the same direction.

Trailing Stop Logic

Suppose:

Sell = 20.00

Initial

Target = 19.00

SL = 22.00

Premium falls to

19.20

Trend still strong

Move SL

22.00

↓

20.20

Premium reaches

18.80

Move SL

20.20

↓

19.30

Premium reaches

18.00

Move SL

19.30

↓

18.50

Eventually

Premium reverses

SL Hit

Exit

You capture 2–4 points instead of only 1 point.

Reversal Detection

Exit immediately if the last three 5-second candles change direction.

Example

↑
↑
↑

becomes

↑
↑
↓

Result

Exit Trade

Reset Strategy
Confidence-Based Target

Use the trend score to decide the maximum target.

Trend Score	Target
3	1 Point
4	2 Points
5	3 Points
6	4 Points
7+	Trail Until Reversal
Trailing Rules

Never move the stop farther away.

Only move it toward profit.

22.00

↓

21.20

↓

20.50

↓

19.80

↓

19.20

Never

19.20

↓

20.50
Complete Decision Engine
Entry
 │
 ▼
Target = 1
SL = 2
 │
 ▼
Read Last 3 Completed
5s NIFTY Candles
 │
 ▼
Trend Same?
 │
 ├── No
 │     │
 │     ▼
 │   Exit
 │
 └── Yes
       │
       ▼
 Increase Target
       │
       ▼
 Trail Stop Loss
       │
       ▼
 Read Next 3 Candles
Smart Exit Algorithm (Recommended)

Rather than increasing the target by a fixed amount every time, use the option premium movement together with the 3×5-second NIFTY trend.

Entry
Sell = 20.00

Target = 19.00

SL = 22.00
If 3×5s trend is still valid and option premium continues falling:
Cancel the existing target order.
Place a new target 0.50–1.00 point lower than the current premium.
Trail the stop to protect at least 50–70% of the unrealized profit.
Exit Conditions

Exit immediately if any of these occur:

Last 3×5s candles are no longer in the same direction.
Option premium closes against your position for 2 consecutive 5-second candles.
Trailing stop is hit.
Maximum holding time (e.g., 60–90 seconds) is reached.

This creates a strategy that:

Cuts losses quickly in weak trends.
Captures 1 point in normal conditions.
Extends winners to 2–5 points during strong directional moves without changing the original entry logic.