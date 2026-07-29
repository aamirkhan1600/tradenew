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

  target: 1.0,
  stopLoss: 2.0,
  positionTimeout: 60,

  lots: 1,

  sessionStart: '09:20',
  sessionEnd: '15:10',
  squareOffAt: '15:15',

  maxOpenCE: 1,
  maxOpenPE: 1,
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

async function seed(conn) {
  const [rows] = await conn.query('SELECT id FROM settings WHERE name = ? LIMIT 1', ['default']);
  if (rows.length) return false;
  await conn.query('INSERT INTO settings (name, payload, version) VALUES (?, ?, 1)',
    ['default', JSON.stringify(DEFAULT_SETTINGS)]);
  console.log('  + seeded settings "default" (mode: PAPER)');
  return true;
}

// The settings row is a JSON blob, so a new config key is a data migration
// rather than a schema one: an existing profile has no `trendFilter` and would
// fail validation on the next boot. Absent keys are filled from the defaults;
// keys the operator has already set are never touched.
async function backfillSettings(conn) {
  const [rows] = await conn.query('SELECT id, name, payload FROM settings');
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

    console.log('migrate: done');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('migrate failed:', err.message);
  process.exit(1);
});
