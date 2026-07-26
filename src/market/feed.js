// Feed registry: one Kite ticker per user, plus tick persistence.
//
// The registry exists so that several strategies belonging to the same user
// share a single WebSocket and a single subscription budget. Opening one socket
// per strategy would multiply connections and burn through Kite's instrument
// cap for no benefit — the strategies are almost always watching overlapping
// strikes of the same chain.

const { KiteTicker } = require('../brokers/zerodha/kiteTicker');
const { diagnose, summarise: diagnoseSummary } = require('../brokers/zerodha/diagnose');
const repo = require('../repositories');
const logger = require('../core/logger');
const config = require('../config');

const tickers = new Map();          // userId -> KiteTicker
const pendingTicks = [];            // buffered for batched persistence
let flushTimer = null;

function get(userId) {
  return tickers.get(Number(userId)) || null;
}

// Attach (or refresh) the feed for a user. Returns null when there is no live
// Kite session — callers must treat that as "cannot trade", not as an error to
// swallow: a strategy running against a dead feed is a strategy trading blind.
async function attach(userId) {
  const id = Number(userId);
  const account = await repo.brokers.get(id, 'zerodha');
  if (!account?.apiKey || !account?.accessToken) return null;

  // The engine calls this every tick. Without this guard, a session the broker
  // has already rejected would be rebuilt once a second, each new ticker
  // failing its handshake — a reconnect storm dressed up as a retry.
  // Reconnecting is the operator's job, via a fresh login.
  if (account.status === 'EXPIRED' || account.status === 'ERROR') {
    return null;
  }

  const existing = tickers.get(id);
  if (existing) {
    return existing.rebind({ apiKey: account.apiKey, accessToken: account.accessToken });
  }

  const ticker = new KiteTicker({
    apiKey: account.apiKey, accessToken: account.accessToken, label: `user:${id}`,
  });

  ticker.on('auth_expired', async () => {
    // The socket only ever says "403". Ask the REST API which of the three
    // possible causes it actually is, so the operator sees a specific problem
    // with a specific fix instead of a disjunction they have to investigate.
    let reason = 'Kite rejected the market-data connection';
    let status = 'EXPIRED';
    try {
      const result = await diagnose(account);
      reason = `${diagnoseSummary(result)}${result.hint ? ' — ' + result.hint : ''}`;
      status = result.status;
    } catch (probeErr) {
      reason = `Kite rejected the market-data connection (diagnosis failed: ${probeErr.message})`;
    }

    const changed = status === 'EXPIRED'
      ? await repo.brokers.markExpiredOnce(id, 'zerodha', reason)
      : await repo.brokers.markError(id, 'zerodha', reason).then(() => true);

    if (changed) {
      logger.error('feed: Kite market data unavailable — strategies will not open positions',
        { userId: id, status, reason });
    }
    tickers.delete(id);
  });

  ticker.on('tick', (tick) => {
    pendingTicks.push({ zToken: Number(tick.token), tsMs: tick.ts, ltp: tick.ltp });
  });

  tickers.set(id, ticker);
  ticker.connect();
  logger.info('feed: ticker attached', { userId: id });
  return ticker;
}

// Re-probe sessions that previously failed, and restore any that now work.
//
// The failure this exists for is not transient in the usual sense: a missing
// market-data entitlement stays broken until someone changes a setting in the
// broker's console. When they do, nothing in this system would notice — the
// feed guard refuses to rebuild a ticker for a session marked EXPIRED/ERROR,
// by design, so it would stay dark until an operator remembered to press a
// button. One cheap REST call every few minutes closes that gap.
async function recoverFailedSessions() {
  let rows;
  try {
    rows = await repo.brokers.listRecoverable('zerodha');
  } catch (err) {
    logger.warn('feed: could not list recoverable sessions', { err: err.message });
    return { checked: 0, recovered: 0 };
  }
  if (!rows.length) return { checked: 0, recovered: 0 };

  let recovered = 0;
  for (const row of rows) {
    const id = Number(row.user_id);
    const account = await repo.brokers.get(id, 'zerodha');
    if (!account?.accessToken) continue;

    const result = await diagnose(account).catch(err => ({ ok: false, reason: err.message }));
    if (!result.ok) continue;

    await repo.brokers.markConnected(id, 'zerodha');
    await attach(id);
    recovered += 1;
    logger.info('feed: Kite market data recovered — strategies can trade again',
      { userId: id, detail: diagnoseSummary(result) });
  }
  return { checked: rows.length, recovered };
}

function detach(userId) {
  const id = Number(userId);
  const ticker = tickers.get(id);
  if (ticker) { ticker.close(); tickers.delete(id); }
}

function detachAll() {
  for (const id of [...tickers.keys()]) detach(id);
}

// Ticks are written in batches rather than per tick. At a few hundred
// subscribed strikes the per-tick rate is high enough that individual INSERTs
// would dominate the engine's time budget, and the history is for post-hoc
// explanation — a second of delay costs nothing.
function startPersistence(intervalMs = 2000) {
  if (flushTimer) return;
  flushTimer = setInterval(async () => {
    if (!pendingTicks.length) return;
    const batch = pendingTicks.splice(0, Math.min(pendingTicks.length, 2000));
    try { await repo.ticks.record(batch); }
    catch (err) { logger.warn('feed: tick persistence failed', { err: err.message, dropped: batch.length }); }
  }, intervalMs);
  flushTimer.unref?.();
}

function stopPersistence() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
}

function status() {
  const out = {};
  for (const [userId, ticker] of tickers) out[userId] = ticker.status();
  return { users: out, bufferedTicks: pendingTicks.length, maxSymbols: config.kite.maxSymbols };
}

module.exports = {
  get, attach, detach, detachAll,
  startPersistence, stopPersistence, recoverFailedSessions, status, tickers,
};
