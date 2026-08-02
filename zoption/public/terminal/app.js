// The terminal, wired together.
//
// Three modules share one socket and one chain payload:
//
//   index_tick          -> module 1's live bar and the header
//   option_chain_update -> module 2's table, the summary panel, and module 3's
//                          quote (the chain row IS the richest snapshot of the
//                          selected contract, so the premium panel reads it
//                          rather than asking for the same numbers again)
//   option_tick         -> module 3's live bar only
//
// The feed on the server starts when this page joins and stops about 45 seconds
// after the last tab leaves, so a closed terminal costs the broker account
// nothing.

window.Z = window.Z || {};

(function (Z) {
  'use strict';

  // The server owns the timeframe list and the strike-range defaults — they are
  // validated against `core/time.js` and clamped by `config.terminal`, so
  // hardcoding a second copy here is how a page ends up offering a timeframe the
  // API rejects. The fallbacks only matter if the markup is ever served without
  // them.
  const root = document.querySelector('main.terminal');
  const TIMEFRAMES = ((root && root.dataset.timeframes) || '5s,15s,30s,1m,3m,5m,15m,1h,1d')
    .split(',').filter(Boolean);
  const MAX_RANGE = Number((root && root.dataset.maxRange) || 20);

  const CHART_TYPES = [
    { id: 'candles', label: 'Candles' },
    { id: 'ohlc', label: 'OHLC' },
    { id: 'line', label: 'Line' },
    { id: 'area', label: 'Area' },
  ];
  const INDEX_INDICATORS = ['ema9', 'ema20', 'ema50', 'ema200', 'vwap', 'supertrend',
    'bollinger', 'openingRange', 'pivot', 'cpr', 'prevDay', 'volume', 'rsi', 'macd', 'adx', 'atr'];
  const PREMIUM_INDICATORS = ['ema9', 'ema20', 'vwap', 'supertrend', 'volume', 'rsi', 'macd', 'atr'];

  const state = {
    symbol: (root && root.dataset.symbol) || 'NIFTY',
    expiry: null,
    range: Number((root && root.dataset.range) || 10),
    indexTimeframe: Z.store.get('tf.index', '1m'),
    premiumTimeframe: Z.store.get('tf.premium', '1m'),
    contract: null,
    chain: null,
    paused: false,
    lastIndexTick: null,
  };

  let socket = null;
  let indexChart = null;
  let premiumChart = null;
  let chain = null;
  let premium = null;

  /* ------------------------------------------------------------- controls */

  function segmented(host, items, current, onPick) {
    host.innerHTML = items.map(item => {
      const id = typeof item === 'string' ? item : item.id;
      const label = typeof item === 'string' ? item : item.label;
      return '<button type="button" class="seg' + (id === current ? ' on' : '') + '" data-v="'
        + id + '">' + label + '</button>';
    }).join('');
    host.onclick = (e) => {
      const button = e.target.closest('button[data-v]');
      if (!button) return;
      for (const b of host.children) b.classList.toggle('on', b === button);
      onPick(button.dataset.v);
    };
  }

  function checkboxes(host, names, isOn, onToggle) {
    host.innerHTML = names.map(n =>
      '<label class="chk"><input type="checkbox" data-v="' + n + '"'
      + (isOn(n) ? ' checked' : '') + '> ' + (Z.INDICATOR_LABEL[n] || n) + '</label>').join('');
    host.onchange = (e) => {
      const input = e.target.closest('input[data-v]');
      if (!input) return;
      onToggle(input.dataset.v, input.checked);
    };
  }

  /* ---------------------------------------------------------- module one  */

  async function loadIndexHistory() {
    try {
      const body = await Z.api('/api/chart/history', {
        symbol: state.symbol, timeframe: state.indexTimeframe, limit: 600,
      });
      indexChart.setTimeframe(state.indexTimeframe);
      indexChart.setBars(body.candles);
      indexChart.setPreviousSession(previousSessionOf(body.candles));
      if (body.note) Z.notify(body.note, 'warn');
    } catch (err) {
      Z.notify('Index history: ' + err.message, 'bad');
      indexChart.setBars([]);
    }
  }

  // Yesterday's OHLC, for the pivots and the previous high/low/close levels.
  // Derived from the bars we already have rather than fetched — one round trip
  // is enough, and a daily bar the store does not hold yet would just be null.
  function previousSessionOf(bars) {
    if (!bars || !bars.length) return null;
    const today = Z.dayKey(bars[bars.length - 1].time);
    const previous = bars.filter(b => Z.dayKey(b.time) < today);
    if (!previous.length) return null;
    const day = Z.dayKey(previous[previous.length - 1].time);
    const session = previous.filter(b => Z.dayKey(b.time) === day);
    return {
      high: Math.max(...session.map(b => b.high)),
      low: Math.min(...session.map(b => b.low)),
      close: session[session.length - 1].close,
    };
  }

  function renderIndexPanel() {
    const chainData = state.chain;
    const idx = chainData && chainData.index;
    const price = state.lastIndexTick ? state.lastIndexTick.price : (chainData ? chainData.spot : null);
    const previousClose = idx ? idx.previousClose : null;
    const change = (price !== null && previousClose !== null && previousClose !== undefined)
      ? price - previousClose : null;
    const pct = (change !== null && previousClose) ? 100 * change / previousClose : null;

    const derived = chainData && chainData.spotSource === 'synthetic';
    Z.setText('ix-price', Z.fmt(price), 'v big ' + (derived ? 'warn-text' : Z.signClass(change)));
    // A derived spot must never look like a quoted one. The tag sits next to
    // the number itself, not only in a tooltip that has to be hunted for.
    Z.setText('spot-source', derived ? 'derived' : '', 'pill ' + (derived ? 'warn' : 'hidden'));

    if (price === null && state.status && state.status.spotProblem) {
      // The header carries the reason inline as well as in the toast: a toast
      // that has already faded leaves the same blank number behind.
      Z.setText('ix-change', state.status.spotProblem, 'sub warn-text');
    } else if (derived) {
      Z.setText('ix-change', 'put-call parity — the index cannot be quoted on this account',
        'sub warn-text');
    } else {
      Z.setText('ix-change', Z.fmtSigned(change) + '  ' + Z.fmtSigned(pct, 2) + '%',
        'sub ' + Z.signClass(change));
    }
    Z.setText('ix-open', Z.fmt(idx ? idx.open : null));
    Z.setText('ix-high', Z.fmt(idx ? idx.high : null));
    Z.setText('ix-low', Z.fmt(idx ? idx.low : null));
    Z.setText('ix-prev', Z.fmt(previousClose));
    Z.setText('ix-range', idx && idx.high != null && idx.low != null
      ? Z.fmt(idx.low) + ' – ' + Z.fmt(idx.high) : '—');

    const computed = indexChart && indexChart.computed;
    const last = indexChart && indexChart.bars.length ? indexChart.bars.length - 1 : null;
    Z.setText('ix-vwap', computed && last !== null ? Z.fmt(computed.vwap[last]) : '—');
    Z.setText('ix-ticks', indexChart && last !== null ? Z.fmtInt(indexChart.bars[last].volume) : '—');

    // Trend from the SuperTrend direction on the chart's own timeframe. It is a
    // description of this chart, not the engine's verdict — the engine's trend
    // filter runs on its own series and is shown on the dashboard.
    let trend = '—';
    let cls = 'v';
    if (computed && last !== null && computed.supertrend.direction[last] !== null) {
      const up = computed.supertrend.direction[last] > 0;
      trend = up ? 'up' : 'down';
      cls = 'v ' + (up ? 'up' : 'down');
    }
    Z.setText('ix-trend', trend, cls);
  }

  /* --------------------------------------------------------- module two   */

  function renderSummary() {
    const data = state.chain;
    if (!data || !data.summary) return;
    const s = data.summary;
    const set = (id, value, cls) => Z.setText(id, value, cls);

    set('sm-spot', Z.fmt(data.spot));
    set('sm-atm', Z.fmtInt(s.atmStrike));
    set('sm-expiry', data.expiry || '—');
    set('sm-lot', Z.fmtInt(s.lotSize));
    set('sm-vix', Z.fmt(s.vix));

    /* --- what an ltp-only account CAN compute ---------------------------- */

    set('sm-straddle', s.atmStraddle === null || s.atmStraddle === undefined
      ? '—' : Z.fmt(s.atmStraddle));
    Z.setText('sm-straddle-legs',
      (s.atmCall == null || s.atmPut == null) ? ''
        : 'CE ' + Z.fmt(s.atmCall) + ' + PE ' + Z.fmt(s.atmPut));

    set('sm-move', s.expectedMovePct == null ? '—'
      : '±' + (s.expectedMovePct * 100).toFixed(2) + '%');
    Z.setText('sm-move-range',
      (s.expectedMoveLow == null || s.expectedMoveHigh == null) ? ''
        : Z.fmtInt(s.expectedMoveLow) + ' – ' + Z.fmtInt(s.expectedMoveHigh));

    set('sm-iv', s.atmIv == null ? '—' : s.atmIv.toFixed(1) + '%');
    // Positive skew is the normal state, so it is not coloured as "good" or
    // "bad" — only signed, so an inversion is visible at a glance.
    set('sm-skew', s.ivSkew == null ? '—'
      : (s.ivSkew >= 0 ? '+' : '') + s.ivSkew.toFixed(1),
    'v ' + (s.ivSkew == null ? '' : (s.ivSkew < 0 ? 'down' : '')));

    Z.setText('sm-dte', s.daysToExpiry == null ? ''
      : (s.daysToExpiry < 1
        ? (s.daysToExpiry * 24).toFixed(1) + 'h to expiry'
        : s.daysToExpiry.toFixed(1) + 'd to expiry'));

    // HIDE what this entitlement cannot produce. A tile showing an em-dash
    // forever is worse than no tile: it reads as "the market has no open
    // interest today" rather than as "this account is not sent open interest".
    const have = s.available || {};
    document.querySelectorAll('.tiles .tile[data-need]').forEach(function (tile) {
      tile.classList.toggle('hidden', have[tile.getAttribute('data-need')] !== true);
    });
    set('sm-pcr', Z.fmt(s.pcr, 2), 'v ' + (s.pcr === null ? '' : s.pcr > 1 ? 'up' : 'down'));
    set('sm-maxpain', Z.fmtInt(s.maxPain));
    set('sm-calloi', Z.fmtCompact(s.totalCallOi));
    set('sm-putoi', Z.fmtCompact(s.totalPutOi));
    set('sm-netoi', Z.fmtCompact(s.netOi), 'v ' + Z.signClass(s.netOi));

    // The banner is the honest half of this screen: it says which columns are
    // real before an operator reads a number off one that is not.
    const cover = data.coverage || {};

    // The Index panel's OHLC rows, by the same rule as the tiles.
    document.querySelectorAll('#ix-stats [data-need]').forEach(function (node) {
      node.classList.toggle('hidden', cover[node.getAttribute('data-need')] !== true);
    });

    const missing = ['oi', 'volume', 'bid', 'ask'].filter(f => cover[f] === false);
    const banner = Z.el('coverage');
    if (!banner) return;
    const parts = [];
    if (missing.length) {
      parts.push('Kotak is not sending <b>' + missing.join(', ') + '</b> on this account, '
        + 'so those columns show — rather than 0.');
    }
    if (data.oiChangeSource === 'session') {
      parts.push('“Chg OI” is measured from the first snapshot this session, not from '
        + 'yesterday’s close — the broker sends no previous-day open interest.');
    }
    parts.push('IV and all greeks are <b>modelled</b> from the last traded price; Kotak sends none.');
    banner.innerHTML = parts.join(' ');
    banner.classList.toggle('warn', missing.length > 0);
  }

  /* -------------------------------------------------------- module three  */

  async function selectContract(contract) {
    state.contract = contract;
    chain.select(contract.token);
    premium.setContract(contract);
    socket.emit('terminal:option', { token: contract.token });

    Z.setText('pm-title', contract.label || (contract.strike + ' ' + contract.type));
    Z.el('premium-empty').classList.add('hidden');
    Z.el('premium-live').classList.remove('hidden');

    try {
      const body = await Z.api('/api/option/chart/history', {
        symbol: state.symbol,
        strike: contract.strike,
        expiry: contract.expiry,
        type: contract.type,
        timeframe: state.premiumTimeframe,
        limit: 400,
      });
      premiumChart.setTimeframe(state.premiumTimeframe);
      premiumChart.setBars(body.candles);
      premium.setBars(premiumChart.bars, premiumChart.computed);
      if (body.note) Z.notify(body.note, 'warn');
    } catch (err) {
      Z.notify('Premium history: ' + err.message, 'bad');
      premiumChart.setBars([]);
    }
    refreshTradeOverlay();
  }

  // The engine's own working levels for this contract, if it happens to be
  // holding one. Read-only: the terminal draws what the engine did, it does not
  // and cannot change it.
  async function refreshTradeOverlay() {
    if (!state.contract || !premiumChart) return;
    try {
      const body = await Z.api('/api/status');
      const leg = (body.legs || []).find(l =>
        l.symbol === state.contract.label
        || (Number(l.strike) === Number(state.contract.strike) && l.optionType === state.contract.type));
      if (!leg) { premiumChart.setTradeOverlay({}); return; }
      const rupees = (p) => (p === null || p === undefined ? null : p / 100);
      premiumChart.setTradeOverlay({
        entry: rupees(leg.sellP),
        average: rupees(leg.filledP),
        target: rupees(leg.targetP),
        stopLoss: rupees(leg.slP),
      });
      Z.setText('pm-position', leg.state + (leg.filledP ? ' @ ' + Z.fmt(leg.filledP / 100) : ''));
    } catch (_) {
      // The status endpoint failing is not worth a toast on a market screen —
      // the overlay is a convenience, not the point of the page.
    }
  }

  /* ------------------------------------------------------------- sockets */

  function connect() {
    socket = window.io();

    socket.on('connect', () => {
      socket.emit('terminal:join', { symbol: state.symbol, range: state.range }, (ack) => {
        if (ack && !ack.ok) Z.notify(ack.error || 'the market feed did not start', 'bad');
      });
      Z.setText('feed', 'connecting…', 'pill');
    });

    socket.on('disconnect', () => Z.setText('feed', 'disconnected', 'pill bad'));

    socket.on('terminal_error', (e) => Z.notify(e.message, 'bad'));

    socket.on('terminal_status', (s) => {
      state.status = s;
      const healthy = s.running && !s.authFailed && s.lastChainAgeMs !== null && s.lastChainAgeMs < 5000;
      Z.setText('feed', s.authFailed ? 'session expired'
        : !s.running ? 'stopped'
          : healthy ? ((s.ticker && s.ticker.source) || 'live') : 'stale',
      'pill ' + (s.authFailed ? 'bad' : healthy ? 'ok' : 'warn'));
      Z.el('feed').title = s.lastError || '';
      if (s.expiry && s.expiry !== state.expiry) {
        state.expiry = s.expiry;
        renderExpiries(s);
      }
      // A blank price with no explanation is the worst thing this page can do.
      // The feed knows exactly why it has no spot, so it is said out loud —
      // once per distinct reason, not once a second.
      if (s.spotProblem && s.spotProblem !== state.lastSpotProblem) {
        state.lastSpotProblem = s.spotProblem;
        Z.notify('No spot price: ' + s.spotProblem, 'bad');
      } else if (!s.spotProblem) {
        state.lastSpotProblem = null;
      }
      renderIndexPanel();
    });

    socket.on('index_tick', (t) => {
      state.lastIndexTick = t;
      indexChart.pushTick(t.price, Math.floor(t.time / 1000));
      renderIndexPanel();
    });

    socket.on('option_tick', (t) => {
      if (!state.contract || t.token !== state.contract.token) return;
      premiumChart.pushTick(t.price, Math.floor(t.time / 1000));
    });

    socket.on('option_chain_update', (payload) => {
      state.chain = payload;
      state.expiry = payload.expiry;
      chain.update(payload);
      renderSummary();
      renderIndexPanel();
      renderExpiries(payload);
      if (state.contract) {
        for (const row of payload.rows) {
          for (const side of ['call', 'put']) {
            if (row[side] && row[side].token === state.contract.token) {
              premium.setQuote(row[side]);
              premium.setBars(premiumChart.bars, premiumChart.computed);
            }
          }
        }
      }
    });
  }

  function renderExpiries(source) {
    const host = Z.el('expiry');
    const list = source.expiries || [];
    if (!list.length || host.dataset.filled === list.join(',')) return;
    host.dataset.filled = list.join(',');
    host.innerHTML = list.map(e =>
      '<option value="' + e + '"' + (e === state.expiry ? ' selected' : '') + '>' + e + '</option>')
      .join('');
  }

  /* ---------------------------------------------------------- market clock */

  // 09:15–15:30 IST on a weekday. Exchange holidays are not known here, and the
  // header says PRE-OPEN / OPEN / CLOSED rather than claiming the market is
  // trading — the feed going quiet is the authoritative signal and it has its
  // own pill.
  function renderClock() {
    const now = Math.floor(Date.now() / 1000);
    const ist = new Date((now + Z.IST_OFFSET_S) * 1000);
    const weekday = ist.getUTCDay();
    const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    let status = 'CLOSED';
    let cls = 'pill';
    if (weekday >= 1 && weekday <= 5) {
      if (minutes >= 9 * 60 && minutes < 9 * 60 + 15) { status = 'PRE-OPEN'; cls = 'pill warn'; }
      else if (minutes >= 9 * 60 + 15 && minutes < 15 * 60 + 30) { status = 'OPEN'; cls = 'pill ok'; }
    }
    Z.setText('market', status, cls);
    Z.setText('clock', Z.istClock(now, true) + ' IST');
  }

  /* ------------------------------------------------------------ shortcuts */

  function bindShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = document.activeElement && document.activeElement.closest
        ? document.activeElement.closest('.pane-premium') : null;
      const chartFor = target ? premiumChart : indexChart;

      if (e.key === '+' || e.key === '=') { chartFor.zoom(0.8); e.preventDefault(); }
      else if (e.key === '-' || e.key === '_') { chartFor.zoom(1.25); e.preventDefault(); }
      else if (e.key === 'r' || e.key === 'R') { chartFor.reset(); e.preventDefault(); }
      else if (e.key === ' ') {
        state.paused = !state.paused;
        indexChart.setPaused(state.paused);
        premiumChart.setPaused(state.paused);
        Z.setText('paused', state.paused ? 'PAUSED' : '', 'pill ' + (state.paused ? 'warn' : 'hidden'));
        e.preventDefault();
      }
    });
  }

  /* ----------------------------------------------------------------- boot */

  function buildToolbars() {
    segmented(Z.el('tf-index'), TIMEFRAMES, state.indexTimeframe, async (tf) => {
      state.indexTimeframe = tf;
      Z.store.set('tf.index', tf);
      await loadIndexHistory();
    });
    segmented(Z.el('type-index'), CHART_TYPES, Z.store.get('type.index', 'candles'), (t) => {
      Z.store.set('type.index', t);
      indexChart.setType(t);
    });
    checkboxes(Z.el('ind-index'), INDEX_INDICATORS, (n) => indexChart.isOn(n), (n, on) => {
      indexChart.toggle(n, on);
      Z.store.set('ind.index', [...indexChart.enabled]);
      renderIndexPanel();
    });

    segmented(Z.el('tf-premium'), TIMEFRAMES.slice(0, 8), state.premiumTimeframe, async (tf) => {
      state.premiumTimeframe = tf;
      Z.store.set('tf.premium', tf);
      if (state.contract) await selectContract(state.contract);
    });
    segmented(Z.el('type-premium'), CHART_TYPES, Z.store.get('type.premium', 'candles'), (t) => {
      Z.store.set('type.premium', t);
      premiumChart.setType(t);
    });
    checkboxes(Z.el('ind-premium'), PREMIUM_INDICATORS, (n) => premiumChart.isOn(n), (n, on) => {
      premiumChart.toggle(n, on);
      Z.store.set('ind.premium', [...premiumChart.enabled]);
    });

    // Drawing tools belong to the index chart — module 3's chart is a read-out,
    // and giving both a tool palette doubles the toolbar for a feature nobody
    // uses on a two-minute option series.
    const tools = Z.el('tools');
    tools.innerHTML = Z.DRAW_TOOLS.map(t =>
      '<button type="button" class="seg' + (t.id === 'cursor' ? ' on' : '') + '" data-v="' + t.id
      + '" title="' + t.hint + '">' + t.label + '</button>').join('')
      + '<button type="button" class="seg ghost" data-act="undo">Undo</button>'
      + '<button type="button" class="seg ghost" data-act="clear">Clear</button>';
    tools.onclick = (e) => {
      const button = e.target.closest('button');
      if (!button) return;
      if (button.dataset.act === 'undo') { indexChart.drawings.undo(); return; }
      if (button.dataset.act === 'clear') { indexChart.drawings.clear(); return; }
      for (const b of tools.querySelectorAll('button[data-v]')) b.classList.toggle('on', b === button);
      indexChart.drawings.setTool(button.dataset.v);
    };
    // One shape per arming, so the palette snaps back to the cursor and the
    // chart is pannable again without a second click.
    Z.on('drawing:done', () => {
      indexChart.drawings.setTool('cursor');
      for (const b of tools.querySelectorAll('button[data-v]')) {
        b.classList.toggle('on', b.dataset.v === 'cursor');
      }
    });

    // Offered widths, capped by TERMINAL_MAX_RANGE — the API clamps anything
    // wider, and a button that silently does something else is worse than a
    // button that is not there. The configured default is always offered.
    const widths = [...new Set([5, 10, 20, state.range]
      .filter(n => n <= MAX_RANGE))].sort((a, b) => a - b);
    segmented(Z.el('range'), widths.map(n => ({ id: String(n), label: '±' + n })),
      String(state.range), (v) => {
        state.range = Number(v);
        socket.emit('terminal:chain', { expiry: state.expiry, range: state.range });
      });

    Z.el('expiry').onchange = (e) => {
      state.expiry = e.target.value;
      socket.emit('terminal:chain', { expiry: state.expiry, range: state.range });
    };

    // Chain column groups. Built by hand rather than through `checkboxes()`
    // because these labels come from the chain module, not the indicator list.
    const groupHost = Z.el('chain-groups');
    groupHost.innerHTML = Object.entries(Z.CHAIN_GROUPS)
      .filter(([, g]) => !g.locked)
      .map(([id, g]) => '<label class="chk"><input type="checkbox" data-v="' + id + '"'
        + (chain.groups.includes(id) ? ' checked' : '') + '> ' + g.label + '</label>').join('');
    groupHost.onchange = () => {
      const on = [...groupHost.querySelectorAll('input:checked')].map(i => i.dataset.v);
      chain.setGroups(['core'].concat(on));
    };
    for (const node of Z.el('chain-filters').querySelectorAll('[data-filter]')) {
      const key = node.dataset.filter;
      if (node.type === 'checkbox') node.checked = Boolean(chain.filters[key]);
      else node.value = chain.filters[key] === undefined ? '' : chain.filters[key];
      node.addEventListener('change', () => {
        const value = node.type === 'checkbox' ? node.checked
          : node.type === 'number' ? Number(node.value || 0) : node.value;
        chain.setFilter({ [key]: value });
      });
    }
    segmented(Z.el('chain-sort'),
      Object.entries(Z.CHAIN_SORTS).map(([id, s]) => ({ id, label: s.label })),
      chain.sort, (v) => chain.setSort(v));

    Z.el('theme').onclick = () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      Z.setTheme(next);
    };

    // The header search: a strike number jumps the chain to it and charts the
    // call; "18500pe" charts the put.
    Z.el('search').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const raw = String(e.target.value || '').trim().toUpperCase();
      const m = /^(\d+(?:\.\d+)?)\s*(CE|PE|C|P)?$/.exec(raw);
      if (!m || !state.chain) { Z.notify('Type a strike, e.g. 24500 or 24500PE', 'warn'); return; }
      const strike = Number(m[1]);
      const type = (m[2] === 'PE' || m[2] === 'P') ? 'PE' : 'CE';
      const row = state.chain.rows.find(r => Number(r.strike) === strike);
      if (!row) { Z.notify('Strike ' + strike + ' is not in the current window', 'warn'); return; }
      const leg = type === 'PE' ? row.put : row.call;
      if (!leg) { Z.notify('No ' + type + ' at ' + strike, 'warn'); return; }
      selectContract({ token: leg.token, label: leg.symbol, strike, type, expiry: state.chain.expiry });
      e.target.blur();
    });
  }

  function boot() {
    Z.initTheme();

    indexChart = new Z.PriceChart({
      container: Z.el('chart-index'),
      legend: Z.el('legend-index'),
      name: 'index',
      timeframe: state.indexTimeframe,
      type: Z.store.get('type.index', 'candles'),
      precision: 2,
      minMove: 0.05,
      indicators: Z.store.get('ind.index', ['ema20', 'vwap', 'volume']),
      drawKey: 'draw.index',
    });

    premiumChart = new Z.PriceChart({
      container: Z.el('chart-premium'),
      legend: Z.el('legend-premium'),
      name: 'premium',
      timeframe: state.premiumTimeframe,
      type: Z.store.get('type.premium', 'candles'),
      precision: 2,
      minMove: 0.05,
      indicators: Z.store.get('ind.premium', ['ema9', 'ema20', 'volume']),
      drawKey: 'draw.premium',
    });

    chain = new Z.OptionChain({ host: Z.el('chain'), onSelect: selectContract });
    premium = new Z.PremiumPanel({
      info: Z.el('pm-info'),
      stats: Z.el('pm-stats'),
      greeks: Z.el('pm-greeks'),
      patterns: Z.el('pm-patterns'),
      volume: Z.el('pm-volume'),
      alerts: Z.el('pm-alerts'),
    });

    connect();
    buildToolbars();
    bindShortcuts();
    loadIndexHistory();

    renderClock();
    setInterval(renderClock, 1000);
    // The engine's levels change on its own clock, not on ours.
    setInterval(refreshTradeOverlay, 5000);

    window.addEventListener('beforeunload', () => {
      try { socket.emit('terminal:leave'); } catch (_) { /* closing anyway */ }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}(window.Z));
