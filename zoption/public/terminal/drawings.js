// Drawing tools, on a canvas over the chart.
//
// Lightweight Charts ships no drawing tools — it is a rendering library, not a
// charting application — so the eight tools the specification asks for are drawn
// here on a transparent canvas stretched over the chart's own.
//
// THE ONE IDEA THAT MAKES THIS WORK: a drawing is stored in CHART COORDINATES
// (a time and a price), never in pixels. Pixels are recomputed from the chart's
// current scales on every redraw. That is what makes a trend line stay attached
// to the two bars it was drawn between when the chart is scrolled, zoomed,
// switched from 1-minute to 5-minute, or reloaded tomorrow — and it is why the
// canvas is repainted on every visible-range change rather than only on resize.
//
// A price that scrolls off the visible range returns null from the library's
// coordinate conversion. Those points are extrapolated linearly from the scale
// rather than dropped, so a horizontal line drawn at a level far above the
// current range still renders its label at the edge instead of vanishing.

window.Z = window.Z || {};

(function (Z) {
  'use strict';

  const TOOLS = [
    { id: 'cursor', label: 'Cursor', hint: 'pan and zoom', points: 0 },
    { id: 'hline', label: 'Horizontal', hint: 'a level', points: 1 },
    { id: 'trend', label: 'Trend line', hint: 'two points', points: 2 },
    { id: 'rect', label: 'Rectangle', hint: 'a zone', points: 2 },
    { id: 'rr', label: 'Risk / reward', hint: 'entry, stop, then target', points: 3 },
    { id: 'long', label: 'Long', hint: 'entry then stop; target mirrors 2R', points: 2 },
    { id: 'short', label: 'Short', hint: 'entry then stop; target mirrors 2R', points: 2 },
    { id: 'arrow', label: 'Arrow', hint: 'two points', points: 2 },
    { id: 'text', label: 'Text', hint: 'click, then type', points: 1 },
  ];

  class DrawingLayer {
    constructor(opts) {
      this.chart = opts.chart;
      this.series = opts.series;
      this.container = opts.container;
      this.storageKey = opts.storageKey;

      this.tool = 'cursor';
      this.items = Z.store.get(this.storageKey, []) || [];
      this.pending = null;
      this.selected = null;
      this.hover = null;

      this.canvas = document.createElement('canvas');
      this.canvas.className = 'draw-layer';
      this.container.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');

      this._bind();
      this._resize();
      this.redraw();
    }

    setSeries(series) { this.series = series; this.redraw(); }

    setTool(tool) {
      this.tool = tool;
      this.pending = null;
      // The canvas only swallows pointer events while a tool is armed. In
      // cursor mode it is transparent to the mouse so the chart keeps its own
      // pan, zoom and crosshair — a permanently capturing overlay would make
      // the chart feel broken.
      this.canvas.classList.toggle('armed', tool !== 'cursor');
      this.redraw();
    }

    _bind() {
      this._onDown = (e) => this._pointerDown(e);
      this._onMove = (e) => this._pointerMove(e);
      this._onKey = (e) => this._key(e);
      this.canvas.addEventListener('pointerdown', this._onDown);
      this.canvas.addEventListener('pointermove', this._onMove);
      window.addEventListener('keydown', this._onKey);

      this._observer = new ResizeObserver(() => { this._resize(); this.redraw(); });
      this._observer.observe(this.container);

      const scale = this.chart.timeScale();
      this._unsubRange = () => scale.unsubscribeVisibleLogicalRangeChange(this._rangeHandler);
      this._rangeHandler = () => this.redraw();
      scale.subscribeVisibleLogicalRangeChange(this._rangeHandler);
      // The price scale can change without the time scale moving (autoscale on a
      // new high), and there is no event for it — so a cheap animation-frame
      // loop repaints while anything is on the canvas.
      this._tick = () => {
        if (this._dead) return;
        if (this.items.length || this.pending) this._paint();
        this._raf = requestAnimationFrame(this._tick);
      };
      this._raf = requestAnimationFrame(this._tick);
    }

    _resize() {
      const rect = this.container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      this.canvas.style.width = rect.width + 'px';
      this.canvas.style.height = rect.height + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.width = rect.width;
      this.height = rect.height;
    }

    /* ------------------------------------------------------- coordinates -- */

    _toPoint(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const time = this.chart.timeScale().coordinateToTime(x);
      const price = this.series.coordinateToPrice(y);
      if (time === null || price === null) return null;
      return { time: Z.fromChart(time), price, x, y };
    }

    // Chart coordinates back to pixels. Two fallbacks matter:
    //
    //  * a time outside the visible range converts to null, so it is estimated
    //    from the bar spacing — otherwise a trend line whose left anchor has
    //    scrolled off would disappear entirely rather than continue off-screen.
    //  * the same for a price above or below the visible price range.
    _toPixel(point) {
      const scale = this.chart.timeScale();
      let x = scale.timeToCoordinate(Z.toChart(point.time));
      if (x === null) {
        const range = scale.getVisibleRange();
        if (!range) return null;
        const fromX = scale.timeToCoordinate(range.from);
        const toX = scale.timeToCoordinate(range.to);
        if (fromX === null || toX === null || range.to === range.from) return null;
        const perSecond = (toX - fromX) / (range.to - range.from);
        x = fromX + (Z.toChart(point.time) - range.from) * perSecond;
      }
      let y = this.series.priceToCoordinate(point.price);
      if (y === null) {
        // Two known prices give the linear scale; log scales are not used here.
        const a = this.series.coordinateToPrice(0);
        const b = this.series.coordinateToPrice(this.height);
        if (a === null || b === null || a === b) return null;
        y = (point.price - a) * (this.height / (b - a));
      }
      return { x, y };
    }

    /* ------------------------------------------------------------ input --- */

    _pointerDown(e) {
      if (this.tool === 'cursor') return;
      const p = this._toPoint(e);
      if (!p) return;
      e.preventDefault();

      const spec = TOOLS.find(t => t.id === this.tool);
      if (!this.pending) this.pending = { type: this.tool, points: [] };
      this.pending.points.push({ time: p.time, price: p.price });

      if (this.pending.points.length >= spec.points) {
        const item = this.pending;
        this.pending = null;
        if (item.type === 'text') {
          // eslint-disable-next-line no-alert
          const text = window.prompt('Label');
          if (!text) { this.redraw(); return; }
          item.text = text.slice(0, 120);
        }
        item.id = 'd' + Date.now() + Math.floor(Math.random() * 1000);
        this.items.push(item);
        this._persist();
        // One shape per click of a tool. Staying armed is how a chart ends up
        // covered in accidental rectangles.
        Z.dispatch('drawing:done');
      }
      this.redraw();
    }

    _pointerMove(e) {
      const p = this._toPoint(e);
      this.cursor = p;
      if (this.pending) this._paint();
    }

    _key(e) {
      if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.key === 'Escape') { this.pending = null; this.setTool('cursor'); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.hover) {
        this.items = this.items.filter(i => i.id !== this.hover);
        this.hover = null;
        this._persist();
        this.redraw();
      }
    }

    clear() {
      this.items = [];
      this.pending = null;
      this._persist();
      this.redraw();
    }

    undo() {
      this.items.pop();
      this._persist();
      this.redraw();
    }

    _persist() { Z.store.set(this.storageKey, this.items); }

    /* ------------------------------------------------------------ paint --- */

    redraw() { this._paint(); }

    _paint() {
      if (!this.ctx || !this.series) return;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.width, this.height);
      const t = Z.theme();

      for (const item of this.items) this._paintItem(ctx, item, t, false);
      if (this.pending && this.pending.points.length && this.cursor) {
        const preview = {
          type: this.pending.type,
          points: this.pending.points.concat([{ time: this.cursor.time, price: this.cursor.price }]),
          text: '…',
        };
        this._paintItem(ctx, preview, t, true);
      }
    }

    _paintItem(ctx, item, t, preview) {
      const pts = item.points.map(p => this._toPixel(p)).filter(Boolean);
      if (pts.length < item.points.length) return;

      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.setLineDash(preview ? [4, 4] : []);
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.strokeStyle = t.accent;
      ctx.fillStyle = t.accent;

      switch (item.type) {
        case 'hline': {
          const y = pts[0].y;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(this.width, y);
          ctx.stroke();
          this._label(ctx, t, this.width - 6, y - 4, Z.fmt(item.points[0].price), 'right');
          break;
        }
        case 'trend':
        case 'arrow': {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          ctx.lineTo(pts[1].x, pts[1].y);
          ctx.stroke();
          if (item.type === 'arrow') this._arrowHead(ctx, pts[0], pts[1]);
          break;
        }
        case 'rect': {
          const x = Math.min(pts[0].x, pts[1].x);
          const y = Math.min(pts[0].y, pts[1].y);
          const w = Math.abs(pts[1].x - pts[0].x);
          const h = Math.abs(pts[1].y - pts[0].y);
          ctx.fillStyle = t.accent + '22';
          ctx.fillRect(x, y, w, h);
          ctx.strokeRect(x, y, w, h);
          const delta = item.points[1].price - item.points[0].price;
          this._label(ctx, t, x + w - 4, y + 12, Z.fmtSigned(delta), 'right');
          break;
        }
        case 'rr': {
          // Three clicks make this shape; a preview after one or two has
          // nothing to draw yet.
          if (pts.length < 3) break;
          this._paintRR(ctx, t, item, pts, item.points[1].price < item.points[0].price);
          break;
        }
        case 'long':
        case 'short': {
          if (item.points.length < 2) break;
          // Entry and stop are placed; the target is the 2R mirror, which is the
          // measurement the tool exists to make rather than a third click.
          const entry = item.points[0].price;
          const stop = item.points[1].price;
          const target = entry + (entry - stop) * 2;
          const full = [item.points[0], item.points[1], { time: item.points[1].time, price: target }];
          const fullPts = full.map(p => this._toPixel(p)).filter(Boolean);
          if (fullPts.length === 3) {
            this._paintRR(ctx, t, { points: full }, fullPts, item.type === 'short');
          }
          break;
        }
        case 'text': {
          ctx.fillStyle = t.text;
          ctx.fillText(item.text || '', pts[0].x + 4, pts[0].y - 4);
          break;
        }
        default: break;
      }
      ctx.restore();
    }

    // The risk/reward box: red from entry to stop, green from entry to target,
    // with the ratio written where the eye lands. Used by the RR tool and by the
    // long/short position tools, which are the same picture with the target
    // derived instead of clicked.
    _paintRR(ctx, t, item, pts, isShort) {
      const entryY = pts[0].y;
      const stopY = pts[1].y;
      const targetY = pts[2].y;
      const x = Math.min(pts[0].x, pts[2].x);
      const width = Math.max(60, Math.abs(pts[2].x - pts[0].x) || 120);

      ctx.fillStyle = t.down + '33';
      ctx.fillRect(x, Math.min(entryY, stopY), width, Math.abs(stopY - entryY));
      ctx.fillStyle = t.up + '33';
      ctx.fillRect(x, Math.min(entryY, targetY), width, Math.abs(targetY - entryY));

      ctx.strokeStyle = t.text;
      ctx.beginPath();
      ctx.moveTo(x, entryY);
      ctx.lineTo(x + width, entryY);
      ctx.stroke();

      const entry = item.points[0].price;
      const stop = item.points[1].price;
      const target = item.points[2].price;
      const risk = Math.abs(entry - stop);
      const reward = Math.abs(target - entry);
      const ratio = risk > 0 ? (reward / risk) : null;

      ctx.fillStyle = t.text;
      const side = isShort ? 'Short' : 'Long';
      this._label(ctx, t, x + 4, entryY - 6,
        side + '  entry ' + Z.fmt(entry) + '  stop ' + Z.fmt(stop)
        + '  target ' + Z.fmt(target)
        + (ratio === null ? '' : '  ' + ratio.toFixed(2) + 'R'), 'left');
    }

    _arrowHead(ctx, from, to) {
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const size = 9;
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - size * Math.cos(angle - Math.PI / 7), to.y - size * Math.sin(angle - Math.PI / 7));
      ctx.lineTo(to.x - size * Math.cos(angle + Math.PI / 7), to.y - size * Math.sin(angle + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
    }

    _label(ctx, t, x, y, text, align) {
      ctx.save();
      ctx.textAlign = align || 'left';
      const metrics = ctx.measureText(text);
      const padding = 3;
      const boxX = align === 'right' ? x - metrics.width - padding : x - padding;
      ctx.fillStyle = t.panel + 'e0';
      ctx.fillRect(boxX, y - 11, metrics.width + padding * 2, 14);
      ctx.fillStyle = t.text;
      ctx.fillText(text, x, y);
      ctx.restore();
    }

    destroy() {
      this._dead = true;
      if (this._raf) cancelAnimationFrame(this._raf);
      this.canvas.removeEventListener('pointerdown', this._onDown);
      this.canvas.removeEventListener('pointermove', this._onMove);
      window.removeEventListener('keydown', this._onKey);
      try { this._observer.disconnect(); } catch (_) { /* ignore */ }
      try { this._unsubRange(); } catch (_) { /* ignore */ }
      this.canvas.remove();
    }
  }

  // A tiny event bus so the drawing layer can tell the toolbar it finished a
  // shape without holding a reference to the DOM the toolbar owns.
  Z._bus = Z._bus || {};
  Z.dispatch = function (name, detail) {
    for (const fn of (Z._bus[name] || [])) {
      try { fn(detail); } catch (_) { /* one listener must not stop the rest */ }
    }
  };
  Z.on = function (name, fn) { (Z._bus[name] = Z._bus[name] || []).push(fn); };

  Z.DrawingLayer = DrawingLayer;
  Z.DRAW_TOOLS = TOOLS;
}(window.Z));
