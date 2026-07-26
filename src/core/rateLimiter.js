// Token-bucket rate limiter, one bucket per key (per user, per broker).
//
// Deliberately a REFUSAL rather than a queue. If a call cannot go out now, the
// caller is told to come back — it must never sit in a hidden queue and fire
// minutes later, because by then the price that justified the order is gone.
// `tryConsume` returning false is a pre-send refusal, which means nothing
// reached the broker and a retry is unconditionally safe.

class TokenBucket {
  constructor(ratePerSec, burst = ratePerSec) {
    this.rate = Math.max(1, Number(ratePerSec) || 1);
    this.capacity = Math.max(1, Number(burst) || this.rate);
    this.tokens = this.capacity;
    this.last = Date.now();
  }

  _refill(now = Date.now()) {
    const elapsed = Math.max(0, now - this.last) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.last = now;
  }

  tryConsume(n = 1, now = Date.now()) {
    this._refill(now);
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }

  // How long until `n` tokens would be available, in ms.
  waitMs(n = 1, now = Date.now()) {
    this._refill(now);
    if (this.tokens >= n) return 0;
    return Math.ceil(((n - this.tokens) / this.rate) * 1000);
  }
}

const buckets = new Map();

function bucketFor(key, ratePerSec) {
  if (!buckets.has(key)) buckets.set(key, new TokenBucket(ratePerSec));
  return buckets.get(key);
}

function tryConsume(key, ratePerSec, n = 1) {
  return bucketFor(key, ratePerSec).tryConsume(n);
}

function waitMs(key, ratePerSec, n = 1) {
  return bucketFor(key, ratePerSec).waitMs(n);
}

function reset(key) {
  if (key) buckets.delete(key); else buckets.clear();
}

module.exports = { TokenBucket, bucketFor, tryConsume, waitMs, reset };
