// Kotak Neo Trade API — raw HTTP. THE ONLY EXECUTION VENUE IN THIS PLATFORM.
//
// Auth is two-step and deliberately interactive:
//   1. tradeApiLogin(mobile, ucc, totp)  -> a short-lived "view" token + sid
//   2. tradeApiValidate(mpin)            -> the trading session token, sid and
//                                           a per-user baseUrl to talk to
// MPIN and TOTP are forwarded once and never persisted — they are the second
// factor, and storing them would defeat the point of having one.
//
// Two quirks that break naive clients:
//   * `Authorization` carries the plain API token with NO "Bearer " scheme.
//   * Trading endpoints are form-encoded as `jData=<url-encoded JSON>`,
//     not JSON bodies.
//
// Errors are classified into the three outcomes the engine must distinguish:
//   rejected  — the broker said no; retrying unchanged will fail identically
//   uncertain — the request left but no answer came back; the order MAY be live
//   auth      — the session is dead; stop and re-login

const axios = require('axios');
const config = require('../../config');
const logger = require('../../core/logger');
const {
  BrokerAuthError, BrokerRejectedError, BrokerUncertainError, AppError,
} = require('../../core/errors');

const TIMEOUT_MS = 15000;
const BROKER = 'kotak';

const clean = (v) => (v == null ? '' : String(v).replace(/[\s\r\n]+/g, ' ').trim());

function requireApiToken() {
  if (!config.neo.apiToken) {
    throw new AppError(
      'NEO_API_TOKEN is empty — copy it from NEO App → Invest → Trade API → Your Applications',
      412, 'neo_token_missing');
  }
  return config.neo.apiToken;
}

// Turn an axios failure into one of our typed errors. The distinction between
// "rejected" and "uncertain" is the whole game: a rejection is safe to react
// to, an uncertain outcome must never be retried because the order may exist.
function classify(err, step, { sent = false } = {}) {
  const res = err.response;

  if (!res) {
    // No response at all — timeout, DNS, socket reset. If the request had
    // already left, we genuinely do not know whether it was executed.
    const kind = sent ? BrokerUncertainError : BrokerRejectedError;
    return new kind(`${step}: ${err.message}`, BROKER, { code: err.code });
  }

  const data = res.data || {};
  const message = data.message || data.emsg || data.errMsg || data.error
    || (typeof data === 'string' ? data.slice(0, 200) : null) || err.message;

  if (res.status === 401 || res.status === 403) {
    return new BrokerAuthError(`${step}: ${message}`, BROKER, { status: res.status, data });
  }
  if (res.status >= 500) {
    // The gateway accepted the bytes and then failed. Cannot distinguish
    // "never processed" from "processed then crashed".
    const kind = sent ? BrokerUncertainError : BrokerRejectedError;
    return new kind(`${step}: HTTP ${res.status} ${message}`, BROKER, { status: res.status, data });
  }
  return new BrokerRejectedError(`${step}: ${message}`, BROKER, { status: res.status, data });
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
    logger.warn('neoClient: login response missing token/sid', { keys: Object.keys(inner).slice(0, 15) });
    throw new BrokerRejectedError(
      `tradeApiLogin: ${data?.message || 'no view token returned — check mobile / UCC / TOTP'}`,
      BROKER, { data });
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
      BROKER, { data });
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
    throw new BrokerAuthError('no Kotak session — re-login required', BROKER);
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
function toJData(order) {
  return {
    am: order.afterMarket ? 'YES' : 'NO',
    dq: String(order.discQty || 0),
    es: order.segment,                                   // nse_fo etc
    mp: String(order.marketProtection || 0),
    pc: order.product,                                   // MIS / NRML
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
      BROKER, { response });
  }
  return { brokerOrderId: String(response.nOrdNo), raw: response };
}

async function cancelOrder(session, { brokerOrderId, tradingSymbol = null, afterMarket = false }) {
  const jData = { on: String(brokerOrderId), am: afterMarket ? 'YES' : 'NO' };
  if (afterMarket && tradingSymbol) jData.ts = tradingSymbol;
  return call(session, { method: 'POST', path: '/quick/order/cancel', jData, sent: true });
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
  if (order.triggerPrice) jData.trgPrc = String(order.triggerPrice);
  return call(session, { method: 'POST', path: '/quick/user/check-margin', jData });
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

module.exports = {
  BROKER,
  tradeApiLogin, tradeApiValidate,
  placeOrder, cancelOrder, checkMargin, orderBook, orderHistory, positions,
};
