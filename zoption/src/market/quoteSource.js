// One batched snapshot of many instruments, at the richest quote filter the
// account turns out to be entitled to.
//
// The engine asks Kotak for `ltp` and nothing else, deliberately: it is the one
// filter this account class is reliably granted, and the strategy needs no more
// than a price. The option chain needs open interest, volume and a spread, which
// live behind richer filters that MAY be refused — with a 4xx, with an empty
// array, or (worst) with a 200 carrying rows that have no extra fields in them.
//
// So the filter is discovered rather than assumed. On the first snapshot each
// candidate is tried from richest to poorest; the first one that both answers
// and carries a field beyond the last price is kept for the rest of the process.
// If none does, the source settles on `ltp` and says so — and every downstream
// column that needed OI renders as unavailable instead of as zero.
//
// The probe runs ONCE. Re-probing on every poll would triple the request rate
// against a rate limit shared with order placement, to re-learn a fact about the
// account that does not change during a session.

const logger = require('../core/logger');
const neo = require('../broker/neoClient');
const { BrokerAuthError } = require('../core/errors');

// The filter name is a PATH SEGMENT — `/quotes/neosymbol/<seg|tok>/<filter>` —
// so an unrecognised one is not a parameter the gateway ignores, it is a route
// that does not exist. Kotak answers those with an HTML
//
//     HTTP 503 — No available server to handle this request
//
// which looks like an outage and is really a 404 wearing the wrong number.
//
// That is why `ltp` is established FIRST, before anything richer is attempted.
// It is the filter the engine already runs on and the one this account class is
// reliably entitled to, so proving it works gives a known-good baseline; the
// richer names are then tried as an optional upgrade whose failure is expected
// and costs nothing. Probing richest-first meant a burst of six requests at
// unroutable paths before the working one was reached, and any 503 from those
// polluted the error the terminal reported for the spot price.
const BASELINE_FILTER = 'ltp';
const RICHER_FILTERS = ['full', 'quote', 'market_depth', 'depth', 'ohlc'];
const CANDIDATE_FILTERS = [BASELINE_FILTER, ...RICHER_FILTERS];

// A gateway refusal rather than an answer. Worth telling apart from "the broker
// answered and had nothing": one is retryable and usually transient, the other
// is a fact about the instrument.
function isGatewayError(err) {
  return /HTTP 5\d\d|No available server|ECONNRESET|ETIMEDOUT|socket hang up/i.test(
    String(err && err.message));
}

// A row is "rich" if it carries anything the ltp filter would not have given us.
// An upgrade is only an upgrade if it still carries a PRICE.
//
// Kotak's filters are mutually exclusive, not cumulative: `ohlc` returns the
// day's four prices and NO last-traded price, `depth` returns the book and no
// last-traded price. Both look "richer" than `ltp` by field count, and
// selecting either would trade the one number the whole platform runs on for
// some extra columns. So the price is a precondition, not one vote among many.
function isRich(rows) {
  const cover = neo.quoteCoverage(rows);
  if (!cover.available.ltp) return false;
  return Boolean(cover.available.oi || cover.available.volume
    || cover.available.bid || cover.available.ask
    || cover.available.high || cover.available.close);
}

class QuoteSource {
  // `session` is the neoSession singleton — it carries the rate limiter and the
  // 401 latch, and going around it would mean this poller could exhaust the
  // budget the order path needs.
  constructor({ session, batchSize = 25, label = 'quotes' }) {
    this.sessionService = session;
    this.batchSize = Math.max(1, Math.trunc(batchSize));
    this.label = label;

    this.filter = null;              // decided by the probe
    this.probed = false;
    this.coverage = null;            // what the chosen filter actually delivers
    this.lastError = null;
    // Kept apart from `lastError` on purpose: a refused UPGRADE is expected and
    // must never be reported as the reason a price is missing.
    this.baselineError = null;
    this.rejectedFilters = [];
    this.gatewayErrors = 0;
    this.consecutiveErrors = 0;
    this.stats = { snapshots: 0, requests: 0, errors: 0, rows: 0 };
  }

  // Baseline first, upgrade second. See the note on CANDIDATE_FILTERS.
  //
  // If the baseline itself fails the probe is NOT marked done: that is a
  // connectivity, entitlement or gateway problem rather than a fact about the
  // account's filters, and it will usually have cleared by the next poll. Latching
  // a decision made during an outage would leave the terminal degraded until the
  // process restarted.
  async _probe(sample) {
    if (this.probed) return this.filter;

    try {
      const rows = await this.sessionService.quotes(sample, BASELINE_FILTER);
      if (!Array.isArray(rows) || !rows.length) {
        // The gateway answered and had nothing to say about these instruments.
        // That is a real answer, so the baseline stands.
        this._settle(BASELINE_FILTER, []);
        return this.filter;
      }
      this._settle(BASELINE_FILTER, rows);
    } catch (err) {
      if (err instanceof BrokerAuthError || err.isAuth) throw err;
      this.lastError = err.message;
      this.baselineError = err.message;
      this.gatewayErrors += isGatewayError(err) ? 1 : 0;
      // Use ltp for this poll but do not remember the decision.
      this.filter = BASELINE_FILTER;
      throw err;
    }

    // The optional upgrade. Every failure here is expected — the account may
    // simply not be entitled — so nothing is logged as an error and, crucially,
    // `lastError` is left alone: a refused upgrade must never be reported as
    // "the quote request is failing".
    for (const candidate of RICHER_FILTERS) {
      let rows;
      try {
        rows = await this.sessionService.quotes(sample, candidate);
      } catch (err) {
        if (err instanceof BrokerAuthError || err.isAuth) throw err;
        this.rejectedFilters.push(candidate);
        continue;
      }
      if (Array.isArray(rows) && rows.length && isRich(rows)) {
        this._settle(candidate, rows);
        return this.filter;
      }
      this.rejectedFilters.push(candidate);
    }
    return this.filter;
  }

  _settle(filter, rows) {
    this.filter = filter;
    this.probed = true;
    this.coverage = rows.length ? neo.quoteCoverage(rows).available : { ltp: true };
    const fields = Object.entries(this.coverage)
      .filter(([, v]) => v).map(([k]) => k).join(', ');
    logger.info('quoteSource: filter selected', { label: this.label, filter, fields });
    if (filter === BASELINE_FILTER) {
      logger.warn('quoteSource: this account answers only the `ltp` quote filter — '
        + 'open interest, volume and the bid/ask spread are unavailable, so the chain '
        + 'columns that need them render as unavailable rather than as zero',
      { label: this.label, tried: this.rejectedFilters.join(', ') || 'none yet' });
    }
  }

  // `instruments` is [{ token, segment }]. Returns a Map keyed by token so the
  // caller never has to match rows back by request order.
  async snapshot(instruments) {
    const list = (instruments || []).filter(i => i && i.token);
    const out = new Map();
    if (!list.length) return out;

    if (!this.probed) await this._probe(list.slice(0, Math.min(2, list.length)));

    for (let i = 0; i < list.length; i += this.batchSize) {
      const batch = list.slice(i, i + this.batchSize);
      let rows;
      try {
        rows = await this.sessionService.quotes(batch, this.filter);
        this.stats.requests += 1;
      } catch (err) {
        this.stats.errors += 1;
        this.lastError = describe(err);
        this.consecutiveErrors += 1;
        if (isGatewayError(err)) this.gatewayErrors += 1;
        if (err instanceof BrokerAuthError || err.isAuth) throw err;
        // One failed batch is one gap in the chain, not a failed snapshot. The
        // strikes that did answer are still worth rendering.
        continue;
      }
      this._merge(out, batch, rows);
    }
    this.stats.snapshots += 1;
    this.stats.rows += out.size;
    if (out.size) { this.lastError = null; this.consecutiveErrors = 0; }
    return out;
  }

  // Match rows back to the instruments that were asked for. Kotak echoes the
  // instrument under different keys depending on segment and filter, so the
  // token is looked for first and request order is the last resort — the same
  // rule the ticker's poller follows, for the same reason.
  _merge(out, batch, rows) {
    const list = Array.isArray(rows) ? rows : [];
    for (let i = 0; i < list.length; i++) {
      const quote = neo.readQuoteFull(list[i]);
      let match = null;
      for (const id of quote.ids) {
        match = batch.find(b => String(b.token) === id);
        if (match) break;
      }
      if (!match && list.length === batch.length) match = batch[i];
      if (!match) continue;
      out.set(String(match.token), quote);
    }
  }

  status() {
    return {
      filter: this.filter,
      probed: this.probed,
      coverage: this.coverage,
      lastError: this.lastError,
      gatewayErrors: this.gatewayErrors,
      consecutiveErrors: this.consecutiveErrors,
      rejectedFilters: this.rejectedFilters,
      stats: { ...this.stats },
    };
  }
}

// Kotak's gateway answers a route it cannot serve with an HTML error page, and
// axios puts the whole document in `err.message`. Dumping several hundred bytes
// of markup into a status field or a toast makes the actual cause unreadable,
// so the page is reduced to the sentence it contains plus the advice that goes
// with it.
function describe(err) {
  const raw = String((err && err.message) || 'unknown error');
  if (!/<html|<body|<h2/i.test(raw)) return raw.slice(0, 300);

  const status = (raw.match(/HTTP\s+(\d{3})/i) || [])[1] || '';
  // The page repeats the status in its heading and again in its body, so the
  // status words are stripped and what remains is the one sentence that says
  // something.
  const sentence = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/\b(?:quotes:\s*)?HTTP\s*(?:Server\s*Error\s*)?\d{3}\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'no detail';

  if (status === '503' || /No available server/i.test(sentence)) {
    return `HTTP 503 from Kotak's gateway ("${sentence}"). `
      + 'That is the gateway refusing to route the request, not the broker saying it has '
      + 'no data — it is what an unroutable quote path or an out-of-hours quote service '
      + 'looks like. Run `node scripts/diagnose-spot.js` to see which filters answer.';
  }
  return `HTTP ${status || '5xx'} from Kotak's gateway: ${sentence}`.slice(0, 400);
}

module.exports = { QuoteSource, CANDIDATE_FILTERS, BASELINE_FILTER, RICHER_FILTERS, isRich, isGatewayError, describe };
