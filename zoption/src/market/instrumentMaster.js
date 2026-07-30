// The instrument master — one broker, one token.
//
// Kotak Neo addresses an instrument as `segment|token` for BOTH quoting and
// ordering, so a contract needs exactly one identifier. This file pulls Kotak's
// scrip files, keeps the NIFTY option rows plus the index row spot comes from,
// and marks a row `tradable` when it carries everything an order requires.
//
// Synced once a session. A stale row points at a contract that no longer exists
// and the strike selector would happily choose it.

const axios = require('axios');
const config = require('../config');
const logger = require('../core/logger');
const repo = require('../repositories');

// NIFTY today; the SDD lists the other three as future expansion and they cost
// nothing to carry in the master.
const UNDERLYINGS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']);

// Index rows have no expiry or strike, but they cannot be stored as NULL: MySQL
// treats NULLs as distinct in a UNIQUE index, so ON DUPLICATE KEY UPDATE would
// never match and every sync would insert a fresh duplicate. Both sentinels are
// unreachable as real contract values.
const INDEX_SENTINEL = { expiryDate: '1970-01-01', strike: 0 };

const INDEX = {
  NIFTY: { segment: 'nse_cm', quoteSymbol: 'Nifty 50', names: ['nifty50', 'nifty'] },
  BANKNIFTY: { segment: 'nse_cm', quoteSymbol: 'Nifty Bank', names: ['niftybank', 'banknifty'] },
  FINNIFTY: { segment: 'nse_cm', quoteSymbol: 'Nifty Fin Service', names: ['niftyfinservice', 'finnifty'] },
  MIDCPNIFTY: { segment: 'nse_cm', quoteSymbol: 'Nifty Midcap Select', names: ['niftymidcapselect', 'midcpnifty'] },
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const INDEX_BY_NAME = new Map();
for (const [underlying, meta] of Object.entries(INDEX)) {
  INDEX_BY_NAME.set(norm(meta.quoteSymbol), underlying);
  for (const n of meta.names) INDEX_BY_NAME.set(norm(n), underlying);
}

/* --------------------------------------------------------------- parsing -- */

// The master files are simple CSVs — no embedded commas, no quoted newlines.
//
// The header is not clean, though, and the mess is load-bearing. Kotak ships
// column names with trailing spaces (`lExpiryDate `, `dTickSize `) and at least
// one with a trailing SEMICOLON (`dStrikePrice;`). A plain trim() handles the
// spaces and misses the semicolon, so the strike column silently fails to
// resolve — and a row with no strike is dropped, which is how a sync returns
// zero contracts while reporting no error at all.
const cleanHeader = (h) => h.trim().replace(/^"|"$/g, '').replace(/[;:,]+$/, '').trim();

function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/);
  while (lines.length && !lines[0].trim()) lines.shift();
  if (!lines.length) return { header: {}, rows: [] };
  const cols = lines[0].split(',').map(cleanHeader);
  const header = {};
  cols.forEach((c, i) => { header[c.toLowerCase()] = i; });
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    rows.push(lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, '')));
  }
  return { header, rows };
}

// Kotak's `lExpiryDate` counts seconds from 1980-01-01, not the Unix epoch — a
// ten-year offset that silently produces 1970s dates if taken literally. Older
// files sometimes do use Unix seconds or milliseconds, so all three are tried
// and whichever lands in a plausible contract window wins.
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

// `dStrikePrice` is ALWAYS in paise, for every underlying — the file shows a
// 240-strike stock option as 24000 and a 12000-strike index option as 1.2e+06.
// (Large values arrive in scientific notation, which Number() reads correctly.)
//
// An earlier version of this divided by 100 only above a threshold, on the
// theory that some files used rupees. They do not, and that heuristic quietly
// multiplied every low strike by a hundred.
function neoStrike(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Number((v / 100).toFixed(4));
}

// Same story for `dTickSize`: 5 means five paise, i.e. ₹0.05 — the NSE option
// tick. Storing it as ₹5 would round every limit price to the nearest five
// rupees and have the exchange reject them all.
function neoTickSize(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Number((v / 100).toFixed(4));
}

function pick(header, names) {
  for (const n of names) {
    const idx = header[n.toLowerCase()];
    if (idx !== undefined) return idx;
  }
  return undefined;
}

/* ------------------------------------------------------------ file paths -- */

// The scrip master follows the QUOTES convention, not the trading one:
//
//   Authorization: <the app's API token>    — and nothing else.
//
// Sending the session token instead earns a 424 Failed Dependency whose body
// reads `Consumer key '<the session JWT>' ...` — the gateway wanted the app's
// consumer key and was handed a user session. That message is only visible in
// the response BODY, which is why every failure below carries its body forward:
// a bare "status code 424" is unactionable.
//
// The session-authenticated variant is kept as a fallback in case Kotak aligns
// this endpoint with the trading calls, but it is tried second.
const MASTER_ENDPOINTS = [
  { path: '/script-details/1.0/masterscrip/file-paths', auth: 'apiToken' },
  { path: '/script-details/1.0/masterscrip/file-paths', auth: 'session' },
];

function describeHttpError(err) {
  const res = err.response;
  if (!res) return err.message;
  const body = res.data;
  const detail = typeof body === 'string'
    ? body.slice(0, 300)
    : JSON.stringify(body || {}).slice(0, 300);
  return `HTTP ${res.status} ${detail}`;
}

async function filePaths(session) {
  const baseUrl = (session.baseUrl || config.neo.apiBase).replace(/\/+$/, '');
  const attempts = [];

  for (const variant of MASTER_ENDPOINTS) {
    const headers = { accept: 'application/json' };
    headers.Authorization = variant.auth === 'apiToken'
      ? config.neo.apiToken
      : session.sessionToken;
    // The trading calls need these; the quotes call breaks when they are sent.
    // The master endpoint has been observed to want them, so they go on the
    // session-authenticated variants only.
    if (variant.auth === 'session') {
      headers.Sid = session.sid;
      headers.Auth = session.sessionToken;
      headers['neo-fin-key'] = config.neo.finKey;
    }

    try {
      const res = await axios.get(baseUrl + variant.path, { timeout: 30000, headers });
      const paths = res.data?.data?.filesPaths || res.data?.filesPaths || [];
      if (paths.length) {
        if (attempts.length) {
          logger.info('instrumentMaster: master endpoint resolved',
            { path: variant.path, auth: variant.auth, afterFailures: attempts.length });
        }
        return paths;
      }
      attempts.push(`${variant.path} [${variant.auth}]: 200 but no filesPaths in the response`);
    } catch (err) {
      attempts.push(`${variant.path} [${variant.auth}]: ${describeHttpError(err)}`);
    }
  }

  throw new Error('Kotak master file list failed — every known endpoint refused:\n  '
    + attempts.join('\n  '));
}

async function download(url) {
  const res = await axios.get(url, {
    responseType: 'text', timeout: 120000, transformResponse: (x) => x,
  });
  return res.data;
}

const segmentOf = (url) => (url.match(/\/([a-z]+_[a-z]+)(?:-v\d+)?\.csv/i) || [])[1]?.toLowerCase();

/* ---------------------------------------------------------- option chain -- */

// Kotak versions some of these files and not others — today the list carries
// `nse_fo.csv` but `nse_cm-v1.csv`. Matching the bare name would silently skip
// the versioned ones, which is how the cash master (and therefore spot, and
// therefore every ATM calculation) goes quietly missing.
const fileMatcher = (segment) => new RegExp(`/${segment}(?:-v\\d+)?\\.csv$`, 'i');

async function syncOptions(session, paths) {
  const wanted = paths.filter(p => fileMatcher('nse_fo').test(p));
  if (!wanted.length) {
    throw new Error('Kotak master returned no NSE F&O file — got: '
      + paths.map(p => p.split('/').pop()).join(', '));
  }

  let total = 0;
  for (const url of wanted) {
    const segment = segmentOf(url);
    if (!segment) continue;

    let text;
    try {
      text = await download(url);
    } catch (err) {
      logger.warn('instrumentMaster: F&O download failed', { url, err: err.message });
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
      logger.warn('instrumentMaster: unexpected Kotak F&O headers',
        { segment, headers: Object.keys(H).slice(0, 20) });
      continue;
    }

    const batch = [];
    // Counted so a sync that drops everything can say WHICH check rejected the
    // rows. "0 contracts, no error" is the least debuggable outcome there is.
    const rejected = { instType: 0, underlying: 0, optionType: 0, strike: 0, expiry: 0, ids: 0 };

    for (const c of rows) {
      if (String(c[I.instType] || '').toUpperCase() !== 'OPTIDX') { rejected.instType++; continue; }
      const underlying = String(c[I.underlying] || '').toUpperCase();
      if (!UNDERLYINGS.has(underlying)) { rejected.underlying++; continue; }

      const optionType = String(c[I.optionType] || '').toUpperCase();
      if (optionType !== 'CE' && optionType !== 'PE') { rejected.optionType++; continue; }

      const strike = neoStrike(c[I.strike]);
      if (strike == null) { rejected.strike++; continue; }

      const expiry = neoExpiryToIso(c[I.expiry]);
      if (!expiry) { rejected.expiry++; continue; }

      const token = c[I.token];
      const tradingSymbol = c[I.tradingSymbol];
      if (!token || !tradingSymbol) { rejected.ids++; continue; }

      batch.push({
        underlying, expiryDate: expiry, strike, optionType,
        token: String(token), symbol: tradingSymbol, segment,
        lotSize: parseInt(c[I.lotSize], 10) || null,
        tickSize: neoTickSize(c[I.tickSize]),
      });
    }

    if (!batch.length && rows.length) {
      logger.error('instrumentMaster: every F&O row was rejected — the file format has changed', {
        segment, rows: rows.length, rejected,
        headers: Object.keys(H).slice(0, 25),
      });
    } else {
      logger.info('instrumentMaster: parsed F&O rows',
        { segment, kept: batch.length, of: rows.length });
    }
    total += await repo.instruments.upsertMany(batch);
  }
  return total;
}

/* ------------------------------------------------------- index spot rows -- */

// The cash master is large (every listed equity) and only a handful of rows
// matter, so the filter is on the NAME rather than an instrument-type code: the
// type spelling drifts between files, the index names do not.
async function syncIndices(session, paths) {
  const wanted = paths.filter(p => fileMatcher('nse_cm').test(p));
  if (!wanted.length) {
    // Not fatal on its own, but it means no spot price — and without spot there
    // is no ATM, so no cycle can ever open. Worth saying loudly.
    logger.warn('instrumentMaster: no NSE cash file in the master — spot will be unavailable',
      { files: paths.map(p => p.split('/').pop()) });
  }
  let total = 0;

  for (const url of wanted) {
    const segment = segmentOf(url);
    if (!segment) continue;

    let text;
    try {
      text = await download(url);
    } catch (err) {
      logger.warn('instrumentMaster: cash download failed', { url, err: err.message });
      continue;
    }

    const { header: H, rows } = parseCsv(text);
    const I = {
      token: pick(H, ['pSymbol', 'lInstrumentToken', 'instrumentToken']),
      tradingSymbol: pick(H, ['pTrdSymbol', 'tradingSymbol']),
      symbolName: pick(H, ['pSymbolName', 'pSymName', 'symbolName']),
      desc: pick(H, ['pDesc', 'pScripName', 'description']),
    };
    if (I.token === undefined) continue;

    const seen = new Set();
    const batch = [];
    for (const c of rows) {
      const candidates = [c[I.tradingSymbol], c[I.symbolName], c[I.desc]].filter(Boolean);
      let underlying = null;
      for (const name of candidates) {
        underlying = INDEX_BY_NAME.get(norm(name));
        if (underlying) break;
      }
      if (!underlying || seen.has(underlying)) continue;
      if (INDEX[underlying].segment !== segment) continue;
      const token = c[I.token];
      if (!token) continue;

      seen.add(underlying);
      batch.push({
        underlying,
        expiryDate: INDEX_SENTINEL.expiryDate,
        strike: INDEX_SENTINEL.strike,
        optionType: 'IDX',
        token: String(token),
        symbol: c[I.tradingSymbol] || INDEX[underlying].quoteSymbol,
        segment,
        lotSize: null, tickSize: null,
      });
    }
    if (batch.length) total += await repo.instruments.upsertMany(batch);
  }
  return total;
}

/* ------------------------------------------------------------------ sync -- */

// Below this, a sync is assumed to have gone wrong (a truncated download, a
// changed CSV format) and pruning is skipped. Deleting the option universe
// because one download half-failed is far worse than carrying stale rows.
const MIN_PLAUSIBLE_OPTION_ROWS = 500;

async function syncAll(session) {
  if (!session?.sessionToken) {
    throw new Error('a Kotak session is required to sync instruments');
  }

  // Taken BEFORE any write: every row the sync touches gets synced_at = NOW(),
  // so anything still older afterwards is a contract Kotak no longer lists.
  const cutoff = await repo.instruments.now();
  const paths = await filePaths(session);

  const options = await syncOptions(session, paths);
  const indices = await syncIndices(session, paths);

  let pruned = 0;
  if (options >= MIN_PLAUSIBLE_OPTION_ROWS) {
    pruned = await repo.instruments.pruneStale(cutoff);
  } else {
    logger.warn('instrumentMaster: skipping the prune — the sync returned too few rows to trust',
      { rows: options, minimum: MIN_PLAUSIBLE_OPTION_ROWS });
  }

  await repo.instruments.refreshTradableFlags();
  logger.info('instrumentMaster: sync complete', { options, indices, pruned });
  return { options, indices, pruned };
}

// The spot instrument, addressed the way the QUOTES API will actually answer.
//
// AN INDEX IS QUOTED BY NAME, NOT BY ITS TOKEN. This is not a preference or a
// fallback — it is the only addressing that works, verified against the live
// gateway:
//
//     nse_cm|26000       -> HTTP 200, and an EMPTY array
//     nse_cm|Nifty 50    -> HTTP 200, {"exchange_token":"Nifty 50","ltp":"24317.15"}
//     nse_fo|65867       -> HTTP 200, {"exchange_token":"65867","ltp":"23.20"}   (options are fine by token)
//
// The empty array is what makes this so hard to see. The gateway does not
// refuse, it does not error, it answers successfully with nothing — so every
// layer above reports "no price for this instrument" and none of them is wrong.
//
// This function used to prefer the stored numeric token and treat the name as a
// degraded fallback for an unsynced master. It had it exactly backwards: once
// the cash master synced, the index became UNQUOTABLE, and with it went the
// spot price, the ATM, the trend filter's entire bar series and therefore every
// entry the engine could ever make.
//
// The numeric token is still returned as `exchangeToken` because the binary
// WebSocket feed addresses instruments that way — the two transports genuinely
// disagree, and only the REST path is proven to work on this account class.
async function indexInstrument(underlying) {
  const key = String(underlying).toUpperCase();
  const stored = await repo.instruments.indexInstrument(key);
  const meta = INDEX[key];

  if (meta) {
    return {
      token: meta.quoteSymbol,               // what the quotes API answers to
      segment: meta.segment,
      symbol: stored?.symbol || meta.quoteSymbol,
      exchangeToken: stored?.token || null,  // what the binary socket answers to
      quoteBy: 'name',
    };
  }
  // An underlying this file carries no name for. The stored token is all there
  // is, and it may well answer with nothing — but guessing a name would be
  // worse than trying what the master published.
  return stored?.token ? { ...stored, quoteBy: 'token' } : null;
}

module.exports = {
  UNDERLYINGS, INDEX, INDEX_SENTINEL,
  parseCsv, cleanHeader, neoExpiryToIso, neoStrike, neoTickSize,
  syncOptions, syncIndices, syncAll, indexInstrument,
};
