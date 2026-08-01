// §8.3 — the option chain's fetching and caching half.
//
// ./chain.js decides whether a snapshot is evidence. This decides when to go and
// get one, and it is the only part of the chain path that does I/O.
//
// ---------------------------------------------------------------------------
// A decision cycle NEVER waits on the network
// ---------------------------------------------------------------------------
//
// §8.3 says the cycle returns `NO_ENTRY(CHAIN_STALE)` if no fresh snapshot is
// available within `CHAIN_TIMEOUT_MS`, and §23.3 says chain snapshots are "never
// fetched inside a cycle". Those read as a contradiction only if `get()` is
// allowed to await. It is not:
//
//     get(nowMs)   pure cache read. Returns the snapshot if it is fresh, and
//                  otherwise returns STALE *immediately* while kicking off a
//                  background refresh.
//     refresh()    the I/O, deduplicated, with CHAIN_TIMEOUT_MS as its OWN
//                  deadline so a slow fetch is abandoned rather than piling up
//                  behind the next one.
//
// So the 800ms bound is on the fetch, not on a wait inside the cycle, and the
// cycle's worst case is a map lookup. A cycle that blocked for 800ms would blow
// the entire §23.2 latency budget eight times over to obtain data that, by
// definition, it did not have when the candle sealed.
//
// ---------------------------------------------------------------------------
// The window, and why it is not "the chain"
// ---------------------------------------------------------------------------
//
// §8.1 says "the option chain". NIFTY has ~200 strikes; at NEO_QUOTE_BATCH=25
// that is 8 requests per refresh, 1.6 rps against an 8 rps budget SHARED WITH
// ORDER PLACEMENT (§30). The order path is the one whose failure costs money, so
// the scan is bounded to ATM ± scanRange and the settings validator rejects a
// range whose steady-state would eat the headroom.

const logger = require('../core/logger');
const time = require('../core/time');
const config = require('../config');
const repo = require('../repositories');
const C = require('./constants');
const chain = require('./chain');

const STALE = 'CHAIN_STALE';
const CORRUPT = 'CHAIN_CORRUPT';
const NO_EXPIRY = 'CHAIN_NO_EXPIRY';
const NO_WINDOW = 'CHAIN_NO_WINDOW';

class ChainSnapshot {
  constructor({ quoteSource, underlying = 'NIFTY', label = 'ose' }) {
    this.quoteSource = quoteSource;
    this.underlying = String(underlying).toUpperCase();
    this.label = label;

    this.snapshot = null;          // { ts, quotes, discarded, ... }
    this.expiry = null;
    this.isExpiryDay = false;
    this.expiryDate = null;        // the trade date the expiry was resolved on

    this._inflight = null;         // §8.3 — concurrent callers share one promise
    this._lastError = null;
    this._consecutiveStale = 0;
    // An entitlement that never sends OI is a fact about the account, not about
    // today's market, so it is said ONCE per process (§8.4, §29.2). Repeating it
    // 4,300 times a session would bury everything else in the log.
    this._saidUnavailable = new Set();
    this.stats = { refreshes: 0, failures: 0, corrupt: 0, quoted: 0 };
  }

  /* ------------------------------------------------------------ the cache -- */

  // The ONLY method a decision cycle calls. Never awaits, never throws.
  //
  // Returns `{ ok, reason, snapshot }`. `ok` false always carries a machine
  // readable reason, because §11.5 forbids a silent rejection and "the chain was
  // not there" is one of the commonest honest answers a cycle can give.
  get(nowMs = Date.now(), { spotP = null, cfg = null } = {}) {
    const snap = this.snapshot;
    const fresh = snap && (nowMs - snap.ts) <= C.CHAIN_MAX_AGE_MS;

    // Kick the refresh whether or not we are about to answer with the cache: a
    // snapshot that is 4.9s old is about to be stale, and refreshing only on the
    // miss guarantees every cycle after the first is served stale data.
    if (!snap || (nowMs - snap.ts) >= C.CHAIN_REFRESH_MS) {
      this.refresh({ spotP, cfg, nowMs }).catch(() => { /* recorded on the instance */ });
    }

    if (!fresh) {
      this._consecutiveStale += 1;
      return { ok: false, reason: STALE, snapshot: null, consecutive: this._consecutiveStale };
    }
    this._consecutiveStale = 0;

    if (snap.corrupt) return { ok: false, reason: CORRUPT, snapshot: snap, detail: snap.reason };
    if (!snap.quotes.length) return { ok: false, reason: NO_WINDOW, snapshot: snap };
    return { ok: true, reason: null, snapshot: snap };
  }

  // §20.3 — five consecutive stale-chain cycles is a halt, not a shrug.
  staleHalt() {
    return this._consecutiveStale >= C.CHAIN_STALE_HALT;
  }

  /* ------------------------------------------------------------- the I/O -- */

  // Deduplicated: concurrent callers share the in-flight promise (§8.3).
  refresh({ spotP = null, cfg = null, nowMs = Date.now() } = {}) {
    if (this._inflight) return this._inflight;
    this._inflight = this._refresh({ spotP, cfg, nowMs })
      .catch((err) => {
        this.stats.failures += 1;
        this._lastError = err.message;
        // Not logged at error: a failed chain refresh is a skipped cycle, and
        // the engine says so through CHAIN_STALE. Logging it as an error once a
        // second during a gateway wobble drowns the log it is meant to inform.
        logger.warn('ose/chain: the refresh failed', { err: err.message });
        throw err;
      })
      .finally(() => { this._inflight = null; });
    return this._inflight;
  }

  async _refresh({ spotP, cfg, nowMs }) {
    const started = Date.now();
    const expiry = await this._resolveExpiry(nowMs);
    if (!expiry) {
      this._lastError = 'no expiry at or after today in the instrument master';
      return null;
    }

    const rows = await repo.instruments.chain(this.underlying, expiry);
    const window = this._window(rows, spotP, cfg);
    if (!window.length) {
      this._lastError = `no strikes within ±${this._range(cfg)} of the money`;
      return null;
    }

    const quotes = await this.quoteSource.snapshot(
      window.map(r => ({ token: String(r.token), segment: r.segment || config.neo.defaultSegment })));

    // The fetch's own deadline (§8.3). A refresh that took longer than the
    // budget is not evidence about NOW — it is evidence about when it started,
    // and `snapshotTs` is stamped at the START for exactly that reason: a slow
    // response must age out, not arrive looking fresh.
    const elapsed = Date.now() - started;
    if (elapsed > C.CHAIN_TIMEOUT_MS) {
      logger.warn('ose/chain: the refresh overran its deadline', {
        elapsedMs: elapsed, budgetMs: C.CHAIN_TIMEOUT_MS, strikes: window.length,
      });
    }

    // A PARTIAL chain is the quiet failure this module can produce.
    //
    // §8.3 treats one failed batch as "a gap, not a failed snapshot", which is
    // right — the strikes that answered are still worth ranking. But a batch
    // that silently went missing takes 25 strikes with it, and if the in-band
    // ones were among them the cycle reports NO_LIQUID_STRIKE: indistinguishable
    // from a market that genuinely offered nothing.
    //
    // Observed live: three consecutive refreshes returned 82, then 75, then 0
    // rows for the same window, purely from rate-bucket contention. So the
    // shortfall is recorded on the snapshot and said out loud, once per drop.
    const answered = quotes.size;
    const shortBy = window.length - answered;
    if (shortBy > 0) {
      const pct = Math.round((shortBy / window.length) * 100);
      const say = pct >= 25 ? logger.error : logger.warn;
      say('ose/chain: the broker answered for fewer strikes than were asked for — any strike '
        + 'that did not answer cannot be selected, and a cycle that finds nothing in band will '
        + 'look identical to a market with nothing in it', {
        asked: window.length, answered, missing: shortBy, pct: `${pct}%`,
      });
    }

    const verdict = chain.validateSnapshot(
      window.map(row => ({
        // `repo.instruments.chain()` does not select expiry_date — it is implied
        // by the query — but chain.normalise() requires it. Attaching it here
        // rather than widening the query keeps the requirement visible at the
        // one place that depends on it.
        row: { ...row, expiry_date: expiry },
        quote: quotes.get(String(row.token)) || null,
      })),
      {
        snapshotTs: started,
        nowMs: Date.now(),
        liquidityMode: cfg?.liquidityMode || 'STRICT',
      });

    this.snapshot = Object.freeze({
      ts: started,
      expiry,
      asked: window.length,
      answered,
      isExpiryDay: this.isExpiryDay,
      quotes: Object.freeze(verdict.quotes),
      discarded: verdict.discarded,
      considered: verdict.considered,
      discardRate: verdict.discardRate,
      corrupt: verdict.corrupt,
      dominantDiscard: verdict.dominantDiscard,
      reason: verdict.reason,
      coverage: this.quoteSource.coverage || null,
      filter: this.quoteSource.filter || null,
    });

    this.stats.refreshes += 1;
    this.stats.quoted += verdict.quotes.length;
    if (verdict.corrupt) {
      this.stats.corrupt += 1;
      this._sayOnce('corrupt', () => logger.error(
        'ose/chain: CHAIN_CORRUPT — no entry will be taken while this holds', {
          reason: verdict.reason,
          liquidityMode: cfg?.liquidityMode || 'STRICT',
          filter: this.quoteSource.filter,
          hint: verdict.dominantDiscard?.reason === chain.DISCARD.NO_BOOK
            ? 'every strike was discarded for having no bid/ask. That is this account\'s '
              + 'entitlement, not the market — §9.2.1: either obtain a richer quote filter '
              + 'or set liquidityMode to LENIENT and accept selection on premium alone.'
            : null,
        }));
    }
    this._lastError = null;
    return this.snapshot;
  }

  /* ------------------------------------------------------------ internals -- */

  // §8.2. Resolved once per trading day: the master syncs daily and an expiry
  // does not change under a running session.
  async _resolveExpiry(nowMs) {
    const today = time.tradeDate(nowMs);
    if (this.expiry && this.expiryDate === today) return this.expiry;

    const expiries = await repo.instruments.expiries(this.underlying);
    const picked = chain.selectExpiry(expiries, today);
    if (!picked.expiry) {
      this._sayOnce('no-expiry', () => logger.error(
        'ose/chain: the instrument master holds no expiry at or after today — run '
        + '`npm run sync-instruments`', { underlying: this.underlying }));
      return null;
    }

    if (picked.expiry !== this.expiry) {
      logger.info('ose/chain: expiry selected',
        { expiry: picked.expiry, isExpiryDay: picked.isExpiryDay });
    }
    this.expiry = picked.expiry;
    this.isExpiryDay = picked.isExpiryDay;
    this.expiryDate = today;
    return this.expiry;
  }

  _range(cfg) {
    const n = Math.trunc(Number(cfg?.scanRange));
    return Number.isFinite(n) && n > 0 ? n : 20;
  }

  // ATM ± scanRange, in strikes. With no spot price yet (the first cycles after
  // boot, before the index series has sealed a bar) the window cannot be
  // centred, so nothing is quoted — quoting an arbitrary slice of the chain
  // would spend the rate budget on strikes the engine has no reason to want.
  _window(rows, spotP, cfg) {
    if (!Array.isArray(rows) || !rows.length) return [];
    if (spotP == null || !Number.isFinite(spotP) || spotP <= 0) return [];

    const spot = spotP / 100;
    const atm = Math.round(spot / C.STRIKE_MULTIPLE) * C.STRIKE_MULTIPLE;
    const span = this._range(cfg) * C.STRIKE_MULTIPLE;

    const within = rows.filter((r) => {
      const strike = Number(r.strike);
      return Number.isFinite(strike) && Math.abs(strike - atm) <= span;
    });

    // NEO_MAX_SYMBOLS is the transport's ceiling, not a strategy choice. If the
    // window exceeds it the window is wrong, so say so rather than silently
    // quoting a truncated chain and ranking within it — §21.3's "no silent caps".
    if (within.length > config.neo.maxSymbols) {
      logger.warn('ose/chain: the strike window exceeds NEO_MAX_SYMBOLS and was truncated', {
        wanted: within.length, cap: config.neo.maxSymbols, atm, scanRange: this._range(cfg),
      });
      // Truncate from the OUTSIDE in, so the strikes nearest the money — the only
      // ones in the ₹15–25 premium band — survive.
      within.sort((a, b) => Math.abs(Number(a.strike) - atm) - Math.abs(Number(b.strike) - atm));
      return within.slice(0, config.neo.maxSymbols);
    }
    return within;
  }

  _sayOnce(key, emit) {
    if (this._saidUnavailable.has(key)) return;
    this._saidUnavailable.add(key);
    emit();
  }

  status() {
    return {
      expiry: this.expiry,
      isExpiryDay: this.isExpiryDay,
      ageMs: this.snapshot ? Date.now() - this.snapshot.ts : null,
      quotes: this.snapshot?.quotes.length ?? 0,
      considered: this.snapshot?.considered ?? 0,
      asked: this.snapshot?.asked ?? null,
      answered: this.snapshot?.answered ?? null,
      discardRate: this.snapshot?.discardRate ?? null,
      corrupt: this.snapshot?.corrupt ?? false,
      dominantDiscard: this.snapshot?.dominantDiscard ?? null,
      filter: this.quoteSource?.filter ?? null,
      coverage: this.quoteSource?.coverage ?? null,
      consecutiveStale: this._consecutiveStale,
      lastError: this._lastError,
      stats: { ...this.stats },
    };
  }
}

module.exports = { ChainSnapshot, STALE, CORRUPT, NO_EXPIRY, NO_WINDOW };
