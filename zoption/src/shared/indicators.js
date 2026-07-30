// Technical indicators — one implementation, two runtimes.
//
// The chart draws these in the browser and the alert engine evaluates them on
// the server. Two copies of an EMA is two answers to "what did the 20 cross",
// and the first time they disagree there is no way to tell which one the
// operator was looking at. So this file is a UMD module: Node requires it,
// Express serves it at /static/shared/indicators.js, and `node --test` proves
// the same code both of them run.
//
// CONVENTIONS
//
// * Input is an ascending array of bars `{ time, open, high, low, close, volume }`
//   in whatever unit the caller uses. Everything here is scale-free — feed it
//   paise and you get paise back, feed it rupees and you get rupees. The only
//   exception is `percent`-valued output (RSI, ADX, %B), which is unitless.
//
// * Output arrays are ALWAYS the same length as the input, front-padded with
//   `null` for the warm-up period. A shorter array would make every caller do
//   index arithmetic to line a value up with its bar, and that arithmetic is
//   where off-by-one indicator bugs live.
//
// * `null` means "not computable here", never 0. A zero MACD histogram and an
//   unwarmed MACD histogram are different facts.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZIndicators = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const filled = (n, v = null) => new Array(Math.max(0, n)).fill(v);

  // Bars arrive from several places (the API, the socket, the store) with
  // different key spellings. Normalising once here means no indicator has to
  // care, and a bar missing a close is dropped rather than read as 0.
  function normalise(bars) {
    const out = [];
    for (const b of bars || []) {
      if (!b) continue;
      const close = Number(b.close ?? b.c ?? b.closeP);
      if (!Number.isFinite(close)) continue;
      const open = Number(b.open ?? b.o ?? b.openP ?? close);
      const high = Number(b.high ?? b.h ?? b.highP ?? close);
      const low = Number(b.low ?? b.l ?? b.lowP ?? close);
      const volume = Number(b.volume ?? b.v ?? b.tickCount ?? 0) || 0;
      out.push({ time: b.time ?? b.t ?? null, open, high, low, close, volume });
    }
    return out;
  }

  /* ------------------------------------------------------------- averages -- */

  function sma(values, period) {
    const p = Math.max(1, Math.trunc(period));
    const out = filled(values.length);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!isNum(v)) { sum = 0; count = 0; continue; }
      sum += v;
      count += 1;
      if (count > p) { sum -= values[i - p]; count = p; }
      if (count === p) out[i] = sum / p;
    }
    return out;
  }

  // Seeded with an SMA of the first `period` values, which is what every charting
  // package does. Seeding with the first value instead makes the early bars of a
  // 200-EMA wrong for a couple of hundred bars — long enough to be believed.
  function ema(values, period) {
    const p = Math.max(1, Math.trunc(period));
    const out = filled(values.length);
    const k = 2 / (p + 1);
    let seedSum = 0;
    let seeded = false;
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!isNum(v)) continue;
      if (!seeded) {
        seedSum += v;
        if (i + 1 >= p) {
          prev = seedSum / p;
          out[i] = prev;
          seeded = true;
        }
        continue;
      }
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // Wilder's smoothing — the 1/period average RSI, ATR and ADX are defined on.
  // It is NOT an EMA of the same period (it is an EMA of 2p-1), and substituting
  // one for the other is the single most common way an RSI ends up 3 points off
  // every other terminal on the desk.
  function wilder(values, period) {
    const p = Math.max(1, Math.trunc(period));
    const out = filled(values.length);
    let sum = 0;
    let count = 0;
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!isNum(v)) continue;
      if (prev === null) {
        sum += v;
        count += 1;
        if (count === p) { prev = sum / p; out[i] = prev; }
        continue;
      }
      prev = (prev * (p - 1) + v) / p;
      out[i] = prev;
    }
    return out;
  }

  const closes = (bars) => bars.map(b => b.close);
  const typical = (bars) => bars.map(b => (b.high + b.low + b.close) / 3);

  /* ----------------------------------------------------------------- VWAP -- */

  // Session VWAP, reset on each new IST trading day. An intraday VWAP that never
  // resets drifts into a slow moving average by the afternoon and stops being
  // the fair-value line traders read it as.
  //
  // `dayKey` maps a bar's timestamp to its session. It is injected rather than
  // computed here because the browser and the server disagree about local time
  // and this module refuses to have an opinion about timezones.
  function vwap(bars, dayKey) {
    const key = typeof dayKey === 'function' ? dayKey : () => 'all';
    const out = filled(bars.length);
    let pv = 0;
    let vol = 0;
    let currentDay = null;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const day = key(b.time, b);
      if (day !== currentDay) { currentDay = day; pv = 0; vol = 0; }
      // Tick count stands in for volume where the feed has none. A bar with
      // neither still has to contribute, or VWAP would ignore quiet bars
      // entirely and drift toward the noisy ones.
      const weight = b.volume > 0 ? b.volume : 1;
      pv += ((b.high + b.low + b.close) / 3) * weight;
      vol += weight;
      out[i] = vol > 0 ? pv / vol : null;
    }
    return out;
  }

  /* ------------------------------------------------------------------ ATR -- */

  function trueRange(bars) {
    const out = filled(bars.length);
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (i === 0) { out[i] = b.high - b.low; continue; }
      const prevClose = bars[i - 1].close;
      out[i] = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
    }
    return out;
  }

  function atr(bars, period = 14) {
    return wilder(trueRange(bars), period);
  }

  /* ------------------------------------------------------------------ RSI -- */

  function rsi(bars, period = 14) {
    const src = closes(bars);
    const gains = filled(src.length);
    const losses = filled(src.length);
    for (let i = 1; i < src.length; i++) {
      const delta = src[i] - src[i - 1];
      gains[i] = delta > 0 ? delta : 0;
      losses[i] = delta < 0 ? -delta : 0;
    }
    const avgGain = wilder(gains.slice(1), period);
    const avgLoss = wilder(losses.slice(1), period);
    const out = filled(src.length);
    for (let i = 0; i < avgGain.length; i++) {
      const g = avgGain[i];
      const l = avgLoss[i];
      if (g === null || l === null) continue;
      // An unbroken run of up bars gives a zero average loss. RS is then
      // infinite and RSI is exactly 100 — the limit, not a division error.
      out[i + 1] = l === 0 ? 100 : 100 - (100 / (1 + g / l));
    }
    return out;
  }

  /* ----------------------------------------------------------------- MACD -- */

  function macd(bars, fast = 12, slow = 26, signalPeriod = 9) {
    const src = closes(bars);
    const fastLine = ema(src, fast);
    const slowLine = ema(src, slow);
    const line = filled(src.length);
    for (let i = 0; i < src.length; i++) {
      if (fastLine[i] === null || slowLine[i] === null) continue;
      line[i] = fastLine[i] - slowLine[i];
    }
    // The signal is an EMA of the MACD line, so it must be seeded from the first
    // bar the line exists on rather than from bar 0 — otherwise its warm-up eats
    // the leading nulls and the histogram starts life wrong.
    const firstIdx = line.findIndex(v => v !== null);
    const signal = filled(src.length);
    const hist = filled(src.length);
    if (firstIdx >= 0) {
      const sig = ema(line.slice(firstIdx), signalPeriod);
      for (let i = 0; i < sig.length; i++) {
        signal[firstIdx + i] = sig[i];
        if (sig[i] !== null && line[firstIdx + i] !== null) {
          hist[firstIdx + i] = line[firstIdx + i] - sig[i];
        }
      }
    }
    return { macd: line, signal, histogram: hist };
  }

  /* ------------------------------------------------------------------ ADX -- */

  function adx(bars, period = 14) {
    const n = bars.length;
    const plusDM = filled(n);
    const minusDM = filled(n);
    for (let i = 1; i < n; i++) {
      const up = bars[i].high - bars[i - 1].high;
      const down = bars[i - 1].low - bars[i].low;
      // Only the LARGER of the two directional moves counts, and only when it is
      // positive. A bar that is an outside bar has movement in both directions
      // and Wilder's rule is that it registers as neither.
      plusDM[i] = (up > down && up > 0) ? up : 0;
      minusDM[i] = (down > up && down > 0) ? down : 0;
    }
    const tr = trueRange(bars);
    const atrLine = wilder(tr.slice(1), period);
    const plusLine = wilder(plusDM.slice(1), period);
    const minusLine = wilder(minusDM.slice(1), period);

    const plusDI = filled(n);
    const minusDI = filled(n);
    const dx = filled(n);
    for (let i = 0; i < atrLine.length; i++) {
      const a = atrLine[i];
      if (a === null || a === 0 || plusLine[i] === null || minusLine[i] === null) continue;
      const p = 100 * plusLine[i] / a;
      const m = 100 * minusLine[i] / a;
      plusDI[i + 1] = p;
      minusDI[i + 1] = m;
      const sum = p + m;
      dx[i + 1] = sum === 0 ? 0 : 100 * Math.abs(p - m) / sum;
    }
    const firstDx = dx.findIndex(v => v !== null);
    const adxLine = filled(n);
    if (firstDx >= 0) {
      const smoothed = wilder(dx.slice(firstDx), period);
      for (let i = 0; i < smoothed.length; i++) adxLine[firstDx + i] = smoothed[i];
    }
    return { adx: adxLine, plusDI, minusDI };
  }

  /* -------------------------------------------------------- Bollinger ------ */

  function bollinger(bars, period = 20, mult = 2) {
    const src = closes(bars);
    const mid = sma(src, period);
    const upper = filled(src.length);
    const lower = filled(src.length);
    const width = filled(src.length);
    const p = Math.max(1, Math.trunc(period));
    for (let i = 0; i < src.length; i++) {
      if (mid[i] === null) continue;
      let variance = 0;
      for (let j = i - p + 1; j <= i; j++) variance += (src[j] - mid[i]) ** 2;
      // Population sigma, not sample. Bollinger's own definition, and the
      // difference at period 20 is a visible 2.6% on the band width.
      const sd = Math.sqrt(variance / p);
      upper[i] = mid[i] + mult * sd;
      lower[i] = mid[i] - mult * sd;
      width[i] = mid[i] === 0 ? null : (upper[i] - lower[i]) / mid[i];
    }
    return { middle: mid, upper, lower, width };
  }

  /* ----------------------------------------------------------- SuperTrend -- */

  // The ATR band that flips side. Two details are what make it match a chart:
  //
  // 1. The bands RATCHET — a new upper band is only accepted if it is lower than
  //    the previous one (or the previous close broke above it). Without that the
  //    line wobbles with every ATR tick and stops being a stop level.
  // 2. The flip is decided on the CLOSE against the band that was in force, not
  //    against the band recomputed from this bar.
  function supertrend(bars, period = 10, multiplier = 3) {
    const n = bars.length;
    const atrLine = atr(bars, period);
    const value = filled(n);
    const direction = filled(n);
    let upper = null;
    let lower = null;
    let trendUp = true;

    for (let i = 0; i < n; i++) {
      if (atrLine[i] === null) continue;
      const b = bars[i];
      const mid = (b.high + b.low) / 2;
      const basicUpper = mid + multiplier * atrLine[i];
      const basicLower = mid - multiplier * atrLine[i];
      const prevClose = i > 0 ? bars[i - 1].close : b.close;

      upper = (upper === null || basicUpper < upper || prevClose > upper) ? basicUpper : upper;
      lower = (lower === null || basicLower > lower || prevClose < lower) ? basicLower : lower;

      if (value[i - 1] === null || value[i - 1] === undefined) {
        trendUp = b.close >= basicUpper ? true : b.close <= basicLower ? false : true;
      } else if (trendUp && b.close < lower) {
        trendUp = false;
      } else if (!trendUp && b.close > upper) {
        trendUp = true;
      }

      value[i] = trendUp ? lower : upper;
      direction[i] = trendUp ? 1 : -1;
    }
    return { value, direction };
  }

  /* ------------------------------------------------------- opening range --- */

  // The high and low of the first `minutes` of a session, as a level that then
  // holds for the rest of the day. `dayKey` and `minutesInto` are injected for
  // the same timezone reason as VWAP.
  function openingRange(bars, { minutes = 15, dayKey, minutesInto }) {
    const key = typeof dayKey === 'function' ? dayKey : () => 'all';
    const into = typeof minutesInto === 'function' ? minutesInto : () => 0;
    const high = filled(bars.length);
    const low = filled(bars.length);
    let currentDay = null;
    let h = null;
    let l = null;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const day = key(b.time, b);
      if (day !== currentDay) { currentDay = day; h = null; l = null; }
      if (into(b.time, b) < minutes) {
        h = h === null ? b.high : Math.max(h, b.high);
        l = l === null ? b.low : Math.min(l, b.low);
      }
      high[i] = h;
      low[i] = l;
    }
    return { high, low };
  }

  /* ---------------------------------------------------- pivots and CPR ----- */

  // Classic floor pivots plus the Central Pivot Range, from ONE previous
  // session's OHLC. These are levels for a whole day, not a series, so the
  // caller supplies yesterday's bar and gets a flat object of prices.
  function pivots(prev) {
    if (!prev) return null;
    const { high, low, close } = prev;
    if (![high, low, close].every(isNum)) return null;
    const pivot = (high + low + close) / 3;
    const bc = (high + low) / 2;
    const tc = pivot + (pivot - bc);
    return {
      pivot,
      r1: 2 * pivot - low,
      r2: pivot + (high - low),
      r3: high + 2 * (pivot - low),
      s1: 2 * pivot - high,
      s2: pivot - (high - low),
      s3: low - 2 * (high - pivot),
      // CPR: the narrower the band, the more a trending day is expected. `tc`
      // can come out below `bc`; that is not an error and traders read the pair
      // unordered, so they are returned as computed and also as a sorted range.
      cprTop: Math.max(tc, bc),
      cprBottom: Math.min(tc, bc),
      cprWidth: Math.abs(tc - bc),
      prevHigh: high,
      prevLow: low,
      prevClose: close,
    };
  }

  /* ------------------------------------------------------------- volume ---- */

  // Volume context for the "volume spike" the spec asks for on both the chain
  // and the premium chart. `ratio` is against the trailing average EXCLUDING the
  // current bar — comparing a bar against an average it is itself in dampens
  // exactly the spike being looked for.
  function volumeProfile(bars, period = 20) {
    const n = bars.length;
    const average = filled(n);
    const ratio = filled(n);
    const p = Math.max(1, Math.trunc(period));
    for (let i = 0; i < n; i++) {
      if (i < p) continue;
      let sum = 0;
      for (let j = i - p; j < i; j++) sum += bars[j].volume;
      const avg = sum / p;
      average[i] = avg;
      ratio[i] = avg > 0 ? bars[i].volume / avg : null;
    }
    return { average, ratio };
  }

  // Where inside its own range a bar closed, split into the two halves traders
  // call buying and selling pressure. A doji-flat bar has no range and no
  // pressure either way rather than a divide-by-zero.
  function pressure(bar) {
    if (!bar) return null;
    const range = bar.high - bar.low;
    if (!(range > 0)) return { buying: 50, selling: 50 };
    const buying = 100 * (bar.close - bar.low) / range;
    return { buying, selling: 100 - buying };
  }

  /* ---------------------------------------------------------------- API ---- */

  // One call that computes everything a chart pane needs, so the browser makes
  // one pass over the bars instead of eleven.
  function computeAll(rawBars, options) {
    const opts = options || {};
    const bars = normalise(rawBars);
    const src = closes(bars);
    const out = {
      bars,
      ema9: ema(src, 9),
      ema20: ema(src, 20),
      ema50: ema(src, 50),
      ema200: ema(src, 200),
      vwap: vwap(bars, opts.dayKey),
      atr: atr(bars, opts.atrPeriod || 14),
      rsi: rsi(bars, opts.rsiPeriod || 14),
      macd: macd(bars),
      adx: adx(bars, opts.adxPeriod || 14),
      bollinger: bollinger(bars, opts.bbPeriod || 20, opts.bbMult || 2),
      supertrend: supertrend(bars, opts.stPeriod || 10, opts.stMult || 3),
      volume: volumeProfile(bars, opts.volumePeriod || 20),
    };
    if (opts.dayKey && opts.minutesInto) {
      out.openingRange = openingRange(bars, {
        minutes: opts.openingRangeMinutes || 15,
        dayKey: opts.dayKey,
        minutesInto: opts.minutesInto,
      });
    }
    if (opts.previousSession) out.pivots = pivots(opts.previousSession);
    return out;
  }

  return {
    normalise, sma, ema, wilder, closes, typical,
    vwap, trueRange, atr, rsi, macd, adx, bollinger, supertrend,
    openingRange, pivots, volumeProfile, pressure, computeAll,
  };
}));
