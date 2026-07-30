// The price chart — modules 1 and 3 are the same object with different data.
//
// Wraps TradingView Lightweight Charts and adds the four things it does not
// ship with: indicator management, a live bar that extends from ticks, a
// crosshair readout, and a drawing layer.
//
// TWO THINGS WORTH KNOWING BEFORE READING ON.
//
// 1. THE LIVE BAR IS BUILT HERE, NOT SENT. The server pushes ticks; the client
//    buckets them into the bar in progress. Both sides align buckets to IST
//    midnight (Z.bucketStart mirrors src/core/time.js), so the bar this chart
//    is drawing and the bar the server will store are the same bar. If those
//    two ever disagree, the symptom is a candle that visibly jumps when the
//    page is reloaded — check the offsets there first.
//
// 2. "VOLUME" IS A TICK COUNT. Kotak's quote feed on this account class carries
//    no traded quantity, so the histogram counts price updates per bar. It is
//    labelled `ticks` in the legend rather than `vol` for that reason: it is a
//    real measure of activity and it is NOT exchange volume, and a chart that
//    blurred the two would be inviting a decision based on a number that does
//    not exist.

window.Z = window.Z || {};

(function (Z) {
  'use strict';

  const LWC = window.LightweightCharts;
  const IND = window.ZIndicators;

  const INDICATOR_LABEL = {
    ema9: 'EMA 9', ema20: 'EMA 20', ema50: 'EMA 50', ema200: 'EMA 200',
    vwap: 'VWAP', supertrend: 'SuperTrend', bollinger: 'Bollinger',
    openingRange: 'Opening range', pivot: 'Pivot', cpr: 'CPR', prevDay: 'Prev H/L/C',
    volume: 'Volume (ticks)', rsi: 'RSI', macd: 'MACD', adx: 'ADX', atr: 'ATR',
  };

  class PriceChart {
    constructor(opts) {
      this.container = opts.container;
      this.legend = opts.legend || null;
      this.name = opts.name || 'chart';
      this.timeframe = opts.timeframe || '1m';
      this.type = opts.type || 'candles';
      this.precision = opts.precision === undefined ? 2 : opts.precision;
      this.minMove = opts.minMove === undefined ? 0.05 : opts.minMove;
      this.onCrosshair = opts.onCrosshair || null;

      this.bars = [];
      this.paused = false;
      this.series = null;
      this.indicatorSeries = new Map();
      this.priceLines = new Map();
      this.markersPlugin = null;
      this.panes = {};
      this.enabled = new Set(opts.indicators || []);
      this.previousSession = null;

      this._build();
      this.drawings = new Z.DrawingLayer({
        chart: this.chart,
        series: this.series,
        container: this.container,
        storageKey: opts.drawKey || ('draw.' + this.name),
      });

      Z.onThemeChange(() => this._applyTheme());
    }

    /* --------------------------------------------------------------- build */

    _build() {
      const t = Z.theme();
      this.chart = LWC.createChart(this.container, {
        layout: {
          background: { type: LWC.ColorType.Solid, color: t.panel },
          textColor: t.muted,
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          fontSize: 11,
          attributionLogo: false,
          panes: { separatorColor: t.line, separatorHoverColor: t.accent, enableResize: true },
        },
        grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
        rightPriceScale: { borderColor: t.line, scaleMargins: { top: 0.08, bottom: 0.08 } },
        timeScale: {
          borderColor: t.line,
          // Seconds matter on a 5-second chart and are noise on a daily one.
          timeVisible: true,
          secondsVisible: Z.TIMEFRAME_SECONDS[this.timeframe] < 60,
          rightOffset: 4,
        },
        crosshair: {
          mode: LWC.CrosshairMode.Normal,
          vertLine: { color: t.crosshair, labelBackgroundColor: t.panel2, width: 1, style: 2 },
          horzLine: { color: t.crosshair, labelBackgroundColor: t.panel2, width: 1, style: 2 },
        },
        handleScroll: true,
        handleScale: true,
        autoSize: true,
      });

      this._createPriceSeries();
      this.chart.subscribeCrosshairMove((param) => this._onCrosshair(param));
    }

    _priceFormat() {
      return { type: 'price', precision: this.precision, minMove: this.minMove };
    }

    _createPriceSeries() {
      const t = Z.theme();
      if (this.series) {
        try { this.chart.removeSeries(this.series); } catch (_) { /* already gone */ }
        this.series = null;
        this.markersPlugin = null;
        // Price lines belong to the series that owned them. Keeping the handles
        // would leave `_syncPriceLines` calling applyOptions on detached
        // objects, and every level — including a live stop — would silently
        // stop being drawn after a chart-type change.
        this.priceLines.clear();
      }

      const common = { priceFormat: this._priceFormat() };
      if (this.type === 'line') {
        this.series = this.chart.addSeries(LWC.LineSeries,
          Object.assign({ color: t.accent, lineWidth: 2 }, common));
      } else if (this.type === 'area') {
        this.series = this.chart.addSeries(LWC.AreaSeries, Object.assign({
          lineColor: t.accent, topColor: t.accent + '55', bottomColor: t.accent + '05', lineWidth: 2,
        }, common));
      } else if (this.type === 'ohlc') {
        this.series = this.chart.addSeries(LWC.BarSeries,
          Object.assign({ upColor: t.up, downColor: t.down, thinBars: false }, common));
      } else {
        this.series = this.chart.addSeries(LWC.CandlestickSeries, Object.assign({
          upColor: t.up, downColor: t.down,
          borderUpColor: t.up, borderDownColor: t.down,
          wickUpColor: t.up, wickDownColor: t.down,
        }, common));
      }
      if (this.drawings) this.drawings.setSeries(this.series);
    }

    // The pane a sub-chart indicator lives in. Created on demand and remembered,
    // so turning RSI off and on again does not stack empty panes down the page.
    _pane(name, stretch) {
      if (this.panes[name] !== undefined) return this.panes[name];
      const pane = this.chart.addPane();
      pane.setStretchFactor(stretch || 0.25);
      this.panes[name] = pane.paneIndex();
      return this.panes[name];
    }

    /* ---------------------------------------------------------------- data */

    // `bars` are the server's shape: utc SECONDS, rupees.
    setBars(bars) {
      this.bars = (bars || []).map(b => ({
        time: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
        volume: b.volume || 0, synthetic: Boolean(b.synthetic),
      }));
      this._redraw({ fit: true });
    }

    // Extend the bar in progress, or open a new one. Called on every tick.
    //
    // Out-of-order ticks are dropped rather than folded backwards: a late frame
    // after a reconnect would otherwise rewrite a bar the eye has already read.
    pushTick(price, utcSeconds) {
      if (this.paused || !(price > 0)) return;
      const seconds = Z.TIMEFRAME_SECONDS[this.timeframe] || 60;
      const bucket = Z.bucketStart(utcSeconds, seconds);
      const last = this.bars[this.bars.length - 1];

      if (last && bucket < last.time) return;

      if (!last || bucket > last.time) {
        this.bars.push({
          time: bucket, open: price, high: price, low: price, close: price,
          volume: 1, synthetic: false,
        });
        // A new bar changes every indicator's last value, so the whole overlay
        // is recomputed. Fifty bars of EMA is microseconds; doing it per tick
        // would not be.
        this._redraw({ fit: false });
        return;
      }

      last.close = price;
      if (price > last.high) last.high = price;
      if (price < last.low) last.low = price;
      last.volume += 1;
      last.synthetic = false;
      this.series.update(this._point(last));
      this._updateLiveIndicators();
      this._renderLegend(null);
    }

    _point(bar) {
      const time = Z.toChart(bar.time);
      if (this.type === 'line' || this.type === 'area') return { time, value: bar.close };
      return { time, open: bar.open, high: bar.high, low: bar.low, close: bar.close };
    }

    setTimeframe(tf) {
      this.timeframe = tf;
      this.chart.applyOptions({
        timeScale: { secondsVisible: Z.TIMEFRAME_SECONDS[tf] < 60 },
      });
    }

    setType(type) {
      if (type === this.type) return;
      this.type = type;
      this._createPriceSeries();
      this._redraw({ fit: false });
    }

    setPreviousSession(bar) {
      this.previousSession = bar || null;
      this._redraw({ fit: false });
    }

    /* --------------------------------------------------------- indicators */

    toggle(name, on) {
      if (on) this.enabled.add(name); else this.enabled.delete(name);
      if (!on) this._removeIndicator(name);
      this._redraw({ fit: false });
    }

    isOn(name) { return this.enabled.has(name); }

    _removeIndicator(name) {
      for (const [key, series] of [...this.indicatorSeries]) {
        if (key !== name && key.indexOf(name + ':') !== 0) continue;
        try { this.chart.removeSeries(series); } catch (_) { /* already gone */ }
        this.indicatorSeries.delete(key);
      }
      // The pane is left in place deliberately: removing it renumbers every
      // pane above it and the remaining indicators would silently move.
    }

    _line(key, options, paneIndex) {
      let series = this.indicatorSeries.get(key);
      if (!series) {
        series = this.chart.addSeries(LWC.LineSeries, Object.assign({
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          priceFormat: this._priceFormat(),
        }, options), paneIndex);
        this.indicatorSeries.set(key, series);
      } else {
        series.applyOptions(options);
      }
      return series;
    }

    // A whole redraw: price series, every enabled indicator, the legend and the
    // drawing layer. Called on new bars and on any toggle — never per tick.
    _redraw(opts) {
      if (!this.bars.length) {
        this.series.setData([]);
        this._renderLegend(null);
        return;
      }
      this.series.setData(this.bars.map(b => this._point(b)));
      this.computed = IND.computeAll(this.bars, {
        dayKey: Z.dayKey,
        minutesInto: Z.minutesIntoSession,
        openingRangeMinutes: 15,
        previousSession: this.previousSession,
      });
      this._drawIndicators();
      this._renderLegend(null);
      if (opts && opts.fit) this.chart.timeScale().fitContent();
      this.drawings.redraw();
    }

    // Only the last point moved, so only the last point is pushed. Recomputing
    // the whole series on every tick is what makes naive terminals burn a core.
    _updateLiveIndicators() {
      if (!this.bars.length) return;
      this.computed = IND.computeAll(this.bars, {
        dayKey: Z.dayKey,
        minutesInto: Z.minutesIntoSession,
        openingRangeMinutes: 15,
        previousSession: this.previousSession,
      });
      const i = this.bars.length - 1;
      const time = Z.toChart(this.bars[i].time);
      const push = (key, value) => {
        const series = this.indicatorSeries.get(key);
        if (series && value !== null && value !== undefined) series.update({ time, value });
      };
      const c = this.computed;
      push('ema9', c.ema9[i]); push('ema20', c.ema20[i]);
      push('ema50', c.ema50[i]); push('ema200', c.ema200[i]);
      push('vwap', c.vwap[i]);
      push('supertrend', c.supertrend.value[i]);
      push('bollinger:u', c.bollinger.upper[i]);
      push('bollinger:m', c.bollinger.middle[i]);
      push('bollinger:l', c.bollinger.lower[i]);
      push('rsi', c.rsi[i]);
      push('macd:line', c.macd.macd[i]); push('macd:signal', c.macd.signal[i]);
      push('adx', c.adx.adx[i]); push('adx:+di', c.adx.plusDI[i]); push('adx:-di', c.adx.minusDI[i]);
      push('atr', c.atr[i]);
      const vol = this.indicatorSeries.get('volume');
      if (vol) {
        const t = Z.theme();
        vol.update({
          time,
          value: this.bars[i].volume,
          color: this.bars[i].close >= this.bars[i].open ? t.up + '77' : t.down + '77',
        });
      }
      const hist = this.indicatorSeries.get('macd:hist');
      if (hist && c.macd.histogram[i] !== null) {
        const t = Z.theme();
        hist.update({
          time,
          value: c.macd.histogram[i],
          color: c.macd.histogram[i] >= 0 ? t.up + '99' : t.down + '99',
        });
      }
    }

    _drawIndicators() {
      const t = Z.theme();
      const c = this.computed;
      const times = this.bars.map(b => Z.toChart(b.time));
      const asLine = (values) => {
        const out = [];
        for (let i = 0; i < values.length; i++) {
          if (values[i] === null || values[i] === undefined) continue;
          out.push({ time: times[i], value: values[i] });
        }
        return out;
      };

      const overlay = (name, key, values, options) => {
        if (!this.enabled.has(name)) return;
        this._line(key, options, 0).setData(asLine(values));
      };

      overlay('ema9', 'ema9', c.ema9, { color: t.ema9 });
      overlay('ema20', 'ema20', c.ema20, { color: t.ema20 });
      overlay('ema50', 'ema50', c.ema50, { color: t.ema50 });
      overlay('ema200', 'ema200', c.ema200, { color: t.ema200, lineWidth: 2 });
      overlay('vwap', 'vwap', c.vwap, { color: t.vwap, lineWidth: 2, lineStyle: 0 });

      if (this.enabled.has('supertrend')) {
        // Coloured by side rather than drawn as one line: a SuperTrend that does
        // not change colour on a flip is just a wandering line.
        const data = [];
        for (let i = 0; i < c.supertrend.value.length; i++) {
          const v = c.supertrend.value[i];
          if (v === null) continue;
          data.push({ time: times[i], value: v, color: c.supertrend.direction[i] > 0 ? t.up : t.down });
        }
        this._line('supertrend', { lineWidth: 2 }, 0).setData(data);
      } else this._removeIndicator('supertrend');

      if (this.enabled.has('bollinger')) {
        this._line('bollinger:u', { color: t.bb, lineStyle: 2 }, 0).setData(asLine(c.bollinger.upper));
        this._line('bollinger:m', { color: t.bb }, 0).setData(asLine(c.bollinger.middle));
        this._line('bollinger:l', { color: t.bb, lineStyle: 2 }, 0).setData(asLine(c.bollinger.lower));
      } else this._removeIndicator('bollinger');

      if (this.enabled.has('openingRange') && c.openingRange) {
        this._line('openingRange:h', { color: t.warn, lineStyle: 2 }, 0)
          .setData(asLine(c.openingRange.high));
        this._line('openingRange:l', { color: t.warn, lineStyle: 2 }, 0)
          .setData(asLine(c.openingRange.low));
      } else this._removeIndicator('openingRange');

      this._drawLevels(c.pivots);

      if (this.enabled.has('volume')) {
        const pane = this._pane('volume', 0.18);
        let series = this.indicatorSeries.get('volume');
        if (!series) {
          series = this.chart.addSeries(LWC.HistogramSeries, {
            priceFormat: { type: 'volume' },
            priceLineVisible: false, lastValueVisible: false,
          }, pane);
          this.indicatorSeries.set('volume', series);
        }
        series.setData(this.bars.map((b, i) => ({
          time: times[i],
          value: b.volume,
          color: b.close >= b.open ? t.up + '77' : t.down + '77',
        })));
      } else this._removeIndicator('volume');

      if (this.enabled.has('rsi')) {
        const pane = this._pane('rsi', 0.22);
        this._line('rsi', {
          color: t.accent,
          priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
          // The 30/70 bands are what an RSI is read against; without them the
          // pane is a wiggle with no reference.
          autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
        }, pane).setData(asLine(c.rsi));
        this._band('rsi:70', 70, t.down, pane);
        this._band('rsi:30', 30, t.up, pane);
      } else this._removeIndicator('rsi');

      if (this.enabled.has('macd')) {
        const pane = this._pane('macd', 0.22);
        const fmt = { type: 'price', precision: 2, minMove: 0.01 };
        this._line('macd:line', { color: t.accent, priceFormat: fmt }, pane)
          .setData(asLine(c.macd.macd));
        this._line('macd:signal', { color: t.warn, priceFormat: fmt }, pane)
          .setData(asLine(c.macd.signal));
        let hist = this.indicatorSeries.get('macd:hist');
        if (!hist) {
          hist = this.chart.addSeries(LWC.HistogramSeries, {
            priceFormat: fmt, priceLineVisible: false, lastValueVisible: false,
          }, pane);
          this.indicatorSeries.set('macd:hist', hist);
        }
        hist.setData(c.macd.histogram.map((v, i) => (v === null ? null : {
          time: times[i], value: v, color: v >= 0 ? t.up + '99' : t.down + '99',
        })).filter(Boolean));
      } else this._removeIndicator('macd');

      if (this.enabled.has('adx')) {
        const pane = this._pane('adx', 0.2);
        const fmt = { type: 'price', precision: 1, minMove: 0.1 };
        this._line('adx', { color: t.text, lineWidth: 2, priceFormat: fmt }, pane)
          .setData(asLine(c.adx.adx));
        this._line('adx:+di', { color: t.up, priceFormat: fmt }, pane).setData(asLine(c.adx.plusDI));
        this._line('adx:-di', { color: t.down, priceFormat: fmt }, pane).setData(asLine(c.adx.minusDI));
        this._band('adx:25', 25, t.muted, pane);
      } else this._removeIndicator('adx');

      if (this.enabled.has('atr')) {
        const pane = this._pane('atr', 0.18);
        this._line('atr', { color: t.warn, priceFormat: this._priceFormat() }, pane)
          .setData(asLine(c.atr));
      } else this._removeIndicator('atr');
    }

    _band(key, value, color, pane) {
      const times = this.bars.map(b => Z.toChart(b.time));
      this._line(key, { color: color + '55', lineStyle: 2, lineWidth: 1 }, pane)
        .setData(times.map(time => ({ time, value })));
    }

    // Pivot, CPR and the previous session's high/low/close are horizontal levels
    // for the whole day, so they are price LINES rather than series — a series
    // would only span the bars that exist and stop at the right edge.
    _drawLevels(p) {
      const t = Z.theme();
      const want = {};
      if (p) {
        if (this.enabled.has('pivot')) {
          want.pivot = { price: p.pivot, color: t.warn, title: 'P' };
          want.r1 = { price: p.r1, color: t.down, title: 'R1' };
          want.r2 = { price: p.r2, color: t.down, title: 'R2' };
          want.s1 = { price: p.s1, color: t.up, title: 'S1' };
          want.s2 = { price: p.s2, color: t.up, title: 'S2' };
        }
        if (this.enabled.has('cpr')) {
          want.cprTop = { price: p.cprTop, color: t.accent, title: 'TC' };
          want.cprBottom = { price: p.cprBottom, color: t.accent, title: 'BC' };
        }
        if (this.enabled.has('prevDay')) {
          want.prevHigh = { price: p.prevHigh, color: t.muted, title: 'PDH' };
          want.prevLow = { price: p.prevLow, color: t.muted, title: 'PDL' };
          want.prevClose = { price: p.prevClose, color: t.muted, title: 'PDC' };
        }
      }
      this._syncPriceLines('level', want);
    }

    // Declarative price lines: the caller says what should exist and this
    // reconciles. Used for the indicator levels and for module 3's trade
    // overlay, so an exited position's stop line disappears rather than being
    // left behind by a missed removal.
    _syncPriceLines(group, wanted) {
      const prefix = group + ':';
      for (const [key, line] of [...this.priceLines]) {
        if (key.indexOf(prefix) !== 0) continue;
        const name = key.slice(prefix.length);
        if (!wanted[name]) {
          try { this.series.removePriceLine(line); } catch (_) { /* already gone */ }
          this.priceLines.delete(key);
        }
      }
      for (const [name, spec] of Object.entries(wanted)) {
        if (spec.price === null || spec.price === undefined || !Number.isFinite(spec.price)) continue;
        const key = prefix + name;
        const existing = this.priceLines.get(key);
        const options = {
          price: spec.price,
          color: spec.color,
          lineWidth: spec.lineWidth || 1,
          lineStyle: spec.lineStyle === undefined ? 2 : spec.lineStyle,
          axisLabelVisible: true,
          title: spec.title || '',
        };
        if (existing) existing.applyOptions(options);
        else this.priceLines.set(key, this.series.createPriceLine(options));
      }
    }

    // Module 3's trade overlay — entry, exit, stop, target, trailing stop and
    // the average price of whatever the engine currently holds in this contract.
    setTradeOverlay(levels) {
      const t = Z.theme();
      const want = {};
      const add = (name, price, color, title, style) => {
        if (price === null || price === undefined) return;
        want[name] = { price, color, title, lineWidth: 2, lineStyle: style === undefined ? 0 : style };
      };
      add('entry', levels.entry, t.accent, 'Entry');
      add('average', levels.average, t.accent, 'Avg', 2);
      add('exit', levels.exit, t.muted, 'Exit');
      add('target', levels.target, t.up, 'Target');
      add('sl', levels.stopLoss, t.down, 'SL');
      add('trail', levels.trailingStop, t.warn, 'Trail', 2);
      this._syncPriceLines('trade', want);
    }

    setMarkers(markers) {
      const data = (markers || []).map(m => ({
        time: Z.toChart(m.time),
        position: m.position || 'aboveBar',
        color: m.color || Z.theme().accent,
        shape: m.shape || 'circle',
        text: m.text || '',
      })).sort((a, b) => a.time - b.time);
      if (!this.markersPlugin) this.markersPlugin = LWC.createSeriesMarkers(this.series, data);
      else this.markersPlugin.setMarkers(data);
    }

    /* ---------------------------------------------------------- crosshair */

    _onCrosshair(param) {
      if (!param || !param.time) { this._renderLegend(null); if (this.onCrosshair) this.onCrosshair(null); return; }
      const utc = Z.fromChart(param.time);
      const index = this.bars.findIndex(b => b.time === utc);
      this._renderLegend(index >= 0 ? index : null);
      if (this.onCrosshair) {
        this.onCrosshair(index >= 0 ? { index, bar: this.bars[index], computed: this.computed } : null);
      }
    }

    // The readout above the chart: OHLC, the tick count, and every enabled
    // indicator's value AT THE HOVERED BAR — not its latest value, which is the
    // thing most legends get wrong and which makes a legend useless for reading
    // history.
    _renderLegend(index) {
      if (!this.legend) return;
      const i = index === null || index === undefined ? this.bars.length - 1 : index;
      const bar = this.bars[i];
      if (!bar) { this.legend.innerHTML = '<span class="muted">no data yet</span>'; return; }

      const c = this.computed;
      const chunks = [];
      const change = bar.close - bar.open;
      chunks.push('<span class="lg-time">' + Z.istClock(bar.time, Z.TIMEFRAME_SECONDS[this.timeframe] < 60) + '</span>');
      chunks.push('<span class="lg-ohlc ' + Z.signClass(change) + '">'
        + 'O <b>' + Z.fmt(bar.open, this.precision) + '</b> '
        + 'H <b>' + Z.fmt(bar.high, this.precision) + '</b> '
        + 'L <b>' + Z.fmt(bar.low, this.precision) + '</b> '
        + 'C <b>' + Z.fmt(bar.close, this.precision) + '</b>'
        + '</span>');
      chunks.push('<span class="lg-vol">ticks <b>' + Z.fmtInt(bar.volume) + '</b></span>');
      if (bar.synthetic) chunks.push('<span class="lg-warn">no prints in this bar</span>');

      const val = (name, value, decimals) => {
        if (!this.enabled.has(name) || value === null || value === undefined) return;
        chunks.push('<span class="lg-ind" data-ind="' + name + '">' + INDICATOR_LABEL[name]
          + ' <b>' + Z.fmt(value, decimals === undefined ? this.precision : decimals) + '</b></span>');
      };
      if (c) {
        val('ema9', c.ema9[i]); val('ema20', c.ema20[i]);
        val('ema50', c.ema50[i]); val('ema200', c.ema200[i]);
        val('vwap', c.vwap[i]);
        val('supertrend', c.supertrend.value[i]);
        val('atr', c.atr[i]);
        val('rsi', c.rsi[i], 1);
        if (this.enabled.has('macd') && c.macd.macd[i] !== null) {
          chunks.push('<span class="lg-ind">MACD <b>' + Z.fmt(c.macd.macd[i]) + '</b> / '
            + Z.fmt(c.macd.signal[i]) + '</span>');
        }
        val('adx', c.adx.adx[i], 1);
      }
      this.legend.innerHTML = chunks.join('');
    }

    /* ------------------------------------------------------------ controls */

    zoom(factor) {
      const scale = this.chart.timeScale();
      const range = scale.getVisibleLogicalRange();
      if (!range) return;
      const centre = (range.from + range.to) / 2;
      const half = (range.to - range.from) / 2 * factor;
      scale.setVisibleLogicalRange({ from: centre - half, to: centre + half });
    }

    reset() {
      this.chart.timeScale().fitContent();
      this.chart.priceScale('right').applyOptions({ autoScale: true });
    }

    setPaused(paused) {
      this.paused = Boolean(paused);
      return this.paused;
    }

    _applyTheme() {
      const t = Z.theme();
      this.chart.applyOptions({
        layout: {
          background: { type: LWC.ColorType.Solid, color: t.panel },
          textColor: t.muted,
          panes: { separatorColor: t.line, separatorHoverColor: t.accent },
        },
        grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
        rightPriceScale: { borderColor: t.line },
        timeScale: { borderColor: t.line },
        crosshair: {
          vertLine: { color: t.crosshair, labelBackgroundColor: t.panel2 },
          horzLine: { color: t.crosshair, labelBackgroundColor: t.panel2 },
        },
      });
      this._createPriceSeries();
      this._redraw({ fit: false });
      this.drawings.redraw();
    }

    destroy() {
      try { this.drawings.destroy(); } catch (_) { /* ignore */ }
      try { this.chart.remove(); } catch (_) { /* ignore */ }
    }
  }

  Z.PriceChart = PriceChart;
  Z.INDICATOR_LABEL = INDICATOR_LABEL;
}(window.Z));
