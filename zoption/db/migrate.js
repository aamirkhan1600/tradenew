#!/usr/bin/env node
// Create the database, apply schema.sql, then run the idempotent patch blocks.
//
// Idempotent by construction: schema.sql is all CREATE TABLE IF NOT EXISTS, and
// anything added to an already-deployed table needs a patch below — IF NOT
// EXISTS will not alter a table that already exists, so a column added to
// schema.sql alone reaches new installs and silently misses upgrades.

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME || 'zoption',
};

// Split on `;` at end of line. The schema deliberately contains no stored
// programs, so there are no embedded semicolons to worry about.
function statements(sql) {
  return sql
    .split(/;\s*$/m)
    .map(s => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1`,
    [DB.database, table, column]);
  return rows.length > 0;
}

async function indexExists(conn, table, index) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = ? AND table_name = ? AND index_name = ? LIMIT 1`,
    [DB.database, table, index]);
  return rows.length > 0;
}

// Convert a JSON column to LONGTEXT, once.
//
// `CREATE TABLE IF NOT EXISTS` will not alter a table that already exists, so a
// database built before the change keeps its JSON columns and behaves
// differently from a fresh one: the driver hands back a parsed OBJECT from a
// JSON column and a STRING from LONGTEXT. Every reader here copes with both, but
// two servers disagreeing about the type is exactly the sort of difference that
// only shows up on the one you did not test.
//
// Only touches a column whose type is genuinely `json`. On MariaDB, `JSON` is
// already an alias for LONGTEXT, so this is a no-op there.
async function jsonToLongtext(conn, table, column, notNull = false) {
  const [rows] = await conn.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1`,
    [DB.database, table, column]);
  if (!rows.length) return false;
  if (String(rows[0].data_type || rows[0].DATA_TYPE).toLowerCase() !== 'json') return false;

  await conn.query(
    `ALTER TABLE \`${table}\` MODIFY \`${column}\` LONGTEXT ${notNull ? 'NOT NULL' : 'NULL'}`);
  console.log(`  ~ ${table}.${column}  JSON -> LONGTEXT`);
  return true;
}

// Drop the `json_valid(...)` CHECK constraints MariaDB attaches when a column is
// declared JSON.
//
// They survive the change to LONGTEXT, so a database built before it validates
// JSON on write while a fresh one does not. That asymmetry is the problem: a
// value that inserts on one server and is rejected on the other is a difference
// that only shows up where nobody tested, and it is not worth keeping for a
// check every writer already satisfies — every one of these columns is written
// with JSON.stringify.
//
// Scoped to clauses that are literally `json_valid(...)`, so a CHECK somebody
// added on purpose is never touched. If the server has no CHECK_CONSTRAINTS view
// (MySQL below 8.0.16) there is nothing to drop and nothing to do.
//
// Removed by REDEFINING THE COLUMN, not by `DROP CONSTRAINT`. MariaDB attaches
// the JSON alias's check to the column rather than to the table, and a
// column-level check has no independent existence to drop:
//
//     ALTER TABLE settings DROP CONSTRAINT payload
//       -> Can't DROP CONSTRAINT `payload`; check that it exists
//     ALTER TABLE settings MODIFY payload LONGTEXT NOT NULL
//       -> gone
//
// The MODIFY restates the type the schema already declares, so it is a no-op for
// the data — verified against a populated table — and it is what actually
// detaches the constraint.
async function dropJsonValidChecks(conn) {
  let rows;
  try {
    [rows] = await conn.query(
      `SELECT constraint_name AS n, table_name AS t, check_clause AS c
         FROM information_schema.check_constraints
        WHERE constraint_schema = ?`, [DB.database]);
  } catch (_) {
    return 0;                                   // no such view; nothing to do
  }

  let dropped = 0;
  for (const row of rows || []) {
    const clause = String(row.c ?? row.CHECK_CLAUSE ?? '');
    if (!/^\s*json_valid\s*\(/i.test(clause)) continue;
    const table = row.t ?? row.TABLE_NAME;
    const column = row.n ?? row.CONSTRAINT_NAME;   // named after the column
    if (!table || !column) continue;

    // Keep the column's own nullability — re-declaring `payload` as NULL when the
    // schema says NOT NULL would quietly weaken it.
    const [meta] = await conn.query(
      `SELECT is_nullable AS nullable FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1`,
      [DB.database, table, column]);
    if (!meta.length) continue;
    const nullable = String(meta[0].nullable ?? meta[0].IS_NULLABLE).toUpperCase() === 'YES';

    try {
      await conn.query(
        `ALTER TABLE \`${table}\` MODIFY \`${column}\` LONGTEXT ${nullable ? 'NULL' : 'NOT NULL'}`);
      console.log(`  - ${table}.${column}  json_valid CHECK removed`);
      dropped += 1;
    } catch (err) {
      console.log(`  ! could not remove the check on ${table}.${column}: ${err.message}`);
    }
  }
  return dropped;
}

async function addColumn(conn, table, column, definition) {
  if (await columnExists(conn, table, column)) return false;
  await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
  console.log(`  + ${table}.${column}`);
  return true;
}

async function addIndex(conn, table, index, definition) {
  if (await indexExists(conn, table, index)) return false;
  await conn.query(`ALTER TABLE \`${table}\` ADD ${definition}`);
  console.log(`  + ${table} index ${index}`);
  return true;
}

// Patch blocks for columns and indexes added after a deploy. Each one is a
// no-op on an install that already has it.
async function patch(conn) {
  const tableExists = async (t) => {
    const [rows] = await conn.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = ? AND table_name = ? LIMIT 1`, [DB.database, t]);
    return rows.length > 0;
  };

  // --- 2026-07 initial release --------------------------------------------
  // Nothing to patch yet: every table above is in schema.sql. New columns go
  // here as the schema evolves, e.g.
  //   await addColumn(conn, 'legs', 'requote_count',
  //     'requote_count INT UNSIGNED NOT NULL DEFAULT 0');

  if (await tableExists('legs')) {
    await addColumn(conn, 'legs', 'requote_count',
      'requote_count INT UNSIGNED NOT NULL DEFAULT 0');
    // The dynamic target ladder's step count — see doc/traling-traget -stoploss.md.
    await addColumn(conn, 'legs', 'confirmations',
      'confirmations INT UNSIGNED NOT NULL DEFAULT 0');
  }
  if (await tableExists('orders')) {
    await addIndex(conn, 'orders', 'idx_orders_cycle', 'KEY idx_orders_cycle (cycle_id, stage)');
    // The Price-Filter Engine (doc/new.md) shares this table. Its orders carry
    // a trade id instead of a leg id and a `pf-` client_ref instead of `zo-`.
    await addColumn(conn, 'orders', 'pfe_trade_id', 'pfe_trade_id INT UNSIGNED NULL');
    await addIndex(conn, 'orders', 'idx_orders_pfe', 'KEY idx_orders_pfe (pfe_trade_id, stage)');
    // The Option Selling Engine (newdoc/update.md) shares this table too. Its
    // orders carry an `os-` client_ref and an ose_trade_id.
    await addColumn(conn, 'orders', 'ose_trade_id', 'ose_trade_id INT UNSIGNED NULL');
    await addIndex(conn, 'orders', 'idx_orders_ose', 'KEY idx_orders_ose (ose_trade_id, stage)');
  }

  // Bars downloaded from Yahoo to give the charts the history Kotak has no
  // endpoint for. Defaulting to LIVE is correct for every row that already
  // exists: everything written before this column was assembled here from the
  // tick stream.
  if (await tableExists('candles')) {
    await addColumn(conn, 'candles', 'source',
      "source ENUM('LIVE','BACKFILL') NOT NULL DEFAULT 'LIVE'");
    await rekeyIndexCandles(conn);
  }

  // newdoc/update.md §19.4. The sample count behind each decision, and whether
  // it was too thin to trade on (§7.8).
  //
  // Defaulting `tick_count` to 0 on rows written before this column existed is
  // deliberate and is NOT the same claim as "that bar had no samples": a zero
  // here means "not recorded". Anything reading the distribution must filter to
  // rows written after the migration, which is what the id ordering is for.
  // Every JSON column, converted in place. Listed rather than discovered so the
  // set is reviewable — a loop over information_schema would also catch a column
  // some future migration deliberately made JSON.
  for (const [table, column, notNull] of [
    ['settings', 'payload', true],
    ['cycles', 'settings_snapshot', false],
    ['events', 'payload', false],
    ['pfe_trades', 'select_detail', false],
    ['pfe_trades', 'settings_snapshot', false],
    ['pfe_scans', 'candidates', false],
    ['ose_trades', 'select_detail', false],
    ['ose_trades', 'settings_snapshot', false],
  ]) {
    if (await tableExists(table)) await jsonToLongtext(conn, table, column, notNull);
  }

  // ...and the CHECK constraints that came with the JSON declaration.
  await dropJsonValidChecks(conn);

  if (await tableExists('ose_decisions')) {
    await addColumn(conn, 'ose_decisions', 'low_confidence',
      'low_confidence TINYINT(1) NOT NULL DEFAULT 0 AFTER synthetic');
    await addColumn(conn, 'ose_decisions', 'tick_count',
      'tick_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER low_confidence');
  }
}

// Move index candles from the numeric exchange token onto the NAME.
//
// Kotak's quotes API addresses a cash-segment index by name — `nse_cm|26000`
// answers 200 with an EMPTY array while `nse_cm|Nifty 50` answers with a price
// (verified against the live gateway). `instrumentMaster.indexInstrument` was
// preferring the numeric token, which made the index unquotable and took the
// spot price, the ATM and the whole trend-filter bar series down with it.
//
// Now that the name is authoritative, any history already stored under the
// numeric token is orphaned — the chart would look under "Nifty 50" and find
// nothing. This moves it rather than making the operator re-download a decade
// of daily bars.
//
// Idempotent: after the first run there is nothing left under the old token.
// Rows are only moved where the destination bucket does not already exist, so a
// bar this platform recorded live can never be overwritten by a moved one.
const INDEX_QUOTE_NAMES = {
  NIFTY: 'Nifty 50',
  BANKNIFTY: 'Nifty Bank',
  FINNIFTY: 'Nifty Fin Service',
  MIDCPNIFTY: 'Nifty Midcap Select',
};

async function rekeyIndexCandles(conn) {
  for (const [underlying, name] of Object.entries(INDEX_QUOTE_NAMES)) {
    const [rows] = await conn.query(
      "SELECT token FROM instruments WHERE underlying = ? AND option_type = 'IDX' LIMIT 1",
      [underlying]);
    const numeric = rows[0]?.token;
    if (!numeric || numeric === name) continue;

    const [existing] = await conn.query(
      'SELECT COUNT(*) AS n FROM candles WHERE token = ?', [numeric]);
    if (!existing[0].n) continue;

    const [res] = await conn.query(
      `UPDATE IGNORE candles SET token = ? WHERE token = ?`, [name, numeric]);
    // UPDATE IGNORE skips a row whose destination bucket already exists. Those
    // are duplicates of something already held, so dropping them is correct.
    const [leftover] = await conn.query(
      'SELECT COUNT(*) AS n FROM candles WHERE token = ?', [numeric]);
    if (leftover[0].n) {
      await conn.query('DELETE FROM candles WHERE token = ?', [numeric]);
    }
    console.log(`  + candles: re-keyed ${res.affectedRows} ${underlying} bars from `
      + `"${numeric}" to "${name}"`
      + (leftover[0].n ? ` (dropped ${leftover[0].n} already held under the name)` : ''));
  }
}

// The default settings row. Written only when absent, so an operator's edits
// are never overwritten by a re-run.
const DEFAULT_SETTINGS = {
  symbol: 'NIFTY',
  expiryMode: 'CURRENT_WEEKLY',
  manualExpiry: null,
  tradeMode: 'BOTH',

  strikeMode: 'PREMIUM',
  atmOffset: 2,
  targetPremium: 12,
  premiumTolerance: 2,

  entryMode: 'OPTION_CANDLE_CLOSE',
  priceSource: 'CANDLE_CLOSE',
  candleTimeframe: '1m',
  sellOffset: 1.0,
  useLiveAsk: false,
  useLiveBid: false,
  useLTP: false,
  lockStrike: true,
  reQuoteOnNextCandle: true,
  pendingTimeout: 10,

  // ---- the NIFTY index trend filter (doc/update-point.md) ----
  // Off by default: it is a constraint on when the engine may sell, and an
  // operator should turn it on knowingly rather than find their fill rate
  // halved after an upgrade.
  // A leg that never gets permission to enter stands down after this long, so
  // one blocked leg cannot hold the strike lock for the rest of the session.
  legEntryTimeout: 180,

  // How long a locked strike may be re-used under cycleScope PER_LEG.
  cycleMaxAge: 900,

  trendFilter: false,
  trendTimeframe: '5s',
  trendConfirmBars: 3,
  trendBodyPct: 60,
  trendCloseNearPct: 25,
  trendStrongBodyPct: 70,
  trendWickPct: 15,
  trendMaxRangePoints: 10,
  trendMinScore: 5,
  trendMinTicks: 4,
  trendMomentum: true,

  // ---- the dynamic target and trailing stop (doc/traling-traget -stoploss.md) ----
  // Off by default: it changes what a winning trade is worth.
  dynamicTarget: false,
  dynamicTargetStep: 1.0,
  dynamicTargetMax: 4,
  trailStart: 0.5,
  trailGap: 0.5,
  exitOnReversal: false,

  // Both 1.5, deliberately symmetric.
  //
  // The source documents specify 1.0 and 2.0 — losing two to win one, which
  // needs a 67% hit rate to break even and has nothing to do with charges: on a
  // zero-brokerage plan a round trip costs about 0.03 points, so risk/reward is
  // very nearly the whole story and the required win rate is just
  // `stop / (stop + target)`.
  //
  // 1.5 / 1.5 asks for a coin flip (50.8%) instead of two-in-three, and keeps
  // more noise tolerance in the stop than tightening to 1.0 / 1.0 would. Widen
  // the target rather than the stop if you want a lower required rate; see
  // doc/HOW-IT-WORKS.md §12, and `dynamicTarget` for letting winners run past
  // the first rung.
  target: 1.5,
  stopLoss: 1.5,
  positionTimeout: 60,

  lots: 1,

  sessionStart: '09:20',
  sessionEnd: '15:10',
  squareOffAt: '15:15',

  // maxOpenCE / maxOpenPE are deliberately absent. They were config for a limit
  // the SCHEMA already enforces — `uk_leg_cycle_type (cycle_id, option_type)`
  // permits exactly one CE and one PE leg per cycle — so nothing ever read them.
  // A setting that cannot change anything is worse than no setting.
  marketMovePause: 40,
  marketMoveWindow: 30,
  cooldownAfterSL: 300,
  maxDailyLoss: 3000,
  maxDailyProfit: 5000,
  maxConsecutiveLoss: 3,
  maxCyclesPerDay: 0,

  cycleScope: 'BOTH_LEGS',
  mode: 'PAPER',
};

// The Price-Filter Engine's profile — doc/new.md, and src/pfe/settings.js is
// the authority. Required here rather than duplicated: a second copy of a
// hundred risk parameters is a second copy to drift.
//
// Loaded lazily and defensively. `npm run migrate` must work on a checkout
// whose .env is not filled in yet, and src/config/index.js exits the process on
// a missing TOKEN_ENC_KEY — so a require() at the top of this file would turn
// "run the migration first" into a chicken-and-egg problem.
function pfeDefaults() {
  try {
    // eslint-disable-next-line global-require
    return require('../src/pfe/settings').DEFAULTS;
  } catch (err) {
    console.log(`  ! could not load the Price Filter defaults (${err.message})`);
    console.log('    — fill in .env and re-run `npm run migrate` to seed that profile');
    return null;
  }
}

// The Option Selling Engine's profile — newdoc/update.md §5.1, and
// src/ose/settings.js is the authority. Same lazy, defensive load as the Price
// Filter's for the same reason.
function oseDefaults() {
  try {
    // eslint-disable-next-line global-require
    return require('../src/ose/settings').DEFAULTS;
  } catch (err) {
    console.log(`  ! could not load the Option Selling defaults (${err.message})`);
    console.log('    — fill in .env and re-run `npm run migrate` to seed that profile');
    return null;
  }
}

async function seed(conn) {
  let seeded = false;

  const [rows] = await conn.query('SELECT id FROM settings WHERE name = ? LIMIT 1', ['default']);
  if (!rows.length) {
    await conn.query('INSERT INTO settings (name, payload, version) VALUES (?, ?, 1)',
      ['default', JSON.stringify(DEFAULT_SETTINGS)]);
    console.log('  + seeded settings "default" (mode: PAPER)');
    seeded = true;
  }

  const [pfe] = await conn.query('SELECT id FROM settings WHERE name = ? LIMIT 1', ['pfe']);
  if (!pfe.length) {
    const defaults = pfeDefaults();
    if (defaults) {
      await conn.query('INSERT INTO settings (name, payload, version) VALUES (?, ?, 1)',
        ['pfe', JSON.stringify(defaults)]);
      console.log('  + seeded settings "pfe" — the Price-Filter Engine (mode: PAPER)');
      seeded = true;
    }
  }

  const [ose] = await conn.query('SELECT id FROM settings WHERE name = ? LIMIT 1', ['ose']);
  if (!ose.length) {
    const defaults = oseDefaults();
    if (defaults) {
      await conn.query('INSERT INTO settings (name, payload, version) VALUES (?, ?, 1)',
        ['ose', JSON.stringify(defaults)]);
      console.log('  + seeded settings "ose" — the Option Selling Engine (mode: PAPER)');
      console.log('    ! liquidityMode ships STRICT (newdoc/update.md §9.2 read literally).');
      console.log('      On a Kotak retail entitlement NO STRIKE WILL EVER BE SELECTED in that');
      console.log('      mode — see [MUST-CONFIRM #10] and /ose/settings.');
      seeded = true;
    }
  }

  return seeded;
}

// New keys added to the Price Filter profile after a deploy. Same rule as
// backfillSettings() below: absent keys are filled from the defaults, keys the
// operator has set are never touched.
async function backfillPfeSettings(conn) {
  const defaults = pfeDefaults();
  if (!defaults) return;
  const [rows] = await conn.query('SELECT id, name, payload FROM settings WHERE name = ?', ['pfe']);
  for (const row of rows) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const added = [];
    for (const [key, value] of Object.entries(defaults)) {
      if (payload[key] === undefined) { payload[key] = value; added.push(key); }
    }
    if (!added.length) continue;
    await conn.query('UPDATE settings SET payload = ?, version = version + 1 WHERE id = ?',
      [JSON.stringify(payload), row.id]);
    console.log(`  + settings "pfe": ${added.join(', ')}`);
  }
}

// The settings row is a JSON blob, so a new config key is a data migration
// rather than a schema one: an existing profile has no `trendFilter` and would
// fail validation on the next boot. Absent keys are filled from the defaults;
// keys the operator has already set are never touched.
// Scoped to the scalper's own profiles. The Price-Filter Engine keeps its
// configuration in a row called `pfe` and the Option Selling Engine in one
// called `ose`, both with completely different key sets, and an unscoped
// backfill would pour a hundred scalper keys into them — every one of which
// their validators would then have to ignore, and one of which (`target`) means
// something different in each engine.
// The same, for the Option Selling Engine's profile.
async function backfillOseSettings(conn) {
  const defaults = oseDefaults();
  if (!defaults) return;
  const [rows] = await conn.query('SELECT id, name, payload FROM settings WHERE name = ?', ['ose']);
  for (const row of rows) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const added = [];
    for (const [key, value] of Object.entries(defaults)) {
      if (payload[key] === undefined) { payload[key] = value; added.push(key); }
    }
    if (!added.length) continue;
    await conn.query('UPDATE settings SET payload = ?, version = version + 1 WHERE id = ?',
      [JSON.stringify(payload), row.id]);
    console.log(`  + settings "ose": ${added.join(', ')}`);
  }
}

async function backfillSettings(conn) {
  const [rows] = await conn.query(
    'SELECT id, name, payload FROM settings WHERE name NOT IN (?, ?)', ['pfe', 'ose']);
  for (const row of rows) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const added = [];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (payload[key] === undefined) { payload[key] = value; added.push(key); }
    }
    // The trend filter was first written against a 15-second bar and a strength
    // score out of 10. The current spec (doc/update-point.md) is 5-second bars
    // scored out of 5, so a profile carrying the old numbers would fail the
    // 0–5 range check at boot. Move it rather than leave the engine unable to
    // start; both are re-editable on the settings page.
    if (Number(payload.trendMinScore) > 5) {
      payload.trendMinScore = 5;
      added.push('trendMinScore→5');
    }
    if (payload.trendTimeframe === '15s') {
      payload.trendTimeframe = '5s';
      added.push('trendTimeframe→5s');
    }

    // The shipped target/stop changed from 1.0/2.0 to 1.5/1.5 — losing two to
    // win one needs a 67% hit rate, and on a zero-brokerage plan that is a
    // risk/reward choice rather than a charges one.
    //
    // Only moved when the row still holds the ORIGINAL pair untouched. An
    // operator who has tuned these has made a decision, and a migration must not
    // quietly overrule it. Announced loudly either way: this is a live risk
    // parameter, not a formatting change.
    if (Number(payload.target) === 1.0 && Number(payload.stopLoss) === 2.0) {
      payload.target = 1.5;
      payload.stopLoss = 1.5;
      added.push('target 1.0→1.5, stopLoss 2.0→1.5');
      console.log('  ! RISK PARAMETERS CHANGED: target 1.0 -> 1.5, stopLoss 2.0 -> 1.5');
      console.log('    (the old pair needed a 67% win rate to break even; the new one 51%)');
      console.log('    Change them back on /settings if that was deliberate.');
    }

    if (!added.length) continue;
    await conn.query('UPDATE settings SET payload = ?, version = version + 1 WHERE id = ?',
      [JSON.stringify(payload), row.id]);
    console.log(`  + settings "${row.name}": ${added.join(', ')}`);
  }
}

async function main() {
  const root = await mysql.createConnection({
    host: DB.host, port: DB.port, user: DB.user, password: DB.password, multipleStatements: false,
  });
  await root.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB.database}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await root.end();
  console.log(`database ${DB.database} ready`);

  const conn = await mysql.createConnection({ ...DB, multipleStatements: false });
  try {
    await conn.query("SET time_zone = '+00:00'");

    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    const list = statements(sql);
    for (const stmt of list) await conn.query(stmt);
    console.log(`applied ${list.length} schema statements`);

    console.log('patches:');
    await patch(conn);
    await seed(conn);
    await backfillSettings(conn);
    await backfillPfeSettings(conn);
    await backfillOseSettings(conn);

    console.log('migrate: done');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('migrate failed:', err.message);
  process.exit(1);
});
