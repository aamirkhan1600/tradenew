// Module 3's side panels: the contract's own statistics, greeks, patterns,
// volume reading and alerts.
//
// The chart itself is a plain Z.PriceChart — an option premium is a price series
// like any other. What is different about an option is everything AROUND the
// chart, and that is what lives here.
//
// A WARNING WORTH REPEATING AT THE POINT OF USE. Every greek shown here is
// solved from the last traded price, and "premium velocity" measures a series
// sampled roughly once a second from a REST poll. On a liquid near-the-money
// weekly that is a fair description of the contract. On a far strike that last
// printed twenty minutes ago it is a description of a stale number, and the
// panel says so — `stale` appears next to the price once the last change is
// older than a minute — rather than showing a confident zero velocity.

window.Z = window.Z || {};

(function (Z) {
  'use strict';

  const IND = window.ZIndicators;
  const PAT = window.ZPatterns;

  const STALE_MS = 60000;

  // Alert definitions. Each returns a message or null. They are evaluated on
  // CLOSED bars only — an alert that fires mid-bar and unfires when the bar
  // moves against it is worse than no alert, because it trains an operator to
  // ignore the ones that matter.
  const ALERTS = {
    breakout: {
      label: 'Premium breakout',
      test(ctx) {
        if (ctx.bars.length < 21) return null;
        const window20 = ctx.bars.slice(-21, -1);
        const high = Math.max(...window20.map(b => b.high));
        const low = Math.min(...window20.map(b => b.low));
        if (ctx.bar.close > high) return 'broke above the 20-bar high ' + Z.fmt(high);
        if (ctx.bar.close < low) return 'broke below the 20-bar low ' + Z.fmt(low);
        return null;
      },
    },
    emaCross: {
      label: 'EMA cross',
      test(ctx) {
        const { ema9, ema20 } = ctx.computed;
        const i = ctx.index;
        if (i < 1) return null;
        const a = ema9[i]; const b = ema20[i];
        const pa = ema9[i - 1]; const pb = ema20[i - 1];
        if ([a, b, pa, pb].some(v => v === null || v === undefined)) return null;
        if (pa <= pb && a > b) return 'EMA 9 crossed above EMA 20';
        if (pa >= pb && a < b) return 'EMA 9 crossed below EMA 20';
        return null;
      },
    },
    vwapBreak: {
      label: 'VWAP break',
      test(ctx) {
        const v = ctx.computed.vwap;
        const i = ctx.index;
        if (i < 1 || v[i] === null || v[i - 1] === null) return null;
        const before = ctx.bars[i - 1].close;
        if (before <= v[i - 1] && ctx.bar.close > v[i]) return 'crossed above VWAP ' + Z.fmt(v[i]);
        if (before >= v[i - 1] && ctx.bar.close < v[i]) return 'crossed below VWAP ' + Z.fmt(v[i]);
        return null;
      },
    },
    volumeSpike: {
      label: 'Volume spike',
      test(ctx) {
        const ratio = ctx.computed.volume.ratio[ctx.index];
        if (ratio === null || ratio === undefined) return null;
        return ratio >= 3 ? ('activity ' + ratio.toFixed(1) + '× the 20-bar average') : null;
      },
    },
    // These two watch the quote rather than the bar, so they compare against the
    // last value seen rather than against a series.
    thetaIncrease: {
      label: 'Theta increase',
      quote: true,
      test(ctx) {
        const now = ctx.quote.theta;
        const before = ctx.previousQuote ? ctx.previousQuote.theta : null;
        if (now === null || before === null || now === undefined || before === undefined) return null;
        // Theta is negative; "increase" means more decay, i.e. more negative.
        if (now < before * 1.15 && Math.abs(now - before) > 0.05) {
          return 'decay steepened to ' + Z.fmt(now) + '/day';
        }
        return null;
      },
    },
    oiIncrease: {
      label: 'OI increase',
      quote: true,
      test(ctx) {
        const now = ctx.quote.oi;
        const before = ctx.previousQuote ? ctx.previousQuote.oi : null;
        if (now === null || before === null || now === undefined || before === undefined) return null;
        if (before > 0 && now >= before * 1.05) {
          return 'open interest up ' + Z.fmtCompact(now - before) + ' to ' + Z.fmtCompact(now);
        }
        return null;
      },
    },
  };

  class PremiumPanel {
    constructor(opts) {
      this.infoHost = opts.info;
      this.statsHost = opts.stats;
      this.greeksHost = opts.greeks;
      this.patternHost = opts.patterns;
      this.volumeHost = opts.volume;
      this.alertHost = opts.alerts;

      this.contract = null;
      this.quote = null;
      this.previousQuote = null;
      this.lastChangeAt = 0;
      this.lastPrice = null;
      this.bars = [];
      this.computed = null;
      this.alertsOn = Z.store.get('premium.alerts', Object.keys(ALERTS)) || Object.keys(ALERTS);
      this.fired = [];
      this._lastAlertBar = null;
    }

    setContract(contract) {
      this.contract = contract;
      this.quote = null;
      this.previousQuote = null;
      this.fired = [];
      this._lastAlertBar = null;
      this.lastPrice = null;
      this.lastChangeAt = 0;
      this.render();
    }

    // Called with the chain row for this contract — the richest snapshot there
    // is, once a second.
    setQuote(quote) {
      if (!quote) return;
      this.previousQuote = this.quote;
      this.quote = quote;
      if (quote.ltp !== null && quote.ltp !== this.lastPrice) {
        this.lastPrice = quote.ltp;
        this.lastChangeAt = Date.now();
      }
      this._evaluateQuoteAlerts();
      this.render();
    }

    setBars(bars, computed) {
      this.bars = bars || [];
      this.computed = computed || null;
      this._evaluateBarAlerts();
      this.render();
    }

    setAlerts(list) {
      this.alertsOn = list;
      Z.store.set('premium.alerts', list);
      this.render();
    }

    /* ----------------------------------------------------------- alerts -- */

    _evaluateBarAlerts() {
      if (!this.computed || this.bars.length < 2) return;
      // The last CLOSED bar, not the one in progress.
      const index = this.bars.length - 2;
      const bar = this.bars[index];
      if (!bar || this._lastAlertBar === bar.time) return;
      this._lastAlertBar = bar.time;

      const ctx = { bars: this.bars.slice(0, index + 1), bar, index, computed: this.computed };
      for (const [id, alert] of Object.entries(ALERTS)) {
        if (alert.quote || !this.alertsOn.includes(id)) continue;
        let message = null;
        try { message = alert.test(ctx); } catch (_) { message = null; }
        if (message) this._fire(id, alert.label, message, bar.time);
      }
    }

    _evaluateQuoteAlerts() {
      if (!this.quote) return;
      const ctx = { quote: this.quote, previousQuote: this.previousQuote };
      for (const [id, alert] of Object.entries(ALERTS)) {
        if (!alert.quote || !this.alertsOn.includes(id)) continue;
        let message = null;
        try { message = alert.test(ctx); } catch (_) { message = null; }
        if (message) this._fire(id, alert.label, message, Math.floor(Date.now() / 1000));
      }
    }

    _fire(id, label, message, time) {
      const last = this.fired[0];
      // The same alert on the same bar is one alert. Without this, an OI tick
      // that arrives twice inside a second reports twice.
      if (last && last.id === id && last.time === time) return;
      this.fired.unshift({ id, label, message, time });
      this.fired = this.fired.slice(0, 40);
      Z.notify(label + ' — ' + (this.contract ? this.contract.label : '') + ': ' + message, 'warn');
    }

    /* ----------------------------------------------------------- render -- */

    render() {
      this._renderInfo();
      this._renderGreeks();
      this._renderStats();
      this._renderPatterns();
      this._renderVolume();
      this._renderAlerts();
    }

    _kv(rows) {
      return '<dl class="kv2">' + rows.map(([k, v, cls]) =>
        '<dt>' + k + '</dt><dd class="' + (cls || '') + '">' + v + '</dd>').join('') + '</dl>';
    }

    _renderInfo() {
      if (!this.infoHost) return;
      if (!this.contract) {
        this.infoHost.innerHTML = '<p class="muted">Click a premium in the chain to chart it.</p>';
        return;
      }
      const q = this.quote || {};
      const stale = this.lastChangeAt && (Date.now() - this.lastChangeAt) > STALE_MS;
      this.infoHost.innerHTML = this._kv([
        ['Strike', Z.fmtInt(this.contract.strike)],
        ['Type', this.contract.type],
        ['Expiry', this.contract.expiry || '—'],
        ['LTP', Z.fmt(q.ltp) + (stale ? ' <span class="tag warn">stale</span>' : ''),
          Z.signClass(q.change)],
        ['Change', Z.fmtSigned(q.change) + '  ' + Z.fmtSigned(q.changePct, 2) + '%', Z.signClass(q.change)],
        ['Bid / Ask', Z.fmt(q.bid) + ' / ' + Z.fmt(q.ask)],
        ['Volume', Z.fmtCompact(q.volume)],
        ['Open interest', Z.fmtCompact(q.oi)],
        ['Chg OI', Z.fmtCompact(q.oiChange), Z.signClass(q.oiChange)],
        ['Intrinsic', Z.fmt(q.intrinsic)],
        ['Time value', Z.fmt(q.timeValue)],
        ['Build-up', q.buildup ? (Z.BUILDUP_LABEL_UI[q.buildup] || q.buildup) : '—'],
      ]);
    }

    _renderGreeks() {
      if (!this.greeksHost) return;
      const q = this.quote || {};
      const none = q.iv === null || q.iv === undefined;
      this.greeksHost.innerHTML = this._kv([
        ['IV', Z.fmt(q.iv, 2) + (none ? '' : '%')],
        ['Delta', Z.fmt(q.delta, 4)],
        ['Gamma', Z.fmt(q.gamma, 5)],
        ['Theta', Z.fmt(q.theta, 3) + (q.theta === null || q.theta === undefined ? '' : ' /day'),
          Z.signClass(q.theta)],
        ['Vega', Z.fmt(q.vega, 4)],
        ['Rho', Z.fmt(q.rho, 5)],
      ]) + '<p class="foot-note">'
        + (none
          ? 'No solvable implied volatility at this price — the model cannot reach it at any '
            + 'volatility between 0.5% and 500%, which usually means a tick-floor or stale quote.'
          : 'Modelled from the last traded price (Black-Scholes, European, no dividend). '
            + 'Kotak sends no greeks.')
        + '</p>';
    }

    _renderStats() {
      if (!this.statsHost) return;
      if (!this.bars.length) { this.statsHost.innerHTML = '<p class="muted">No bars yet.</p>'; return; }

      const today = Z.dayKey(Math.floor(Date.now() / 1000));
      const todays = this.bars.filter(b => Z.dayKey(b.time) === today);
      const scope = todays.length ? todays : this.bars;

      const highs = scope.map(b => b.high);
      const lows = scope.map(b => b.low);
      const closes = scope.map(b => b.close);
      const avg = closes.reduce((a, b) => a + b, 0) / closes.length;

      // Velocity: premium change per minute across the last five bars, which is
      // short enough to be current and long enough not to be one print.
      const tail = scope.slice(-6);
      let velocity = null;
      let momentum = null;
      if (tail.length >= 2) {
        const minutes = Math.max(1 / 60, (tail[tail.length - 1].time - tail[0].time) / 60);
        velocity = (tail[tail.length - 1].close - tail[0].close) / minutes;
        const earlier = scope.slice(-12, -6);
        if (earlier.length >= 2) {
          const m2 = Math.max(1 / 60, (earlier[earlier.length - 1].time - earlier[0].time) / 60);
          const previous = (earlier[earlier.length - 1].close - earlier[0].close) / m2;
          momentum = velocity - previous;
        }
      }

      // Decay is theta where the model could solve it, and the observed drift
      // per hour where it could not. They are labelled differently on purpose —
      // one is a model output and the other is what actually happened.
      const theta = this.quote ? this.quote.theta : null;
      const observed = scope.length >= 2
        ? (scope[scope.length - 1].close - scope[0].close)
          / Math.max(1 / 60, (scope[scope.length - 1].time - scope[0].time) / 3600)
        : null;

      this.statsHost.innerHTML = this._kv([
        ['Today high', Z.fmt(Math.max(...highs))],
        ['Today low', Z.fmt(Math.min(...lows))],
        ['Average', Z.fmt(avg)],
        ['Session high', Z.fmt(Math.max(...this.bars.map(b => b.high)))],
        ['Session low', Z.fmt(Math.min(...this.bars.map(b => b.low)))],
        ['Decay (theta)', theta === null || theta === undefined ? '—' : Z.fmt(theta, 3) + ' /day'],
        ['Drift (observed)', observed === null ? '—' : Z.fmtSigned(observed, 3) + ' /hr',
          Z.signClass(observed)],
        ['Velocity', velocity === null ? '—' : Z.fmtSigned(velocity, 3) + ' /min', Z.signClass(velocity)],
        ['Momentum', momentum === null ? '—' : Z.fmtSigned(momentum, 3), Z.signClass(momentum)],
      ]);
    }

    _renderPatterns() {
      if (!this.patternHost) return;
      if (this.bars.length < 3) { this.patternHost.innerHTML = '<p class="muted">Not enough bars.</p>'; return; }
      const found = PAT.scan(this.bars).slice(-8).reverse();
      if (!found.length) { this.patternHost.innerHTML = '<p class="muted">No pattern on the recent bars.</p>'; return; }
      this.patternHost.innerHTML = '<ul class="plain">' + found.map(f =>
        '<li><span class="t">' + Z.istClock(f.time, true) + '</span>'
        + f.patterns.map(p => '<span class="tag ' + (PAT.BIAS[p] === 'BULL' ? 'up'
          : PAT.BIAS[p] === 'BEAR' ? 'down' : '') + '">' + (PAT.LABEL[p] || p) + '</span>').join('')
        + '</li>').join('') + '</ul>';
    }

    _renderVolume() {
      if (!this.volumeHost) return;
      if (!this.bars.length) { this.volumeHost.innerHTML = '<p class="muted">No bars yet.</p>'; return; }
      const profile = IND.volumeProfile(this.bars, 20);
      const i = this.bars.length - 1;
      const press = IND.pressure(this.bars[i]);
      const ratio = profile.ratio[i];
      this.volumeHost.innerHTML = this._kv([
        ['Bar activity', Z.fmtInt(this.bars[i].volume) + ' ticks'],
        ['20-bar average', profile.average[i] === null ? '—' : Z.fmt(profile.average[i], 1)],
        ['Ratio', ratio === null || ratio === undefined ? '—' : ratio.toFixed(2) + '×',
          ratio >= 3 ? 'up' : ''],
        ['Spike', ratio !== null && ratio !== undefined && ratio >= 3 ? 'yes' : 'no',
          ratio >= 3 ? 'up' : 'muted'],
        ['Buying pressure', press ? Z.fmt(press.buying, 0) + '%' : '—'],
        ['Selling pressure', press ? Z.fmt(press.selling, 0) + '%' : '—'],
      ]) + '<p class="foot-note">Activity is the number of price updates in the bar. '
        + 'Kotak\'s quote feed carries no traded quantity on this account, so this is a '
        + 'proxy for volume and not exchange volume.</p>';
    }

    _renderAlerts() {
      if (!this.alertHost) return;
      const toggles = Object.entries(ALERTS).map(([id, a]) =>
        '<label class="chk"><input type="checkbox" data-alert="' + id + '"'
        + (this.alertsOn.includes(id) ? ' checked' : '') + '> ' + a.label + '</label>').join('');
      const list = this.fired.length
        ? '<ul class="plain alerts">' + this.fired.slice(0, 12).map(f =>
          '<li><span class="t">' + Z.istClock(f.time, true) + '</span>'
          + '<b>' + Z.escapeHtml(f.label) + '</b> ' + Z.escapeHtml(f.message) + '</li>').join('') + '</ul>'
        : '<p class="muted">Nothing has fired yet.</p>';
      this.alertHost.innerHTML = '<div class="alert-toggles">' + toggles + '</div>' + list;

      for (const input of this.alertHost.querySelectorAll('input[data-alert]')) {
        input.addEventListener('change', () => {
          const on = [...this.alertHost.querySelectorAll('input[data-alert]:checked')]
            .map(i => i.dataset.alert);
          this.setAlerts(on);
        });
      }
    }
  }

  // The build-up labels, duplicated for the browser. The server's copy in
  // chainAnalytics.js is the one the API speaks; this is only the display text.
  Z.BUILDUP_LABEL_UI = {
    LONG_BUILDUP: 'Long build-up',
    SHORT_BUILDUP: 'Short build-up',
    SHORT_COVERING: 'Short covering',
    LONG_UNWINDING: 'Long unwinding',
    FLAT: 'Flat',
  };

  Z.PremiumPanel = PremiumPanel;
  Z.PREMIUM_ALERTS = ALERTS;
}(window.Z));
