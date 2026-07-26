// Data access. Every SQL statement in the application lives in this file, so
// the schema's blast radius is one module and higher layers deal in plain
// objects rather than rows.

const { query, queryOne, tx } = require('../core/db');
const crypto = require('../core/crypto');
const { istDateString } = require('../core/time');

/* =============================================================== users ==== */
const users = {
  async findByEmail(email) {
    return queryOne('SELECT * FROM users WHERE email = ? LIMIT 1', [String(email).toLowerCase()]);
  },

  async findById(id) {
    return queryOne('SELECT * FROM users WHERE id = ? LIMIT 1', [Number(id)]);
  },

  async create({ email, password, fullName = null, role = 'OWNER' }) {
    const r = await query(
      'INSERT INTO users (email, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
      [String(email).toLowerCase(), crypto.hashPassword(password), fullName, role]);
    return r.insertId;
  },

  async touchLogin(id) {
    await query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [Number(id)]);
  },

  async count() {
    const r = await queryOne('SELECT COUNT(*) AS n FROM users');
    return Number(r.n);
  },
};

/* ====================================================== broker accounts ==== */
// Column names are generic (`secret_enc`, `aux1_enc`) because the two brokers
// need different fields; these helpers map them to named properties so nothing
// downstream has to remember which slot holds what.
const brokers = {
  async get(userId, broker) {
    const row = await queryOne(
      'SELECT * FROM broker_accounts WHERE user_id = ? AND broker = ? LIMIT 1',
      [Number(userId), broker]);
    if (!row) return null;
    const base = {
      id: row.id, userId: Number(row.user_id), broker: row.broker, status: row.status,
      publicId: row.public_id, brokerUserId: row.broker_user_id,
      brokerUserName: row.broker_user_name, lastLoginAt: row.last_login_at,
      lastError: row.last_error,
      accessToken: crypto.decrypt(row.access_token_enc),
      secret: crypto.decrypt(row.secret_enc),
    };
    if (broker === 'zerodha') {
      return { ...base, apiKey: row.public_id, apiSecret: base.secret, publicToken: crypto.decrypt(row.aux1_enc) };
    }
    return {
      ...base,
      ucc: row.public_id, mobile: base.secret,
      sessionToken: base.accessToken,
      sid: crypto.decrypt(row.aux1_enc),
      baseUrl: row.aux3,
    };
  },

  async saveZerodhaCredentials(userId, { apiKey, apiSecret }) {
    await query(
      `INSERT INTO broker_accounts (user_id, broker, public_id, secret_enc)
       VALUES (?, 'zerodha', ?, ?)
       ON DUPLICATE KEY UPDATE
         public_id = COALESCE(VALUES(public_id), public_id),
         secret_enc = COALESCE(VALUES(secret_enc), secret_enc)`,
      [Number(userId), apiKey || null, apiSecret ? crypto.encrypt(apiSecret) : null]);
  },

  async saveZerodhaSession(userId, { apiKey, apiSecret, accessToken, publicToken, kiteUserId, kiteUserName }) {
    await query(
      `INSERT INTO broker_accounts
         (user_id, broker, status, public_id, secret_enc, access_token_enc, aux1_enc,
          broker_user_id, broker_user_name, last_login_at, last_error)
       VALUES (?, 'zerodha', 'CONNECTED', ?, ?, ?, ?, ?, ?, NOW(), NULL)
       ON DUPLICATE KEY UPDATE
         status = 'CONNECTED', public_id = VALUES(public_id), secret_enc = VALUES(secret_enc),
         access_token_enc = VALUES(access_token_enc), aux1_enc = VALUES(aux1_enc),
         broker_user_id = VALUES(broker_user_id), broker_user_name = VALUES(broker_user_name),
         last_login_at = NOW(), last_error = NULL`,
      [Number(userId), apiKey, crypto.encrypt(apiSecret), crypto.encrypt(accessToken),
       publicToken ? crypto.encrypt(publicToken) : null, kiteUserId || null, kiteUserName || null]);
  },

  async saveKotakSession(userId, { ucc, mobile, sessionToken, sid, baseUrl, userName }) {
    await query(
      `INSERT INTO broker_accounts
         (user_id, broker, status, public_id, secret_enc, access_token_enc, aux1_enc, aux3,
          broker_user_id, broker_user_name, last_login_at, last_error)
       VALUES (?, 'kotak', 'CONNECTED', ?, ?, ?, ?, ?, ?, ?, NOW(), NULL)
       ON DUPLICATE KEY UPDATE
         status = 'CONNECTED', public_id = VALUES(public_id), secret_enc = VALUES(secret_enc),
         access_token_enc = VALUES(access_token_enc), aux1_enc = VALUES(aux1_enc),
         aux3 = VALUES(aux3), broker_user_id = VALUES(broker_user_id),
         broker_user_name = VALUES(broker_user_name), last_login_at = NOW(), last_error = NULL`,
      [Number(userId), ucc || null, mobile ? crypto.encrypt(mobile) : null,
       crypto.encrypt(sessionToken), crypto.encrypt(sid), baseUrl || null,
       ucc || null, userName || null]);
  },

  async disconnect(userId, broker) {
    await query(
      `UPDATE broker_accounts SET status = 'DISCONNECTED', access_token_enc = NULL, aux1_enc = NULL
        WHERE user_id = ? AND broker = ?`, [Number(userId), broker]);
  },

  // Flip to EXPIRED exactly once. Several concurrent calls can all see a 403 at
  // the same moment; without the conditional UPDATE each would raise its own
  // alert for a single underlying event.
  async markExpiredOnce(userId, broker, reason) {
    const r = await query(
      `UPDATE broker_accounts SET status = 'EXPIRED', last_error = ?
        WHERE user_id = ? AND broker = ? AND status <> 'EXPIRED'`,
      [String(reason || '').slice(0, 500), Number(userId), broker]);
    return r.affectedRows === 1;
  },

  async markError(userId, broker, message) {
    await query(
      `UPDATE broker_accounts SET status = 'ERROR', last_error = ? WHERE user_id = ? AND broker = ?`,
      [String(message || '').slice(0, 500), Number(userId), broker]);
  },

  // Sessions that failed but still hold a token — candidates for a recovery
  // probe. A DISCONNECTED account is excluded: it has no token and only a fresh
  // login can help it.
  async listRecoverable(broker) {
    return query(
      `SELECT user_id FROM broker_accounts
        WHERE broker = ? AND status IN ('EXPIRED','ERROR') AND access_token_enc IS NOT NULL`,
      [broker]);
  },

  // Restore a session that a probe has just proven healthy, without touching the
  // stored token.
  async markConnected(userId, broker) {
    await query(
      `UPDATE broker_accounts SET status = 'CONNECTED', last_error = NULL
        WHERE user_id = ? AND broker = ?`, [Number(userId), broker]);
  },

  async listConnected(broker) {
    return query(
      `SELECT user_id FROM broker_accounts
        WHERE broker = ? AND status = 'CONNECTED' AND access_token_enc IS NOT NULL`, [broker]);
  },
};

/* ======================================================== instruments ===== */
const instruments = {
  // Bulk upsert of one broker's side of the master. `side` is 'z' or 'k'; the
  // other side's columns are left untouched, which is what lets two independent
  // syncs converge on one bridged row.
  async upsertMany(rows, side) {
    if (!rows.length) return 0;
    const cols = side === 'z'
      ? ['z_token', 'z_symbol', 'z_exchange']
      : ['k_token', 'k_symbol', 'k_segment'];
    const CHUNK = 400;
    let written = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
      const params = [];
      for (const r of slice) {
        params.push(r.underlying, r.expiryDate, r.strike, r.optionType,
          r.a, r.b, r.c, r.lotSize ?? null, r.tickSize ?? null);
      }
      await query(
        `INSERT INTO instruments
           (underlying, expiry_date, strike, option_type, ${cols.join(', ')}, lot_size, tick_size)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           ${cols.map(c => `${c} = VALUES(${c})`).join(', ')},
           lot_size = COALESCE(VALUES(lot_size), lot_size),
           tick_size = COALESCE(VALUES(tick_size), tick_size),
           synced_at = NOW()`,
        params);
      written += slice.length;
    }
    return written;
  },

  // The database's clock, not the application's. A prune compares against
  // synced_at, which the server sets with NOW() — comparing that to a
  // Node-generated timestamp would silently mis-fire whenever the app server
  // and the database disagree about the time.
  async now() {
    const row = await queryOne('SELECT NOW(3) AS t');
    return row.t;
  },

  // Remove option contracts neither master listed in the latest sync. Index
  // rows are exempt: they are seeded from a much smaller feed and their absence
  // from one download is not evidence of anything.
  async pruneStale(cutoff) {
    const r = await query(
      `DELETE FROM instruments WHERE option_type IN ('CE','PE') AND synced_at < ?`, [cutoff]);
    return r.affectedRows;
  },

  // Recompute the bridge flag after a sync. A contract is tradable only when
  // BOTH brokers know it: quotable without being orderable is a trap.
  async refreshTradableFlags() {
    const r = await query(
      `UPDATE instruments
          SET tradable = CASE WHEN z_token IS NOT NULL AND k_token IS NOT NULL
                              AND k_symbol IS NOT NULL THEN 1 ELSE 0 END`);
    return r.affectedRows;
  },

  async listExpiries(underlying) {
    const rows = await query(
      `SELECT DISTINCT expiry_date FROM instruments
        WHERE underlying = ? AND option_type IN ('CE','PE')
          AND expiry_date IS NOT NULL AND expiry_date >= CURDATE()
        ORDER BY expiry_date ASC`, [String(underlying).toUpperCase()]);
    return rows.map(r => (r.expiry_date instanceof Date
      ? r.expiry_date.toISOString().slice(0, 10)
      : String(r.expiry_date).slice(0, 10)));
  },

  async indexToken(underlying) {
    const row = await queryOne(
      `SELECT z_token FROM instruments WHERE underlying = ? AND option_type = 'IDX' LIMIT 1`,
      [String(underlying).toUpperCase()]);
    return row?.z_token != null ? String(row.z_token) : null;
  },

  // The option chain, one row per strike with both brokers' identifiers.
  async chain(underlying, expiry) {
    const rows = await query(
      `SELECT id, strike, option_type, z_token, z_symbol, k_token, k_symbol, k_segment,
              lot_size, tick_size, tradable
         FROM instruments
        WHERE underlying = ? AND expiry_date = ? AND option_type IN ('CE','PE')
        ORDER BY strike ASC`,
      [String(underlying).toUpperCase(), expiry]);

    const byStrike = new Map();
    let lotSize = null;
    for (const r of rows) {
      const strike = Number(r.strike);
      if (!Number.isFinite(strike)) continue;
      if (!byStrike.has(strike)) byStrike.set(strike, { strike });
      if (r.lot_size && !lotSize) lotSize = r.lot_size;
      const cell = {
        instrumentId: r.id,
        zToken: r.z_token != null ? String(r.z_token) : null,
        zSymbol: r.z_symbol,
        kToken: r.k_token,
        kSymbol: r.k_symbol,
        kSegment: r.k_segment || 'nse_fo',
        lotSize: r.lot_size,
        tickSize: r.tick_size != null ? Number(r.tick_size) : 0.05,
        tradable: !!r.tradable && r.z_token != null,
      };
      byStrike.get(strike)[r.option_type === 'CE' ? 'ce' : 'pe'] = cell;
    }
    return { underlying, expiry, lotSize, chain: [...byStrike.values()].sort((a, b) => a.strike - b.strike) };
  },

  async lotSize(underlying) {
    const row = await queryOne(
      `SELECT lot_size, COUNT(*) n FROM instruments
        WHERE underlying = ? AND option_type IN ('CE','PE') AND lot_size > 0
          AND expiry_date >= CURDATE()
        GROUP BY lot_size ORDER BY n DESC LIMIT 1`, [String(underlying).toUpperCase()]);
    return row ? Number(row.lot_size) : null;
  },

  async bridgeHealth(underlying, expiry) {
    const row = await queryOne(
      `SELECT COUNT(*) total,
              SUM(tradable = 1) tradable,
              SUM(z_token IS NULL) missing_zerodha,
              SUM(k_token IS NULL) missing_kotak
         FROM instruments
        WHERE underlying = ? AND expiry_date = ? AND option_type IN ('CE','PE')`,
      [String(underlying).toUpperCase(), expiry]);
    return {
      underlying, expiry,
      total: Number(row?.total || 0),
      tradable: Number(row?.tradable || 0),
      missingZerodha: Number(row?.missing_zerodha || 0),
      missingKotak: Number(row?.missing_kotak || 0),
    };
  },

  async summary() {
    return query(
      `SELECT underlying, option_type, COUNT(*) n, SUM(tradable = 1) tradable,
              MIN(expiry_date) first_expiry, MAX(expiry_date) last_expiry, MAX(synced_at) synced_at
         FROM instruments GROUP BY underlying, option_type ORDER BY underlying, option_type`);
  },
};

/* ========================================================= strategies ===== */
const strategies = {
  async listByUser(userId) {
    return query(
      `SELECT * FROM strategies WHERE user_id = ? ORDER BY queue_priority ASC, id ASC`,
      [Number(userId)]);
  },

  async listEnabled() {
    return query(
      `SELECT * FROM strategies WHERE enabled = 1 ORDER BY user_id ASC, queue_priority ASC, id ASC`);
  },

  async get(id, userId = null) {
    return userId == null
      ? queryOne('SELECT * FROM strategies WHERE id = ? LIMIT 1', [Number(id)])
      : queryOne('SELECT * FROM strategies WHERE id = ? AND user_id = ? LIMIT 1', [Number(id), Number(userId)]);
  },

  async create(userId, { name, config, queuePriority = 5 }) {
    const r = await query(
      `INSERT INTO strategies (user_id, name, config, queue_priority) VALUES (?, ?, ?, ?)`,
      [Number(userId), name, JSON.stringify(config), Number(queuePriority)]);
    return r.insertId;
  },

  async update(id, userId, { name, config, queuePriority }) {
    await query(
      `UPDATE strategies SET name = ?, config = ?, queue_priority = ? WHERE id = ? AND user_id = ?`,
      [name, JSON.stringify(config), Number(queuePriority), Number(id), Number(userId)]);
  },

  async remove(id, userId) {
    const r = await query('DELETE FROM strategies WHERE id = ? AND user_id = ?', [Number(id), Number(userId)]);
    return r.affectedRows;
  },

  async setEnabled(id, userId, enabled) {
    await query('UPDATE strategies SET enabled = ? WHERE id = ? AND user_id = ?',
      [enabled ? 1 : 0, Number(id), Number(userId)]);
  },

  // Record an operator square-off request. Separate from saveRuntime on purpose:
  // the engine rewrites `state` every tick, so a request written there would be
  // clobbered within a second.
  async requestSquareOff(id, userId, by) {
    const r = await query(
      `UPDATE strategies SET square_off_requested_at = NOW(), square_off_requested_by = ?
        WHERE id = ? AND user_id = ? AND square_off_requested_at IS NULL`,
      [String(by).slice(0, 191), Number(id), Number(userId)]);
    return r.affectedRows === 1;
  },

  // Atomically take the request. The conditional UPDATE means two engines (or a
  // retried tick) cannot both act on the same one.
  async claimSquareOff(id) {
    const row = await queryOne(
      'SELECT square_off_requested_by FROM strategies WHERE id = ? AND square_off_requested_at IS NOT NULL',
      [Number(id)]);
    if (!row) return null;
    const r = await query(
      `UPDATE strategies SET square_off_requested_at = NULL, square_off_requested_by = NULL
        WHERE id = ? AND square_off_requested_at IS NOT NULL`, [Number(id)]);
    return r.affectedRows === 1 ? (row.square_off_requested_by || 'operator') : null;
  },

  async saveRuntime(id, { status, state, lastDecision, lastError }) {
    await query(
      `UPDATE strategies SET status = ?, state = ?, last_decision = ?, last_error = ? WHERE id = ?`,
      [status, JSON.stringify(state ?? {}),
       lastDecision ? String(lastDecision).slice(0, 500) : null,
       lastError ? String(lastError).slice(0, 500) : null,
       Number(id)]);
  },
};

/* ============================================================== orders ==== */
const orders = {
  // Reserve the row BEFORE anything is sent. A duplicate client_order_id throws
  // ER_DUP_ENTRY, which is exactly the at-most-once guarantee: the database
  // refuses the second attempt even if it comes from another process.
  async reserve(o) {
    try {
      const r = await query(
        `INSERT INTO orders
           (user_id, strategy_id, trade_id, client_order_id, purpose, instrument_id,
            k_token, k_symbol, k_segment, side, qty, product, order_type,
            limit_price, trigger_price, reduce_only, status, raw_request)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', ?)`,
        [Number(o.userId), o.strategyId ?? null, o.tradeId ?? null, o.clientOrderId, o.purpose,
         o.instrumentId ?? null, String(o.kToken), o.kSymbol, o.kSegment || 'nse_fo',
         o.side, Number(o.qty), o.product || 'MIS', o.orderType || 'MKT',
         o.limitPrice ?? null, o.triggerPrice ?? null, o.reduceOnly ? 1 : 0,
         JSON.stringify(o.raw ?? {})]);
      return { id: r.insertId, duplicate: false };
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        const existing = await queryOne(
          'SELECT * FROM orders WHERE user_id = ? AND client_order_id = ? LIMIT 1',
          [Number(o.userId), o.clientOrderId]);
        return { id: existing?.id ?? null, duplicate: true, existing };
      }
      throw err;
    }
  },

  // NEW -> SENDING, and only from NEW. Returns false if someone else already
  // claimed it, which is the in-process half of the at-most-once guarantee.
  async claimForSend(id) {
    const r = await query(
      `UPDATE orders SET status = 'SENDING', sent_at = NOW() WHERE id = ? AND status = 'NEW'`,
      [Number(id)]);
    return r.affectedRows === 1;
  },

  async markPlaced(id, { brokerOrderId, response }) {
    await query(
      `UPDATE orders SET status = 'PLACED', broker_order_id = ?, raw_response = ?, settled_at = NOW()
        WHERE id = ?`,
      [String(brokerOrderId), JSON.stringify(response ?? {}), Number(id)]);
  },

  async markRejected(id, reason, response = null) {
    await query(
      `UPDATE orders SET status = 'REJECTED', reject_reason = ?, raw_response = ?, settled_at = NOW()
        WHERE id = ?`,
      [String(reason).slice(0, 255), response ? JSON.stringify(response) : null, Number(id)]);
  },

  // The request left but we never learned the outcome. Never resent.
  async markUnknown(id, reason) {
    await query(
      `UPDATE orders SET status = 'UNKNOWN', reject_reason = ?, settled_at = NOW() WHERE id = ?`,
      [String(reason).slice(0, 255), Number(id)]);
  },

  async recordFill(id, { avgPrice, filledQty }) {
    await query('UPDATE orders SET avg_fill_price = ?, filled_qty = ? WHERE id = ?',
      [avgPrice ?? null, filledQty ?? null, Number(id)]);
  },

  async get(id) {
    return queryOne('SELECT * FROM orders WHERE id = ? LIMIT 1', [Number(id)]);
  },

  async byClientId(userId, clientOrderId) {
    return queryOne('SELECT * FROM orders WHERE user_id = ? AND client_order_id = ? LIMIT 1',
      [Number(userId), clientOrderId]);
  },

  async listByTrade(tradeId) {
    return query('SELECT * FROM orders WHERE trade_id = ? ORDER BY id ASC', [Number(tradeId)]);
  },

  async listByUser(userId, limit = 200) {
    return query('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      [Number(userId), Number(limit)]);
  },

  // Orders confirmed at the broker but never linked to a trade — the signature
  // of a crash between placing a leg and recording it. These represent real
  // exposure the strategy has no memory of.
  async placedWithoutTrade(strategyId) {
    return query(
      `SELECT * FROM orders
        WHERE strategy_id = ? AND trade_id IS NULL AND status IN ('PLACED','UNKNOWN')
          AND created_at > (NOW() - INTERVAL 1 DAY)`, [Number(strategyId)]);
  },

  // Orders stuck mid-send because the process died. Surfaced for reconciliation
  // rather than left to look like they never happened.
  async listStuck(olderThanSec = 120) {
    return query(
      `SELECT * FROM orders WHERE status = 'SENDING' AND sent_at < (NOW() - INTERVAL ? SECOND)`,
      [Number(olderThanSec)]);
  },
};

/* ============================================================== trades ==== */
const trades = {
  async open(t) {
    const r = await query(
      `INSERT INTO trades
         (user_id, strategy_id, trade_date, underlying, expiry_date, option_type,
          sell_symbol, sell_k_token, sell_z_token, sell_strike,
          hedge_symbol, hedge_k_token, hedge_z_token, hedge_strike, hedge_price,
          lots, lot_size, qty, arm_price, offset_value, mode, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'HEDGE_OPEN')`,
      [Number(t.userId), Number(t.strategyId), t.tradeDate, t.underlying, t.expiryDate, t.optionType,
       t.sellSymbol, t.sellKToken, t.sellZToken, t.sellStrike,
       t.hedgeSymbol, t.hedgeKToken, t.hedgeZToken, t.hedgeStrike, t.hedgePrice,
       t.lots, t.lotSize, t.qty, t.armPrice, t.offsetValue, t.mode]);
    return r.insertId;
  },

  // The one place the app builds SQL from object keys. Every caller is internal,
  // but an allow-list costs nothing and removes the possibility that a future
  // caller passes something user-derived.
  PATCHABLE: new Set([
    'sell_price', 'sell_exit_price', 'hedge_price', 'hedge_exit_price',
    'target_points', 'target_price', 'sl_price', 'armed_at', 'armed_low',
    'exit_reason', 'gross_pnl', 'charges', 'net_pnl', 'status', 'closed_at',
  ]),

  async patch(id, fields) {
    const keys = Object.keys(fields).filter(k => trades.PATCHABLE.has(k));
    const rejected = Object.keys(fields).filter(k => !trades.PATCHABLE.has(k));
    if (rejected.length) throw new Error(`trades.patch: unknown column(s) ${rejected.join(', ')}`);
    if (!keys.length) return;
    await query(
      `UPDATE trades SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...keys.map(k => fields[k]), Number(id)]);
  },

  async get(id) {
    return queryOne('SELECT * FROM trades WHERE id = ? LIMIT 1', [Number(id)]);
  },

  async listOpen(userId = null) {
    const where = "status IN ('HEDGE_OPEN','OPEN','EXITING','NEEDS_ATTENTION')";
    return userId == null
      ? query(`SELECT * FROM trades WHERE ${where} ORDER BY id ASC`)
      : query(`SELECT * FROM trades WHERE user_id = ? AND ${where} ORDER BY id ASC`, [Number(userId)]);
  },

  async openForStrategy(strategyId) {
    return queryOne(
      `SELECT * FROM trades WHERE strategy_id = ?
         AND status IN ('HEDGE_OPEN','OPEN','EXITING','NEEDS_ATTENTION')
       ORDER BY id DESC LIMIT 1`, [Number(strategyId)]);
  },

  async listByUser(userId, { limit = 200, strategyId = null } = {}) {
    if (strategyId) {
      return query(
        'SELECT * FROM trades WHERE user_id = ? AND strategy_id = ? ORDER BY id DESC LIMIT ?',
        [Number(userId), Number(strategyId), Number(limit)]);
    }
    return query('SELECT * FROM trades WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      [Number(userId), Number(limit)]);
  },

  async dailyReport(userId, days = 60) {
    return query(
      `SELECT trade_date, COUNT(*) total,
              SUM(net_pnl >= 0) wins, SUM(net_pnl < 0) losses,
              SUM(gross_pnl) gross, SUM(charges) charges, SUM(net_pnl) net
         FROM trades WHERE user_id = ? AND status = 'CLOSED'
        GROUP BY trade_date ORDER BY trade_date DESC LIMIT ?`,
      [Number(userId), Number(days)]);
  },
};

/* ============================================================== events ==== */
const events = {
  async record(e) {
    await query(
      `INSERT INTO strategy_events
         (user_id, strategy_id, trade_id, event_type, level, from_state, to_state, message, ltp, spot, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [Number(e.userId), e.strategyId ?? null, e.tradeId ?? null, e.eventType, e.level || 'INFO',
       e.fromState ?? null, e.toState ?? null, String(e.message || '').slice(0, 500),
       e.ltp ?? null, e.spot ?? null, e.meta ? JSON.stringify(e.meta) : null]);
  },

  async list(userId, { limit = 200, strategyId = null, tradeId = null } = {}) {
    const where = ['user_id = ?'];
    const params = [Number(userId)];
    if (strategyId) { where.push('strategy_id = ?'); params.push(Number(strategyId)); }
    if (tradeId) { where.push('trade_id = ?'); params.push(Number(tradeId)); }
    params.push(Number(limit));
    return query(
      `SELECT * FROM strategy_events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, params);
  },

  async purge(days) {
    const r = await query('DELETE FROM strategy_events WHERE created_at < (NOW() - INTERVAL ? DAY)',
      [Number(days)]);
    return r.affectedRows;
  },
};

/* ========================================================= daily stats ==== */
const dailyStats = {
  async get(strategyId, date = istDateString()) {
    const row = await queryOne(
      'SELECT * FROM daily_stats WHERE strategy_id = ? AND trade_date = ? LIMIT 1',
      [Number(strategyId), date]);
    if (!row) return null;
    return {
      tradeDate: date,
      trades: Number(row.trades), wins: Number(row.wins), losses: Number(row.losses),
      grossPnl: Number(row.gross_pnl), charges: Number(row.charges), netPnl: Number(row.net_pnl),
      blockedReason: row.blocked_reason,
    };
  },

  async save(strategyId, userId, stats, date = istDateString()) {
    await query(
      `INSERT INTO daily_stats
         (strategy_id, trade_date, user_id, trades, wins, losses, gross_pnl, charges, net_pnl, blocked_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         trades = VALUES(trades), wins = VALUES(wins), losses = VALUES(losses),
         gross_pnl = VALUES(gross_pnl), charges = VALUES(charges), net_pnl = VALUES(net_pnl),
         blocked_reason = VALUES(blocked_reason)`,
      [Number(strategyId), date, Number(userId), stats.trades, stats.wins, stats.losses,
       stats.grossPnl, stats.charges, stats.netPnl, stats.blockedReason ?? null]);
  },
};

/* ============================================================== flags ===== */
const flags = {
  async get(key) {
    const row = await queryOne('SELECT flag_value FROM system_flags WHERE flag_key = ? LIMIT 1', [key]);
    return row ? row.flag_value : null;
  },

  async set(key, value, note = null) {
    await query(
      `INSERT INTO system_flags (flag_key, flag_value, note) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE flag_value = VALUES(flag_value), note = COALESCE(VALUES(note), note)`,
      [key, String(value), note]);
  },

  async isTradingHalted() {
    const v = await flags.get('trading_halted');
    return /^(1|true|yes|on)$/i.test(String(v ?? ''));
  },
};

/* =============================================================== locks ==== */
// A DB-backed leader lock. The engine takes it before trading and refreshes it
// every tick; a crashed holder's lock expires and another process may take
// over. The conditional UPDATE means the takeover is atomic — two engines
// cannot both believe they hold it.
const locks = {
  async acquire(name, owner, ttlMs) {
    const ttlSec = Math.ceil(ttlMs / 1000);
    return tx(async (t) => {
      const row = await t.queryOne(
        `SELECT owner, TIMESTAMPDIFF(SECOND, heartbeat_at, NOW()) AS age
           FROM engine_locks WHERE lock_name = ? FOR UPDATE`, [name]);

      if (!row) {
        await t.query('INSERT INTO engine_locks (lock_name, owner) VALUES (?, ?)', [name, owner]);
        return { acquired: true, owner, tookOver: false };
      }
      if (row.owner === owner) {
        await t.query('UPDATE engine_locks SET heartbeat_at = NOW() WHERE lock_name = ?', [name]);
        return { acquired: true, owner, tookOver: false };
      }
      if (Number(row.age) > ttlSec) {
        await t.query(
          'UPDATE engine_locks SET owner = ?, acquired_at = NOW(), heartbeat_at = NOW() WHERE lock_name = ?',
          [owner, name]);
        return { acquired: true, owner, tookOver: true, previousOwner: row.owner };
      }
      return { acquired: false, owner: row.owner, ageSec: Number(row.age) };
    });
  },

  async release(name, owner) {
    await query('DELETE FROM engine_locks WHERE lock_name = ? AND owner = ?', [name, owner]);
  },

  async status(name) {
    return queryOne(
      `SELECT owner, acquired_at, heartbeat_at, TIMESTAMPDIFF(SECOND, heartbeat_at, NOW()) AS age
         FROM engine_locks WHERE lock_name = ?`, [name]);
  },
};

/* =============================================================== ticks ==== */
const ticks = {
  async record(rows) {
    if (!rows.length) return 0;
    const placeholders = rows.map(() => '(?,?,?)').join(',');
    const params = [];
    for (const r of rows) params.push(r.zToken, r.tsMs, r.ltp);
    const res = await query(
      `INSERT IGNORE INTO tick_history (z_token, ts_ms, ltp) VALUES ${placeholders}`, params);
    return res.affectedRows;
  },

  async range(zToken, fromMs, toMs) {
    return query(
      'SELECT ts_ms, ltp FROM tick_history WHERE z_token = ? AND ts_ms BETWEEN ? AND ? ORDER BY ts_ms ASC',
      [Number(zToken), Number(fromMs), Number(toMs)]);
  },

  async purge(days) {
    const cutoff = Date.now() - days * 86400000;
    const r = await query('DELETE FROM tick_history WHERE ts_ms < ?', [cutoff]);
    return r.affectedRows;
  },
};

module.exports = {
  users, brokers, instruments, strategies, orders, trades, events, dailyStats, flags, locks, ticks,
};
