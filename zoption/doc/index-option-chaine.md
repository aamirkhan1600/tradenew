# NIFTY Trading Terminal
## Module Specification v1.0

---

# Overview

This document defines the complete specification for the three core modules of the NIFTY Trading Terminal.

Modules

1. NIFTY Index Chart
2. Live Option Chain
3. Option Premium Chart

Goal

Provide ultra-fast visualization of market structure and option data for automated option selling strategies.

---

# Technology Stack

Frontend

- React
- TypeScript
- Redux Toolkit
- TradingView Lightweight Charts
- TailwindCSS
- Socket.IO Client

Backend

- Node.js
- Express
- Socket.IO
- Redis
- MySQL

Broker

- Kotak Neo API

Refresh Rate

Market Data
100~300 ms

Option Chain
1 second

Charts
Tick Based

---

# MODULE 1
# NIFTY INDEX CHART

Purpose

Display live NIFTY movement.

---

## Supported Timeframes

5 Second

15 Second

30 Second

1 Minute

3 Minute

5 Minute

15 Minute

1 Hour

Daily

---

## Chart Type

Candlestick

OHLC

Volume

Line

Area

---

## Candle Data

Each candle contains

Open

High

Low

Close

Volume

Timestamp

Example

{
    "time":"10:15:05",
    "open":25012.50,
    "high":25018.20,
    "low":25010.25,
    "close":25017.80,
    "volume":220
}

---

## Indicators

EMA 9

EMA 20

EMA 50

EMA 200

VWAP

SuperTrend

ATR

RSI

MACD

ADX

Bollinger Bands

Opening Range

Pivot

CPR

Previous High

Previous Low

Previous Close

---

## Drawing Tools

Horizontal Line

Trend Line

Rectangle

Risk Reward

Long Position

Short Position

Text Label

Arrow

---

## Crosshair

Show

Price

Time

OHLC

Volume

Indicator Value

---

## Live Information Panel

Current Price

Change

%

High

Low

Open

Previous Close

Day Range

Volume

VWAP

Trend

---

## Trading Signals

Buy Marker

Sell Marker

Exit Marker

Trailing Stop

Target

Stop Loss

---

## Color Rules

Bull Candle

Green

Bear Candle

Red

VWAP

Blue

EMA 20

Yellow

EMA 50

Purple

EMA 200

White

---

## Keyboard Shortcuts

+

Zoom In

-

Zoom Out

R

Reset Chart

Space

Pause

---

# API

GET

/api/chart/history

Parameters

symbol

timeframe

from

to

Response

Array of OHLC

---

WebSocket

event

index_tick

Payload

{
price,
volume,
time
}

---

# MODULE 2
# OPTION CHAIN

Purpose

Display complete option chain.

Refresh

Every 1 Second

---

## Expiry Selector

Weekly

Monthly

Far Month

---

## Strike Selection

Auto ATM

Manual

±5 Strike

±10 Strike

±20 Strike

Custom

---

## Columns

CALL SIDE

OI

OI Change

Volume

IV

LTP

Bid

Ask

Delta

Gamma

Theta

Vega

Rho

Intrinsic Value

Time Value

PCR

Strike

PUT SIDE

LTP

Bid

Ask

IV

Delta

Gamma

Theta

Vega

Rho

Volume

OI Change

OI

---

## Highlight

ATM

ITM

OTM

Highest OI

Highest OI Change

Volume Spike

Highest IV

Highest Theta

Highest Gamma

---

## Heatmap

Dark Green

Highest Put OI

Dark Red

Highest Call OI

Yellow

ATM

Blue

Highest Volume

Orange

Highest IV

---

## Summary Panel

Spot Price

Future Price

ATM Strike

Expiry

Lot Size

India VIX

PCR

Max Pain

Total Call OI

Total Put OI

Net OI

---

## Filters

Hide Zero Volume

Hide Deep OTM

Only ATM

Only ITM

Only OTM

Minimum OI

Minimum Volume

---

## Sorting

By Strike

By Volume

By OI

By IV

By Theta

---

## Option Analytics

Max Pain

PCR

OI Build-up

Call Writing

Put Writing

Long Build-up

Short Build-up

Long Unwinding

Short Covering

---

## API

GET

/api/options/chain

Response

[
{
strike,
call:{},
put:{}
}
]

---

WebSocket

option_chain_update

---

# MODULE 3
# OPTION PREMIUM CHART

Purpose

Display selected option premium movement.

Supports

CE

PE

---

## Timeframes

Tick

5 Second

15 Second

30 Second

1 Minute

3 Minute

5 Minute

15 Minute

---

## Chart Type

Candlestick

Line

Area

OHLC

---

## Indicators

EMA 9

EMA 20

VWAP

RSI

MACD

Volume

ATR

SuperTrend

---

## Information Panel

Strike

Expiry

Type

LTP

Change

%

Volume

OI

IV

Delta

Theta

Gamma

Vega

Intrinsic

Time Value

---

## Trade Overlay

Entry

Exit

SL

Target

Trailing Stop

Average Price

Current P/L

---

## Premium Statistics

Highest Premium

Lowest Premium

Average Premium

Today's High

Today's Low

Decay

Premium Velocity

Premium Momentum

---

## Greeks Panel

Delta

Gamma

Theta

Vega

Rho

IV

Update Live

---

## Option Candle Pattern

Doji

Hammer

Shooting Star

Marubozu

Engulfing

Morning Star

Evening Star

Inside Bar

Outside Bar

---

## Volume Analysis

Volume Spike

Average Volume

Volume Ratio

Buying Pressure

Selling Pressure

---

## Alerts

Premium Breakout

EMA Cross

VWAP Break

Volume Spike

Theta Increase

OI Increase

---

## API

GET

/option/chart/history

Parameters

symbol

strike

expiry

type

timeframe

---

WebSocket

option_tick

Payload

{
price,
volume,
oi,
iv,
theta,
delta,
gamma,
vega,
time
}

---

# UI Layout

--------------------------------------------------------------

HEADER

Broker

Market Status

Spot

Expiry

Search

--------------------------------------------------------------

LEFT (70%)

NIFTY INDEX CHART

--------------------------------------------------------------

RIGHT (30%)

Market Summary

ATM

PCR

Max Pain

VIX

Greeks

--------------------------------------------------------------

BOTTOM

OPTION CHAIN

--------------------------------------------------------------

BOTTOM

OPTION PREMIUM CHART

--------------------------------------------------------------

# Performance Requirements

Chart Load

<500 ms

Tick Delay

<100 ms

Chain Refresh

1 sec

CPU

<20%

Memory

<300 MB

Reconnect

Automatic

Offline Cache

Yes

Multi Monitor

Supported

Dark Theme

Supported

Light Theme

Supported

# Future Enhancements

Market Depth

DOM Ladder

OI Heatmap Animation

Strategy Builder

Multi Chart Layout

Option Greeks Surface

AI Trade Recommendation

Replay Mode

Backtesting

Order Flow Analysis

Institutional Activity Detection

---

End of Document
Version 1.0