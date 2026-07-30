// Kotak Neo Trade API — raw HTTP. The only execution venue and the only price
// source in this platform.
//
// Auth is two-step and deliberately interactive:
//   1. tradeApiLogin(mobile, ucc, totp)  -> a short-lived "view" token + sid
//   2. tradeApiValidate(mpin)            -> the trading session token, sid and a
//                                           per-user baseUrl to talk to
// MPIN and TOTP are forwarded once and never persisted — they are the second
// factor, and storing them would defeat the point of having one.
//
// Two quirks that break naive clients:
//   * `Authorization` carries the plain API token with NO "Bearer " scheme.
//   * Trading endpoints are form-encoded as `jData=<url-encoded JSON>`, not
//     JSON bodies.
//
// Failures are classified into the three outcomes the engine must distinguish:
//   rejected  — the broker said no; retrying unchanged fails identically
//   uncertain — the request left but no answer came back; the order MAY be live
//   auth      — the session is dead; stop and re-login

const axios = require('axios');
const config = require('../config');
const logger = require('../core/logger');
const {
  BrokerAuthError, BrokerRejectedError, BrokerUncertainError, AppError,
} = require('../core/errors');

const TIMEOUT_MS = 15000;

const clean = (v) => (v == null ? '' : String(v).replace(/[\s\r\n]+/g, ' ').trim());

function requireApiToken() {
  if (!config.neo.apiToken) {
    throw new AppError(
      'NEO_API_TOKEN is empty — copy it from NEO App → Invest → Trade API → Your Applications',
      412, 'neo_token_missing');
  }
  return config.neo.apiToken;
}

// The distinction between "rejected" and "uncertain" is the whole game: a
// rejection is safe to react to, an uncertain outcome must never be retried
// because the order may already exist at the exchange.
function classify(err, step, { sent = false } = {}) {
  const res = err.response;

  if (!res) {
    // No response at all — timeout, DNS, socket reset. If the request had
    // already left, we genuinely do not know whether it was executed.
    const Kind = sent ? BrokerUncertainError : BrokerRejectedError;
    return new Kind(`${step}: ${err.message}`, { code: err.code });
  }

  const data = res.data || {};
  const message = data.message || data.emsg || data.errMsg || data.error
    || (typeof data === 'string' ? data.slice(0, 200) : null) || err.message;

  if (res.status === 401 || res.status === 403) {
    return new BrokerAuthError(`${step}: ${message}`, { status: res.status, data });
  }
  if (res.status >= 500) {
    // The gateway accepted the bytes and then failed. "Never processed" and
    // "processed then crashed" are indistinguishable from here.
    const Kind = sent ? BrokerUncertainError : BrokerRejectedError;
    return new Kind(`${step}: HTTP ${res.status} ${message}`, { status: res.status, data });
  }
  return new BrokerRejectedError(`${step}: ${message}`, { status: res.status, data });
}

/* ------------------------------------------------------------------ login - */

async function tradeApiLogin({ mobile, ucc, totp }) {
  const apiToken = requireApiToken();
  const m = clean(mobile); const u = clean(ucc); const t = clean(totp);
  if (!m || !u || !t) {
    throw new AppError('mobile, ucc and totp are all required', 400, 'validation_error');
  }

  let data;
  try {
    const res = await axios.post(
      `${config.neo.loginUrl}/login/1.0/tradeApiLogin`,
      { mobileNumber: m, ucc: u, totp: t },
      {
        timeout: TIMEOUT_MS,
        headers: {
          Authorization: apiToken,              // plain — no "Bearer"
          'neo-fin-key': config.neo.finKey,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
      });
    data = res.data;
  } catch (err) {
    throw classify(err, 'tradeApiLogin');
  }

  const inner = data?.data || data || {};
  const viewToken = clean(inner.token);
  const viewSid = clean(inner.sid);
  if (!viewToken || !viewSid) {
    logger.warn('neoClient: login response missing token/sid',
      { keys: Object.keys(inner).slice(0, 15) });
    throw new BrokerRejectedError(
      `tradeApiLogin: ${data?.message || 'no view token returned — check mobile / UCC / TOTP'}`,
      { data });
  }
  return { viewToken, viewSid, ucc: inner.ucc || u, greetingName: inner.greetingName };
}

async function tradeApiValidate({ viewToken, viewSid, mpin }) {
  const apiToken = requireApiToken();
  const pin = clean(mpin);
  if (!viewToken || !viewSid) throw new AppError('missing view token / sid', 400, 'validation_error');
  if (!pin) throw new AppError('mpin is required', 400, 'validation_error');

  let data;
  try {
    const res = await axios.post(
      `${config.neo.loginUrl}/login/1.0/tradeApiValidate`,
      { mpin: pin },
      {
        timeout: TIMEOUT_MS,
        headers: {
          Authorization: apiToken,
          Auth: viewToken,
          sid: viewSid,
          'neo-fin-key': config.neo.finKey,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
      });
    data = res.data;
  } catch (err) {
    throw classify(err, 'tradeApiValidate');
  }

  const inner = data?.data || data || {};
  const sessionToken = clean(inner.token);
  if (!sessionToken) {
    throw new BrokerRejectedError(
      `tradeApiValidate: ${data?.message || 'no session token returned — check the MPIN'}`,
      { data });
  }
  return {
    sessionToken,
    sid: clean(inner.sid) || viewSid,
    baseUrl: (inner.baseUrl || '').trim() || config.neo.apiBase,
    ucc: inner.ucc,
    userName: inner.greetingName || inner.ucc,
  };
}

/* --------------------------------------------------- authenticated calls -- */

// `session` = { sessionToken, sid, baseUrl }
async function call(session, { method = 'POST', path, jData = null, sent = false }) {
  if (!session?.sessionToken || !session?.sid) {
    throw new BrokerAuthError('no Kotak session — re-login required');
  }
  const baseUrl = (session.baseUrl || config.neo.apiBase).replace(/\/+$/, '');
  const headers = {
    Auth: session.sessionToken,
    Sid: session.sid,
    'neo-fin-key': config.neo.finKey,
    accept: 'application/json',
  };

  let body;
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (jData != null) {
      const params = new URLSearchParams();
      params.set('jData', JSON.stringify(jData));
      body = params.toString();
    }
  }

  try {
    const res = await axios({ method, url: baseUrl + path, timeout: TIMEOUT_MS, headers, data: body });
    return res.data;
  } catch (err) {
    throw classify(err, `neo ${path}`, { sent });
  }
}

/* ------------------------------------------------------------------ orders */

// Prices cross this boundary in RUPEES, because that is what Kotak's wire format
// expects. Everything above this function works in paise; `orderRouter` is the
// only caller and it converts once, here.
function toJData(order) {
  return {
    am: 'NO',
    dq: '0',
    es: order.segment,                                   // nse_fo
    mp: String(order.marketProtection || 0),
    pc: order.product,                                   // NRML / MIS
    pf: 'N',
    pr: String(order.limitPrice || 0),
    pt: order.orderType,                                 // MKT / L / SL / SL-M
    qt: String(order.qty),
    rt: order.validity || 'DAY',
    tp: String(order.triggerPrice || 0),
    ts: order.tradingSymbol,
    tt: order.side === 'BUY' ? 'B' : 'S',
  };
}

// `sent: true` — from here on a failure without a response means the order MAY
// be live at the exchange, which is what turns a timeout into an uncertain
// outcome rather than a retryable one.
async function placeOrder(session, order) {
  const response = await call(session, {
    method: 'POST', path: '/quick/order/rule/ms/place', jData: toJData(order), sent: true,
  });
  // Neo replies { stat: 'Ok', nOrdNo } or { stat: 'Not_Ok', emsg, stCode }.
  if (response?.stat !== 'Ok' || !response?.nOrdNo) {
    throw new BrokerRejectedError(
      response?.emsg || `order rejected (stCode ${response?.stCode ?? '?'})`,
      { response });
  }
  return { brokerOrderId: String(response.nOrdNo), raw: response };
}

async function cancelOrder(session, { brokerOrderId }) {
  return call(session, {
    method: 'POST',
    path: '/quick/order/cancel',
    jData: { on: String(brokerOrderId), am: 'NO' },
    sent: true,
  });
}

async function orderBook(session) {
  return call(session, { method: 'GET', path: '/quick/user/orders' });
}

async function orderHistory(session, brokerOrderId) {
  return call(session, {
    method: 'POST', path: '/quick/order/history', jData: { nOrdNo: String(brokerOrderId) },
  });
}

async function positions(session) {
  return call(session, { method: 'GET', path: '/quick/user/positions' });
}

async function checkMargin(session, order) {
  const jData = {
    es: order.segment,
    brkName: 'KOTAK',
    pCode: order.product,
    tok: String(order.token || ''),
    trnsTp: order.side === 'BUY' ? 'B' : 'S',
    prcTp: order.orderType,
    qty: String(order.qty),
    prc: String(order.limitPrice || 0),
  };
  return call(session, { method: 'POST', path: '/quick/user/check-margin', jData });
}

/* ------------------------------------------------------------ market data - */

// Quotes REST. This endpoint does NOT follow the trading-call convention:
//
//   GET <baseUrl>/script-details/1.0/quotes/neosymbol/<seg>|<tok>[,...]/<filter>
//   Headers: Authorization: <the app's API token> — and nothing else. No
//            neo-fin-key, no Auth, no Sid. Sending them makes it fail.
//
// Only the `ltp` filter is used: it is the one this account class is reliably
// entitled to, and richer filters have been observed to return rows that do not
// echo the requested token at all.
async function quotes(session, queries, filter = 'ltp') {
  if (!Array.isArray(queries) || !queries.length) return [];
  const apiToken = requireApiToken();
  const baseUrl = (session?.baseUrl || config.neo.apiBase).replace(/\/+$/, '');

  // The path carries `|` between segment and token and `,` between queries. Both
  // are structural, so each component is encoded on its own and the delimiters
  // restored — encoding the whole path breaks the gateway's parsing and it
  // answers with an empty result rather than an error.
  const path = queries
    .map(q => `${q.segment}|${q.token}`)
    .map(s => encodeURIComponent(s).replace(/%7C/gi, '|'))
    .join(',');

  let res;
  try {
    res = await axios.get(
      `${baseUrl}/script-details/1.0/quotes/neosymbol/${path}/${encodeURIComponent(filter)}`,
      { timeout: TIMEOUT_MS, headers: { Authorization: apiToken, accept: 'application/json' } });
  } catch (err) {
    throw classify(err, 'quotes');
  }
  const data = res.data;
  return Array.isArray(data) ? data : (data?.data || []);
}

// Pull (token, ltp) out of a quotes row. Kotak echoes the instrument under one
// of several key names depending on segment and filter, so every plausible
// identifier is offered back rather than guessing one.
function readQuoteRow(row) {
  const ltp = Number(
    row?.ltp ?? row?.LTP ?? row?.lp ?? row?.last_price ?? row?.last_traded_price ?? NaN);
  const ids = [
    row?.exchange_token, row?.exchangeToken, row?.token, row?.tk,
    row?.symbol, row?.tradingSymbol, row?.tSym, row?.trdSym,
  ].filter(v => v != null).map(String);
  return { ltp: Number.isFinite(ltp) && ltp > 0 ? ltp : null, ids };
}

/* ---------------------------------------------------- rich quote fields --- */

// The option chain wants OI, volume, bid, ask and the day's OHLC. Whether any of
// them arrive depends on the account's entitlement and on which quote filter the
// gateway honours, and Kotak spells each field several ways across filters and
// segments. So every field is looked up under every spelling that has been
// observed, and ANYTHING NOT FOUND IS null — never 0.
//
// That distinction is the whole point of this function. An option chain that
// prints 0 in the OI column looks like a strike nobody holds; one that prints an
// em-dash looks like a column the broker did not send. The first is a lie a
// trader can act on.
const QUOTE_KEYS = {
  ltp: ['ltp', 'LTP', 'lp', 'last_price', 'last_traded_price', 'lastPrice'],
  open: ['open', 'op', 'openPrice', 'o', 'dayOpen'],
  high: ['high', 'h', 'hp', 'highPrice', 'dayHigh'],
  low: ['low', 'l', 'lo', 'lowPrice', 'dayLow'],
  close: ['close', 'c', 'cp', 'prevClose', 'previousClose', 'closePrice', 'pc'],
  volume: ['volume', 'v', 'vol', 'volumeTraded', 'tradedVolume', 'totalTradedVolume', 'ttv', 'vtt'],
  oi: ['oi', 'OI', 'openInterest', 'open_interest', 'opnInterest', 'oiCur'],
  // Kotak reports a previous-day open interest under its own set of names. The
  // chain's "OI change" is this subtracted from `oi`; where it is missing the
  // change is null rather than equal to the OI itself.
  prevOi: ['prevOi', 'previousOi', 'oiPrev', 'prev_open_interest', 'poi'],
  bid: ['bid', 'bp', 'bidPrice', 'bestBid', 'bp1', 'buyPrice'],
  ask: ['ask', 'sp', 'askPrice', 'bestAsk', 'sp1', 'sellPrice', 'offerPrice'],
  bidQty: ['bidQty', 'bq', 'bq1', 'bidQuantity', 'buyQty'],
  askQty: ['askQty', 'sq', 'sq1', 'askQuantity', 'sellQty'],
};

function firstNumber(row, keys) {
  for (const k of keys) {
    if (row[k] === undefined || row[k] === null || row[k] === '') continue;
    const n = Number(row[k]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Kotak's richer filters NEST their payload instead of flattening it:
//
//   ltp   -> { exchange_token, ltp }
//   ohlc  -> { exchange_token, ohlc: { open, high, low, close } }
//   depth -> { exchange_token, depth: { buy: [{price, quantity, orders} …],
//                                       sell: [ … ] } }
//
// and each filter returns ONLY its own block — there is no combined response.
// Read flat-only, an `ohlc` row looks like a row with nothing in it, which is
// how a filter that works gets classified as one that does not.
function flatten(row) {
  const flat = { ...row };
  const ohlc = row.ohlc;
  if (ohlc && typeof ohlc === 'object') {
    for (const k of ['open', 'high', 'low', 'close']) {
      if (flat[k] === undefined && ohlc[k] !== undefined) flat[k] = ohlc[k];
    }
  }
  const depth = row.depth;
  if (depth && typeof depth === 'object') {
    // The best bid and offer are the FIRST rung of each ladder. The rest of the
    // book is not carried: nothing in this platform trades off level two.
    const bid = Array.isArray(depth.buy) ? depth.buy[0] : null;
    const ask = Array.isArray(depth.sell) ? depth.sell[0] : null;
    if (bid) {
      if (flat.bid === undefined) flat.bid = bid.price;
      if (flat.bidQty === undefined) flat.bidQty = bid.quantity;
    }
    if (ask) {
      if (flat.ask === undefined) flat.ask = ask.price;
      if (flat.askQty === undefined) flat.askQty = ask.quantity;
    }
  }
  return flat;
}

function readQuoteFull(raw) {
  if (!raw || typeof raw !== 'object') return { ids: [] };
  const row = flatten(raw);
  const out = { ids: readQuoteRow(row).ids };
  for (const [field, keys] of Object.entries(QUOTE_KEYS)) {
    out[field] = firstNumber(row, keys);
  }
  // A price of 0 means "no trade yet", which is absent rather than free.
  for (const field of ['ltp', 'open', 'high', 'low', 'close', 'bid', 'ask']) {
    if (out[field] !== null && out[field] <= 0) out[field] = null;
  }
  // Open interest and volume of exactly 0 ARE meaningful — a strike can
  // legitimately have neither — so they are left as they came.
  out.oiChange = (out.oi !== null && out.prevOi !== null) ? out.oi - out.prevOi : null;
  return out;
}

// Which of the interesting fields a batch of rows actually carried. The terminal
// reports this to the browser so a column the broker never sends is labelled
// unavailable once, at the top, rather than as a table full of dashes the
// operator has to interpret.
function quoteCoverage(rows) {
  const fields = ['ltp', 'open', 'high', 'low', 'close', 'volume', 'oi', 'oiChange', 'bid', 'ask'];
  const seen = {};
  for (const f of fields) seen[f] = 0;
  for (const raw of rows || []) {
    const q = readQuoteFull(raw);
    for (const f of fields) if (q[f] !== null && q[f] !== undefined) seen[f] += 1;
  }
  const total = (rows || []).length;
  const available = {};
  for (const f of fields) available[f] = total > 0 && seen[f] > 0;
  return { total, counts: seen, available };
}

/* ------------------------------------------------------- order-book shape - */

// Kotak's order book uses short, inconsistent keys and spells the status in
// several ways. Everything that reads the book goes through this so the
// vocabulary lives in one place.
function normaliseBookRow(row) {
  if (!row || typeof row !== 'object') return null;
  const brokerOrderId = row.nOrdNo ?? row.norenordno ?? row.orderId ?? row.ordNo;
  if (brokerOrderId == null) return null;

  const rawStatus = String(row.ordSt ?? row.status ?? row.stat ?? '').toLowerCase();
  let status = 'WORKING';
  if (/reject/.test(rawStatus)) status = 'REJECTED';
  else if (/cancel/.test(rawStatus)) status = 'CANCELLED';
  else if (/complete|filled|traded|executed/.test(rawStatus)) status = 'FILLED';
  else if (/open|pending|trigger|modif|replac/.test(rawStatus)) status = 'WORKING';

  const filledQty = Number(row.fldQty ?? row.filledQty ?? row.fillshares ?? 0) || 0;
  const totalQty = Number(row.qty ?? row.orderQty ?? row.qty_ ?? 0) || 0;
  const avgPrice = Number(row.avgPrc ?? row.avgPrice ?? row.flprc ?? row.prc ?? 0) || 0;

  // A book that reports a partial fill without saying so in the status is
  // common enough to normalise here rather than in three call sites.
  if (status === 'WORKING' && filledQty > 0 && totalQty > 0 && filledQty < totalQty) {
    status = 'PARTIAL';
  }

  return {
    brokerOrderId: String(brokerOrderId),
    status,
    rawStatus,
    filledQty,
    totalQty,
    avgPrice,
    rejectionReason: row.rejRsn ?? row.rejReason ?? row.emsg ?? null,
    tradingSymbol: row.trdSym ?? row.tsym ?? row.sym ?? null,
  };
}

function readOrderBook(response) {
  const rows = Array.isArray(response) ? response : (response?.data || response?.stat === 'Ok' ? response.data : []);
  return (rows || []).map(normaliseBookRow).filter(Boolean);
}

module.exports = {
  tradeApiLogin, tradeApiValidate,
  placeOrder, cancelOrder, orderBook, orderHistory, positions, checkMargin,
  quotes, readQuoteRow, readQuoteFull, quoteCoverage, QUOTE_KEYS,
  normaliseBookRow, readOrderBook, flattenQuoteRow: flatten,
};
