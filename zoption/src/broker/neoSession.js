// The Kotak session: stored encrypted, rate-limited on the way out, and marked
// EXPIRED exactly once when the broker stops accepting it.
//
// "Exactly once" matters more than it sounds. On a dead session every poll, every
// order and every quote fails with a 401 simultaneously; writing EXPIRED on each
// one buries the first — and only informative — failure under a hundred
// identical rows. The latch here means the operator sees one clear line.

const EventEmitter = require('events');
const config = require('../config');
const logger = require('../core/logger');
const crypto = require('../core/crypto');
const repo = require('../repositories');
const { TokenBucket } = require('../core/rateLimiter');
const { BrokerAuthError } = require('../core/errors');
const neo = require('./neoClient');

const LABEL = 'primary';

class NeoSession extends EventEmitter {
  constructor() {
    super();
    this.session = null;                 // { sessionToken, sid, baseUrl }
    this.meta = { ucc: null, userName: null, status: 'DISCONNECTED', lastError: null };
    this.bucket = new TokenBucket({ ratePerSecond: config.neo.rps });
    // Short-lived, memory only. The view token is a step in the login flow, not
    // a credential worth persisting.
    this._pending = null;
    this._expiredLatched = false;
  }

  /* ------------------------------------------------------------- lifecycle */

  async load() {
    const row = await repo.broker.get(LABEL);
    if (!row || !row.session_token) {
      this.session = null;
      this.meta = { ucc: row?.ucc ?? null, userName: row?.user_name ?? null,
        status: row?.status || 'DISCONNECTED', lastError: row?.last_error ?? null };
      return null;
    }
    const sessionToken = crypto.tryDecrypt(row.session_token);
    const sid = crypto.tryDecrypt(row.sid);
    if (!sessionToken || !sid) {
      // A rotated TOKEN_ENC_KEY should not take the engine down — it should ask
      // for a fresh login.
      logger.warn('neoSession: stored session could not be decrypted — a re-login is required');
      this.session = null;
      this.meta.status = 'EXPIRED';
      return null;
    }
    this.session = { sessionToken, sid, baseUrl: row.base_url || config.neo.apiBase };
    this.meta = { ucc: row.ucc, userName: row.user_name, status: row.status, lastError: row.last_error };
    this._expiredLatched = row.status === 'EXPIRED';
    return this.session;
  }

  // Step 1. Returns nothing useful to the caller on purpose — the view token
  // stays here rather than travelling out to a browser and back.
  async beginLogin({ mobile, ucc, totp }) {
    const out = await neo.tradeApiLogin({ mobile, ucc, totp });
    this._pending = { ...out, mobile, startedAt: Date.now() };
    return { greetingName: out.greetingName, ucc: out.ucc };
  }

  // Step 2. The MPIN is used once and discarded with the view token.
  async completeLogin({ mpin }) {
    if (!this._pending) throw new BrokerAuthError('no login in progress — start with mobile, UCC and TOTP');
    // A view token is short-lived; a stale one produces a confusing broker error.
    if (Date.now() - this._pending.startedAt > 5 * 60 * 1000) {
      this._pending = null;
      throw new BrokerAuthError('the login step timed out — start again with a fresh TOTP');
    }

    const out = await neo.tradeApiValidate({
      viewToken: this._pending.viewToken,
      viewSid: this._pending.viewSid,
      mpin,
    });
    const mobile = this._pending.mobile;
    this._pending = null;

    await repo.broker.saveSession(LABEL, {
      sessionToken: crypto.encrypt(out.sessionToken),
      sid: crypto.encrypt(out.sid),
      baseUrl: out.baseUrl,
      ucc: out.ucc,
      userName: out.userName,
      mobile,
    });

    this.session = { sessionToken: out.sessionToken, sid: out.sid, baseUrl: out.baseUrl };
    this.meta = { ucc: out.ucc, userName: out.userName, status: 'ACTIVE', lastError: null };
    this._expiredLatched = false;

    logger.info('neoSession: session established', { ucc: out.ucc, user: out.userName });
    this.emit('connected', this.session);
    return { ucc: out.ucc, userName: out.userName };
  }

  isActive() {
    return Boolean(this.session?.sessionToken && this.meta.status === 'ACTIVE');
  }

  require() {
    if (!this.session?.sessionToken) {
      throw new BrokerAuthError('no Kotak session — log in on the Broker page');
    }
    return this.session;
  }

  // Say it once, loudly. Everything that touches the broker funnels its 401s
  // here so the EXPIRED row is written by whoever noticed first.
  async markExpired(reason) {
    this.meta.status = 'EXPIRED';
    this.meta.lastError = String(reason || '').slice(0, 500);
    if (this._expiredLatched) return false;
    this._expiredLatched = true;
    await repo.broker.markExpired(LABEL, reason);
    logger.error('neoSession: the Kotak session has expired — log in again', { reason });
    this.emit('expired', reason);
    return true;
  }

  /* ------------------------------------------------------------ call proxy */

  // Every broker call goes through here: one token from the bucket first (a
  // pre-send refusal is safe to retry), then the call, then 401 handling.
  async _call(fn, { cost = 1 } = {}) {
    this.bucket.take(cost);                       // throws RateLimitedError
    try {
      return await fn(this.require());
    } catch (err) {
      if (err?.isAuth) await this.markExpired(err.message);
      throw err;
    }
  }

  placeOrder(order) { return this._call(s => neo.placeOrder(s, order)); }

  cancelOrder(args) { return this._call(s => neo.cancelOrder(s, args)); }

  orderBook() { return this._call(s => neo.orderBook(s)); }

  orderHistory(id) { return this._call(s => neo.orderHistory(s, id)); }

  positions() { return this._call(s => neo.positions(s)); }

  checkMargin(order) { return this._call(s => neo.checkMargin(s, order)); }

  quotes(queries, filter = 'ltp') { return this._call(s => neo.quotes(s, queries, filter)); }

  status() {
    return {
      connected: this.isActive(),
      status: this.meta.status,
      ucc: this.meta.ucc,
      userName: this.meta.userName,
      lastError: this.meta.lastError,
      rateLimit: this.bucket.status(),
    };
  }
}

module.exports = new NeoSession();
module.exports.NeoSession = NeoSession;
