// Candlestick patterns, for the option premium chart.
//
// A UMD module for the same reason as indicators.js: the chart marks these and
// the alert engine fires on them, and two implementations would eventually
// disagree about whether a bar was an engulfing.
//
// WHAT THESE ARE WORTH, said once here rather than in the UI: an option premium
// is a derived, decaying series, not an auction on the contract's own supply and
// demand. A hammer on a 15-second premium bar built from one-second REST samples
// is a description of four numbers, not a signal. They are drawn because the
// specification asks for them and because "the last three bars had no bodies" is
// genuinely useful context — but every threshold below is a convention, not a
// law, and they are all in one object so they can be argued with.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZPatterns = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    dojiBodyPct: 5,          // body ≤ 5% of the range
    marubozuBodyPct: 90,     // body ≥ 90% of the range
    longWickRatio: 2,        // the signature wick is ≥ 2× the body
    shortWickPct: 15,        // the opposite wick is ≤ 15% of the range
    starGapPct: 0,           // how far the star's body must clear the first body
    smallBodyPct: 35,        // the star's own body, as a share of its range
  };

  function shape(bar) {
    if (!bar) return null;
    const open = Number(bar.open ?? bar.o);
    const high = Number(bar.high ?? bar.h);
    const low = Number(bar.low ?? bar.l);
    const close = Number(bar.close ?? bar.c);
    if (![open, high, low, close].every(Number.isFinite)) return null;
    const range = high - low;
    const body = Math.abs(close - open);
    const upper = high - Math.max(open, close);
    const lower = Math.min(open, close) - low;
    return {
      open, high, low, close, range, body, upper, lower,
      bull: close > open,
      bear: close < open,
      // A zero-range bar (every tick at one price) would divide by zero
      // everywhere below. Its percentages are defined as 0 so a flat bar
      // classifies as a doji rather than as NaN.
      bodyPct: range > 0 ? 100 * body / range : 0,
      upperPct: range > 0 ? 100 * upper / range : 0,
      lowerPct: range > 0 ? 100 * lower / range : 0,
      mid: (open + close) / 2,
    };
  }

  /* ------------------------------------------------------ single-bar ------- */

  function isDoji(s, cfg) {
    return s.bodyPct <= cfg.dojiBodyPct;
  }

  // A hammer needs a long lower wick, a small upper one, and a body near the
  // top. The body may be either colour — the wick is the statement.
  function isHammer(s, cfg) {
    if (s.body <= 0) return false;
    return s.lower >= cfg.longWickRatio * s.body
      && s.upperPct <= cfg.shortWickPct
      && s.bodyPct > cfg.dojiBodyPct;
  }

  function isShootingStar(s, cfg) {
    if (s.body <= 0) return false;
    return s.upper >= cfg.longWickRatio * s.body
      && s.lowerPct <= cfg.shortWickPct
      && s.bodyPct > cfg.dojiBodyPct;
  }

  function isMarubozu(s, cfg) {
    return s.bodyPct >= cfg.marubozuBodyPct;
  }

  /* -------------------------------------------------------- two-bar -------- */

  // Body-engulfing, not range-engulfing: the classical definition is about the
  // open/close pair. Requiring the whole range to be engulfed turns a common
  // pattern into a rare one and would make the marker almost never appear.
  function engulfing(prev, s) {
    if (!prev || prev.body <= 0 || s.body <= 0) return null;
    const top = Math.max(s.open, s.close);
    const bottom = Math.min(s.open, s.close);
    const prevTop = Math.max(prev.open, prev.close);
    const prevBottom = Math.min(prev.open, prev.close);
    if (!(top >= prevTop && bottom <= prevBottom)) return null;
    if (s.bull && prev.bear) return 'BULLISH_ENGULFING';
    if (s.bear && prev.bull) return 'BEARISH_ENGULFING';
    return null;
  }

  function insideBar(prev, s) {
    if (!prev) return false;
    return s.high <= prev.high && s.low >= prev.low;
  }

  function outsideBar(prev, s) {
    if (!prev) return false;
    return s.high >= prev.high && s.low <= prev.low && (s.high > prev.high || s.low < prev.low);
  }

  /* ------------------------------------------------------ three-bar -------- */

  // Morning star: a decisive down bar, a small-bodied pause, then a decisive up
  // bar closing back into the first bar's body. Evening star is its mirror.
  //
  // The "closes past the midpoint of bar one" condition is what separates a star
  // from any three bars that happen to alternate, and it is the condition most
  // implementations quietly drop.
  function star(a, b, c, cfg) {
    if (!a || !b || !c) return null;
    if (b.bodyPct > cfg.smallBodyPct) return null;
    if (a.body <= 0 || c.body <= 0) return null;

    const bTop = Math.max(b.open, b.close);
    const bBottom = Math.min(b.open, b.close);

    if (a.bear && c.bull) {
      const gapsDown = bTop <= Math.min(a.open, a.close) * (1 + cfg.starGapPct / 100);
      if (gapsDown && c.close > a.mid) return 'MORNING_STAR';
    }
    if (a.bull && c.bear) {
      const gapsUp = bBottom >= Math.max(a.open, a.close) * (1 - cfg.starGapPct / 100);
      if (gapsUp && c.close < a.mid) return 'EVENING_STAR';
    }
    return null;
  }

  /* ----------------------------------------------------------- detect ------ */

  // Every pattern present on the bar at `index`, most-specific first. A bar can
  // legitimately be several things at once (a marubozu is also an engulfing
  // often enough), so this returns a list rather than picking a winner — the UI
  // shows the first and the tooltip shows the rest.
  function at(bars, index, options) {
    const cfg = Object.assign({}, DEFAULTS, options || {});
    const s = shape(bars[index]);
    if (!s) return [];
    const prev = shape(bars[index - 1]);
    const prev2 = shape(bars[index - 2]);
    const found = [];

    const three = star(prev2, prev, s, cfg);
    if (three) found.push(three);

    const two = engulfing(prev, s);
    if (two) found.push(two);

    if (isDoji(s, cfg)) found.push('DOJI');
    if (isMarubozu(s, cfg)) found.push(s.bull ? 'BULLISH_MARUBOZU' : 'BEARISH_MARUBOZU');
    if (isHammer(s, cfg)) found.push('HAMMER');
    if (isShootingStar(s, cfg)) found.push('SHOOTING_STAR');
    if (outsideBar(prev, s)) found.push('OUTSIDE_BAR');
    else if (insideBar(prev, s)) found.push('INSIDE_BAR');

    return found;
  }

  // The whole series, as an array of `{ index, time, patterns }` for the bars
  // that matched. Bars with nothing on them are omitted — a chart marks the
  // exceptions, not every bar.
  function scan(bars, options) {
    const out = [];
    for (let i = 0; i < (bars || []).length; i++) {
      const patterns = at(bars, i, options);
      if (patterns.length) out.push({ index: i, time: bars[i].time ?? null, patterns });
    }
    return out;
  }

  const LABEL = {
    DOJI: 'Doji',
    HAMMER: 'Hammer',
    SHOOTING_STAR: 'Shooting star',
    BULLISH_MARUBOZU: 'Bullish marubozu',
    BEARISH_MARUBOZU: 'Bearish marubozu',
    BULLISH_ENGULFING: 'Bullish engulfing',
    BEARISH_ENGULFING: 'Bearish engulfing',
    MORNING_STAR: 'Morning star',
    EVENING_STAR: 'Evening star',
    INSIDE_BAR: 'Inside bar',
    OUTSIDE_BAR: 'Outside bar',
  };

  const BIAS = {
    HAMMER: 'BULL',
    BULLISH_MARUBOZU: 'BULL',
    BULLISH_ENGULFING: 'BULL',
    MORNING_STAR: 'BULL',
    SHOOTING_STAR: 'BEAR',
    BEARISH_MARUBOZU: 'BEAR',
    BEARISH_ENGULFING: 'BEAR',
    EVENING_STAR: 'BEAR',
  };

  return { DEFAULTS, LABEL, BIAS, shape, at, scan, engulfing, star, insideBar, outsideBar };
}));
