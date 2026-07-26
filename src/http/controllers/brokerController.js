// Broker connections and the instrument sync.
//
// Two very different login models sit behind one screen:
//   Zerodha — an OAuth-style redirect; the access token dies ~06:00 IST daily
//   Kotak   — TOTP + MPIN, entered live and never stored
// Neither secret is persisted beyond what is strictly required to keep a
// session: for Kotak that is the session token and sid, and nothing else.

const repo = require('../../repositories');
const kite = require('../../brokers/zerodha/kiteClient');
const neo = require('../../brokers/kotak/neoClient');
const instrumentStore = require('../../market/instrumentStore');
const feed = require('../../market/feed');
const config = require('../../config');
const logger = require('../../core/logger');
const { ValidationError } = require('../../core/errors');
const { diagnose: probeZerodha } = require('../../brokers/zerodha/diagnose');

// Everything the page needs, with no secret in it.
async function overview(userId) {
  const [zerodha, kotak, summary] = await Promise.all([
    repo.brokers.get(userId, 'zerodha'),
    repo.brokers.get(userId, 'kotak'),
    repo.instruments.summary(),
  ]);

  const kiteApiKey = zerodha?.apiKey || config.kite.apiKey || null;
  const instrumentTotals = summary.reduce((acc, r) => {
    acc.rows += Number(r.n);
    acc.tradable += Number(r.tradable || 0);
    if (r.synced_at && (!acc.syncedAt || r.synced_at > acc.syncedAt)) acc.syncedAt = r.synced_at;
    return acc;
  }, { rows: 0, tradable: 0, syncedAt: null });

  return {
    zerodha: {
      configured: !!kiteApiKey,
      hasSecret: !!(zerodha?.apiSecret || config.kite.apiSecret),
      status: zerodha?.accessToken ? zerodha.status : 'DISCONNECTED',
      apiKey: kiteApiKey,
      userId: zerodha?.brokerUserId || null,
      userName: zerodha?.brokerUserName || null,
      lastLoginAt: zerodha?.lastLoginAt || null,
      lastError: zerodha?.lastError || null,
      loginUrl: kiteApiKey ? kite.loginUrl(kiteApiKey) : null,
    },
    kotak: {
      status: kotak?.sessionToken ? kotak.status : 'DISCONNECTED',
      ucc: kotak?.ucc || null,
      userName: kotak?.brokerUserName || null,
      lastLoginAt: kotak?.lastLoginAt || null,
      lastError: kotak?.lastError || null,
      apiTokenConfigured: !!config.neo.apiToken,
    },
    instruments: { ...instrumentTotals, breakdown: summary },
  };
}

async function page(req, res) {
  res.render('brokers', {
    title: 'Brokers', user: req.user, data: await overview(req.user.id), notice: null,
  });
}

async function status(req, res) {
  res.json(await overview(req.user.id));
}

/* ------------------------------------------------------------- Zerodha --- */
async function saveKiteCredentials(req, res) {
  const apiKey = String(req.body?.apiKey || '').trim() || null;
  const apiSecret = String(req.body?.apiSecret || '').trim() || null;
  if (!apiKey && !apiSecret) throw new ValidationError('Provide an API key, an API secret, or both.');
  await repo.brokers.saveZerodhaCredentials(req.user.id, { apiKey, apiSecret });
  res.json({ ok: true, data: await overview(req.user.id) });
}

async function connectKite(req, res) {
  const requestToken = String(req.body?.requestToken || req.query?.request_token || '').trim();
  if (!requestToken) throw new ValidationError('The request_token from the Kite redirect is required.');

  const stored = await repo.brokers.get(req.user.id, 'zerodha');
  const apiKey = stored?.apiKey || config.kite.apiKey;
  const apiSecret = stored?.apiSecret || config.kite.apiSecret;
  if (!apiKey || !apiSecret) throw new ValidationError('Save the Kite API key and secret first.');

  try {
    const session = await kite.generateSession({ apiKey, apiSecret, requestToken });

    // Prove the token can actually READ PRICES before storing it as connected.
    // A token that logs in but cannot quote is the failure mode that otherwise
    // shows up minutes later as an unexplained 403 on the ticker.
    const probe = await probeZerodha({ apiKey, accessToken: session.access_token });
    if (!probe.ok) {
      throw new ValidationError(`Logged in, but ${probe.stage === 'data'
        ? 'market data is not available' : 'the session failed'}: ${probe.reason}. ${probe.hint}`);
    }

    await repo.brokers.saveZerodhaSession(req.user.id, {
      apiKey, apiSecret,
      accessToken: session.access_token,
      publicToken: session.public_token,
      kiteUserId: session.user_id,
      kiteUserName: session.user_name,
    });
    // Bring the ticker straight up so the engine's next tick has prices.
    await feed.attach(req.user.id);
    logger.info('brokers: Kite connected', { userId: req.user.id, kiteUserId: session.user_id });
    res.json({ ok: true, data: await overview(req.user.id) });
  } catch (err) {
    await repo.brokers.markError(req.user.id, 'zerodha', err.message);
    throw err;
  }
}

async function verifyKite(req, res) {
  const account = await repo.brokers.get(req.user.id, 'zerodha');
  if (!account?.accessToken) {
    return res.json({ ok: false, reason: 'No access token stored — complete the daily login.' });
  }

  const probe = await probeZerodha(account);

  if (probe.ok) {
    // A session that previously failed and now works must go back to CONNECTED,
    // or the feed guard would keep refusing to attach a ticker.
    await repo.brokers.saveZerodhaSession(req.user.id, {
      apiKey: account.apiKey, apiSecret: account.apiSecret,
      accessToken: account.accessToken, publicToken: account.publicToken,
      kiteUserId: probe.profile.user_id, kiteUserName: probe.profile.user_name,
    });
    await feed.attach(req.user.id);
    return res.json({
      ok: true,
      message: `Session and market data both working — ${probe.profile.user_id} `
        + `(${probe.profile.user_name}), NIFTY 50 at ${probe.spot}.`,
      data: await overview(req.user.id),
    });
  }

  if (probe.status === 'EXPIRED') await repo.brokers.markExpiredOnce(req.user.id, 'zerodha', probe.reason);
  else await repo.brokers.markError(req.user.id, 'zerodha', probe.reason);

  logger.warn('brokers: Kite verification failed', {
    userId: req.user.id, stage: probe.stage, err: probe.reason,
  });
  return res.json({
    ok: false, stage: probe.stage, reason: probe.reason, hint: probe.hint,
    loggedInAs: probe.profile ? `${probe.profile.user_id} (${probe.profile.user_name})` : null,
    data: await overview(req.user.id),
  });
}

async function disconnectKite(req, res) {
  feed.detach(req.user.id);
  await repo.brokers.disconnect(req.user.id, 'zerodha');
  res.json({ ok: true, data: await overview(req.user.id) });
}

/* --------------------------------------------------------------- Kotak --- */
// One call does both legs of the login. The TOTP is only valid for ~30 seconds,
// so splitting this into two round trips would routinely expire mid-flow.
async function connectKotak(req, res) {
  const mobile = String(req.body?.mobile || '').trim();
  const ucc = String(req.body?.ucc || '').trim();
  const totp = String(req.body?.totp || '').trim();
  const mpin = String(req.body?.mpin || '').trim();
  if (!mobile || !ucc || !totp || !mpin) {
    throw new ValidationError('Mobile, UCC, TOTP and MPIN are all required.');
  }

  try {
    const step1 = await neo.tradeApiLogin({ mobile, ucc, totp });
    const step2 = await neo.tradeApiValidate({
      viewToken: step1.viewToken, viewSid: step1.viewSid, mpin,
    });
    await repo.brokers.saveKotakSession(req.user.id, {
      ucc: step2.ucc || ucc,
      mobile,
      sessionToken: step2.sessionToken,
      sid: step2.sid,
      baseUrl: step2.baseUrl,
      userName: step2.userName || step1.greetingName,
    });
    logger.info('brokers: Kotak connected', { userId: req.user.id, ucc });
    // TOTP and MPIN go out of scope here and are never written anywhere.
    res.json({ ok: true, data: await overview(req.user.id) });
  } catch (err) {
    await repo.brokers.markError(req.user.id, 'kotak', err.message);
    throw err;
  }
}

async function disconnectKotak(req, res) {
  await repo.brokers.disconnect(req.user.id, 'kotak');
  res.json({ ok: true, data: await overview(req.user.id) });
}

/* --------------------------------------------------------- instruments --- */
// Both masters, then the bridge. Explicit rather than automatic: it is a
// multi-megabyte download and a ~100k-row upsert.
async function syncInstruments(req, res) {
  const kotak = await repo.brokers.get(req.user.id, 'kotak');
  const session = kotak?.sessionToken
    ? { sessionToken: kotak.sessionToken, sid: kotak.sid, baseUrl: kotak.baseUrl }
    : null;

  const result = await instrumentStore.syncAll(session);
  const summary = await repo.instruments.summary();
  const tradable = summary.reduce((a, r) => a + Number(r.tradable || 0), 0);

  logger.info('brokers: instrument sync complete', { userId: req.user.id, tradable });
  res.json({
    ok: true, ...result, tradable,
    warning: session ? null
      : 'Kotak was not connected, so no contract is orderable yet. Connect Kotak and sync again.',
  });
}

async function bridgeHealth(req, res) {
  const underlying = String(req.query.underlying || 'BANKNIFTY').toUpperCase();
  const expiries = await repo.instruments.listExpiries(underlying);
  const expiry = String(req.query.expiry || expiries[0] || '');
  res.json({
    underlying, expiries,
    health: expiry ? await repo.instruments.bridgeHealth(underlying, expiry) : null,
    lotSize: await repo.instruments.lotSize(underlying),
  });
}

module.exports = {
  page, status, saveKiteCredentials, connectKite, verifyKite, disconnectKite,
  connectKotak, disconnectKotak, syncInstruments, bridgeHealth,
};
