// Zerodha Kite Connect v3 — REST. MARKET DATA ONLY.
//
// This module exposes exactly four things: session exchange, profile, quotes
// and the instrument master. There is no order, position or margin call here
// and there must never be one — in this platform Zerodha is the eyes and Kotak
// is the hands. Keeping the capability absent, rather than merely unused, is
// what makes that guarantee auditable.
//
// Auth: the user opens Kite's login page, approves, and is redirected back with
// a `request_token`. That is exchanged (with a SHA-256 checksum proving we hold
// the api_secret) for an access_token valid until ~06:00 IST the next day.

const axios = require('axios');
const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../core/logger');
const { BrokerAuthError, BrokerRejectedError, AppError } = require('../../core/errors');

const BROKER = 'zerodha';
const TIMEOUT_MS = 15000;
// /quote and /quote/ltp accept up to 500 instruments; 200 keeps URLs short.
const QUOTE_BATCH = 200;

const http = axios.create({
  baseURL: config.kite.apiBase,
  timeout: TIMEOUT_MS,
  headers: { 'X-Kite-Version': '3' },
});

function authHeader(apiKey, accessToken) {
  return { Authorization: `token ${apiKey}:${accessToken}` };
}

function toError(err, step) {
  const body = err.response?.data;
  const message = body?.message || err.message || 'kite request failed';
  const type = body?.error_type;
  // TokenException is Kite's "your access_token is dead" — always an auth
  // failure, whatever HTTP status accompanies it.
  if (type === 'TokenException' || err.response?.status === 403) {
    return new BrokerAuthError(`${step}: ${message}`, BROKER, { type, status: err.response?.status });
  }
  return new BrokerRejectedError(`${step}: ${message}`, BROKER, { type, status: err.response?.status });
}

async function call(step, cfg) {
  try {
    const res = await http.request(cfg);
    const body = res.data;
    if (body && body.status === 'error') {
      throw toError({ response: { data: body, status: res.status } }, step);
    }
    return body?.data !== undefined ? body.data : body;
  } catch (err) {
    if (err.name === 'BrokerAuthError' || err.name === 'BrokerRejectedError') throw err;
    throw toError(err, step);
  }
}

// Where the user must go to authorise us for the day.
function loginUrl(apiKey) {
  return `${config.kite.loginUrl}?v=3&api_key=${encodeURIComponent(apiKey)}`;
}

async function generateSession({ apiKey, apiSecret, requestToken }) {
  if (!apiKey || !apiSecret || !requestToken) {
    throw new AppError('apiKey, apiSecret and requestToken are all required', 400, 'validation_error');
  }
  const checksum = crypto.createHash('sha256')
    .update(String(apiKey) + String(requestToken) + String(apiSecret))
    .digest('hex');
  const body = new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum });
  return call('generateSession', {
    method: 'post',
    url: '/session/token',
    data: body.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

async function invalidateSession({ apiKey, accessToken }) {
  return call('invalidateSession', {
    method: 'delete',
    url: '/session/token',
    params: { api_key: apiKey, access_token: accessToken },
  });
}

async function profile({ apiKey, accessToken }) {
  return call('profile', { method: 'get', url: '/user/profile', headers: authHeader(apiKey, accessToken) });
}

// LTP for many instruments. `ids` are numeric instrument tokens (Kite also
// accepts "EXCHANGE:TRADINGSYMBOL"); the reply is keyed by whatever was sent,
// so it is normalised back to a token -> price Map for callers.
async function ltp({ apiKey, accessToken, ids }) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += QUOTE_BATCH) {
    const params = new URLSearchParams();
    for (const id of ids.slice(i, i + QUOTE_BATCH)) params.append('i', String(id));
    const data = await call('ltp', {
      method: 'get', url: '/quote/ltp', params, headers: authHeader(apiKey, accessToken),
    });
    for (const [key, row] of Object.entries(data || {})) {
      const token = row?.instrument_token != null ? String(row.instrument_token) : String(key);
      const price = Number(row?.last_price);
      if (Number.isFinite(price)) out.set(token, price);
    }
  }
  return out;
}

// Full quote — depth, OHLC, open interest. Used for liquidity checks.
async function quote({ apiKey, accessToken, ids }) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += QUOTE_BATCH) {
    const params = new URLSearchParams();
    for (const id of ids.slice(i, i + QUOTE_BATCH)) params.append('i', String(id));
    const data = await call('quote', {
      method: 'get', url: '/quote', params, headers: authHeader(apiKey, accessToken),
    });
    for (const [key, row] of Object.entries(data || {})) {
      out.set(row?.instrument_token != null ? String(row.instrument_token) : String(key), row);
    }
  }
  return out;
}

// The instrument master, as CSV. Large (NFO alone is ~90k rows), so it gets its
// own long timeout and a raw text transform.
async function instrumentsCsv(exchange) {
  const url = `${config.kite.apiBase}/instruments${exchange ? '/' + exchange : ''}`;
  try {
    const res = await axios.get(url, {
      responseType: 'text',
      timeout: 120000,
      headers: { 'X-Kite-Version': '3' },
      transformResponse: (x) => x,
      maxContentLength: 200 * 1024 * 1024,
    });
    return res.data;
  } catch (err) {
    logger.warn('kiteClient: instrument download failed', { exchange, err: err.message });
    throw toError(err, `instruments/${exchange}`);
  }
}

module.exports = {
  BROKER, loginUrl, generateSession, invalidateSession, profile, ltp, quote, instrumentsCsv,
};
