// Yahoo Finance — historical bars for the INDEX, and nothing else.
//
// This exists because Kotak's Trade API has no historical-candles endpoint, so
// every chart in this platform starts empty and fills in only while the terminal
// is open. Yahoo carries the Indian indices going back years, which fixes that
// for the index chart and makes the index-side of the strategy backtestable.
//
// ---------------------------------------------------------------------------
// READ THIS BEFORE PLANNING A BACKTEST ON IT
// ---------------------------------------------------------------------------
//
// YAHOO HAS NO NSE OPTION DATA. None. `options('^NSEI')` returns zero
// expirations, and no option symbol in any spelling resolves — this was checked
// against the live API, not assumed. So:
//
//   * The index chart, the trend filter and anything that reads the underlying
//     CAN be backfilled and replayed from here.
//
//   * The strategy's ENTRY cannot. `doc/PROJECT_PLAN.md` §2 R1 is explicit that
//     the sell price is the OPTION contract's own closed candle plus an offset.
//     There is no source on Yahoo for that series at any price, so a full
//     backtest of entries, targets, stops and P&L needs option premiums that
//     only zoption's own recordings can supply.
//
// The other limit worth knowing up front is granularity. Yahoo's finest interval
// is 1 minute and it only retains about a week of it; the strategy's trend
// filter is configured at 5 SECONDS. A replay from here therefore tests the
// filter's logic at 1m and above, not at the timeframe it actually runs on.
//
// Retention, measured against the live API rather than taken from the docs:
//
//     1m    ~5 trading days
//     2m    ~10 days
//     5m    ~30 days
//     15m   ~45 days
//     30m   ~45 days
//     60m   ~2 years
//     1d    decades
//
// ---------------------------------------------------------------------------
//
// One more thing about the data itself: an INDEX has no traded volume, so every
// bar comes back with `volume: 0`. That is not a gap in the download; there is
// no such number. It is carried through as 0 rather than invented.

const path = require('path');
const logger = require('../core/logger');
const { ValidationError } = require('../core/errors');

// The intervals doc/hisotry.md asks for, mapped to how long a single request
// may span. Yahoo silently returns a short series rather than an error when a
// request reaches past the retention window, so the fetcher chunks against
// these rather than discovering the limit by getting less data than it asked
// for.
const INTERVALS = {
  '1m': { days: 7, chunkDays: 7 },
  '2m': { days: 60, chunkDays: 60 },
  '5m': { days: 60, chunkDays: 60 },
  '15m': { days: 60, chunkDays: 60 },
  '30m': { days: 60, chunkDays: 60 },
  '60m': { days: 730, chunkDays: 730 },
  '90m': { days: 60, chunkDays: 60 },
  '1d': { days: 36500, chunkDays: 36500 },
  '1wk': { days: 36500, chunkDays: 36500 },
  '1mo': { days: 36500, chunkDays: 36500 },
};

// What this platform calls an underlying, and what Yahoo calls it. The mapping
// is one-way on purpose: a caller may also pass a raw Yahoo symbol (`^NSEI`,
// `RELIANCE.NS`) and it is used as-is, so the service is not limited to the four
// indices this strategy happens to trade.
const SYMBOLS = {
  NIFTY: '^NSEI',
  NIFTY50: '^NSEI',
  BANKNIFTY: '^NSEBANK',
  NIFTYBANK: '^NSEBANK',
  FINNIFTY: '^CNXFIN',
  MIDCPNIFTY: '^NSEMDCP50',
  INDIAVIX: '^INDIAVIX',
  VIX: '^INDIAVIX',
  SENSEX: '^BSESN',
};

const DAY_MS = 24 * 60 * 60 * 1000;

// The library warns on stderr about the Node version on EVERY call. It is a
// real caveat — worth saying once, through the logger, where an operator will
// see it with the rest of the boot output — and pure noise the other nine
// hundred times. So the warning is captured at construction and re-emitted once.
let noticed = false;

function loadClient() {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const YahooFinance = require(path.join('yahoo-finance2')).default;
  const original = console.warn;
  let captured = null;
  console.warn = (...args) => {
    const text = args.map(String).join(' ');
    if (/yahoo-finance2/i.test(text)) { captured = text; return; }
    original.apply(console, args);
  };
  try {
    // `ripHistorical` is the deprecation notice for the old historical() method,
    // which this service does not use — it calls chart() directly.
    return new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
  } finally {
    console.warn = original;
    if (captured && !noticed) {
      noticed = true;
      logger.warn('yahoo: ' + captured.replace(/^\[yahoo-finance2\]\s*/, ''),
        { note: 'history downloads have been verified working on this Node version; '
          + 'upgrade if downloads start failing' });
    }
  }
}

/* ------------------------------------------------------------ validation -- */

function resolveSymbol(symbol) {
  const raw = String(symbol || '').trim();
  if (!raw) throw new ValidationError('symbol is required');
  if (raw.length > 32) throw new ValidationError('symbol is too long');
  const mapped = SYMBOLS[raw.toUpperCase().replace(/[^A-Z0-9]/g, '')];
  if (mapped) return mapped;
  // A raw Yahoo symbol. Restricted rather than passed through untouched: this
  // value lands in a URL path, and the set of characters a real ticker uses is
  // small.
  if (!/^[A-Za-z0-9.^=:-]+$/.test(raw)) {
    throw new ValidationError(`"${raw}" is not a symbol this service recognises`);
  }
  return raw;
}

function validateInterval(interval) {
  const key = String(interval || '1d').toLowerCase();
  if (!INTERVALS[key]) {
    throw new ValidationError(
      `interval must be one of ${Object.keys(INTERVALS).join(', ')} (got "${interval}")`);
  }
  return key;
}

// Accepts a Date, an epoch in milliseconds, or 'YYYY-MM-DD'. Returns epoch ms.
function parseDate(value, label) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new ValidationError(`${label} is not a valid date`);
    return value.getTime();
  }
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new ValidationError(`${label} is not a valid date`);
    // Ten digits is seconds, thirteen is milliseconds. Guessing wrong puts the
    // request in 1970 and Yahoo answers with an empty series rather than an
    // error, which is the least debuggable outcome available.
    return n < 1e11 ? n * 1000 : n;
  }
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(text)) {
    throw new ValidationError(`${label} must be YYYY-MM-DD or an epoch (got "${value}")`);
  }
  const ms = Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(ms)) throw new ValidationError(`${label} is not a valid date`);
  return ms;
}

/* --------------------------------------------------------------- service -- */

class YahooFinanceService {
  constructor({ client = null } = {}) {
    this._client = client;
    this.stats = { requests: 0, bars: 0, errors: 0 };
  }

  get client() {
    if (!this._client) this._client = loadClient();
    return this._client;
  }

  // The interval table, for a UI or an error message.
  static get intervals() { return Object.keys(INTERVALS); }

  static get symbols() { return { ...SYMBOLS }; }

  static maxDaysFor(interval) { return INTERVALS[validateInterval(interval)].days; }

  /* ------------------------------------------------------------- history -- */

  // `{ date, open, high, low, close, volume }` per doc/hisotry.md §6, ascending,
  // with `date` as an ISO string and `time` as epoch ms alongside it — the
  // string is what the specification asks for and the number is what everything
  // downstream actually arithmetics on.
  //
  // Requests longer than the interval's retention are CHUNKED rather than sent
  // whole, because Yahoo answers an over-long request with a short series and no
  // error at all.
  async getHistoricalData(symbol, interval = '1d', startDate = null, endDate = null) {
    const resolved = resolveSymbol(symbol);
    const iv = validateInterval(interval);
    const limits = INTERVALS[iv];

    const now = Date.now();
    let to = parseDate(endDate, 'endDate') ?? now;
    let from = parseDate(startDate, 'startDate') ?? (to - Math.min(limits.days, 30) * DAY_MS);
    if (from >= to) throw new ValidationError('startDate must be before endDate');
    // A request that starts before the interval's retention is not an error —
    // it just cannot be answered in full. It is clamped, and `truncated` says so
    // on the way out so a caller does not read a short series as a quiet market.
    const earliest = now - limits.days * DAY_MS;
    const truncated = from < earliest;
    if (truncated) from = earliest;
    if (to > now) to = now;

    const chunkMs = limits.chunkDays * DAY_MS;
    const seen = new Map();          // epoch ms -> bar, deduped across chunks
    let meta = null;

    for (let start = from; start < to; start += chunkMs) {
      const end = Math.min(to, start + chunkMs);
      const result = await this._chart(resolved, iv, start, end);
      if (!meta) meta = result.meta;
      for (const row of result.quotes || []) {
        // Yahoo emits a placeholder row for a bar it has no data for — a market
        // holiday, or the bar in progress before its first print. Dropping them
        // is not lossy: a bar with no close never existed.
        if (row == null || row.close == null) continue;
        const ms = row.date instanceof Date ? row.date.getTime() : Date.parse(row.date);
        if (!Number.isFinite(ms)) continue;
        seen.set(ms, {
          date: new Date(ms).toISOString(),
          time: ms,
          open: num(row.open, row.close),
          high: num(row.high, row.close),
          low: num(row.low, row.close),
          close: Number(row.close),
          // An index has no traded volume and Yahoo returns 0. Carried through
          // as 0 rather than invented — see the header.
          volume: Number(row.volume ?? 0) || 0,
        });
      }
    }

    const bars = [...seen.values()].sort((a, b) => a.time - b.time);
    this.stats.bars += bars.length;

    return {
      symbol: resolved,
      requested: String(symbol),
      interval: iv,
      from,
      to,
      truncated,
      // Yahoo reports the exchange's own timezone. It is echoed rather than
      // assumed: everything downstream buckets to IST, and a silent timezone
      // change would move every bar by hours without any error.
      timezone: meta ? (meta.exchangeTimezoneName || meta.timezone || null) : null,
      gmtOffset: meta ? (meta.gmtoffset ?? null) : null,
      count: bars.length,
      bars,
    };
  }

  async _chart(symbol, interval, fromMs, toMs) {
    this.stats.requests += 1;
    try {
      return await this.client.chart(symbol, {
        period1: new Date(fromMs),
        period2: new Date(toMs),
        interval,
      });
    } catch (err) {
      this.stats.errors += 1;
      // Yahoo's "no data found" is the answer to a symbol that does not exist,
      // which is a caller error rather than a service fault — and the most
      // common one, because a plausible-looking option symbol always fails.
      if (/No data found|Not Found|delisted/i.test(err.message)) {
        throw new ValidationError(
          `Yahoo has no data for "${symbol}" at ${interval}. `
          + 'Note that Yahoo carries NO NSE option contracts — only indices and equities.');
      }
      throw new Error(`Yahoo history request failed for ${symbol}: ${err.message}`);
    }
  }

  /* --------------------------------------------------------------- quote -- */

  async getQuote(symbol) {
    const resolved = resolveSymbol(symbol);
    this.stats.requests += 1;
    let q;
    try {
      q = await this.client.quote(resolved);
    } catch (err) {
      this.stats.errors += 1;
      throw new Error(`Yahoo quote failed for ${resolved}: ${err.message}`);
    }
    if (!q) throw new ValidationError(`Yahoo returned no quote for "${resolved}"`);
    return {
      symbol: resolved,
      name: q.shortName || q.longName || null,
      price: q.regularMarketPrice ?? null,
      previousClose: q.regularMarketPreviousClose ?? null,
      change: q.regularMarketChange ?? null,
      changePercent: q.regularMarketChangePercent ?? null,
      open: q.regularMarketOpen ?? null,
      high: q.regularMarketDayHigh ?? null,
      low: q.regularMarketDayLow ?? null,
      volume: q.regularMarketVolume ?? null,
      currency: q.currency || null,
      exchange: q.fullExchangeName || q.exchange || null,
      // Yahoo's own timestamp, so a caller can tell a live price from a
      // yesterday's-close price on a closed market.
      at: q.regularMarketTime ? new Date(q.regularMarketTime).toISOString() : null,
      marketState: q.marketState || null,
    };
  }

  /* -------------------------------------------------------------- search -- */

  async searchStocks(query, { limit = 10 } = {}) {
    const q = String(query || '').trim();
    if (!q) throw new ValidationError('a search query is required');
    if (q.length > 64) throw new ValidationError('the search query is too long');
    this.stats.requests += 1;
    let result;
    try {
      result = await this.client.search(q, { quotesCount: Math.min(25, Math.max(1, limit)) });
    } catch (err) {
      this.stats.errors += 1;
      throw new Error(`Yahoo search failed: ${err.message}`);
    }
    return (result.quotes || [])
      .filter(r => r.symbol)
      .slice(0, limit)
      .map(r => ({
        symbol: r.symbol,
        name: r.shortname || r.longname || null,
        exchange: r.exchDisp || r.exchange || null,
        type: r.quoteType || r.typeDisp || null,
      }));
  }

  status() {
    return { intervals: Object.keys(INTERVALS), symbols: SYMBOLS, stats: { ...this.stats } };
  }
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : Number(fallback);
}

module.exports = {
  YahooFinanceService,
  INTERVALS,
  SYMBOLS,
  resolveSymbol,
  validateInterval,
  parseDate,
  // One service per process: it holds a client with its own cookie/crumb state,
  // and building a second would re-do that handshake on every request.
  service: new YahooFinanceService(),
};
