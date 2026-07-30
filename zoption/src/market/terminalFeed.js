// The trading terminal's market-data feed.
//
// This runs in the WEB process, which everywhere else in this codebase is the
// process that does not talk to the broker. The boundary is still intact: the
// terminal READS quotes and never places, cancels or modifies anything. It is
// the same exception the interactive broker login already makes, for the same
// reason — the alternative is worse. Putting the feed in the engine would make
// a read-only chart depend on the trading process being up, and `npm start`
// alone would show a terminal with no prices in it.
//
// COST, stated plainly, because this is the design's one real trade-off. The
// feed opens a second market-data socket and a second quote poller against the
// same Kotak account as the engine. Kotak's rate limit is per account and the
// two processes have separate token buckets, so the budgets add rather than
// share. At the defaults that is roughly:
//
//     ticker poll    1 request/s   (index + at most one option)
//     chain poll     2 requests/s  (±10 strikes = 42 tokens, batched by 25)
//
// against NEO_RPS 8 per process. It is comfortable, but it is not free, and it
// is why the feed is LAZY: nothing starts until a browser opens the terminal,
// and everything stops IDLE_STOP_MS after the last one closes. A dashboard
// nobody is looking at costs the account nothing.
//
// What the terminal does NOT do is invent data. Kotak's Trade API has no
// historical-candles endpoint and its quote endpoint may refuse every filter
// richer than `ltp`, so charts start empty and fill in as the feed runs, and any
// column the broker will not send is reported unavailable rather than zero.

const EventEmitter = require('events');
const config = require('../config');
const logger = require('../core/logger');
const time = require('../core/time');
const repo = require('../repositories');
const { Ticker } = require('./ticker');
const { CandleBuilder } = require('./candleBuilder');
const { QuoteSource } = require('./quoteSource');
const instrumentMaster = require('./instrumentMaster');
const greeks = require('./greeks');
const analytics = require('./chainAnalytics');
const { BrokerAuthError } = require('../core/errors');

// The two series that get written to `candles`. Everything wider is rebuilt
// from these on read — see market/history.js.
const PERSIST_TIMEFRAMES = ['5s', '1m'];

// How long the feed keeps running after the last browser disconnects. Short
// enough that a closed tab stops costing quota, long enough that a page reload
// does not tear down and rebuild the socket, the candle state and the filter
// probe.
const IDLE_STOP_MS = 45000;

// India VIX is not in Kotak's F&O master and this platform never trades it, so
// it is never synced as an instrument. The quotes path accepts an index by NAME
// as readily as by token, which is enough for one number on a summary panel.
const VIX_INSTRUMENT = { token: 'India VIX', segment: 'nse_cm', byName: true };

const paise = (rupees) => (rupees == null ? null : Math.round(Number(rupees) * 100));
const rupees = (p) => (p == null ? null : Number(p) / 100);

class TerminalFeed extends EventEmitter {
  constructor({ session } = {}) {
    super();
    this.sessionService = session;

    this.running = false;
    this.viewers = new Set();
    this._idleTimer = null;

    this.underlying = 'NIFTY';
    this.expiry = null;
    this.range = config.terminal.defaultRange;

    this.indexInstrument = null;
    this.lotSize = null;
    this.strikeStep = 50;

    // token -> instrument row, for every strike currently in the window.
    this.chainInstruments = new Map();
    // token -> the last quote we received for it.
    this.quotes = new Map();
    // token -> the first open interest this process saw today. Kotak does not
    // always send a previous-day OI, and "OI change" with no baseline is the
    // column most likely to be quietly wrong — so where the broker gives no
    // baseline, one is established at the first snapshot and LABELLED as a
    // session baseline rather than passed off as the day's change.
    this.oiBaseline = new Map();
    this.baselineDate = null;

    this.spotPaise = null;
    this.vix = null;
    this.optionToken = null;

    this.ticker = null;
    this.quoteSource = null;
    this.builders = new Map();       // timeframe -> CandleBuilder
    this._pendingCandles = [];
    this._chainTimer = null;
    this._flushTimer = null;
    this._chainBusy = false;
    this._authFailed = false;
    this.lastError = null;
    this.lastChainAt = 0;
    this.stats = { chainPolls: 0, chainErrors: 0, ticks: 0, barsWritten: 0 };
  }

  /* ------------------------------------------------------------- viewers -- */

  addViewer(id) {
    this.viewers.add(id);
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (!this.running) this.start().catch(err => logger.warn('terminalFeed: start failed', { err: err.message }));
    return this.viewers.size;
  }

  // Deliberately NOT `this.running`. `start()` sets that flag on its first line
  // and then awaits a session load, so a second caller checking `running` would
  // sail past a half-built feed and reconfigure a chain that does not exist
  // yet. This promise is the only safe "is it up" for a concurrent caller.
  get startPromise() { return this._startPromise; }

  removeViewer(id) {
    this.viewers.delete(id);
    if (this.viewers.size === 0 && this.running && !this._idleTimer) {
      this._idleTimer = setTimeout(() => {
        this._idleTimer = null;
        if (this.viewers.size === 0) {
          logger.info('terminalFeed: no viewers — stopping');
          this.stop();
        }
      }, IDLE_STOP_MS);
      this._idleTimer.unref?.();
    }
    return this.viewers.size;
  }

  /* ----------------------------------------------------------- lifecycle -- */

  // Idempotent and awaitable. Two browsers opening the terminal in the same
  // second must produce one feed, and the second one must wait for the first
  // rather than reconfiguring a chain that is still being built.
  start() {
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._start().catch((err) => {
      // A failed start must not latch: the usual cause is "not logged in yet",
      // and the next attempt after a login has to be allowed to try again.
      this._startPromise = null;
      this.running = false;
      throw err;
    });
    return this._startPromise;
  }

  async _start() {
    if (this.running) return this;
    this.running = true;
    this._authFailed = false;

    await this.sessionService.load();
    if (!this.sessionService.isActive()) {
      this.lastError = 'no active Kotak session — log in on the Broker page';
      this._emitStatus();
      throw new Error(this.lastError);
    }

    this.quoteSource = new QuoteSource({
      session: this.sessionService,
      batchSize: config.neo.quoteBatch,
      label: 'terminal',
    });

    this.ticker = new Ticker({ session: this.sessionService, label: 'terminal' });
    this.ticker.on('tick', (t) => this._onTick(t));
    this.ticker.on('auth_expired', (err) => {
      this._authFailed = true;
      this.lastError = err.message;
      this._emitStatus();
    });

    for (const tf of PERSIST_TIMEFRAMES) {
      // minTicks 0: this builder feeds a CHART, not an entry. The engine refuses
      // to price an order from a thin bar; a chart that dropped thin bars would
      // simply have holes in it, which is worse than a bar an operator can see
      // is thin.
      const builder = new CandleBuilder({ timeframe: tf, minTicks: 0, clockMs: 250 });
      builder.on('candle', (bar) => this._onCandle(bar));
      builder.start();
      this.builders.set(tf, builder);
    }

    // Forced: the master may have been synced since the last time this feed ran,
    // and a boot is the right moment to pick that up.
    await this._resolveIndex(true);
    await this.setChain({ underlying: this.underlying, expiry: this.expiry, range: this.range });

    this.ticker.connect();
    this._startChainLoop();
    this._startFlushLoop();

    logger.info('terminalFeed: started', {
      underlying: this.underlying, expiry: this.expiry, strikes: this.chainInstruments.size / 2,
    });
    this._emitStatus();
    return this;
  }

  // Start if needed, point the window where the caller asked, and wait for one
  // real snapshot before answering.
  //
  // This exists so `GET /api/options/chain` works on its own — the endpoint is
  // in the specification and an operator should be able to curl it without
  // first opening the page. The HTTP caller registers as a viewer under its own
  // id, so a one-off request keeps the feed alive for the idle window and no
  // longer; it does not pin the socket open forever.
  async ensure({ viewer = 'http', underlying = this.underlying, expiry = null,
    range = this.range, timeoutMs = 5000 } = {}) {
    this.addViewer(viewer);
    // Awaits whichever start is in flight, including the one addViewer just
    // kicked off. Checking `this.running` here instead would let a second
    // caller reconfigure a feed that has not finished building.
    await this.start();

    const changed = underlying !== this.underlying
      || (expiry && expiry !== this.expiry)
      || (range && Number(range) !== this.range);
    if (changed) {
      await this.setChain({ underlying, expiry, range });
      this.lastChainAt = 0;              // the window moved; the old snapshot is not an answer
    }
    if (this.lastChainAt) return true;

    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      if (this.lastChainAt) return true;
      if (this._authFailed) return false;
      await new Promise(r => setTimeout(r, 100));
    }
    return Boolean(this.lastChainAt);
  }

  stop() {
    this.running = false;
    this._startPromise = null;         // the next viewer starts a fresh feed
    if (this._chainTimer) { clearTimeout(this._chainTimer); this._chainTimer = null; }
    if (this._flushTimer) { clearInterval(this._flushTimer); this._flushTimer = null; }
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    for (const b of this.builders.values()) b.stop();
    this.builders.clear();
    try { this.ticker?.close(); } catch (_) { /* already gone */ }
    this.ticker = null;
    this.quoteSource = null;
    // The last flush is awaited by nobody on purpose: losing the final partial
    // bar of a session the operator has stopped watching is not worth blocking
    // a shutdown for.
    this._flush().catch(() => {});
    this._emitStatus();
  }

  /* ------------------------------------------------------- instrument set -- */

  // The index row has no `underlying` column of its own, so which one it was
  // resolved for is remembered here. Without that there is no way to notice a
  // stale instrument after an underlying change, and the terminal would draw
  // NIFTY's spot on a BANKNIFTY chain.
  async _resolveIndex(force = false) {
    if (!force && this.indexInstrument && this._indexFor === this.underlying) return;
    this.indexInstrument = await instrumentMaster.indexInstrument(this.underlying);
    this._indexFor = this.underlying;
    if (!this.indexInstrument) {
      this.lastError = `no index instrument for ${this.underlying} — sync the instrument master`;
      logger.warn('terminalFeed: ' + this.lastError);
    }
  }

  // Choose the strike window and subscribe to it. Called on start, when the
  // operator changes expiry or range, and when the spot has drifted far enough
  // that the window no longer straddles the money.
  async setChain({ underlying = this.underlying, expiry = null, range = this.range } = {}) {
    this.underlying = String(underlying || 'NIFTY').toUpperCase();
    this.range = Math.max(1, Math.min(config.terminal.maxRange, Math.trunc(range) || config.terminal.defaultRange));

    const expiries = await repo.instruments.expiries(this.underlying);
    if (!expiries.length) {
      this.lastError = 'the instrument master carries no future expiries — sync it on the Broker page';
      this.expiries = [];
      this.chainInstruments.clear();
      this._emitStatus();
      return { expiries: [], strikes: 0 };
    }
    this.expiries = expiries;
    this.expiry = expiry && expiries.includes(expiry) ? expiry : expiries[0];

    // A no-op unless the underlying changed or the master had nothing last time.
    await this._resolveIndex();

    this.fullChain = await repo.instruments.chain(this.underlying, this.expiry);
    this.strikeStep = this._deriveStep(this.fullChain);
    this.lotSize = this.fullChain.find(r => r.lot_size)?.lot_size ?? null;

    this._selectWindow();
    this._resubscribe();
    return { expiries, strikes: this.chainInstruments.size / 2 };
  }

  _deriveStep(chain) {
    const strikes = [...new Set(chain.map(r => Number(r.strike)))].sort((a, b) => a - b);
    if (strikes.length < 2) return 50;
    const gaps = [];
    for (let i = 1; i < strikes.length; i++) gaps.push(strikes[i] - strikes[i - 1]);
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)] || 50;
  }

  // The ±range ladder around the money. Before the first spot arrives the window
  // is centred on the middle of the ladder — a chain that renders nothing until
  // the first tick would look broken for the first second of every session.
  _selectWindow() {
    const chain = this.fullChain || [];
    if (!chain.length) { this.chainInstruments.clear(); return; }

    const strikes = [...new Set(chain.map(r => Number(r.strike)))].sort((a, b) => a - b);
    const spot = rupees(this.spotPaise);
    const centre = spot == null
      ? strikes[Math.floor(strikes.length / 2)]
      : Math.round(spot / this.strikeStep) * this.strikeStep;

    let index = strikes.findIndex(s => s >= centre);
    if (index < 0) index = strikes.length - 1;
    const from = Math.max(0, index - this.range);
    const to = Math.min(strikes.length, index + this.range + 1);
    const wanted = new Set(strikes.slice(from, to));

    this.windowCentre = centre;
    this.chainInstruments.clear();
    for (const row of chain) {
      if (!wanted.has(Number(row.strike))) continue;
      this.chainInstruments.set(String(row.token), row);
    }
  }

  // The ticker carries the index and, when the premium chart is open, the one
  // selected contract. The CHAIN is not on the ticker: it is polled once a
  // second at a richer filter, and subscribing forty strikes to the tick socket
  // as well would double the quote traffic to redraw a table that only refreshes
  // once a second anyway.
  _resubscribe() {
    if (!this.ticker) return;
    const items = [];
    if (this.indexInstrument) {
      items.push({ token: String(this.indexInstrument.token), segment: this.indexInstrument.segment });
    }
    if (this.optionToken) {
      const row = this.chainInstruments.get(String(this.optionToken))
        || (this.fullChain || []).find(r => String(r.token) === String(this.optionToken));
      if (row) items.push({ token: String(row.token), segment: row.segment });
    }
    this.ticker.setSubscriptions(items);
    for (const b of this.builders.values()) b.setTokens(items.map(i => i.token));
  }

  // Module 3's contract. One at a time by design: the premium chart shows one
  // strike, and keeping every strike ever clicked on the tick socket is how a
  // long session ends up subscribed to two hundred contracts.
  setOption(token) {
    const next = token == null ? null : String(token);
    if (next === this.optionToken) return;
    this.optionToken = next;
    this._resubscribe();
  }

  /* ---------------------------------------------------------------- ticks -- */

  _onTick(tick) {
    this.stats.ticks += 1;
    const token = String(tick.token);
    for (const b of this.builders.values()) b.addTick(token, tick.ltpPaise, tick.ts);

    if (this.indexInstrument && token === String(this.indexInstrument.token)) {
      const previous = this.spotPaise;
      this.spotPaise = tick.ltpPaise;
      this.spotSource = tick.source;
      this.lastSpotAt = tick.ts;
      // Per the specification's `index_tick` payload. Volume is the feed's tick
      // count rather than traded quantity — see the note in history.js.
      this.emit('index_tick', {
        price: rupees(tick.ltpPaise),
        volume: this.stats.ticks,
        time: tick.ts,
        source: tick.source,
      });
      // Re-centre the ladder when the money has moved off the window's middle by
      // more than a couple of strikes. Rebuilding on every tick would thrash the
      // table; never rebuilding leaves a ±10 window looking at yesterday's money
      // after a 300-point day.
      if (previous == null || Math.abs(rupees(tick.ltpPaise) - (this.windowCentre ?? 0)) > this.strikeStep * 2) {
        this._selectWindow();
      }
      return;
    }

    if (this.optionToken && token === this.optionToken) {
      const q = this.quotes.get(token) || {};
      const analysed = this._analyse(token, tick.ltpPaise);
      this.emit('option_tick', {
        token,
        price: rupees(tick.ltpPaise),
        volume: q.volume ?? null,
        oi: q.oi ?? null,
        iv: analysed ? analysed.iv : null,
        theta: analysed ? analysed.theta : null,
        delta: analysed ? analysed.delta : null,
        gamma: analysed ? analysed.gamma : null,
        vega: analysed ? analysed.vega : null,
        time: tick.ts,
      });
    }
  }

  _onCandle(bar) {
    this._pendingCandles.push({
      token: bar.token,
      timeframe: bar.timeframe,
      bucketStart: bar.bucketStart,
      openP: bar.openP, highP: bar.highP, lowP: bar.lowP, closeP: bar.closeP,
      tickCount: bar.tickCount,
      synthetic: bar.synthetic,
    });
    this.emit('candle', bar);
  }

  _startFlushLoop() {
    // Batched rather than per-bar: at 5s across a handful of tokens that is a
    // few hundred inserts an hour, and one multi-row statement beats a hundred
    // round trips.
    this._flushTimer = setInterval(() => {
      this._flush().catch(err => logger.warn('terminalFeed: candle flush failed', { err: err.message }));
    }, 5000);
    this._flushTimer.unref?.();
  }

  async _flush() {
    if (!this._pendingCandles.length) return;
    const batch = this._pendingCandles;
    this._pendingCandles = [];
    const written = await repo.candles.insertMany(batch);
    this.stats.barsWritten += written;
  }

  /* ---------------------------------------------------------------- chain -- */

  _startChainLoop() {
    const loop = async () => {
      this._chainTimer = null;
      if (!this.running) return;
      let failed = false;
      try {
        await this._pollChain();
      } catch (err) {
        failed = true;
        this.stats.chainErrors += 1;
        this.lastError = err.message;
        if (err instanceof BrokerAuthError || err.isAuth) {
          this._authFailed = true;
          logger.error('terminalFeed: the Kotak session was rejected — stopping the chain poll',
            { err: err.message });
          this._emitStatus();
          return;                      // a re-login restarts the feed
        }
        if (this.stats.chainErrors === 1 || this.stats.chainErrors % 20 === 0) {
          logger.warn('terminalFeed: chain poll failed', { err: err.message, attempt: this.stats.chainErrors });
        }
      }

      // A failed BATCH does not throw — `QuoteSource.snapshot` drops it and
      // carries on so one bad batch is a gap rather than a dead chain. That
      // means a gateway refusing every request looks like a quiet success from
      // here, so the failure count is read off the source rather than inferred
      // from an exception.
      if (this.quoteSource && this.quoteSource.consecutiveErrors > 0) failed = true;

      // BACK OFF WHEN THE GATEWAY SAYS NO.
      //
      // A 503 "no available server" means Kotak has nothing to serve the
      // request. Re-asking a second later, forever, cannot fix that and is how
      // an account gets throttled for the rest of the session — the same
      // per-account budget the engine's order path spends. So the interval
      // doubles up to a minute on repeated failure and snaps back the moment a
      // poll succeeds.
      if (failed) {
        this._chainBackoff = Math.min(60, Math.max(1, (this._chainBackoff || 1) * 2));
        if (this._chainBackoff >= 8) this._emitStatus();
      } else {
        this._chainBackoff = 1;
      }

      if (!this.running) return;
      this._chainTimer = setTimeout(loop, config.terminal.chainRefreshMs * (this._chainBackoff || 1));
      this._chainTimer.unref?.();
    };
    this._chainTimer = setTimeout(loop, 0);
    this._chainTimer.unref?.();
  }

  // THE SPOT IS POLLED ON ITS OWN, AND BEFORE THE STRIKES. Both halves of that
  // sentence were bugs.
  //
  // This used to be one call that put the index and India VIX in the same
  // request list as the forty strikes. Two things went wrong with that:
  //
  //   * the whole poll was skipped when the strike ladder was empty — which is
  //     exactly the state of a fresh install whose instrument master has not
  //     been synced yet. No option chain meant no spot either, so the header sat
  //     at an em-dash and nothing said why.
  //
  //   * batching by 25 put the index and VIX in the SECOND batch, behind
  //     eighteen strikes. `QuoteSource.snapshot` drops a failed batch and keeps
  //     going, so one gateway complaint about the by-name VIX entry took the
  //     spot price down with it, silently, on every poll.
  //
  // The index is the one instrument the whole screen depends on, so it gets its
  // own request and nothing can knock it out.
  async _pollChain() {
    if (this._chainBusy || this._authFailed) return;
    this._chainBusy = true;
    try {
      await this._pollIndex();
      await this._pollStrikes();
      // Only after the strikes: parity needs their premiums.
      this._applySyntheticSpot();
      this.lastChainAt = Date.now();
      this.stats.chainPolls += 1;
      this._rollBaselineIfNewDay();
      this.emit('option_chain_update', this.buildChain());
      // Status is otherwise only emitted on start, stop and auth failure — so a
      // feed that comes up and then quietly stops receiving a price would never
      // get to say so. Every five seconds is often enough to explain a blank
      // header and rare enough to be free.
      if (this.stats.chainPolls % 5 === 0) this._emitStatus();
    } finally {
      this._chainBusy = false;
    }
  }

  async _pollIndex() {
    if (!this.indexInstrument) return;
    const snapshot = await this.quoteSource.snapshot([{
      token: String(this.indexInstrument.token),
      segment: this.indexInstrument.segment,
    }]);
    const quote = snapshot.get(String(this.indexInstrument.token));
    if (quote && quote.ltp != null) {
      this.spotPaise = paise(quote.ltp);
      this.indexQuote = quote;
      this.spotSource = 'quote';
      this.lastSpotAt = Date.now();
    }

    // VIX moves in tenths over a session and is worth one number on a panel, so
    // it is asked for once every tenth poll rather than every second — and in
    // its own request, because it is quoted by NAME and a gateway that dislikes
    // that must not be able to take anything else down with it.
    if (!config.terminal.vix) return;
    this._vixCountdown = (this._vixCountdown || 0) - 1;
    if (this._vixCountdown > 0) return;
    this._vixCountdown = 10;
    try {
      const vix = await this.quoteSource.snapshot([VIX_INSTRUMENT]);
      const row = vix.get(String(VIX_INSTRUMENT.token));
      if (row && row.ltp != null) this.vix = row.ltp;
    } catch (err) {
      if (err instanceof BrokerAuthError || err.isAuth) throw err;
      // Not worth a log line every ten seconds: the panel already shows an
      // em-dash, and TERMINAL_VIX=false is the documented way to stop asking.
    }
  }

  async _pollStrikes() {
    if (!this.chainInstruments.size) return;
    const items = [...this.chainInstruments.values()]
      .map(r => ({ token: String(r.token), segment: r.segment }));
    const snapshot = await this.quoteSource.snapshot(items);
    for (const [token, quote] of snapshot) this.quotes.set(token, quote);
  }

  // SPOT FROM THE OPTION CHAIN, when the index itself cannot be quoted.
  //
  // Put-call parity is an identity, not a model: for European options on the
  // same strike and expiry,
  //
  //     C − P = S − K·e^(−rT)      so      S = C − P + K·e^(−rT)
  //
  // NIFTY options are European and cash-settled, so this holds exactly. It gives
  // a real, current index level out of two premiums the account CAN quote — and
  // some accounts are entitled to F&O quotes but not to the cash segment the
  // index lives in, which is precisely the case this exists for.
  //
  // Three things make the estimate usable rather than merely arithmetic:
  //
  //   * the strike with the SMALLEST |C − P| is nearest the money, where both
  //     legs are liquid and a stale print is least likely. Parity is exact at
  //     every strike but only trustworthy where both sides actually trade.
  //   * several near-the-money strikes are estimated and the MEDIAN is taken, so
  //     one stale leg moves the answer by nothing rather than by its error.
  //   * it is labelled `synthetic` everywhere it surfaces. The greeks are then
  //     solved against a spot derived from the same premiums, which is mildly
  //     self-referential — good enough to place the ATM and shape the chain,
  //     not something to trade a delta off.
  _syntheticSpotPaise() {
    const T = greeks.yearsToExpiry(this.expiry);
    if (!T) return null;
    const discount = Math.exp(-config.terminal.riskFreeRate * T);

    const byStrike = new Map();
    for (const row of this.chainInstruments.values()) {
      const quote = this.quotes.get(String(row.token));
      if (!quote || quote.ltp == null) continue;
      const strike = Number(row.strike);
      if (!byStrike.has(strike)) byStrike.set(strike, {});
      byStrike.get(strike)[row.option_type] = quote.ltp;
    }

    const usable = [];
    for (const [strike, legs] of byStrike) {
      if (legs.CE == null || legs.PE == null) continue;
      usable.push({ strike, spread: Math.abs(legs.CE - legs.PE), spot: legs.CE - legs.PE + strike * discount });
    }
    if (!usable.length) return null;

    // The five strikes closest to the money, by construction.
    usable.sort((a, b) => a.spread - b.spread);
    const sample = usable.slice(0, 5).map(u => u.spot).sort((a, b) => a - b);
    const median = sample[Math.floor(sample.length / 2)];
    if (!(median > 0)) return null;
    return paise(median);
  }

  // A real quote always wins. The synthetic only stands in while none has
  // arrived recently — otherwise a brief gateway hiccup would swap a quoted
  // index for a derived one and leave it there for the session.
  _applySyntheticSpot() {
    const quotedRecently = this.spotSource === 'quote'
      && this.lastSpotAt && (Date.now() - this.lastSpotAt) < 10000;
    if (quotedRecently) return;

    const synthetic = this._syntheticSpotPaise();
    if (synthetic == null) return;

    const previous = this.spotPaise;
    this.spotPaise = synthetic;
    this.spotSource = 'synthetic';
    this.lastSpotAt = Date.now();
    if (previous == null) {
      logger.warn('terminalFeed: the index cannot be quoted — deriving spot from the option '
        + 'chain by put-call parity. Run `node scripts/diagnose-spot.js` to find out why.',
      { underlying: this.underlying, spot: rupees(synthetic) });
      // The first synthetic spot tells us where the money is, so the window can
      // stop being centred on the middle of the ladder.
      this._selectWindow();
    }
    // The chart gets it too, so the page shows a live price rather than an
    // em-dash. It is NOT fed to the candle builders: a derived series must not
    // end up persisted as this index's stored history.
    this.emit('index_tick', {
      price: rupees(synthetic),
      volume: this.stats.chainPolls,
      time: Date.now(),
      source: 'synthetic',
    });
  }

  // The session OI baseline is per trading day. Carrying yesterday's over would
  // report a day's accumulated OI as this morning's change.
  _rollBaselineIfNewDay() {
    const today = time.tradeDate();
    if (this.baselineDate !== today) {
      this.baselineDate = today;
      this.oiBaseline.clear();
    }
    for (const [token, quote] of this.quotes) {
      if (quote.oi == null) continue;
      if (!this.oiBaseline.has(token)) this.oiBaseline.set(token, quote.oi);
    }
  }

  // Greeks for one contract from its last price. Returns null when there is no
  // price or no spot to model against — a chain row with no greeks is normal on
  // an untraded far strike, and null is what makes the cell render as an
  // em-dash rather than as zero delta.
  _analyse(token, ltpPaise) {
    const row = this.chainInstruments.get(String(token))
      || (this.fullChain || []).find(r => String(r.token) === String(token));
    if (!row || this.spotPaise == null) return null;
    const premium = rupees(ltpPaise);
    if (!(premium > 0)) return null;
    return greeks.analyse({
      type: row.option_type,
      premium,
      spot: rupees(this.spotPaise),
      strike: Number(row.strike),
      expiryDate: this.expiry,
      rate: config.terminal.riskFreeRate,
    });
  }

  // The `option_chain_update` payload, and the body of GET /api/options/chain.
  // One function so the socket and the REST endpoint cannot drift apart.
  buildChain() {
    const spot = rupees(this.spotPaise);
    const byStrike = new Map();

    for (const row of this.chainInstruments.values()) {
      const strike = Number(row.strike);
      if (!byStrike.has(strike)) byStrike.set(strike, { strike, call: null, put: null });
      const entry = byStrike.get(strike);
      const side = this._sideFor(row, spot);
      if (row.option_type === 'CE') entry.call = side; else entry.put = side;
    }

    const rows = [...byStrike.values()].sort((a, b) => a.strike - b.strike);

    for (const row of rows) {
      for (const side of ['call', 'put']) {
        const leg = row[side];
        if (!leg) continue;
        leg.buildup = analytics.buildup({
          priceChange: leg.change,
          oiChange: leg.oiChange,
          // A rupee of premium and a hundred contracts of OI are the floor of
          // "something happened". Below that the four-quadrant reading is a
          // story told about rounding.
          priceThreshold: 0.05,
          oiThreshold: 100,
        });
        leg.moneyness = analytics.moneyness(row.strike, spot, side === 'call' ? 'CE' : 'PE', this.strikeStep);
      }
      row.writing = analytics.writingBias(row);
      row.pcr = (row.call?.oi && row.put?.oi != null && row.call.oi > 0)
        ? row.put.oi / row.call.oi
        : null;
    }

    const summary = analytics.chainSummary(rows, {
      spot,
      expiry: this.expiry,
      lotSize: this.lotSize,
      vix: this.vix,
    });

    return {
      underlying: this.underlying,
      expiry: this.expiry,
      expiries: this.expiries || [],
      strikeStep: this.strikeStep,
      range: this.range,
      spot,
      spotSource: this.spotSource || null,
      // The index's own day, where the feed's filter supplies it.
      index: this.indexQuote
        ? {
          ltp: this.indexQuote.ltp, open: this.indexQuote.open, high: this.indexQuote.high,
          low: this.indexQuote.low, previousClose: this.indexQuote.close,
        }
        : null,
      summary,
      rows,
      ts: this.lastChainAt || Date.now(),
      // Which columns are real. The UI greys out the rest instead of drawing
      // zeros — see quoteSource.js.
      coverage: this.quoteSource ? this.quoteSource.status().coverage : null,
      oiChangeSource: this._oiChangeSource,
    };
  }

  _sideFor(row, spot) {
    const token = String(row.token);
    const quote = this.quotes.get(token) || {};
    const ltp = quote.ltp ?? null;

    let oiChange = quote.oiChange;
    if (oiChange == null && quote.oi != null && this.oiBaseline.has(token)) {
      // Not the day's change — the change since this process first saw the
      // strike. Flagged on the payload so the column header can say so.
      oiChange = quote.oi - this.oiBaseline.get(token);
      this._oiChangeSource = 'session';
    } else if (oiChange != null) {
      this._oiChangeSource = 'broker';
    }

    const analysed = (ltp != null && spot != null)
      ? greeks.analyse({
        type: row.option_type,
        premium: ltp,
        spot,
        strike: Number(row.strike),
        expiryDate: this.expiry,
        rate: config.terminal.riskFreeRate,
      })
      : null;

    return {
      token,
      symbol: row.symbol,
      segment: row.segment,
      lotSize: row.lot_size,
      tickSize: row.tick_size,
      ltp,
      bid: quote.bid ?? null,
      ask: quote.ask ?? null,
      open: quote.open ?? null,
      high: quote.high ?? null,
      low: quote.low ?? null,
      previousClose: quote.close ?? null,
      change: (ltp != null && quote.close != null) ? ltp - quote.close : null,
      changePct: (ltp != null && quote.close) ? 100 * (ltp - quote.close) / quote.close : null,
      volume: quote.volume ?? null,
      oi: quote.oi ?? null,
      oiChange: oiChange ?? null,
      iv: analysed ? analysed.iv : null,
      delta: analysed ? analysed.delta : null,
      gamma: analysed ? analysed.gamma : null,
      theta: analysed ? analysed.theta : null,
      vega: analysed ? analysed.vega : null,
      rho: analysed ? analysed.rho : null,
      intrinsic: analysed ? analysed.intrinsic : null,
      timeValue: analysed ? analysed.timeValue : null,
    };
  }

  /* --------------------------------------------------------------- status -- */

  _emitStatus() { this.emit('status', this.status()); }

  // Why is there no spot price? Answered here rather than left to be inferred
  // from a blank header — every way this can fail is a different fix, and an
  // operator should not have to read the source to tell them apart.
  spotDiagnosis() {
    if (this.spotPaise != null) {
      if (this.spotSource !== 'synthetic') return null;
      // Not an error, but the operator must never mistake this for a quoted
      // index: the greeks below it are solved against a spot derived from the
      // same premiums.
      return `the index itself cannot be quoted on this account, so the spot is DERIVED from `
        + 'the option chain by put-call parity. It is a real current level, but the greeks are '
        + 'then modelled against it — run `node scripts/diagnose-spot.js` to see why the '
        + 'index quote is failing.';
    }
    if (!this.running) return 'the terminal feed is not running — open /terminal, or check the broker session';
    if (this._authFailed) return 'the Kotak session was rejected — log in again on the Broker page';
    if (!this.indexInstrument) {
      return `no ${this.underlying} index instrument — sync instruments on the Broker page`;
    }
    // The baseline error is the one that explains a missing price. A refused
    // richer filter is expected on most accounts and must never be reported
    // here — that conflation is what made a rejected `full` upgrade read as
    // "the quote request is failing".
    const q = this.quoteSource;
    if (q && q.baselineError && !q.probed) {
      return `Kotak is refusing the quote request. ${q.baselineError}`;
    }
    if (q && q.lastError && q.consecutiveErrors > 0) {
      return `the quote request is failing (${q.consecutiveErrors} in a row). ${q.lastError}`;
    }
    if (!this.lastChainAt) return 'no quote has come back yet — give it a second';
    return `the broker answers but sends no price for ${this.underlying} `
      + `(${this.indexInstrument.segment}|${this.indexInstrument.token}) — the market may be closed`;
  }

  status() {
    return {
      running: this.running,
      viewers: this.viewers.size,
      underlying: this.underlying,
      expiry: this.expiry,
      range: this.range,
      strikes: this.chainInstruments.size / 2,
      lotSize: this.lotSize,
      strikeStep: this.strikeStep,
      spot: rupees(this.spotPaise),
      spotSource: this.spotSource || null,
      spotAgeMs: this.lastSpotAt ? Date.now() - this.lastSpotAt : null,
      spotProblem: this.spotDiagnosis(),
      index: this.indexInstrument
        ? {
          token: String(this.indexInstrument.token),
          segment: this.indexInstrument.segment,
          quoteBy: this.indexInstrument.quoteBy || 'token',
          exchangeToken: this.indexInstrument.exchangeToken || null,
        }
        : null,
      vix: this.vix,
      optionToken: this.optionToken,
      authFailed: this._authFailed,
      lastError: this.lastError,
      // >1 means the poll has backed off after repeated gateway refusals. Shown
      // so a chain that has visibly stopped refreshing has a reason attached.
      backoff: this._chainBackoff || 1,
      lastChainAgeMs: this.lastChainAt ? Date.now() - this.lastChainAt : null,
      ticker: this.ticker ? this.ticker.status() : null,
      quotes: this.quoteSource ? this.quoteSource.status() : null,
      stats: { ...this.stats },
    };
  }
}

module.exports = { TerminalFeed, PERSIST_TIMEFRAMES, IDLE_STOP_MS };
