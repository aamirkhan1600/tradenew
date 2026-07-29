// MySQL access. Everything goes through query / queryOne / tx — no module opens
// its own connection.
//
// Connections are pinned to UTC. The driver's `timezone` option only affects how
// it parses DATETIME values; without also setting the session time_zone, NOW()
// and CURRENT_TIMESTAMP defaults evaluate in the server's local zone (IST on
// most Indian hosts) and are read back as UTC — a silent 5h30m offset on every
// timestamp the app writes.

const mysql = require('mysql2/promise');
const config = require('../config');
const logger = require('./logger');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  queueLimit: 0,
  timezone: 'Z',
  dateStrings: false,
  multipleStatements: false,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

// mysql2's prepared-statement path rejects `undefined`. A stray undefined is
// nearly always a typo'd property in the caller, so surface it with the index
// rather than the driver's generic error.
function assertParams(sql, params) {
  for (let i = 0; i < params.length; i++) {
    if (params[i] === undefined) {
      throw new Error(`query parameter ${i} is undefined — ${sql.slice(0, 90).replace(/\s+/g, ' ')}`);
    }
  }
}

async function query(sql, params = []) {
  assertParams(sql, params);
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const scoped = {
      query: async (sql, params = []) => {
        assertParams(sql, params);
        const [rows] = await conn.execute(sql, params);
        return rows;
      },
    };
    scoped.queryOne = async (sql, params = []) => {
      const rows = await scoped.query(sql, params);
      return rows.length ? rows[0] : null;
    };
    const out = await fn(scoped);
    await conn.commit();
    return out;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* connection already gone */ }
    throw err;
  } finally {
    conn.release();
  }
}

const isDuplicate = (err) => err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062);

async function healthCheck() {
  const rows = await query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

async function close() {
  try { await pool.end(); } catch (err) { logger.warn('db pool close failed', { err: err.message }); }
}

module.exports = { pool, query, queryOne, tx, isDuplicate, healthCheck, close };
