// Single source of truth for every environment value. Nothing else in the app
// reads process.env directly — a missing or malformed setting fails loudly at
// boot instead of as a confusing runtime error hours into a session.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const errors = [];

function str(name, fallback = undefined, { required = false } = {}) {
  let v = process.env[name];
  if (v === undefined || v === '') v = fallback;
  if (v === undefined || v === '') {
    if (required) errors.push(`${name} is required`);
    return null;
  }
  return String(v).trim();
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) { errors.push(`${name} must be an integer (got "${raw}")`); return fallback; }
  return n;
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) { errors.push(`${name} must be a number (got "${raw}")`); return fallback; }
  return n;
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

const env = str('NODE_ENV', 'development');
const isProd = env === 'production';

const tokenEncKey = str('TOKEN_ENC_KEY', undefined, { required: true });
if (tokenEncKey && !/^[0-9a-fA-F]{64}$/.test(tokenEncKey)) {
  errors.push('TOKEN_ENC_KEY must be exactly 64 hex characters (32 bytes for AES-256)');
}

const jwtSecret = str('JWT_SECRET', undefined, { required: true });
if (jwtSecret && jwtSecret.length < 32) {
  errors.push('JWT_SECRET must be at least 32 characters');
}

const allowInsecureCookies = bool('ALLOW_INSECURE_COOKIES', false);
if (isProd && allowInsecureCookies) {
  errors.push('ALLOW_INSECURE_COOKIES must be false in production');
}

const config = {
  env,
  isProd,
  port: int('PORT', 4100),
  appUrl: str('APP_URL', 'http://localhost:4100'),
  allowInsecureCookies,

  // Kill switch. The engine keeps managing and exiting open positions when this
  // is set — halting entries is a risk control, abandoning a live short is not.
  tradingHalted: bool('TRADING_HALTED', false),

  db: {
    host: str('DB_HOST', '127.0.0.1'),
    port: int('DB_PORT', 3306),
    user: str('DB_USER', 'root'),
    // A blank password is legitimate on a local dev MySQL, so this one skips
    // str()'s empty-means-missing rule.
    password: process.env.DB_PASSWORD ?? '',
    database: str('DB_NAME', 'zoption'),
    connectionLimit: int('DB_CONNECTION_LIMIT', 10),
  },

  jwt: {
    secret: jwtSecret,
    expiresIn: str('JWT_EXPIRES_IN', '12h'),
  },

  tokenEncKey,

  // Kotak Neo — market data and execution both come from here.
  neo: {
    // Whitespace inside this value lands in an HTTP header and Kotak's gateway
    // rejects the request with an opaque error, so strip it aggressively.
    apiToken: (process.env.NEO_API_TOKEN || '').replace(/[\s\r\n]+/g, ''),
    apiBase: str('NEO_API_BASE', 'https://gw-napi.kotaksecurities.com'),
    loginUrl: str('NEO_LOGIN_URL', 'https://mis.kotaksecurities.com'),
    finKey: str('NEO_FIN_KEY', 'neotradeapi'),
    rps: int('NEO_RPS', 8),

    wsUrl: str('NEO_WS_URL', 'wss://mlhsm.kotaksecurities.com/realtime'),
    // Not a fallback that switches on after a timeout: Kotak's HSM socket
    // accepts subscribes and then streams nothing on many accounts, so the poll
    // always runs alongside it. 0 makes the platform depend on a socket that
    // may be permanently silent.
    pollMs: int('NEO_POLL_MS', 1000),
    quoteBatch: int('NEO_QUOTE_BATCH', 25),
    maxSymbols: int('NEO_MAX_SYMBOLS', 250),
    defaultSegment: str('NEO_DEFAULT_SEGMENT', 'nse_fo'),
  },

  engine: {
    tickMs: int('ENGINE_TICK_MS', 1000),
    id: str('ENGINE_ID', '') || `engine-${process.pid}`,
    lockTtlMs: int('ENGINE_LOCK_TTL_MS', 30000),
    orderConfirmTimeoutMs: int('ORDER_CONFIRM_TIMEOUT_MS', 15000),
    orderConfirmPollMs: int('ORDER_CONFIRM_POLL_MS', 750),
  },

  candles: {
    // A bar assembled from fewer ticks than this is low-confidence — the close
    // may predate the bucket by most of its width — and will not trigger an
    // entry. 0 accepts any bar that saw at least one tick.
    minTicks: int('CANDLE_MIN_TICKS', 2),
  },

  // NSE F&O options charge schedule. Approximations for net P&L; the broker's
  // contract note remains authoritative.
  charges: {
    brokeragePerOrder: num('CHG_BROKERAGE_PER_ORDER', 20),
    sttSellPct: num('CHG_STT_SELL_PCT', 0.1) / 100,
    exchTxnPct: num('CHG_EXCH_TXN_PCT', 0.03503) / 100,
    sebiPct: num('CHG_SEBI_PCT', 0.0001) / 100,
    gstPct: num('CHG_GST_PCT', 18) / 100,
    stampBuyPct: num('CHG_STAMP_BUY_PCT', 0.003) / 100,
  },

  retention: {
    eventDays: int('EVENT_RETENTION_DAYS', 30),
    candleDays: int('CANDLE_RETENTION_DAYS', 14),
  },
};

if (config.engine.lockTtlMs <= config.engine.tickMs * 3) {
  errors.push('ENGINE_LOCK_TTL_MS must be at least 3x ENGINE_TICK_MS or the leader lock will flap');
}

if (errors.length) {
  // eslint-disable-next-line no-console
  console.error('\nConfiguration errors:\n' + errors.map(e => `  - ${e}`).join('\n')
    + '\n\nCopy .env.example to .env and fill in the missing values.\n');
  process.exit(1);
}

module.exports = config;
