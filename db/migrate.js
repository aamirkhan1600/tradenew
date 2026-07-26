// Idempotent migration runner.
//
// Creates the database if absent, applies db/schema.sql statement-by-statement
// (so a failure names the statement that broke rather than bubbling up an
// opaque driver error), then runs additive patches for installs whose tables
// already exist — CREATE TABLE IF NOT EXISTS silently skips a table that is
// present, so new columns and indexes need their own idempotent step.
//
// Safe to run repeatedly. Run it after every pull.

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config');

// Columns added to tables that may already exist in the wild.
const COLUMN_PATCHES = [
  { table: 'strategies', column: 'square_off_requested_at',
    definition: 'DATETIME DEFAULT NULL AFTER last_error' },
  { table: 'strategies', column: 'square_off_requested_by',
    definition: 'VARCHAR(191) DEFAULT NULL AFTER square_off_requested_at' },
];

// Indexes added after the fact.
const INDEX_PATCHES = [
  // { table: 'orders', name: 'idx_foo', columns: '(a, b)' },
];

const SEED_FLAGS = [
  ['trading_halted', String(config.tradingHalted), 'global kill switch for opening orders'],
];

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
  });

  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\`
       DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${config.db.database}\``);

  // Older MySQL 5.6 / MariaDB 10.1 default to a 767-byte index prefix, which a
  // utf8mb4 VARCHAR(191) key exceeds. These are no-ops on modern servers and
  // may be denied on managed hosts — neither case is fatal.
  for (const stmt of [
    'SET SESSION innodb_strict_mode = 0',
    "SET GLOBAL innodb_file_format = 'Barracuda'",
    'SET GLOBAL innodb_large_prefix = 1',
  ]) {
    try { await conn.query(stmt); }
    catch (e) { console.warn(`[migrate] skipped "${stmt}" (${e.code || e.message})`); }
  }

  const statements = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map(s => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);

  let applied = 0;
  for (const stmt of statements) {
    try {
      await conn.query(stmt);
      applied += 1;
    } catch (err) {
      console.error(`[migrate] FAILED: ${stmt.slice(0, 100).replace(/\s+/g, ' ')}...`);
      throw err;
    }
  }
  console.log(`[migrate] applied ${applied} statements`);

  /* ------------------------------------------------------------- patches -- */
  const tableExists = async (table) => {
    const [r] = await conn.query(
      `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1`,
      [config.db.database, table]);
    return r.length > 0;
  };

  for (const p of COLUMN_PATCHES) {
    if (!await tableExists(p.table)) continue;
    const [cols] = await conn.query(
      `SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [config.db.database, p.table, p.column]);
    if (!cols.length) {
      await conn.query(`ALTER TABLE \`${p.table}\` ADD COLUMN \`${p.column}\` ${p.definition}`);
      console.log(`[migrate] + column ${p.table}.${p.column}`);
    }
  }

  for (const p of INDEX_PATCHES) {
    if (!await tableExists(p.table)) continue;
    const [idx] = await conn.query(
      `SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
      [config.db.database, p.table, p.name]);
    if (!idx.length) {
      await conn.query(`ALTER TABLE \`${p.table}\` ADD KEY \`${p.name}\` ${p.columns}`);
      console.log(`[migrate] + index ${p.table}.${p.name}`);
    }
  }

  // One-off repair: index rows were originally written with NULL expiry/strike.
  // MySQL treats NULLs as distinct in a UNIQUE key, so every sync INSERTed a
  // fresh duplicate instead of updating. Collapse them onto the sentinel values
  // the code now uses, keeping the newest row per underlying.
  const [nullIdx] = await conn.query(
    `SELECT COUNT(*) n FROM instruments WHERE option_type = 'IDX' AND (expiry_date IS NULL OR strike IS NULL)`);
  if (Number(nullIdx[0].n) > 0) {
    const [keep] = await conn.query(
      `SELECT MAX(id) id FROM instruments WHERE option_type = 'IDX' GROUP BY underlying`);
    const keepIds = keep.map(r => r.id);
    const [del] = await conn.query(
      `DELETE FROM instruments WHERE option_type = 'IDX'
        ${keepIds.length ? `AND id NOT IN (${keepIds.map(() => '?').join(',')})` : ''}`,
      keepIds);
    const [upd] = await conn.query(
      `UPDATE instruments SET expiry_date = '1970-01-01', strike = 0
        WHERE option_type = 'IDX' AND (expiry_date IS NULL OR strike IS NULL)`);
    console.log(`[migrate] index rows: removed ${del.affectedRows} duplicates, `
      + `normalised ${upd.affectedRows} onto sentinel keys`);
  }

  for (const [key, value, note] of SEED_FLAGS) {
    await conn.query(
      `INSERT INTO system_flags (flag_key, flag_value, note) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE note = VALUES(note)`,
      [key, value, note]);
  }

  const [[{ n: tables }]] = await conn.query(
    `SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
    [config.db.database]);

  await conn.end();
  console.log(`[migrate] ok — ${config.db.database} has ${tables} tables`);
}

main().catch((err) => {
  console.error('[migrate] failed:', err.message);
  process.exit(1);
});
