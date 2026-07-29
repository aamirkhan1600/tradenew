// Kotak Neo market data.
//
// Two paths run in parallel into one price store, and that is deliberate:
//
//   WS   wss://mlhsm.kotaksecurities.com/realtime?sid=...  — push, binary
//   REST /script-details/1.0/quotes/neosymbol/...          — pull, ~1s
//
// The socket alone is not trustworthy. Kotak's HSM gateway accepts a connect and
// a subscribe, answers heartbeats, and then on many accounts never streams a
// quote. A feed that looks connected and silently delivers nothing is the worst
// failure mode a trading system can have, so the REST poller is not a fallback
// that engages after a timeout — it always runs, and either source satisfies the
// health check.
//
// The cost of that is duplication: where the socket does stream, both paths
// produce the same price, and `_record` suppresses an identical price arriving
// inside one poll interval.
//
// Consequence for THIS strategy, worth being explicit about: on a REST-only
// account the candles are built from roughly one sample a second. A 1-minute bar
// then has ~60 samples and its close is accurate to within a poll interval,
// which is fine. A 15-second bar has ~15, and its high and low are materially
// understated. That is the real reason `candleTimeframe` should stay at 1m until
// a session has proven the socket streams.
//
// Wire format of the binary frames (best effort, from Kotak's own SDKs):
//   byte 0        : packet count
//   per packet:
//     uint16 BE   : packet length
//     body[0]     : packet type
//     body[1..4]  : token (uint32 BE)
//     body[5..8]  : LTP   (int32 BE, in paise)

const EventEmitter = require('events');
const WebSocket = require('ws');
const config = require('../config');
const logger = require('../core/logger');
const neo = require('../broker/neoClient');
const { BrokerAuthError } = require('../core/errors');

const HEARTBEAT_MS = 20000;
const STALE_AFTER_MS = 15000;
const MAX_RECONNECT_DELAY_MS = 30000;

// Kotak addresses an instrument as `segment|token`; a bare token means nothing
// to the gateway, so everything is normalised to the pair on the way in.
function normalise(item, fallbackSegment = 'nse_fo') {
  if (item == null) return null;
  if (typeof item === 'object') {
    const token = String(item.token ?? '').trim();
    const segment = String(item.segment ?? fallbackSegment).trim().toLowerCase();
    return token ? { token, segment } : null;
  }
  const s = String(item).trim();
  if (!s) return null;
  if (s.includes('|')) {
    const [segment, token] = s.split('|');
    return token ? { token: token.trim(), segment: segment.trim().toLowerCase() } : null;
  }
  return { token: s, segment: fallbackSegment };
}

class Ticker extends EventEmitter {
  constructor({ session, label = 'ticker' }) {
    super();
    this.sessionService = session;
    this.label = label;

    this.ws = null;
    this.closed = false;
    this.connected = false;
    // Set once the broker rejects our credentials. Distinct from `closed`: a
    // closed ticker may be reconnected, an auth-failed one may not until a fresh
    // session arrives.
    this.authFailed = false;

    this.subscriptions = new Map();      // token -> { token, segment }
    this.prices = new Map();             // token -> { ltpPaise, ts, source }

    this.reconnectAttempts = 0;
    this.lastFrameAt = 0;
    this.lastDataAt = 0;
    this.lastError = null;

    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._pollTimer = null;
    this._polling = false;
    this._pollBackoff = 1;
    this._warnedNoParse = false;

    this.stats = { frames: 0, ticks: 0, wsTicks: 0, restTicks: 0, polls: 0, pollErrors: 0, reconnects: 0 };
  }

  get session() { return this.sessionService.session; }

  get url() {
    return `${config.neo.wsUrl}?sid=${encodeURIComponent(this.session?.sid || '')}`;
  }

  /* ------------------------------------------------------------ lifecycle */

  connect() {
    if (this.closed || this.ws) { this._startPolling(); return this; }
    if (!this.session?.sessionToken || !this.session?.sid) {
      this.lastError = 'no Kotak session';
      return this;
    }

    let ws;
    try {
      // The handshake takes no auth headers — the session travels in the query
      // string and in the `cn` packet below. Origin is set because some Kotak
      // edges refuse to stream to an upgrade that does not look like a browser.
      ws = new WebSocket(this.url, {
        handshakeTimeout: 15000,
        origin: 'https://www.kotaksecurities.com',
      });
    } catch (err) {
      this.lastError = err.message;
      this._scheduleReconnect();
      this._startPolling();
      return this;
    }
    ws.binaryType = 'nodebuffer';
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.lastFrameAt = Date.now();
      this.lastError = null;
      logger.info('ticker: connected', { label: this.label, subscriptions: this.subscriptions.size });
      this._send({
        Authorization: this.session.sessionToken,
        Sid: this.session.sid,
        type: 'cn',
        source: 'API',
      });
      // The server keeps no subscription state across a reconnect.
      if (this.subscriptions.size) this._sendSubscribe([...this.subscriptions.values()]);
      this._startHeartbeat();
      this.emit('open');
    });

    ws.on('message', (data, isBinary) => {
      this.lastFrameAt = Date.now();
      this.stats.frames += 1;
      // Only a frame that actually arrived proves the link works, so that — not
      // `open` — is when the backoff resets. A gateway that accepts and
      // immediately drops would otherwise reconnect at 1s forever.
      this.reconnectAttempts = 0;
      if (isBinary || Buffer.isBuffer(data)) this._onBinary(Buffer.from(data));
      else this._onText(String(data));
    });

    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        this._failAuth(`Kotak rejected the market-data socket (HTTP ${res.statusCode}) — `
          + 'the session has expired. Log in again on the Broker page.');
        return;
      }
      this.lastError = `handshake failed with HTTP ${res.statusCode}`;
      logger.warn('ticker: unexpected handshake response', { label: this.label, status: res.statusCode });
    });

    ws.on('error', (err) => {
      if (/Unexpected server response:\s*(401|403)/.test(err.message)) {
        this._failAuth(`Kotak rejected the market-data socket — ${err.message}`);
        return;
      }
      this.lastError = err.message;
      logger.warn('ticker: socket error', { label: this.label, err: err.message });
    });

    ws.on('close', (code) => {
      this.connected = false;
      this.ws = null;
      this._stopHeartbeat();
      if (this.authFailed) return;
      logger.info('ticker: disconnected', { label: this.label, code });
      this.emit('close', code);
      this._scheduleReconnect();
    });

    this._startPolling();
    return this;
  }

  close() {
    this.closed = true;
    for (const t of ['_reconnectTimer', '_pollTimer']) {
      if (this[t]) clearTimeout(this[t]);
      this[t] = null;
    }
    this._stopHeartbeat();
    try { this.ws?.close(); } catch (_) { /* already gone */ }
    this.ws = null;
    this.connected = false;
  }

  // Adopt a fresh session (the daily re-login) without replacing the object, so
  // anything bound to its events stays bound.
  rebind() {
    this.closed = false;
    this.authFailed = false;
    this.reconnectAttempts = 0;
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch (_) { /* ignore */ }
      this.ws = null;
      this.connected = false;
    }
    this.connect();
    return this;
  }

  // The session is dead. Say so once and stop — a reconnect loop against a
  // rejected session produces nothing but noise, and the operator needs to know
  // market data is DOWN rather than watching it "retry".
  _failAuth(message) {
    if (this.authFailed) return;
    this.authFailed = true;
    this.lastError = message;
    logger.error('ticker: authentication failed — market data stopped',
      { label: this.label, err: message });
    const err = new Error(message);
    err.isAuth = true;
    this.emit('auth_expired', err);
    this.close();
  }

  _scheduleReconnect() {
    if (this.closed || this.authFailed || this._reconnectTimer) return;
    this.reconnectAttempts += 1;
    this.stats.reconnects += 1;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
    this._reconnectTimer.unref?.();
  }

  // Kotak's HSM gateway marks a session dead without this. Plain text, not JSON,
  // and not a WebSocket ping.
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      try { this.ws.send('HBChk'); } catch (_) { /* the close handler deals with it */ }
    }, HEARTBEAT_MS);
    this._heartbeatTimer.unref?.();
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  _send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return true;
    } catch (err) {
      logger.warn('ticker: send failed', { label: this.label, err: err.message });
      return false;
    }
  }

  _sendSubscribe(items) {
    if (!items.length) return;
    this._send({
      type: 'mws',
      scrips: items.map(i => `${i.segment}|${i.token}`).join('&'),
      channelnum: '1',
      task: 'mws',
    });
  }

  /* --------------------------------------------------------- subscriptions */

  subscribe(items) {
    const list = (Array.isArray(items) ? items : [items])
      .map(i => normalise(i, config.neo.defaultSegment))
      .filter(Boolean);

    const fresh = list.filter(i => !this.subscriptions.has(i.token));
    for (const i of list) this.subscriptions.set(i.token, i);

    if (this.subscriptions.size > config.neo.maxSymbols) {
      const excess = [...this.subscriptions.keys()]
        .slice(0, this.subscriptions.size - config.neo.maxSymbols);
      this.unsubscribe(excess);
      logger.warn('ticker: subscription cap reached, dropped oldest',
        { label: this.label, dropped: excess.length, cap: config.neo.maxSymbols });
    }
    if (fresh.length && this.connected) this._sendSubscribe(fresh);
    this._startPolling();
    return fresh.length;
  }

  unsubscribe(items) {
    const list = (Array.isArray(items) ? items : [items])
      .map(i => normalise(i, config.neo.defaultSegment))
      .filter(Boolean);
    const removed = [];
    for (const i of list) {
      const held = this.subscriptions.get(i.token);
      if (!held) continue;
      this.subscriptions.delete(i.token);
      this.prices.delete(i.token);
      removed.push(held);
    }
    if (removed.length && this.connected) {
      this._send({
        type: 'mws',
        scrips: removed.map(i => `${i.segment}|${i.token}`).join('&'),
        channelnum: '1',
        task: 'mwu',
      });
    }
    return removed.length;
  }

  setSubscriptions(items) {
    const want = new Map();
    for (const raw of (Array.isArray(items) ? items : [items])) {
      const i = normalise(raw, config.neo.defaultSegment);
      if (i) want.set(i.token, i);
    }
    const toDrop = [...this.subscriptions.values()].filter(i => !want.has(i.token));
    const toAdd = [...want.values()].filter(i => !this.subscriptions.has(i.token));
    if (toDrop.length) this.unsubscribe(toDrop);
    if (toAdd.length) this.subscribe(toAdd);
    return { added: toAdd.length, removed: toDrop.length, total: this.subscriptions.size };
  }

  /* ------------------------------------------------------------ tick parse */

  _onBinary(buf) {
    if (!buf || buf.length < 3) return;                 // heartbeat / ack
    const packets = buf[0];
    if (packets <= 0) return;

    let offset = 1;
    let parsed = 0;
    for (let i = 0; i < packets && offset < buf.length; i++) {
      if (offset + 2 > buf.length) break;
      const length = buf.readUInt16BE(offset);
      offset += 2;
      // Shorter than 9 bytes cannot hold type+token+price; a length running past
      // the buffer means a torn frame. Skip rather than read adjacent memory as
      // a price.
      if (length < 9 || offset + length > buf.length) { offset += length; continue; }

      const body = buf.slice(offset, offset + length);
      offset += length;
      try {
        const token = body.readUInt32BE(1);
        const paise = body.readInt32BE(5);              // already paise on the wire
        if (token > 0 && Number.isFinite(paise) && paise > 0 && paise < 1_000_000_000) {
          this._record(String(token), paise, 'ws');
          parsed += 1;
        }
      } catch (_) { /* malformed packet — skip */ }
    }

    // Say it once. A silent parser that never produces a tick looks exactly like
    // a quiet market, and on this strategy that difference is every entry.
    if (!parsed && !this._warnedNoParse) {
      this._warnedNoParse = true;
      logger.warn('ticker: binary frames produce no ticks — running on the REST poll alone', {
        label: this.label, firstByte: buf[0], length: buf.length,
        hex: buf.slice(0, Math.min(32, buf.length)).toString('hex'),
      });
    }
  }

  _onText(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }   // 'HBChk' echoes etc
    for (const t of (Array.isArray(msg) ? msg : [msg])) {
      if (!t || typeof t !== 'object') continue;
      if (t.type === 'cn') continue;                        // connect ack
      const token = t.tk ?? t.token;
      const ltp = Number(t.lp ?? t.ltp ?? t.last_price);
      if (token != null && Number.isFinite(ltp) && ltp > 0) {
        this._record(String(token), Math.round(ltp * 100), 'ws');
      }
    }
  }

  _record(token, ltpPaise, source) {
    const previous = this.prices.get(token);
    const now = Date.now();
    // Both paths feed this by design. Suppress an identical price arriving
    // inside one poll interval so a streaming socket does not double-count; an
    // unchanged price still lands once per interval, which keeps `ageMs`
    // meaningful for the staleness guards.
    if (previous && previous.ltpPaise === ltpPaise && now - previous.ts < config.neo.pollMs) return;

    this.prices.set(token, { token, ltpPaise, ts: now, source });
    this.stats.ticks += 1;
    this.stats[source === 'ws' ? 'wsTicks' : 'restTicks'] += 1;
    this.lastDataAt = now;
    this.emit('tick', { token, ltpPaise, ts: now, source });
  }

  /* -------------------------------------------------------- REST quote poll */

  _startPolling() {
    if (this._pollTimer || this._polling || this.closed || config.neo.pollMs <= 0) return;
    const loop = async () => {
      this._pollTimer = null;
      if (this.closed) return;
      await this._pollOnce();
      if (this.closed) return;
      this._pollTimer = setTimeout(loop, config.neo.pollMs * this._pollBackoff);
      this._pollTimer.unref?.();
    };
    // Fire immediately: the first candle should not have to wait a full interval
    // for its first price.
    this._pollTimer = setTimeout(loop, 0);
    this._pollTimer.unref?.();
  }

  async _pollOnce() {
    if (this._polling || this.authFailed || !this.subscriptions.size) return;
    if (!this.session?.sessionToken) return;
    this._polling = true;

    const subs = [...this.subscriptions.values()];
    try {
      // Batched: the path carries every instrument and the gateway rejects a URL
      // that grows too long.
      for (let i = 0; i < subs.length; i += config.neo.quoteBatch) {
        const batch = subs.slice(i, i + config.neo.quoteBatch);
        const rows = await this.sessionService.quotes(batch, 'ltp');
        this._applyQuotes(batch, rows);
      }
      this.stats.polls += 1;
      this._pollBackoff = 1;
      this.lastError = null;
    } catch (err) {
      this.stats.pollErrors += 1;
      this.lastError = err.message;
      if (err instanceof BrokerAuthError || err.isAuth) {
        this._failAuth(`Kotak rejected a quote request — ${err.message}`);
      } else {
        // Back off, so a rate limit is not made worse by the retry that caused
        // it — the same budget serves order placement.
        this._pollBackoff = Math.min(8, this._pollBackoff * 2);
        if (this.stats.pollErrors === 1 || this.stats.pollErrors % 20 === 0) {
          logger.warn('ticker: quote poll failed',
            { label: this.label, err: err.message, attempt: this.stats.pollErrors });
        }
      }
    } finally {
      this._polling = false;
    }
  }

  // Match each returned row back to the instrument that was asked for. Kotak
  // echoes the instrument under different keys depending on segment, so request
  // order is the last resort.
  _applyQuotes(batch, rows) {
    for (let i = 0; i < rows.length; i++) {
      const { ltp, ids } = neo.readQuoteRow(rows[i]);
      if (ltp == null) continue;
      let match = null;
      for (const id of ids) {
        match = batch.find(b => b.token === id);
        if (match) break;
      }
      if (!match && rows.length === batch.length) match = batch[i];
      if (match) this._record(match.token, Math.round(ltp * 100), 'rest');
    }
  }

  /* ------------------------------------------------------------------ read */

  ltpPaise(token) {
    return this.prices.get(String(token))?.ltpPaise ?? null;
  }

  // A price WITH its age. Anything that gates on a price must know how old it
  // is — this strategy refuses to place an order behind a stale quote.
  quote(token) {
    const tick = this.prices.get(String(token));
    if (!tick) return null;
    return { ltpPaise: tick.ltpPaise, ts: tick.ts, ageMs: Date.now() - tick.ts, source: tick.source };
  }

  // Healthy when a PRICE arrived recently, from either path. Deliberately not
  // "the socket is open": on many Kotak accounts the socket is open, answers
  // heartbeats, and never sends a quote.
  isHealthy() {
    if (this.authFailed) return false;
    if (!this.lastDataAt) return false;
    return Date.now() - this.lastDataAt < STALE_AFTER_MS;
  }

  status() {
    return {
      connected: this.connected,
      healthy: this.isHealthy(),
      authFailed: this.authFailed,
      subscriptions: this.subscriptions.size,
      priced: this.prices.size,
      lastFrameAgeMs: this.lastFrameAt ? Date.now() - this.lastFrameAt : null,
      lastDataAgeMs: this.lastDataAt ? Date.now() - this.lastDataAt : null,
      source: this.stats.wsTicks > 0 ? (this.stats.restTicks > 0 ? 'ws+rest' : 'ws') : 'rest',
      lastError: this.lastError,
      stats: { ...this.stats },
    };
  }
}

module.exports = { Ticker, normalise };
