// Tick -> OHLC. The piece the whole strategy rests on.
//
// Every document in doc/ says the same thing: the SELL price comes from a
// COMPLETED candle of the option contract itself, never from a live ask, bid or
// LTP. That makes this file the price source of record, and four decisions in it
// are load-bearing:
//
// 1. BUCKETS ARE ABSOLUTE, NOT RELATIVE. A bar is 10:15:00.000–10:15:59.999 IST,
//    not "60 seconds after I subscribed". Two builders started a second apart
//    must produce byte-identical bars, or a restart silently changes the
//    strategy's entries.
//
// 2. THE FIRST BAR IS DISCARDED. Its open is wherever the tick stream happened
//    to start, so its OHLC describes the subscription, not the market. The
//    engine therefore waits up to one full timeframe before its first entry —
//    a real, logged delay, not a bug.
//
// 3. A BAR WITH NO TICKS IS SYNTHETIC AND NEVER TRADED. It is emitted (charts
//    need continuity) with o=h=l=c = the previous close, flagged `synthetic`,
//    and the engine refuses to price an entry from it. Offsetting from a close
//    that is a minute stale is fiction.
//
// 4. A BAR CLOSES ON TIME, NOT ON THE NEXT TICK. A timer closes the bucket even
//    if the strike goes completely quiet. Closing only on the first tick of the
//    next bucket would stall a leg indefinitely on an illiquid strike — which is
//    exactly when you least want the engine wedged.
//
// Prices in, prices out: integer paise.

const EventEmitter = require('events');
const time = require('../core/time');

class CandleSeries {
  constructor({ token, timeframe }) {
    this.token = String(token);
    this.timeframe = timeframe;
    this.seconds = time.timeframeSeconds(timeframe);

    this.current = null;          // the bucket being assembled
    this.lastClosed = null;       // the most recent CLOSED bar
    this.lastClosePaise = null;   // carried into synthetic bars
    // The first bucket we touch is partial by construction — we joined it
    // mid-flight. Emitted with `partial: true` and never traded on.
    this.sawFirst = false;
  }

  _open(bucketStartMs, pricePaise) {
    return {
      token: this.token,
      timeframe: this.timeframe,
      bucketStart: bucketStartMs,
      bucketEnd: time.bucketEnd(bucketStartMs, this.seconds),
      openP: pricePaise,
      highP: pricePaise,
      lowP: pricePaise,
      closeP: pricePaise,
      tickCount: pricePaise == null ? 0 : 1,
      synthetic: pricePaise == null,
      partial: false,
    };
  }

  // Returns the array of bars closed by this tick (usually empty or one; more
  // than one when the feed was silent across several buckets).
  addTick(pricePaise, tsMs) {
    const price = Math.round(Number(pricePaise));
    if (!Number.isFinite(price) || price <= 0) return [];

    const bucket = time.bucketStart(tsMs, this.seconds);
    const closed = [];

    if (!this.current) {
      this.current = this._open(bucket, price);
      this.current.partial = !this.sawFirst;
      this.sawFirst = true;
      return closed;
    }

    if (bucket === this.current.bucketStart) {
      const c = this.current;
      if (price > c.highP) c.highP = price;
      if (price < c.lowP) c.lowP = price;
      c.closeP = price;
      c.tickCount += 1;
      return closed;
    }

    if (bucket < this.current.bucketStart) {
      // A tick older than the bucket being assembled. Out-of-order frames do
      // happen on a reconnect; folding one into a closed bar would rewrite a
      // price the engine may already have traded on, so it is dropped.
      return closed;
    }

    // Moved on. Close the current bucket, then fill any silent gap between it
    // and the new one so the series has no holes.
    //
    // The closed bar's start is captured BEFORE the gap loop: _close() nulls
    // `this.current`, so reading it afterwards dereferences null on the very
    // first rollover.
    const previous = this._close();
    closed.push(previous);
    for (let b = previous.bucketStart + this.seconds * 1000; b < bucket; b += this.seconds * 1000) {
      closed.push(this._synthetic(b));
    }
    this.current = this._open(bucket, price);
    return closed;
  }

  // Close the assembling bucket and hand it back.
  _close() {
    const bar = this.current;
    this.current = null;
    this.lastClosed = bar;
    this.lastClosePaise = bar.closeP;
    return bar;
  }

  _synthetic(bucketStartMs) {
    const price = this.lastClosePaise;
    const bar = {
      token: this.token,
      timeframe: this.timeframe,
      bucketStart: bucketStartMs,
      bucketEnd: time.bucketEnd(bucketStartMs, this.seconds),
      openP: price, highP: price, lowP: price, closeP: price,
      tickCount: 0,
      synthetic: true,
      partial: false,
    };
    this.lastClosed = bar;
    return bar;
  }

  // Called by the timer. Closes the bucket if the clock has moved past it, even
  // though no tick arrived to push it along.
  closeIfElapsed(nowMs) {
    if (!this.current) return [];
    if (nowMs < this.current.bucketEnd) return [];

    const closed = [this._close()];
    // Fill the silence up to (but not including) the bucket now in progress.
    const nowBucket = time.bucketStart(nowMs, this.seconds);
    for (let b = closed[0].bucketStart + this.seconds * 1000; b < nowBucket; b += this.seconds * 1000) {
      closed.push(this._synthetic(b));
    }
    return closed;
  }
}

class CandleBuilder extends EventEmitter {
  // `minTicks` — a bar assembled from fewer ticks than this is low-confidence:
  // its close may predate the end of the bucket by most of its width. Such bars
  // are emitted and stored but flagged `lowConfidence`, and the engine will not
  // price an entry from one.
  constructor({ timeframe = '1m', minTicks = 2, clockMs = 250 } = {}) {
    super();
    this.timeframe = timeframe;
    this.seconds = time.timeframeSeconds(timeframe);
    this.minTicks = Math.max(0, Math.trunc(minTicks));
    this.clockMs = clockMs;
    this.series = new Map();          // token -> CandleSeries
    this._timer = null;
    this.stats = { ticks: 0, closed: 0, synthetic: 0, discardedPartial: 0 };
  }

  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => this._sweep(Date.now()), this.clockMs);
    this._timer.unref?.();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  track(token) {
    const key = String(token);
    if (!this.series.has(key)) {
      this.series.set(key, new CandleSeries({ token: key, timeframe: this.timeframe }));
    }
    return this.series.get(key);
  }

  untrack(token) {
    this.series.delete(String(token));
  }

  // Replace the tracked set; anything not named is dropped along with its
  // partially assembled bar. Called when a cycle locks a new pair of strikes.
  setTokens(tokens) {
    const want = new Set((tokens || []).map(String));
    for (const key of [...this.series.keys()]) {
      if (!want.has(key)) this.series.delete(key);
    }
    for (const t of want) this.track(t);
  }

  addTick(token, pricePaise, tsMs = Date.now()) {
    const series = this.series.get(String(token));
    if (!series) return;
    this.stats.ticks += 1;
    for (const bar of series.addTick(pricePaise, tsMs)) this._emit(bar);
  }

  _sweep(nowMs) {
    for (const series of this.series.values()) {
      for (const bar of series.closeIfElapsed(nowMs)) this._emit(bar);
    }
  }

  _emit(bar) {
    // The first bucket we joined mid-flight describes the subscription, not the
    // market. Count it and drop it — nothing downstream should ever see it.
    if (bar.partial) {
      this.stats.discardedPartial += 1;
      this.emit('discarded', bar);
      return;
    }
    this.stats.closed += 1;
    if (bar.synthetic) this.stats.synthetic += 1;

    const lowConfidence = !bar.synthetic && bar.tickCount < this.minTicks;
    // `tradable` is the single flag the engine reads. Keeping the rule here
    // rather than in the state machine means there is one place to audit the
    // answer to "was this bar allowed to price an order".
    const out = { ...bar, lowConfidence, tradable: !bar.synthetic && !lowConfidence };
    this.emit('candle', out);
  }

  lastClosed(token) {
    return this.series.get(String(token))?.lastClosed || null;
  }

  // The bar currently being assembled. For the dashboard only — it is not a
  // closed candle and must never price an order.
  inProgress(token) {
    const c = this.series.get(String(token))?.current;
    return c ? { ...c } : null;
  }

  status() {
    return {
      timeframe: this.timeframe,
      tracked: this.series.size,
      minTicks: this.minTicks,
      stats: { ...this.stats },
    };
  }
}

module.exports = { CandleBuilder, CandleSeries };
