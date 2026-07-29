For your 1-point premium option selling strategy, using only the last three completed 5-second NIFTY candles is actually faster and more consistent than mixing multiple timeframes.

NIFTY 5-Second 3-Candle Trend Confirmation
Objective

Use the last 3 completed 5-second NIFTY candles to determine whether to:

✅ Sell PE
✅ Sell CE
❌ Skip the trade

The Option Candle is still used only for calculating the SELL price.

Strategy Flow
Option Candle Closed
        │
        ▼
Calculate Sell Price
(Candle Close + Offset)
        │
        ▼
Read Last 3 Closed
5s NIFTY Candles
        │
        ▼
Calculate Trend Score
        │
        ▼
Trade Decision
        │
        ▼
Place SELL Order
Candle Classification

Each completed 5-second candle is classified as:

Strong Bullish (↑)

Conditions

Close > Open
Body ≥ 60% of Total Range
Close Near High

Score

+1 Bullish
Strong Bearish (↓)

Conditions

Close < Open
Body ≥ 60%
Close Near Low

Score

+1 Bearish
Neutral (•)

Conditions

Small Body
Long Wicks
Doji

Score

0
Last 3 Candle Logic
Case 1
↑
↑
↑

Trend

Strong Bullish

Trade

✅ Sell PE Only

Confidence

⭐⭐⭐⭐⭐

Case 2
↓
↓
↓

Trend

Strong Bearish

Trade

✅ Sell CE Only

Confidence

⭐⭐⭐⭐⭐

Case 3
↑
↑
↓

Trend

Bullish but Weak

Trade

❌ Skip
Case 4
↓
↓
↑

Trend

Bearish but Weak

Trade

❌ Skip
Case 5
↑
↓
↑

Trend

Choppy Market

Trade

❌ Skip
Case 6
↓
↑
↓

Trend

Choppy Market

Trade

❌ Skip
Consecutive Candle Rule

Only trade if all three candles point in the same direction.

Candle 1	Candle 2	Candle 3	Decision
↑	↑	↑	✅ Sell PE
↓	↓	↓	✅ Sell CE
↑	↑	↓	❌ Skip
↓	↓	↑	❌ Skip
↑	↓	↑	❌ Skip
↓	↑	↓	❌ Skip
High Volatility Filter

Before allowing any trade, check the combined movement of the last three candles.

Skip the trade if:

Highest High - Lowest Low
>
10 NIFTY Points

Reason:

Large moves often result in pullbacks or sudden reversals.

Momentum Strength

Also verify momentum.

Example:

Candle 1 Range = 2 Points

Candle 2 Range = 3 Points

Candle 3 Range = 5 Points

Increasing range indicates strengthening momentum.

If ranges continuously decrease:

5
3
2

Momentum is weakening.

Skip the trade.

Trade Validity

A signal is valid only until the next 5-second candle closes.

Every new candle:

Read the newest completed candle.
Drop the oldest candle.
Recalculate the 3-candle pattern.
Revalidate the trade.
Final Decision Engine
Last 3 Completed 5s NIFTY Candles
                │
                ▼
      All 3 Bullish?
         │
      Yes ─────────► Sell PE
         │
         No
         ▼
      All 3 Bearish?
         │
      Yes ─────────► Sell CE
         │
         No
         ▼
      Mixed Candles
         │
         ▼
        Skip
Additional improvement (recommended)

Instead of checking only the candle direction, give each 5-second candle a quality score:

Body ≥ 70% of range → +2
Upper wick < 15% (bullish) or lower wick < 15% (bearish) → +1
Volume higher than previous candle → +1
Candle closes at the extreme (near high/low) → +2

Only consider a candle strong if it scores 5 or more. Then require 3 consecutive strong candles in the same direction before allowing the trade. This filters out many weak trends while keeping the strategy fast enough for 1-point premium scalping.