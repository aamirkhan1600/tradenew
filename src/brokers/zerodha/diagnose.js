// Why is Zerodha not working?
//
// The ticker can only ever report "403 Authentication failed", which covers at
// least three different problems with three different fixes. This module asks
// the REST API the questions that separate them, and is used both by the
// Brokers page and automatically whenever the ticker fails — so the operator
// gets a specific cause rather than a disjunction.
//
// The three outcomes, in the order they are ruled out:
//
//   session   /user/profile fails      → the access token is dead. Log in again.
//   scope     profile works, /quote    → the token is fine and the app has API
//             fails with a Permission    access, but MARKET DATA is not entitled
//             Exception                  on it. Logging in again cannot help;
//                                        this is fixed in the Kite developer
//                                        console, not in this application.
//   ok        both work                → the feed should be able to connect.

const kite = require('./kiteClient');

// NSE:NIFTY 50 — always quotable during and outside market hours.
const PROBE_TOKEN = '256265';

/**
 * @param {{apiKey: string, accessToken: string}} account
 * @returns {Promise<{ok, stage, status, reason, hint, profile?, spot?}>}
 */
async function diagnose(account) {
  if (!account?.apiKey || !account?.accessToken) {
    return {
      ok: false, stage: 'session', status: 'DISCONNECTED',
      reason: 'No Kite access token is stored.',
      hint: 'Complete the daily login on the Brokers page.',
    };
  }

  let profile;
  try {
    profile = await kite.profile({ apiKey: account.apiKey, accessToken: account.accessToken });
  } catch (err) {
    return {
      ok: false, stage: 'session', status: 'EXPIRED',
      reason: err.message,
      hint: 'The access token is dead. Log in again — a request_token can be exchanged '
          + 'only once, and access tokens expire around 06:00 IST.',
    };
  }

  try {
    const quotes = await kite.ltp({
      apiKey: account.apiKey, accessToken: account.accessToken, ids: [PROBE_TOKEN],
    });
    if (!quotes.size) {
      return {
        ok: false, stage: 'data', status: 'ERROR', profile,
        reason: 'Kite accepted the quote request but returned no price.',
        hint: 'Retry during market hours. If it persists, check the app in the Kite developer console.',
      };
    }
    return { ok: true, stage: 'ok', status: 'CONNECTED', profile, spot: quotes.get(PROBE_TOKEN) };
  } catch (err) {
    // PermissionException here, with the profile call succeeding, is the
    // signature of an app that has API access but no market-data entitlement.
    const noPermission = /insufficient permission/i.test(err.message)
      || /PermissionException/i.test(err.meta?.type || '');
    return {
      ok: false, stage: 'data', status: 'ERROR', profile,
      reason: err.message,
      hint: noPermission
        ? 'The login works and the app has API access, but MARKET DATA is not enabled on it — '
          + 'which is also why the ticker returns 403. Enable market data for this app in the '
          + 'Kite developer console (developers.kite.trade). Logging in again will not help. '
          + 'Once enabled, the engine picks it up within five minutes — or press '
          + '"Test connection" to resume immediately.'
        : 'Market data could not be read with this token.',
    };
  }
}

// One line suitable for a status field or a log.
function summarise(result) {
  if (result.ok) {
    return `market data OK — ${result.profile?.user_id ?? '?'}, NIFTY 50 at ${result.spot}`;
  }
  return `${result.stage === 'data' ? 'market data unavailable' : 'session invalid'}: ${result.reason}`;
}

module.exports = { diagnose, summarise, PROBE_TOKEN };
