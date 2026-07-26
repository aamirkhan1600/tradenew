// The instrument bridge — the single most load-bearing piece of this platform.
//
// Two brokers, two instrument masters, no shared identifier:
//   Zerodha  addresses an option by a numeric instrument_token on its ticker
//   Kotak    needs its own pSymbol token plus a trading symbol to place an order
//
// They are joined on what the contract actually IS:
//     (underlying, expiry_date, strike, option_type)
// Both syncs write into the same row from opposite sides; a row with both sides
// present becomes `tradable`. Anything else is quotable-but-not-orderable (or
// the reverse) and the scanner refuses to select it — the alternative is a
// strategy that finds a perfect strike and then cannot trade it.
//
// Both masters must be synced before trading, and both change daily as contracts
// are added and expire.

const axios = require('axios');
const config = require('../config');
const logger = require('../core/logger');
const kite = require('../brokers/zerodha/kiteClient');
const neo = require('../brokers/kotak/neoClient');
const repo = require('../repositories');

const UNDERLYINGS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX']);

// Index (spot) rows have no expiry or strike, but they cannot be stored as NULL:
// MySQL treats NULLs as distinct in a UNIQUE index, so `ON DUPLICATE KEY UPDATE`
// would never match and every sync would insert a fresh duplicate. These
// sentinels make the key comparable. Both are unreachable as real contract
// values, so they cannot collide with an option.
const INDEX_SENTINEL = { expiryDate: '1970-01-01', strike: 0 };

// Index spot symbols as Kite names them, plus published token fallbacks so a
// fresh install can read spot before its first sync completes.
const INDEX = {
  NIFTY: { kiteSymbol: 'NIFTY 50', fallbackToken: 256265 },
  BANKNIFTY: { kiteSymbol: 'NIFTY BANK', fallbackToken: 260105 },
  FINNIFTY: { kiteSymbol: 'NIFTY FIN SERVICE', fallbackToken: 257801 },
  MIDCPNIFTY: { kiteSymbol: 'NIFTY MID SELECT', fallbackToken: 288009 },
  SENSEX: { kiteSymbol: 'SENSEX', fallbackToken: 265 },
  BANKEX: { kiteSymbol: 'BANKEX', fallbackToken: 274441 },
};

/* --------------------------------------------------------------- parsing -- */
// Both masters are simple CSVs — no embedded commas or quoted newlines.
function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/);
  while (lines.length && !lines[0].trim()) lines.shift();
  if (!lines.length) return { header: {}, rows: [] };
  const cols = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const header = {};
  cols.forEach((c, i) => { header[c.toLowerCase()] = i; });
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    rows.push(lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, '')));
  }
  return { header, rows };
}

const isoDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim()) ? String(s).trim() : null);

/* --------------------------------------------------------------- Zerodha -- */
// Kite CSV columns:
//   instrument_token, exchange_token, tradingsymbol, name, last_price, expiry,
//   strike, tick_size, lot_size, instrument_type, segment, exchange
async function syncZerodha() {
  const results = {};
  let total = 0;

  for (const exchange of ['NFO', 'BFO']) {
    const { header: H, rows } = parseCsv(await kite.instrumentsCsv(exchange));
    if (H.instrument_token === undefined) {
      logger.warn('instrumentStore: unexpected Kite headers', { exchange });
      results[exchange] = 0;
      continue;
    }
    const batch = [];
    for (const c of rows) {
      const name = String(c[H.name] || '').toUpperCase();
      const type = String(c[H.instrument_type] || '').toUpperCase();
      if (!UNDERLYINGS.has(name)) continue;
      if (type !== 'CE' && type !== 'PE') continue;
      const strike = Number(c[H.strike]);
      const expiry = isoDate(c[H.expiry]);
      if (!Number.isFinite(strike) || strike <= 0 || !expiry) continue;

      batch.push({
        underlying: name, expiryDate: expiry, strike, optionType: type,
        a: Number(c[H.instrument_token]),          // z_token
        b: c[H.tradingsymbol],                     // z_symbol
        c: c[H.exchange] || exchange,              // z_exchange
        lotSize: parseInt(c[H.lot_size], 10) || null,
        tickSize: Number(c[H.tick_size]) || null,
      });
    }
    results[exchange] = await repo.instruments.upsertMany(batch, 'z');
    total += results[exchange];
  }

  // Index spot rows, so the engine can read the underlying's price. They have no
  // strike or expiry, which the (underlying, expiry, strike, type) unique key
  // handles because MySQL treats NULLs as distinct — hence option_type 'IDX'
  // as the discriminator.
  for (const exchange of ['NSE', 'BSE']) {
    const { header: H, rows } = parseCsv(await kite.instrumentsCsv(exchange));
    if (H.instrument_token === undefined) continue;
    const wanted = new Map();
    for (const [underlying, meta] of Object.entries(INDEX)) {
      wanted.set(meta.kiteSymbol.toUpperCase(), underlying);
    }
    const batch = [];
    for (const c of rows) {
      const symbol = String(c[H.tradingsymbol] || '').toUpperCase();
      const underlying = wanted.get(symbol);
      if (!underlying) continue;
      batch.push({
        underlying,
        expiryDate: INDEX_SENTINEL.expiryDate,
        strike: INDEX_SENTINEL.strike,
        optionType: 'IDX',
        a: Number(c[H.instrument_token]), b: c[H.tradingsymbol], c: c[H.exchange] || exchange,
        lotSize: null, tickSize: null,
      });
    }
    if (batch.length) {
      results[exchange] = await repo.instruments.upsertMany(batch, 'z');
      total += results[exchange];
    }
  }

  logger.info('instrumentStore: Zerodha sync complete', { total, results });
  return { total, results };
}

/* ----------------------------------------------------------------- Kotak -- */
// Kotak's `lExpiryDate` counts seconds from 1980-01-01, not the Unix epoch —
// a 10-year offset that silently produces 1970s dates if taken literally. Older
// files sometimes do use Unix seconds or milliseconds, so all three are tried
// and the one landing in a plausible contract window wins.
const NEO_EPOCH_OFFSET_S = 315532800;

function neoExpiryToIso(raw) {
  const e = parseInt(raw, 10);
  if (!Number.isFinite(e) || e <= 0) return null;
  const nowSec = Date.now() / 1000;
  for (const seconds of [e + NEO_EPOCH_OFFSET_S, e, Math.floor(e / 1000)]) {
    if (seconds > nowSec - 365 * 86400 && seconds < nowSec + 5 * 365 * 86400) {
      const d = new Date(seconds * 1000);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

// Some Neo files express the strike in paise (22000 as 2200000).
function neoStrike(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v >= 100000 ? Number((v / 100).toFixed(4)) : Number(v.toFixed(4));
}

function pick(header, names) {
  for (const n of names) {
    const idx = header[n.toLowerCase()];
    if (idx !== undefined) return idx;
  }
  return undefined;
}

async function syncKotak(session) {
  let paths;
  try {
    const baseUrl = (session.baseUrl || config.neo.apiBase).replace(/\/+$/, '');
    const res = await axios.get(`${baseUrl}/script-details/1.0/masterscrip/file-paths`, {
      timeout: 30000,
      headers: { Authorization: session.sessionToken, accept: 'application/json' },
    });
    paths = res.data?.data?.filesPaths || [];
  } catch (err) {
    throw new Error(`Kotak master file list failed: ${err.message}`);
  }

  const wanted = paths.filter(p => /(nse_fo|bse_fo)\.csv/i.test(p));
  if (!wanted.length) throw new Error('Kotak master returned no F&O files');

  const results = {};
  let total = 0;

  for (const url of wanted) {
    const segment = (url.match(/\/([a-z]+_[a-z]+)(?:-v\d+)?\.csv/i) || [])[1]?.toLowerCase();
    if (!segment) continue;

    let text;
    try {
      const res = await axios.get(url, {
        responseType: 'text', timeout: 120000, transformResponse: (x) => x,
      });
      text = res.data;
    } catch (err) {
      logger.warn('instrumentStore: Kotak file download failed', { url, err: err.message });
      continue;
    }

    const { header: H, rows } = parseCsv(text);
    const I = {
      token: pick(H, ['pSymbol', 'lInstrumentToken', 'instrumentToken']),
      instType: pick(H, ['pInstType', 'pInstName', 'instrumentType']),
      underlying: pick(H, ['pSymbolName', 'pSymName', 'symbolName']),
      tradingSymbol: pick(H, ['pTrdSymbol', 'tradingSymbol']),
      optionType: pick(H, ['pOptionType', 'pOpType', 'optionType', 'pOptType']),
      strike: pick(H, ['dStrikePrice', 'strikePrice', 'strike']),
      expiry: pick(H, ['lExpiryDate', 'expiryDate', 'expiry']),
      lotSize: pick(H, ['lLotSize', 'lotSize']),
      tickSize: pick(H, ['lTickSize', 'tickSize']),
    };
    if (I.token === undefined || I.tradingSymbol === undefined || I.underlying === undefined) {
      logger.warn('instrumentStore: unexpected Kotak headers', { segment, headers: Object.keys(H).slice(0, 20) });
      continue;
    }

    const batch = [];
    for (const c of rows) {
      const instType = String(c[I.instType] || '').toUpperCase();
      const underlying = String(c[I.underlying] || '').toUpperCase();
      if (instType !== 'OPTIDX') continue;
      if (!UNDERLYINGS.has(underlying)) continue;

      const optionType = String(c[I.optionType] || '').toUpperCase();
      if (optionType !== 'CE' && optionType !== 'PE') continue;

      const strike = neoStrike(c[I.strike]);
      const expiry = neoExpiryToIso(c[I.expiry]);
      const token = c[I.token];
      const tradingSymbol = c[I.tradingSymbol];
      if (!token || !tradingSymbol || strike == null || !expiry) continue;

      const rawTick = Number(c[I.tickSize]);
      batch.push({
        underlying, expiryDate: expiry, strike, optionType,
        a: String(token),                          // k_token
        b: tradingSymbol,                          // k_symbol
        c: segment,                                // k_segment
        lotSize: parseInt(c[I.lotSize], 10) || null,
        tickSize: Number.isFinite(rawTick) && rawTick > 0
          ? Number((rawTick >= 100 ? rawTick / 100 : rawTick).toFixed(4)) : null,
      });
    }
    results[segment] = await repo.instruments.upsertMany(batch, 'k');
    total += results[segment];
  }

  logger.info('instrumentStore: Kotak sync complete', { total, results });
  return { total, results };
}

/* ------------------------------------------------------------------ both -- */
// Below this, a Zerodha sync is assumed to have gone wrong (a truncated
// download, a changed CSV format) and pruning is skipped. Deleting the whole
// option universe because one download half-failed would be far worse than
// carrying a few stale rows.
const MIN_PLAUSIBLE_OPTION_ROWS = 500;

async function syncAll(kotakSession) {
  // Take the cutoff BEFORE any write. Every row either sync touches gets
  // synced_at = NOW(), so anything still older than this afterwards is a
  // contract neither broker lists any more.
  const cutoff = await repo.instruments.now();

  const zerodha = await syncZerodha();
  let kotak = { total: 0, results: {}, skipped: 'no Kotak session' };
  if (kotakSession?.sessionToken) {
    kotak = await syncKotak(kotakSession);
  } else {
    logger.warn('instrumentStore: Kotak sync skipped — no session; nothing will be tradable');
  }

  // Prune contracts that survived neither sync: expired series, delisted
  // strikes, and — the reason this exists — anything a test or a manual insert
  // left behind. A stale row that still carries both brokers' tokens would look
  // perfectly tradable to the scanner while pointing at a contract that no
  // longer exists.
  let pruned = 0;
  if (zerodha.total >= MIN_PLAUSIBLE_OPTION_ROWS) {
    pruned = await repo.instruments.pruneStale(cutoff);
    if (pruned) logger.info('instrumentStore: pruned contracts absent from both masters', { pruned });
  } else {
    logger.warn('instrumentStore: skipping the prune — the Zerodha sync returned too few rows to trust',
      { rows: zerodha.total, minimum: MIN_PLAUSIBLE_OPTION_ROWS });
  }

  const bridged = await repo.instruments.refreshTradableFlags();
  return { zerodha, kotak, pruned, rowsEvaluated: bridged };
}

// Spot instrument token, preferring the synced row and falling back to the
// published constant so a first run is not blind.
async function indexToken(underlying) {
  const stored = await repo.instruments.indexToken(underlying);
  if (stored) return stored;
  const fallback = INDEX[String(underlying).toUpperCase()]?.fallbackToken;
  return fallback != null ? String(fallback) : null;
}

module.exports = {
  UNDERLYINGS, INDEX, INDEX_SENTINEL,
  syncZerodha, syncKotak, syncAll, indexToken, parseCsv,
};
