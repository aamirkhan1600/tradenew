// Typed errors. The engine branches on these, so they carry intent rather than
// just a message string.

class AppError extends Error {
  constructor(message, status = 500, code = 'internal_error', meta = null) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.meta = meta;
  }
}

class ValidationError extends AppError {
  constructor(message, meta = null) { super(message, 400, 'validation_error', meta); }
}

class AuthError extends AppError {
  constructor(message = 'unauthorized') { super(message, 401, 'unauthorized'); }
}

class NotFoundError extends AppError {
  constructor(message = 'not found') { super(message, 404, 'not_found'); }
}

class ConflictError extends AppError {
  constructor(message, meta = null) { super(message, 409, 'conflict', meta); }
}

// The broker is reachable but refused us — session expired, bad credentials.
// `isAuth` tells the caller to stop retrying and prompt a re-login.
class BrokerAuthError extends AppError {
  constructor(message, meta = null) {
    super(message, 502, 'broker_auth', meta);
    this.isAuth = true;
  }
}

// The broker refused for a business reason (rejected order, insufficient
// margin). Retrying unchanged will fail identically.
class BrokerRejectedError extends AppError {
  constructor(message, meta = null) {
    super(message, 422, 'broker_rejected', meta);
    this.retryable = false;
  }
}

// We never learned the outcome — timeout, dropped socket, 5xx after send. The
// order MAY be live. This is the one error that must never trigger a resend;
// the reconciler resolves it against the broker's order book.
class BrokerUncertainError extends AppError {
  constructor(message, meta = null) {
    super(message, 504, 'broker_uncertain', meta);
    this.uncertain = true;
  }
}

// The local rate limiter refused BEFORE anything was sent. Nothing reached the
// broker, so retrying is always safe.
class RateLimitedError extends AppError {
  constructor(waitMs) {
    super('rate_limited', 429, 'rate_limited', { waitMs });
    this.waitMs = waitMs;
    this.retryable = true;
  }
}

module.exports = {
  AppError, ValidationError, AuthError, NotFoundError, ConflictError,
  BrokerAuthError, BrokerRejectedError, BrokerUncertainError, RateLimitedError,
};
