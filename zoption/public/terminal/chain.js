// Module 2 — the live option chain.
//
// One table, rebuilt once a second. Three decisions shape the whole thing:
//
// 1. AN EM-DASH IS NOT A ZERO. Kotak's quote endpoint may refuse every filter
//    richer than `ltp`, in which case open interest, volume and the spread never
//    arrive. Those columns render as `—` and their headers are struck through,
//    and the banner above the table says which fields the broker is actually
//    sending. A chain that printed 0 OI would look like a strike nobody holds.
//
// 2. THE GREEKS ARE MODELLED, NOT QUOTED. Every IV and greek in this table is
//    solved from the last traded price by the server (src/market/greeks.js).
//    On a far strike whose last print was twenty minutes ago they describe
//    twenty minutes ago. The header says so once rather than the table
//    pretending otherwise.
//
// 3. INNERHTML, ONCE PER REFRESH. Forty rows of thirty cells is 1,200 nodes; a
//    per-cell diff would be more code and no faster at a one-second cadence.
//    The one piece of state that must survive the rebuild — which row is
//    selected — is reapplied after the write.

window.Z = window.Z || {};

(function (Z) {
  'use strict';

  // Column groups, because the specification's full column list is 29 wide and
  // does not fit a laptop. Greeks and value columns fold away; the ones a seller
  // reads at a glance never do.
  const GROUPS = {
    core: { label: 'Core', locked: true },
    quote: { label: 'Bid / Ask' },
    greeks: { label: 'Greeks' },
    value: { label: 'Intrinsic / Time' },
    rho: { label: 'Rho' },
  };

  const SORTS = {
    strike: { label: 'Strike', pick: (r) => r.strike, dir: 1 },
    volume: { label: 'Volume', pick: (r) => max(r, 'volume'), dir: -1 },
    oi: { label: 'OI', pick: (r) => max(r, 'oi'), dir: -1 },
    iv: { label: 'IV', pick: (r) => max(r, 'iv'), dir: -1 },
    theta: { label: 'Theta', pick: (r) => min(r, 'theta'), dir: 1 },
  };

  function max(row, field) {
    const a = row.call ? row.call[field] : null;
    const b = row.put ? row.put[field] : null;
    if (a === null && b === null) return null;
    return Math.max(a === null ? -Infinity : a, b === null ? -Infinity : b);
  }
  function min(row, field) {
    const a = row.call ? row.call[field] : null;
    const b = row.put ? row.put[field] : null;
    if (a === null && b === null) return null;
    return Math.min(a === null ? Infinity : a, b === null ? Infinity : b);
  }

  const BUILDUP_SHORT = {
    LONG_BUILDUP: 'LB', SHORT_BUILDUP: 'SB',
    SHORT_COVERING: 'SC', LONG_UNWINDING: 'LU', FLAT: '',
  };
  const BUILDUP_TITLE = {
    LONG_BUILDUP: 'Long build-up — price up, open interest up',
    SHORT_BUILDUP: 'Short build-up — price down, open interest up',
    SHORT_COVERING: 'Short covering — price up, open interest down',
    LONG_UNWINDING: 'Long unwinding — price down, open interest down',
    FLAT: 'No meaningful change',
  };

  class OptionChain {
    constructor(opts) {
      this.host = opts.host;
      this.onSelect = opts.onSelect || (() => {});
      this.data = null;
      this.selectedToken = null;

      this.groups = Z.store.get('chain.groups', ['core', 'greeks']) || ['core', 'greeks'];
      this.filters = Z.store.get('chain.filters', {
        hideZeroVolume: false,
        hideDeepOtm: false,
        moneyness: 'ALL',
        minOi: 0,
        minVolume: 0,
      });
      this.sort = Z.store.get('chain.sort', 'strike') || 'strike';
      // Volume spike, as a multiple of the chain's median volume. A strike doing
      // four times what the median strike is doing is the definition used
      // throughout this file.
      this.spikeMultiple = 4;
    }

    setGroups(list) { this.groups = list; Z.store.set('chain.groups', list); this.render(); }

    setFilter(patch) {
      Object.assign(this.filters, patch);
      Z.store.set('chain.filters', this.filters);
      this.render();
    }

    setSort(key) {
      this.sort = SORTS[key] ? key : 'strike';
      Z.store.set('chain.sort', this.sort);
      this.render();
    }

    update(payload) {
      this.data = payload;
      this.render();
    }

    select(token) {
      this.selectedToken = token;
      this._applySelection();
    }

    /* --------------------------------------------------------- filtering -- */

    _visibleRows() {
      const data = this.data;
      if (!data || !data.rows) return [];
      const f = this.filters;
      const spot = data.spot;
      const step = data.strikeStep || 50;

      let rows = data.rows.slice();

      if (f.moneyness && f.moneyness !== 'ALL') {
        rows = rows.filter(r => {
          const c = r.call && r.call.moneyness;
          const p = r.put && r.put.moneyness;
          return c === f.moneyness || p === f.moneyness;
        });
      }
      if (f.hideDeepOtm && spot != null) {
        // "Deep" is more than ten strikes from the money. Beyond that a NIFTY
        // weekly is usually a tick-floor quote whose greeks are unsolvable
        // anyway — see the null-IV note in src/market/greeks.js.
        rows = rows.filter(r => Math.abs(r.strike - spot) <= step * 10);
      }
      if (f.hideZeroVolume) {
        rows = rows.filter(r => {
          const v = max(r, 'volume');
          // A null volume means the broker sends none. Hiding every row then
          // would empty the table, which reads as "no options trade today".
          return v === null || v > 0;
        });
      }
      if (Number(f.minOi) > 0) rows = rows.filter(r => { const v = max(r, 'oi'); return v === null || v >= Number(f.minOi); });
      if (Number(f.minVolume) > 0) rows = rows.filter(r => { const v = max(r, 'volume'); return v === null || v >= Number(f.minVolume); });

      const sort = SORTS[this.sort] || SORTS.strike;
      rows.sort((a, b) => {
        const av = sort.pick(a);
        const bv = sort.pick(b);
        // Rows with nothing to sort on sink to the bottom rather than to the
        // top, where they would push the interesting strikes off the screen.
        if (av === null && bv === null) return a.strike - b.strike;
        if (av === null) return 1;
        if (bv === null) return -1;
        if (av === bv) return a.strike - b.strike;
        return (av - bv) * sort.dir;
      });
      return rows;
    }

    _medianVolume(rows) {
      const values = [];
      for (const r of rows) {
        for (const side of ['call', 'put']) {
          const v = r[side] && r[side].volume;
          if (v !== null && v !== undefined && v > 0) values.push(v);
        }
      }
      if (!values.length) return null;
      values.sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    }

    /* ------------------------------------------------------------ render -- */

    render() {
      if (!this.data) {
        this.host.innerHTML = '<p class="muted pad">Waiting for the option chain…</p>';
        return;
      }
      const rows = this._visibleRows();
      const cover = this.data.coverage || {};
      const ex = (this.data.summary && this.data.summary.extremes) || {};
      const median = this._medianVolume(rows);
      const on = (g) => this.groups.includes(g) || GROUPS[g].locked;

      const head = this._header(on, cover);
      const body = rows.map(r => this._row(r, on, cover, ex, median)).join('');

      this.host.innerHTML =
        '<table class="chain">' + head + '<tbody>' + (body
          || '<tr><td colspan="40" class="muted pad">No strike matches these filters.</td></tr>')
        + '</tbody></table>';

      this._bindRows();
      this._applySelection();
    }

    _th(label, field, cover, extra) {
      const dead = cover && field && cover[field] === false;
      return '<th class="' + (dead ? 'dead' : '') + (extra ? ' ' + extra : '') + '"'
        + (dead ? ' title="the broker does not send this field on this account"' : '')
        + '>' + label + '</th>';
    }

    _header(on, cover) {
      const call = [];
      const put = [];
      call.push(this._th('OI', 'oi', cover));
      call.push(this._th('Chg OI', 'oiChange', cover));
      call.push(this._th('Vol', 'volume', cover));
      call.push(this._th('IV', null, cover));
      if (on('greeks')) {
        call.push(this._th('Δ', null, cover));
        call.push(this._th('Γ', null, cover));
        call.push(this._th('Θ', null, cover));
        call.push(this._th('V', null, cover));
      }
      if (on('rho')) call.push(this._th('ρ', null, cover));
      if (on('value')) {
        call.push(this._th('Intr', null, cover));
        call.push(this._th('TV', null, cover));
      }
      if (on('quote')) {
        call.push(this._th('Bid', 'bid', cover));
        call.push(this._th('Ask', 'ask', cover));
      }
      call.push(this._th('LTP', 'ltp', cover, 'ltp'));
      call.push(this._th('Chg', null, cover));

      put.push(this._th('Chg', null, cover));
      put.push(this._th('LTP', 'ltp', cover, 'ltp'));
      if (on('quote')) {
        put.push(this._th('Bid', 'bid', cover));
        put.push(this._th('Ask', 'ask', cover));
      }
      if (on('value')) {
        put.push(this._th('Intr', null, cover));
        put.push(this._th('TV', null, cover));
      }
      if (on('rho')) put.push(this._th('ρ', null, cover));
      if (on('greeks')) {
        put.push(this._th('V', null, cover));
        put.push(this._th('Θ', null, cover));
        put.push(this._th('Γ', null, cover));
        put.push(this._th('Δ', null, cover));
      }
      put.push(this._th('IV', null, cover));
      put.push(this._th('Vol', 'volume', cover));
      put.push(this._th('Chg OI', 'oiChange', cover));
      put.push(this._th('OI', 'oi', cover));

      return '<thead>'
        + '<tr class="side-row">'
        + '<th colspan="' + call.length + '" class="side call">CALLS</th>'
        + '<th class="strike-head">Strike</th>'
        + '<th colspan="' + put.length + '" class="side put">PUTS</th>'
        + '</tr>'
        + '<tr>' + call.join('') + '<th class="strike-head">PCR</th>' + put.join('') + '</tr>'
        + '</thead>';
    }

    _row(row, on, cover, ex, median) {
      const spot = this.data.spot;
      const atm = this.data.summary ? this.data.summary.atmStrike : null;
      const isAtm = atm !== null && row.strike === atm;

      const cells = [];
      const c = row.call || {};
      const p = row.put || {};

      const cell = (value, cls, title) => '<td class="' + (cls || '') + '"'
        + (title ? ' title="' + Z.escapeHtml(title) + '"' : '') + '>' + value + '</td>';

      // --- calls, read right-to-left toward the strike ----------------------
      cells.push(cell(Z.fmtCompact(c.oi), 'num oi ' + this._heat('callOi', row.strike, ex)));
      cells.push(cell(Z.fmtCompact(c.oiChange), 'num ' + Z.signClass(c.oiChange)
        + this._flag('callOiChange', row.strike, ex),
      c.buildup ? BUILDUP_TITLE[c.buildup] : ''));
      cells.push(cell(Z.fmtCompact(c.volume), 'num ' + this._volumeClass(c.volume, median, 'callVolume', row.strike, ex)));
      cells.push(cell(Z.fmt(c.iv, 1), 'num' + this._flag('callIv', row.strike, ex)));
      if (on('greeks')) {
        cells.push(cell(Z.fmt(c.delta, 3), 'num dim'));
        cells.push(cell(Z.fmt(c.gamma, 4), 'num dim' + this._flag('callGamma', row.strike, ex)));
        cells.push(cell(Z.fmt(c.theta, 2), 'num dim' + this._flag('callTheta', row.strike, ex)));
        cells.push(cell(Z.fmt(c.vega, 3), 'num dim'));
      }
      if (on('rho')) cells.push(cell(Z.fmt(c.rho, 4), 'num dim'));
      if (on('value')) {
        cells.push(cell(Z.fmt(c.intrinsic), 'num dim'));
        cells.push(cell(Z.fmt(c.timeValue), 'num dim'));
      }
      if (on('quote')) {
        cells.push(cell(Z.fmt(c.bid), 'num dim'));
        cells.push(cell(Z.fmt(c.ask), 'num dim'));
      }
      cells.push(cell(Z.fmt(c.ltp), 'num ltp ' + this._moneyClass(c.moneyness), 'click to chart this contract'));
      cells.push(cell(Z.fmt(c.changePct, 1), 'num ' + Z.signClass(c.change)));

      const strikeCell = '<td class="strike ' + (isAtm ? 'atm' : '') + '">'
        + '<b>' + Z.fmtInt(row.strike) + '</b>'
        + (row.pcr === null || row.pcr === undefined ? '' : '<span class="pcr">' + Z.fmt(row.pcr, 2) + '</span>')
        + '</td>';

      const puts = [];
      puts.push(cell(Z.fmt(p.changePct, 1), 'num ' + Z.signClass(p.change)));
      puts.push(cell(Z.fmt(p.ltp), 'num ltp ' + this._moneyClass(p.moneyness), 'click to chart this contract'));
      if (on('quote')) {
        puts.push(cell(Z.fmt(p.bid), 'num dim'));
        puts.push(cell(Z.fmt(p.ask), 'num dim'));
      }
      if (on('value')) {
        puts.push(cell(Z.fmt(p.intrinsic), 'num dim'));
        puts.push(cell(Z.fmt(p.timeValue), 'num dim'));
      }
      if (on('rho')) puts.push(cell(Z.fmt(p.rho, 4), 'num dim'));
      if (on('greeks')) {
        puts.push(cell(Z.fmt(p.vega, 3), 'num dim'));
        puts.push(cell(Z.fmt(p.theta, 2), 'num dim' + this._flag('putTheta', row.strike, ex)));
        puts.push(cell(Z.fmt(p.gamma, 4), 'num dim' + this._flag('putGamma', row.strike, ex)));
        puts.push(cell(Z.fmt(p.delta, 3), 'num dim'));
      }
      puts.push(cell(Z.fmt(p.iv, 1), 'num' + this._flag('putIv', row.strike, ex)));
      puts.push(cell(Z.fmtCompact(p.volume), 'num ' + this._volumeClass(p.volume, median, 'putVolume', row.strike, ex)));
      puts.push(cell(Z.fmtCompact(p.oiChange), 'num ' + Z.signClass(p.oiChange)
        + this._flag('putOiChange', row.strike, ex),
      p.buildup ? BUILDUP_TITLE[p.buildup] : ''));
      puts.push(cell(Z.fmtCompact(p.oi), 'num oi ' + this._heat('putOi', row.strike, ex)));

      const writing = row.writing
        ? ' w-' + row.writing.toLowerCase().replace('_', '-')
        : '';
      const near = spot != null && Math.abs(row.strike - spot) <= (this.data.strikeStep || 50)
        ? ' near' : '';

      return '<tr class="' + (isAtm ? 'row-atm' : '') + writing + near + '"'
        + ' data-strike="' + row.strike + '"'
        + ' data-call="' + (c.token || '') + '" data-put="' + (p.token || '') + '"'
        + ' data-call-label="' + Z.escapeHtml(c.symbol || '') + '"'
        + ' data-put-label="' + Z.escapeHtml(p.symbol || '') + '"'
        + ' data-buildup="' + (c.buildup || '') + '/' + (p.buildup || '') + '">'
        + cells.join('') + strikeCell + puts.join('') + '</tr>';
    }

    // The heat map from the specification: dark red on the call wall, dark green
    // on the put wall. Only the single largest strike is painted — shading every
    // large value produces a gradient the eye cannot rank.
    _heat(key, strike, ex) {
      return ex[key] === strike ? (key === 'callOi' ? 'heat-call' : 'heat-put') : '';
    }

    _flag(key, strike, ex) {
      return ex[key] === strike ? ' top' : '';
    }

    _volumeClass(volume, median, key, strike, ex) {
      if (ex[key] === strike) return 'heat-vol';
      if (volume === null || volume === undefined || !median) return '';
      return volume >= median * this.spikeMultiple ? 'spike' : '';
    }

    _moneyClass(m) {
      return m === 'ITM' ? 'itm' : m === 'ATM' ? 'atm-cell' : m === 'OTM' ? 'otm' : '';
    }

    /* -------------------------------------------------------- interaction */

    _bindRows() {
      for (const tr of this.host.querySelectorAll('tbody tr[data-strike]')) {
        tr.addEventListener('click', (e) => {
          const cell = e.target.closest('td');
          if (!cell) return;
          const cells = [...tr.children];
          const index = cells.indexOf(cell);
          const strikeIndex = cells.findIndex(td => td.classList.contains('strike'));
          // Which half of the row was clicked decides which contract charts.
          // Clicking the strike itself picks the call, which is the convention
          // every Indian chain screen uses.
          const isPut = index > strikeIndex;
          const token = isPut ? tr.dataset.put : tr.dataset.call;
          const label = isPut ? tr.dataset.putLabel : tr.dataset.callLabel;
          if (!token) return;
          this.onSelect({
            token,
            label,
            strike: Number(tr.dataset.strike),
            type: isPut ? 'PE' : 'CE',
            expiry: this.data.expiry,
          });
        });
      }
    }

    _applySelection() {
      for (const tr of this.host.querySelectorAll('tbody tr')) {
        const isSelected = this.selectedToken
          && (tr.dataset.call === this.selectedToken || tr.dataset.put === this.selectedToken);
        tr.classList.toggle('selected', Boolean(isSelected));
        tr.classList.toggle('sel-put', Boolean(isSelected && tr.dataset.put === this.selectedToken));
      }
    }
  }

  Z.OptionChain = OptionChain;
  Z.CHAIN_GROUPS = GROUPS;
  Z.CHAIN_SORTS = SORTS;
  Z.BUILDUP_SHORT = BUILDUP_SHORT;
}(window.Z));
