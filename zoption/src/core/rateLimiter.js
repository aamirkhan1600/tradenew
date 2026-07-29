// A token bucket in front of every Kotak call.
//
// The refusal is deliberately made BEFORE the HTTP request leaves, and that
// distinction is load-bearing: a call the limiter rejected definitely did not
// reach the broker, so the caller may retry it safely. Once bytes are on the
// wire a failure is ambiguous and must never be retried. `RateLimitedError` is
// how a pre-send refusal announces itself.

const { RateLimitedError } = require('./errors');

class TokenBucket {
  constructor({ ratePerSecond = 8, burst = null } = {}) {
    this.rate = Math.max(1, Number(ratePerSecond) || 1);
    this.capacity = Math.max(1, Number(burst) || this.rate);
    this.tokens = this.capacity;
    this.last = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.last = now;
  }

  // Take a token or throw. Never blocks: a queued order is a stale order, and
  // the caller usually wants to reschedule rather than wait.
  take(cost = 1) {
    this._refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    const waitMs = Math.ceil(((cost - this.tokens) / this.rate) * 1000);
    throw new RateLimitedError(waitMs);
  }

  // Non-throwing variant for the quote poller, which would rather skip a cycle
  // than raise.
  tryTake(cost = 1) {
    try { return this.take(cost); } catch (_) { return false; }
  }

  status() {
    this._refill();
    return { tokens: Math.floor(this.tokens), capacity: this.capacity, rate: this.rate };
  }
}

module.exports = { TokenBucket };
