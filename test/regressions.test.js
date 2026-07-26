// One test per defect found in the 2026-07-26 audit. Each documents the bug it
// pins down, so a future change that reintroduces it fails here rather than in
// production.

const test = require('node:test');
const assert = require('node:assert/strict');

const riskManager = require('../src/strategy/riskManager');
const strategyConfig = require('../src/strategy/config');
const { INDEX_SENTINEL } = require('../src/market/instrumentStore');
const { KiteTicker } = require('../src/brokers/zerodha/kiteTicker');
const time = require('../src/core/time');

/* ------------------------------------------------------------------ AUDIT-1 */
// Index rows were stored with NULL expiry/strike. MySQL treats NULLs as
// DISTINCT in a UNIQUE key, so ON DUPLICATE KEY UPDATE never matched and every
// sync inserted duplicates — 47 rows where there should have been 6.
test('AUDIT-1: index rows use non-null sentinels so the unique key can match', () => {
  assert.notEqual(INDEX_SENTINEL.expiryDate, null);
  assert.notEqual(INDEX_SENTINEL.strike, null);
  assert.match(INDEX_SENTINEL.expiryDate, /^\d{4}-\d{2}-\d{2}$/);
  // The sentinels must be unreachable as real contract values.
  assert.equal(INDEX_SENTINEL.strike, 0, 'a real strike is always > 0');
  assert.ok(INDEX_SENTINEL.expiryDate < '2000-01-01', 'a real expiry is always in the future');
});

/* ------------------------------------------------------------------ AUDIT-2 */
// nextEntryAllowedAt returned Infinity to mean "no more entries today", but the
// runtime is persisted as JSON and JSON.stringify(Infinity) is null — which
// reads back as falsy and silently re-enabled entry after any restart.
test('AUDIT-2: the day-long re-entry block survives a JSON round trip', () => {
  const now = Date.UTC(2026, 6, 30, 5, 30);   // 11:00 IST
  const blockedUntil = riskManager.nextEntryAllowedAt({
    config: { reentryAfterTarget: true, reentryAfterStop: false, reentryCooldownSec: 60 },
    exitReason: 'stoploss',
    now,
  });

  assert.ok(Number.isFinite(blockedUntil), 'must be a finite instant, never Infinity');
  assert.ok(blockedUntil > now, 'must be in the future');

  const roundTripped = JSON.parse(JSON.stringify({ cooldownUntil: blockedUntil })).cooldownUntil;
  assert.equal(roundTripped, blockedUntil, 'must survive persistence unchanged');
  assert.ok(roundTripped && now < roundTripped, 'must still block after a restart');
});

test('AUDIT-2: the block lasts the rest of the IST day, not longer', () => {
  const now = Date.UTC(2026, 6, 30, 5, 30);   // 11:00 IST on 30 Jul
  const until = riskManager.endOfTradingDay(now);
  assert.equal(time.istDateString(until), time.istDateString(now), 'same IST date');
  assert.ok(time.istMinutes(until) > 23 * 60, 'late in the IST evening');
  // The next IST day must be free again.
  assert.ok(until < now + 24 * 3600 * 1000);
});

test('AUDIT-2: a normal cooldown is still a short delay', () => {
  const now = 1_800_000_000_000;
  const until = riskManager.nextEntryAllowedAt({
    config: { reentryAfterTarget: true, reentryAfterStop: true, reentryCooldownSec: 60 },
    exitReason: 'stoploss', now,
  });
  assert.equal(until, now + 60_000);
});

/* ------------------------------------------------------------------ AUDIT-3 */
// The square-off request was written into the `state` column, which the engine
// rewrites every tick — so the emergency control could be silently discarded.
// It now has its own columns with a claim/clear contract.
test('AUDIT-3: square-off has a dedicated channel, not the tick-rewritten state', () => {
  const repoSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'repositories', 'index.js'), 'utf8');
  assert.match(repoSrc, /requestSquareOff/, 'a dedicated request method must exist');
  assert.match(repoSrc, /claimSquareOff/, 'an atomic claim method must exist');
  assert.match(repoSrc, /square_off_requested_at = NOW\(\)/);
  // The claim must be conditional, so two engines cannot both act on one request.
  assert.match(repoSrc, /square_off_requested_at = NULL[\s\S]{0,200}?square_off_requested_at IS NOT NULL/);

  const runnerSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'strategy', 'strategyRunner.js'), 'utf8');
  assert.match(runnerSrc, /claimSquareOff/, 'the runner must claim from the dedicated channel');
  assert.doesNotMatch(runnerSrc, /runtime\.squareOffRequested/,
    'the request must not travel through runtime state any more');
});

/* ------------------------------------------------------------------ AUDIT-4 */
// A WebSocket 403 was retried forever because only the REST poller checked for
// auth failures — and the poller never ran when nothing was subscribed.
test('AUDIT-4: an auth failure latches and stops the reconnect loop', () => {
  const t = new KiteTicker({ apiKey: 'k', accessToken: 'a', label: 'test' });
  t.closed = true;
  let events = 0;
  t.on('auth_expired', () => { events += 1; });

  t._failAuth('rejected');
  t._failAuth('rejected again');

  assert.equal(t.authFailed, true);
  assert.equal(events, 1, 'the failure is reported exactly once, not per retry');
  assert.equal(t.isHealthy(), false, 'an auth-failed feed is never healthy');

  const before = t.stats.reconnects;
  t._scheduleReconnect();
  assert.equal(t.stats.reconnects, before, 'no reconnect is scheduled after an auth failure');
});

test('AUDIT-4: a fresh token clears the latch so re-login works', () => {
  const t = new KiteTicker({ apiKey: 'k', accessToken: 'old', label: 'test' });
  t.closed = true;
  t._failAuth('rejected');
  assert.equal(t.authFailed, true);

  t.connect = () => t;                 // do not open a socket in a test
  t.rebind({ apiKey: 'k', accessToken: 'new' });
  assert.equal(t.authFailed, false, 'a new token must clear the latch');
});

/* ------------------------------------------------------------------ AUDIT-5 */
// Session windows were unbounded, so a strategy could be configured to scan
// before the open or square off after the close — the latter meaning it would
// never exit.
test('AUDIT-5: session windows are bounded by exchange hours', () => {
  const tooEarly = strategyConfig.validate(
    strategyConfig.normalise({ entryTime: '08:00', lastEntryTime: '09:00', squareOffTime: '09:30' }));
  assert.ok(tooEarly.some(e => /market open/.test(e)));

  const tooLate = strategyConfig.validate(
    strategyConfig.normalise({ squareOffTime: '16:30' }));
  assert.ok(tooLate.some(e => /market close/.test(e)));

  assert.deepEqual(strategyConfig.validate(strategyConfig.defaults()), [],
    'the shipped defaults must sit inside market hours');
});

/* ------------------------------------------------------------------ AUDIT-6 */
// trades.patch built SQL from object keys with no allow-list.
test('AUDIT-6: trades.patch refuses columns outside its allow-list', async () => {
  const repo = require('../src/repositories');
  await assert.rejects(
    () => repo.trades.patch(1, { 'status = 1, user_id': 9 }),
    /unknown column/,
    'an unexpected key must be rejected rather than interpolated');
  assert.ok(repo.trades.PATCHABLE.has('status'));
  assert.ok(!repo.trades.PATCHABLE.has('user_id'), 'ownership columns are not patchable');
});

/* ------------------------------------------------------------------ AUDIT-7 */
// A crash between placing a leg and writing the trade row left a live position
// nothing was watching; reconciliation went quietly IDLE.
test('AUDIT-7: orphaned orders are detectable', () => {
  const repo = require('../src/repositories');
  assert.equal(typeof repo.orders.placedWithoutTrade, 'function');

  const runnerSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'strategy', 'strategyRunner.js'), 'utf8');
  assert.match(runnerSrc, /placedWithoutTrade/,
    'reconciliation must check for orders with no trade record');
  assert.match(runnerSrc, /orphaned order/i);
});

/* ------------------------------------------------------------------ AUDIT-8 */
// An uncertain buy-back left the strategy in POSITION_OPEN, retrying an exit
// whose outcome was unknown.
test('AUDIT-8: an unknown exit outcome halts instead of retrying', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'strategy', 'strategyRunner.js'), 'utf8');
  // The two branches must differ — the original bug was `x ? OPEN : OPEN`.
  const uncertainBranch = src.slice(src.indexOf('if (buyBack.uncertain)'));
  assert.ok(uncertainBranch.indexOf('S.HALTED') > -1
    && uncertainBranch.indexOf('S.HALTED') < uncertainBranch.indexOf('S.POSITION_OPEN'),
    'the uncertain branch must reach HALTED before any POSITION_OPEN path');
  assert.match(uncertainBranch.slice(0, 700), /NEEDS_ATTENTION/,
    'the trade must be flagged for a human');
  assert.doesNotMatch(src, /buyBack\.uncertain \? S\.POSITION_OPEN : S\.POSITION_OPEN/,
    'the identical-branch ternary must be gone');
});

/* ------------------------------------------------------------------ AUDIT-10 */
// A broker session can be repaired OUTSIDE this application — by enabling an
// entitlement in the broker's console, or by the next day's login. The feed
// guard deliberately refuses to rebuild a ticker for a failed session, so
// without a probe the feed would stay dark until someone pressed a button.
test('AUDIT-10: a failed session is re-probed rather than left dark forever', () => {
  const feed = require('../src/market/feed');
  const repo = require('../src/repositories');
  assert.equal(typeof feed.recoverFailedSessions, 'function');
  assert.equal(typeof repo.brokers.listRecoverable, 'function');
  assert.equal(typeof repo.brokers.markConnected, 'function');

  const engineSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'engine.js'), 'utf8');
  assert.match(engineSrc, /recoverFailedSessions/, 'the engine must run the probe on a timer');

  const repoSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'repositories', 'index.js'), 'utf8');
  // Only sessions that still hold a token are worth probing; a DISCONNECTED
  // account has none and only a fresh login can help it.
  assert.match(repoSrc,
    /listRecoverable[\s\S]{0,400}?status IN \('EXPIRED','ERROR'\)[\s\S]{0,120}?access_token_enc IS NOT NULL/);
});

test('AUDIT-10: the diagnostic separates a dead session from a missing entitlement', async () => {
  const { diagnose } = require('../src/brokers/zerodha/diagnose');
  const noToken = await diagnose({ apiKey: 'k', accessToken: null });
  assert.equal(noToken.ok, false);
  assert.equal(noToken.stage, 'session');
  assert.equal(noToken.status, 'DISCONNECTED');
  assert.match(noToken.hint, /daily login/i);
});
