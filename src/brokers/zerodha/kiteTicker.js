// Kite Ticker — the binary WebSocket price feed.
//
// Wire format (all big-endian):
//   frame  : int16 packetCount, then per packet: int16 length, payload
//   packet : int32 instrument_token, int32 last_price, [mode-specific tail]
//   a frame shorter than 2 bytes is the server's ~1s heartbeat
//   text frames are JSON (errors, order updates) — ignored, we only want prices
//
// last_price is an integer in the instrument's minor unit. The divisor comes
// from the exchange segment encoded in the low byte of the token: currency
// derivatives use 1e7 and 1e4, everything else (including NFO options, which is
// all this platform trades) uses 100.
//
// Why a REST fallback also runs: the ticker only pushes when a price CHANGES.
// An illiquid far strike can go minutes without a tick, but the premium scanner
// needs a value for every candidate on every pass — and a strike with no price
// is silently excluded, which would quietly bias selection toward whatever
// happens to be trading. Topping up from /quote/ltp closes that gap.

const EventEmitter = require('events');
const WebSocket = require('ws');
const config = require('../../config');
const logger = require('../../core/logger');
const kite = require('./kiteClient');

const HEARTBEAT_TIMEOUT_MS = 15000;
const MAX_RECONNECT_DELAY_MS = 30000;

function divisorFor(token) {
  const segment = token & 0xff;
  if (segment === 3) return 10000000;   // CDS
  if (segment === 6) return 10000;      // BCD
  return 100;
}

class KiteTicker extends EventEmitter {
  constructor({ apiKey, accessToken, label = 'ticker' }) {
    super();
    this.apiKey = apiKey;
    this.accessToken = accessToken;
    this.label = label;

    this.ws = null;
    this.closed = false;
    this.connected = false;
    // Set once the broker has rejected our credentials. Distinct from `closed`:
    // a closed ticker may be reconnected, an auth-failed one may not until the
    // operator supplies a fresh token.
    this.authFailed = false;
    this.subscriptions = new Set();      // instrument tokens, as strings
    this.prices = new Map();             // token -> { ltp, ts, source }

    this.reconnectAttempts = 0;
    this.lastFrameAt = 0;
    this.lastError = null;

    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._pollTimer = null;
    this._polling = false;
    this._pollBackoff = 1;

    this.stats = { frames: 0, ticks: 0, polls: 0, pollErrors: 0, reconnects: 0 };
  }

  get url() {
    return `${config.kite.wsUrl}?api_key=${encodeURIComponent(this.apiKey)}`
         + `&access_token=${encodeURIComponent(this.accessToken)}`;
  }

  /* ------------------------------------------------------------ lifecycle */
  connect() {
    if (this.closed || this.ws) return this;
    let ws;
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 15000 });
    } catch (err) {
      this.lastError = err.message;
      this._scheduleReconnect();
      return this;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.lastFrameAt = Date.now();
      this.lastError = null;
      logger.info('kiteTicker: connected', { label: this.label, subscriptions: this.subscriptions.size });
      // Re-subscribe everything: the server keeps no state across a reconnect.
      if (this.subscriptions.size) this._sendSubscribe([...this.subscriptions]);
      this._watchHeartbeat();
      this.emit('open');
    });

    ws.on('message', (data, isBinary) => {
      this.lastFrameAt = Date.now();
      this.stats.frames += 1;
      if (isBinary || Buffer.isBuffer(data)) this._onBinary(Buffer.from(data));
      else this._onText(String(data));
    });

    // A non-101 handshake response. Kite answers 403 when the access_token is
    // invalid or expired, which is NOT something to retry: the token cannot fix
    // itself, and reconnecting forever hides a dead session behind a wall of
    // identical warnings.
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        // The ticker cannot distinguish the two causes, and they have entirely
        // different fixes, so name both rather than guess. Use "Test connection"
        // on the Brokers page to find out which one it is.
        this._failAuth(`Kite rejected the websocket (HTTP ${res.statusCode}). Either the access token `
          + 'is invalid/expired, or this Kite Connect app has no market-data permission.');
        return;
      }
      this.lastError = `handshake failed with HTTP ${res.statusCode}`;
      logger.warn('kiteTicker: unexpected handshake response', {
        label: this.label, status: res.statusCode,
      });
    });

    ws.on('error', (err) => {
      // Older `ws` versions surface the same condition only as an error string.
      if (/Unexpected server response:\s*(401|403)/.test(err.message)) {
        this._failAuth(`Kite rejected the connection — ${err.message}`);
        return;
      }
      this.lastError = err.message;
      logger.warn('kiteTicker: socket error', { label: this.label, err: err.message });
    });

    ws.on('close', (code) => {
      this.connected = false;
      this.ws = null;
      if (this.authFailed) return;            // already reported; do not loop
      logger.warn('kiteTicker: disconnected', { label: this.label, code });
      this.emit('close', code);
      this._scheduleReconnect();
    });

    this._startPolling();
    return this;
  }

  close() {
    this.closed = true;
    for (const t of ['_reconnectTimer', '_heartbeatTimer', '_pollTimer']) {
      if (this[t]) clearTimeout(this[t]);
      this[t] = null;
    }
    try { this.ws?.close(); } catch (_) { /* already gone */ }
    this.ws = null;
    this.connected = false;
  }

  // Swap in a fresh access_token (the daily re-login) without replacing the
  // object, so anything already bound to its events stays bound.
  rebind({ apiKey, accessToken }) {
    const changed = apiKey !== this.apiKey || accessToken !== this.accessToken;
    this.apiKey = apiKey;
    this.accessToken = accessToken;
    this.closed = false;
    // A new token is precisely what clears an auth failure. Without this the
    // latch would survive a successful re-login and the feed would stay dark.
    if (changed) { this.authFailed = false; this.reconnectAttempts = 0; }
    if (changed && this.ws) {
      try { this.ws.close(); } catch (_) { /* ignore */ }
      this.ws = null;
      this.connected = false;
    }
    if (!this.ws) this.connect();
    return this;
  }

  // The session is dead. Say so once, loudly, and stop — a reconnect loop
  // against a rejected token produces nothing but noise, and the operator needs
  // to know that market data is down rather than watching it "retry".
  _failAuth(message) {
    if (this.authFailed) return;
    this.authFailed = true;
    this.lastError = message;
    logger.error('kiteTicker: authentication failed — market data stopped', {
      label: this.label, err: message,
    });
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

  // Kite heartbeats about once a second. Silence past the timeout means a
  // half-open socket — the TCP connection looks alive but nothing is arriving.
  // Tearing it down forces the reconnect path instead of going quietly stale,
  // which for a trading feed is the difference between "no data" and "wrong
  // data".
  _watchHeartbeat() {
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = setTimeout(() => {
      if (this.closed) return;
      if (Date.now() - this.lastFrameAt > HEARTBEAT_TIMEOUT_MS) {
        logger.warn('kiteTicker: heartbeat timeout, recycling socket', { label: this.label });
        try { this.ws?.terminate(); } catch (_) { /* ignore */ }
        this.ws = null;
        this.connected = false;
        this._scheduleReconnect();
        return;
      }
      this._watchHeartbeat();
    }, HEARTBEAT_TIMEOUT_MS);
    this._heartbeatTimer.unref?.();
  }

  _send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify(payload)); return true; }
    catch (err) {
      logger.warn('kiteTicker: send failed', { label: this.label, err: err.message });
      return false;
    }
  }

  _sendSubscribe(tokens) {
    const nums = tokens.map(Number);
    this._send({ a: 'subscribe', v: nums });
    this._send({ a: 'mode', v: ['ltp', nums] });   // LTP mode: 8-byte packets
  }

  /* --------------------------------------------------------- subscriptions */
  subscribe(tokens) {
    const list = (Array.isArray(tokens) ? tokens : [tokens])
      .map(String).filter(t => /^\d+$/.test(t));
    const fresh = list.filter(t => !this.subscriptions.has(t));
    for (const t of list) this.subscriptions.add(t);

    // Hard cap. Kite disconnects a client that subscribes past its limit, which
    // would take the whole feed down rather than just dropping the extra token.
    if (this.subscriptions.size > config.kite.maxSymbols) {
      const excess = [...this.subscriptions].slice(0, this.subscriptions.size - config.kite.maxSymbols);
      this.unsubscribe(excess);
      logger.warn('kiteTicker: subscription cap reached, dropped oldest',
        { label: this.label, dropped: excess.length, cap: config.kite.maxSymbols });
    }
    if (fresh.length && this.connected) this._sendSubscribe(fresh);
    return fresh.length;
  }

  unsubscribe(tokens) {
    const list = (Array.isArray(tokens) ? tokens : [tokens]).map(String);
    const removed = list.filter(t => this.subscriptions.delete(t));
    for (const t of removed) this.prices.delete(t);
    if (removed.length && this.connected) this._send({ a: 'unsubscribe', v: removed.map(Number) });
    return removed.length;
  }

  // Replace the whole set at once — the scanner re-centres its strike window as
  // spot drifts, and doing it in one diff avoids a churn of individual calls.
  setSubscriptions(tokens) {
    const want = new Set((Array.isArray(tokens) ? tokens : [tokens])
      .map(String).filter(t => /^\d+$/.test(t)));
    const toDrop = [...this.subscriptions].filter(t => !want.has(t));
    const toAdd = [...want].filter(t => !this.subscriptions.has(t));
    if (toDrop.length) this.unsubscribe(toDrop);
    if (toAdd.length) this.subscribe(toAdd);
    return { added: toAdd.length, removed: toDrop.length, total: this.subscriptions.size };
  }

  /* ------------------------------------------------------------ tick parse */
  _onBinary(buf) {
    if (buf.length < 2) return;                       // heartbeat
    const packetCount = buf.readInt16BE(0);
    if (packetCount <= 0) return;

    let offset = 2;
    for (let i = 0; i < packetCount; i++) {
      if (offset + 2 > buf.length) break;
      const length = buf.readInt16BE(offset);
      offset += 2;
      // A packet shorter than 8 bytes cannot hold token+price; a length running
      // past the buffer means a torn frame. Either way, stop parsing rather
      // than read adjacent memory as a price.
      if (length < 8 || offset + length > buf.length) break;

      const token = buf.readInt32BE(offset);
      const raw = buf.readInt32BE(offset + 4);
      offset += length;

      const price = raw / divisorFor(token);
      if (Number.isFinite(price) && price >= 0) this._record(String(token), price, 'ws');
    }
  }

  _onText(text) {
    try {
      const msg = JSON.parse(text);
      if (msg?.type === 'error') {
        this.lastError = msg.data || 'kite websocket error';
        logger.warn('kiteTicker: server error frame', { label: this.label, err: this.lastError });
      }
    } catch (_) { /* not JSON — nothing we need */ }
  }

  _record(token, ltp, source) {
    const previous = this.prices.get(token);
    const tick = { token, ltp, ts: Date.now(), source };
    this.prices.set(token, tick);
    this.stats.ticks += 1;
    if (!previous || previous.ltp !== ltp) this.emit('tick', tick);
  }

  /* ---------------------------------------------------------- REST top-up */
  _startPolling() {
    if (this._pollTimer || config.kite.pollMs <= 0) return;
    const loop = async () => {
      this._pollTimer = null;
      if (this.closed) return;
      await this._pollOnce();
      if (this.closed) return;
      this._pollTimer = setTimeout(loop, config.kite.pollMs * this._pollBackoff);
      this._pollTimer.unref?.();
    };
    this._pollTimer = setTimeout(loop, config.kite.pollMs);
    this._pollTimer.unref?.();
  }

  async _pollOnce() {
    if (this._polling || !this.subscriptions.size || !this.accessToken) return;
    this._polling = true;
    try {
      const map = await kite.ltp({
        apiKey: this.apiKey, accessToken: this.accessToken, ids: [...this.subscriptions],
      });
      for (const [token, price] of map) this._record(token, price, 'rest');
      this.stats.polls += 1;
      this._pollBackoff = 1;
    } catch (err) {
      this.stats.pollErrors += 1;
      this.lastError = err.message;
      this._pollBackoff = Math.min(8, this._pollBackoff * 2);
      if (err.isAuth) {
        // The access token died (they expire ~06:00 IST). Stop rather than
        // hammer a dead session; the operator must re-authorise.
        this._failAuth(`Kite rejected a quote request — ${err.message}`);
      } else {
        logger.warn('kiteTicker: rest poll failed', { label: this.label, err: err.message });
      }
    } finally {
      this._polling = false;
    }
  }

  /* ------------------------------------------------------------------ read */
  ltp(token) {
    const tick = this.prices.get(String(token));
    return tick ? tick.ltp : null;
  }

  // Price WITH its age. Everything that trades on a price must know how old it
  // is — see stateMachine's staleness guards.
  quote(token) {
    const tick = this.prices.get(String(token));
    if (!tick) return null;
    return { ltp: tick.ltp, ts: tick.ts, ageMs: Date.now() - tick.ts, source: tick.source };
  }

  // A feed is healthy when a frame arrived recently. Used to refuse new entries
  // rather than trade blind.
  isHealthy() {
    if (this.authFailed) return false;
    if (!this.lastFrameAt) return false;
    return Date.now() - this.lastFrameAt < HEARTBEAT_TIMEOUT_MS * 2;
  }

  status() {
    return {
      connected: this.connected,
      healthy: this.isHealthy(),
      authFailed: this.authFailed,
      subscriptions: this.subscriptions.size,
      priced: this.prices.size,
      lastFrameAgeMs: this.lastFrameAt ? Date.now() - this.lastFrameAt : null,
      lastError: this.lastError,
      stats: { ...this.stats },
    };
  }
}

module.exports = { KiteTicker, divisorFor };
