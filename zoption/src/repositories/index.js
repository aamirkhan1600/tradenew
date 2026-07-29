// Every SQL statement in the application lives here. Services and the engine
// speak in domain objects; nothing above this layer writes SQL.

const db = require('../core/db');
const time = require('../core/time');

/* ------------------------------------------------------------- settings -- */

const settings = {
  async get(name = 'default') {
    const row = await db.queryOne('SELECT * FROM settings WHERE name = ? LIMIT 1', [name]);
    if (!row) return null;
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    return { ...payload, _name: row.name, _version: row.version, _updatedAt: row.updated_at };
  },

  async save(name, payload) {
    await db.query(
      `INSERT INTO settings (name, payload, version) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE payload = VALUES(payload), version = version + 1`,
      [name, JSON.stringify(payload)]);
    return settings.get(name);
  },
};

/* ---------------------------------------------------------------- flags -- */

const flags = {
  async get(name, fallback = null) {
    const row = await db.queryOne('SELECT value FROM system_flags WHERE name = ? LIMIT 1', [name]);
    return row ? row.value : fallback;
  },

  async set(name, value) {
    await db.query(
      `INSERT INTO system_flags (name, value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [name, value == null ? null : String(value)]);
  },

  async all() {
    const rows = await db.query('SELECT name, value, updated_at FROM system_flags');
    return Object.fromEntries(rows.map(r => [r.name, r.value]));
  },
};

/* ----------------------------------------------------------- instruments -- */

const instruments = {
  async now() {
    const row = await db.queryOne('SELECT NOW() AS now');
    return row.now;
  },

  async upsertMany(rows) {
    if (!rows.length) return 0;
    let written = 0;
    // Chunked so one oversized packet cannot fail a whole sync.
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const values = chunk.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
      const params = [];
      for (const r of chunk) {
        params.push(r.underlying, r.expiryDate, r.strike, r.optionType,
          r.token, r.segment, r.symbol, r.lotSize ?? null, r.tickSize ?? null);
      }
      const res = await db.query(
        `INSERT INTO instruments
           (underlying, expiry_date, strike, option_type, token, segment, symbol, lot_size, tick_size)
         VALUES ${values}
         ON DUPLICATE KEY UPDATE
           token = VALUES(token), segment = VALUES(segment), symbol = VALUES(symbol),
           lot_size = VALUES(lot_size), tick_size = VALUES(tick_size),
           synced_at = CURRENT_TIMESTAMP`,
        params);
      written += res.affectedRows || 0;
    }
    return written;
  },

  // A contract is tradable when it carries everything an order needs. The
  // selector only ever considers tradable rows, so a master row missing a lot
  // size cannot become a position.
  async refreshTradableFlags() {
    const res = await db.query(
      `UPDATE instruments
          SET tradable = (token IS NOT NULL AND token <> '' AND lot_size IS NOT NULL AND lot_size > 0)`);
    return res.affectedRows || 0;
  },

  async pruneStale(cutoff) {
    const res = await db.query(
      'DELETE FROM instruments WHERE synced_at < ? AND option_type <> ?', [cutoff, 'IDX']);
    return res.affectedRows || 0;
  },

  // Expiries still ahead of us, nearest first. The instrument master is the only
  // source of truth for what expiries exist — a hardcoded weekday silently
  // trades the wrong contract the first time the exchange moves expiry day.
  async expiries(underlying) {
    const rows = await db.query(
      `SELECT DISTINCT expiry_date FROM instruments
        WHERE underlying = ? AND option_type IN ('CE','PE') AND tradable = 1
          AND expiry_date >= CURDATE()
        ORDER BY expiry_date ASC`, [underlying]);
    return rows.map(r => (r.expiry_date instanceof Date
      ? r.expiry_date.toISOString().slice(0, 10)
      : String(r.expiry_date).slice(0, 10)));
  },

  // The full ladder for one expiry, both option types, ordered by strike.
  async chain(underlying, expiryDate) {
    return db.query(
      `SELECT token, segment, symbol, strike, option_type, lot_size, tick_size
         FROM instruments
        WHERE underlying = ? AND expiry_date = ? AND option_type IN ('CE','PE') AND tradable = 1
        ORDER BY strike ASC, option_type ASC`,
      [underlying, expiryDate]);
  },

  async byToken(token) {
    return db.queryOne('SELECT * FROM instruments WHERE token = ? LIMIT 1', [String(token)]);
  },

  async indexInstrument(underlying) {
    return db.queryOne(
      `SELECT token, segment, symbol FROM instruments
        WHERE underlying = ? AND option_type = 'IDX' LIMIT 1`, [underlying]);
  },

  async count() {
    const row = await db.queryOne('SELECT COUNT(*) AS n FROM instruments');
    return row.n;
  },
};

/* --------------------------------------------------------------- broker -- */

const broker = {
  async get(label = 'primary') {
    return db.queryOne('SELECT * FROM broker_account WHERE label = ? LIMIT 1', [label]);
  },

  async saveSession(label, { sessionToken, sid, baseUrl, ucc, userName, mobile }) {
    await db.query(
      `INSERT INTO broker_account
         (label, mobile, ucc, user_name, session_token, sid, base_url, status, last_login_at, last_error)
       VALUES (?,?,?,?,?,?,?, 'ACTIVE', NOW(), NULL)
       ON DUPLICATE KEY UPDATE
         mobile = VALUES(mobile), ucc = VALUES(ucc), user_name = VALUES(user_name),
         session_token = VALUES(session_token), sid = VALUES(sid), base_url = VALUES(base_url),
         status = 'ACTIVE', last_login_at = NOW(), last_error = NULL`,
      [label, mobile ?? null, ucc ?? null, userName ?? null, sessionToken, sid, baseUrl ?? null]);
  },

  // Mark the session dead. Called once per expiry, not once per failed poll —
  // an EXPIRED row that keeps being rewritten tells an operator nothing.
  async markExpired(label, reason) {
    const res = await db.query(
      `UPDATE broker_account SET status = 'EXPIRED', last_error = ?
        WHERE label = ? AND status <> 'EXPIRED'`,
      [String(reason || '').slice(0, 500), label]);
    return (res.affectedRows || 0) > 0;
  },
};

/* --------------------------------------------------------------- cycles -- */

const cycles = {
  // Open a cycle and claim the global open-cycle slot in one transaction. The
  // UNIQUE index on cycle_guard.open_key is what makes a second concurrent
  // opener fail with a duplicate-key error rather than lock a second strike.
  async open(row) {
    return db.tx(async (t) => {
      const res = await t.query(
        `INSERT INTO cycles
           (trade_date, underlying, expiry_date, ce_token, ce_symbol, ce_strike,
            pe_token, pe_symbol, pe_strike, spot_at_lock, lot_size, qty,
            settings_snapshot, status, locked_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'LOCKED', NOW())`,
        [row.tradeDate, row.underlying, row.expiryDate,
          row.ceToken ?? null, row.ceSymbol ?? null, row.ceStrike ?? null,
          row.peToken ?? null, row.peSymbol ?? null, row.peStrike ?? null,
          row.spotAtLock ?? null, row.lotSize, row.qty,
          JSON.stringify(row.settingsSnapshot || {})]);
      const cycleId = res.insertId;
      await t.query('INSERT INTO cycle_guard (cycle_id, open_key) VALUES (?, 1)', [cycleId]);
      return cycleId;
    });
  },

  // Release the slot by nulling open_key. NULLs are distinct in a UNIQUE index,
  // so any number of closed cycles coexist.
  async close(cycleId, reason) {
    await db.tx(async (t) => {
      await t.query(
        `UPDATE cycles SET status = 'CLOSED', unlocked_at = NOW(), unlock_reason = ? WHERE id = ?`,
        [String(reason || '').slice(0, 64), cycleId]);
      await t.query('UPDATE cycle_guard SET open_key = NULL WHERE cycle_id = ?', [cycleId]);
    });
  },

  async openCycle() {
    return db.queryOne(
      `SELECT c.* FROM cycles c
         JOIN cycle_guard g ON g.cycle_id = c.id AND g.open_key = 1
        LIMIT 1`);
  },

  async byId(id) {
    return db.queryOne('SELECT * FROM cycles WHERE id = ? LIMIT 1', [id]);
  },

  async countForDate(tradeDate) {
    const row = await db.queryOne(
      'SELECT COUNT(*) AS n FROM cycles WHERE trade_date = ?', [tradeDate]);
    return row.n;
  },

  async setStatus(cycleId, status) {
    await db.query('UPDATE cycles SET status = ? WHERE id = ?', [status, cycleId]);
  },
};

/* ------------------------------------------------------------------ legs -- */

const legs = {
  async create(row) {
    const res = await db.query(
      `INSERT INTO legs (cycle_id, option_type, token, symbol, strike, state)
       VALUES (?,?,?,?,?,?)`,
      [row.cycleId, row.optionType, row.token, row.symbol, row.strike, row.state || 'IDLE']);
    return res.insertId;
  },

  async byCycle(cycleId) {
    return db.query('SELECT * FROM legs WHERE cycle_id = ? ORDER BY option_type', [cycleId]);
  },

  async byId(id) {
    return db.queryOne('SELECT * FROM legs WHERE id = ? LIMIT 1', [id]);
  },

  async setState(legId, state, patch = {}) {
    const cols = ['state = ?'];
    const params = [state];
    const map = {
      attemptSeq: 'attempt_seq', entryCandleId: 'entry_candle_id',
      sellPriceP: 'sell_price_p', filledPriceP: 'filled_price_p',
      targetPriceP: 'target_price_p', slPriceP: 'sl_price_p',
      filledQty: 'filled_qty', openedAt: 'opened_at', closedAt: 'closed_at',
      exitReason: 'exit_reason', requoteCount: 'requote_count',
      confirmations: 'confirmations',
    };
    for (const [key, col] of Object.entries(map)) {
      if (patch[key] !== undefined) { cols.push(`${col} = ?`); params.push(patch[key]); }
    }
    params.push(legId);
    await db.query(`UPDATE legs SET ${cols.join(', ')} WHERE id = ?`, params);
  },

  async bumpAttempt(legId) {
    await db.query(
      'UPDATE legs SET attempt_seq = attempt_seq + 1, requote_count = requote_count + 1 WHERE id = ?',
      [legId]);
    const row = await legs.byId(legId);
    return row.attempt_seq;
  },
};

/* --------------------------------------------------------------- candles -- */

const candles = {
  // Insert-or-ignore. A bucket is written once; a replay or a double-close must
  // not rewrite history the engine already traded on.
  async insert(row) {
    const res = await db.query(
      `INSERT INTO candles (token, timeframe, bucket_start, open_p, high_p, low_p, close_p, tick_count, synthetic)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE id = id`,
      [String(row.token), row.timeframe, time.toMysql(row.bucketStart),
        row.openP, row.highP, row.lowP, row.closeP, row.tickCount, row.synthetic ? 1 : 0]);
    if (res.insertId) return res.insertId;
    const existing = await db.queryOne(
      'SELECT id FROM candles WHERE token = ? AND timeframe = ? AND bucket_start = ? LIMIT 1',
      [String(row.token), row.timeframe, time.toMysql(row.bucketStart)]);
    return existing ? existing.id : null;
  },

  async recent(token, timeframe, limit = 120) {
    const rows = await db.query(
      `SELECT * FROM candles WHERE token = ? AND timeframe = ?
        ORDER BY bucket_start DESC LIMIT ?`,
      [String(token), timeframe, Math.max(1, Math.trunc(limit))]);
    return rows.reverse();
  },

  async purgeOlderThan(days) {
    const res = await db.query(
      'DELETE FROM candles WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [Math.max(1, Math.trunc(days))]);
    return res.affectedRows || 0;
  },
};

/* ---------------------------------------------------------------- orders -- */

const orders = {
  async create(row) {
    const res = await db.query(
      `INSERT INTO orders
         (client_ref, cycle_id, leg_id, stage, token, segment, symbol, side, order_type,
          product, limit_price_p, qty, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING')`,
      [row.clientRef, row.cycleId ?? null, row.legId ?? null, row.stage,
        String(row.token), row.segment || 'nse_fo', row.symbol, row.side, row.orderType,
        row.product || 'NRML', row.limitPriceP || 0, row.qty]);
    return res.insertId;
  },

  // Atomically move PENDING -> PLACING. Kotak's place-order has no client order
  // id, so this claim is the only thing that stops a retried job from sending a
  // second live order: the second run sees a non-PENDING row and refuses.
  async claimForPlacement(orderId) {
    const res = await db.query(
      `UPDATE orders SET status = 'PLACING', placed_at = NOW()
        WHERE id = ? AND status = 'PENDING'`, [orderId]);
    return (res.affectedRows || 0) === 1;
  },

  // Pre-send failure only — nothing reached the broker, so the order is safe to
  // place again.
  async resetToPending(orderId, reason) {
    await db.query(
      `UPDATE orders SET status = 'PENDING', placed_at = NULL, reason = ?
        WHERE id = ? AND status = 'PLACING'`,
      [String(reason || '').slice(0, 500), orderId]);
  },

  async markWorking(orderId, brokerOrderId) {
    await db.query(
      `UPDATE orders SET status = 'WORKING', broker_order_id = ?, reason = NULL WHERE id = ?`,
      [String(brokerOrderId), orderId]);
  },

  async markRejected(orderId, reason) {
    await db.query(
      `UPDATE orders SET status = 'REJECTED', reason = ?, closed_at = NOW() WHERE id = ?`,
      [String(reason || '').slice(0, 500), orderId]);
  },

  // The order MAY be live. Never resent, never retried — the reconciler matches
  // it against the broker's book on the next poll.
  async markUnknown(orderId, reason) {
    await db.query(
      `UPDATE orders SET status = 'UNKNOWN', reason = ? WHERE id = ?`,
      [String(reason || '').slice(0, 500), orderId]);
  },

  async markFilled(orderId, { filledQty, filledPriceP }) {
    await db.query(
      `UPDATE orders SET status = 'FILLED', filled_qty = ?, filled_price_p = ?, closed_at = NOW()
        WHERE id = ?`,
      [filledQty, filledPriceP, orderId]);
  },

  async markPartial(orderId, { filledQty, filledPriceP }) {
    await db.query(
      `UPDATE orders SET status = 'PARTIAL', filled_qty = ?, filled_price_p = ? WHERE id = ?`,
      [filledQty, filledPriceP, orderId]);
  },

  async markCancelled(orderId, reason) {
    await db.query(
      `UPDATE orders SET status = 'CANCELLED', reason = ?, closed_at = NOW() WHERE id = ?`,
      [String(reason || '').slice(0, 500), orderId]);
  },

  async byId(id) {
    return db.queryOne('SELECT * FROM orders WHERE id = ? LIMIT 1', [id]);
  },

  async byClientRef(clientRef) {
    return db.queryOne('SELECT * FROM orders WHERE client_ref = ? LIMIT 1', [clientRef]);
  },

  async working() {
    return db.query(
      `SELECT * FROM orders WHERE status IN ('PLACING','WORKING','PARTIAL','UNKNOWN')
        ORDER BY id ASC`);
  },

  async workingForLeg(legId, stage = null) {
    const sql = stage
      ? `SELECT * FROM orders WHERE leg_id = ? AND stage = ?
           AND status IN ('PENDING','PLACING','WORKING','PARTIAL') ORDER BY id DESC`
      : `SELECT * FROM orders WHERE leg_id = ?
           AND status IN ('PENDING','PLACING','WORKING','PARTIAL') ORDER BY id DESC`;
    return db.query(sql, stage ? [legId, stage] : [legId]);
  },

  async recent(limit = 100) {
    return db.query('SELECT * FROM orders ORDER BY id DESC LIMIT ?',
      [Math.max(1, Math.trunc(limit))]);
  },
};

/* ------------------------------------------------------------- positions -- */

const positions = {
  async open(row) {
    const res = await db.query(
      `INSERT INTO positions
         (cycle_id, leg_id, trade_date, option_type, symbol, strike, qty,
          entry_p, target_p, sl_p, status, opened_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'OPEN', NOW())`,
      [row.cycleId, row.legId, row.tradeDate, row.optionType, row.symbol, row.strike,
        row.qty, row.entryP, row.targetP, row.slP]);
    return res.insertId;
  },

  async close(positionId, { exitP, grossPnlP, chargesP, netPnlP, exitReason }) {
    await db.query(
      `UPDATE positions
          SET exit_p = ?, gross_pnl_p = ?, charges_p = ?, net_pnl_p = ?,
              status = 'CLOSED', exit_reason = ?, closed_at = NOW()
        WHERE id = ?`,
      [exitP, grossPnlP, chargesP, netPnlP, String(exitReason || '').slice(0, 32), positionId]);
  },

  // The brackets move after the fill now: the dynamic target ladder walks the
  // target out and the trail walks the stop down. Without this the trades page
  // would show the levels a position opened with rather than the ones it was
  // actually working, and a post-mortem would misread every laddered trade.
  //
  // `target_p` is NOT NULL, so a withdrawn target (trail-only) leaves the last
  // real level standing rather than writing a null that the column would reject.
  async updateBrackets(legId, { targetP, slP }) {
    const cols = [];
    const params = [];
    if (targetP != null) { cols.push('target_p = ?'); params.push(targetP); }
    if (slP != null) { cols.push('sl_p = ?'); params.push(slP); }
    if (!cols.length) return;
    params.push(legId);
    await db.query(
      `UPDATE positions SET ${cols.join(', ')} WHERE leg_id = ? AND status = 'OPEN'`, params);
  },

  async openByLeg(legId) {
    return db.queryOne(
      `SELECT * FROM positions WHERE leg_id = ? AND status = 'OPEN' ORDER BY id DESC LIMIT 1`,
      [legId]);
  },

  async allOpen() {
    return db.query(`SELECT * FROM positions WHERE status = 'OPEN' ORDER BY id ASC`);
  },

  async forDate(tradeDate) {
    return db.query('SELECT * FROM positions WHERE trade_date = ? ORDER BY id DESC', [tradeDate]);
  },
};

/* ------------------------------------------------------------ daily stats -- */

const stats = {
  async ensure(tradeDate) {
    await db.query(
      'INSERT INTO daily_stats (trade_date) VALUES (?) ON DUPLICATE KEY UPDATE trade_date = trade_date',
      [tradeDate]);
    return stats.get(tradeDate);
  },

  async get(tradeDate) {
    return db.queryOne('SELECT * FROM daily_stats WHERE trade_date = ? LIMIT 1', [tradeDate]);
  },

  // Fold one closed trade into the day. Consecutive losses reset on any
  // non-losing trade — a scratch is not a loss, and treating it as one would
  // trip the cooldown on a flat day.
  async recordTrade(tradeDate, { grossPnlP, chargesP, netPnlP }) {
    const isLoss = netPnlP < 0;
    await db.query(
      `INSERT INTO daily_stats
         (trade_date, realized_pnl_p, gross_pnl_p, charges_p, trade_count, win_count, loss_count, consecutive_losses)
       VALUES (?,?,?,?,1,?,?,?)
       ON DUPLICATE KEY UPDATE
         realized_pnl_p = realized_pnl_p + VALUES(realized_pnl_p),
         gross_pnl_p    = gross_pnl_p + VALUES(gross_pnl_p),
         charges_p      = charges_p + VALUES(charges_p),
         trade_count    = trade_count + 1,
         win_count      = win_count + VALUES(win_count),
         loss_count     = loss_count + VALUES(loss_count),
         consecutive_losses = IF(VALUES(loss_count) = 1, consecutive_losses + 1, 0)`,
      [tradeDate, netPnlP, grossPnlP, chargesP, isLoss ? 0 : 1, isLoss ? 1 : 0, isLoss ? 1 : 0]);
    return stats.get(tradeDate);
  },

  async setCooldown(tradeDate, untilMs) {
    await db.query(
      `INSERT INTO daily_stats (trade_date, cooldown_until) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE cooldown_until = VALUES(cooldown_until)`,
      [tradeDate, time.toMysql(untilMs)]);
  },

  async disable(tradeDate, reason) {
    await db.query(
      `INSERT INTO daily_stats (trade_date, disabled, disabled_reason) VALUES (?, 1, ?)
       ON DUPLICATE KEY UPDATE disabled = 1, disabled_reason = VALUES(disabled_reason)`,
      [tradeDate, String(reason || '').slice(0, 64)]);
  },

  async bumpCycle(tradeDate) {
    await db.query(
      `INSERT INTO daily_stats (trade_date, cycle_count) VALUES (?, 1)
       ON DUPLICATE KEY UPDATE cycle_count = cycle_count + 1`, [tradeDate]);
  },
};

/* ---------------------------------------------------------------- events -- */

const events = {
  async log(row) {
    await db.query(
      `INSERT INTO events (cycle_id, leg_id, option_type, kind, from_state, to_state, reason, payload, ts_ms)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [row.cycleId ?? null, row.legId ?? null, row.optionType ?? null, row.kind,
        row.fromState ?? null, row.toState ?? null,
        row.reason == null ? null : String(row.reason).slice(0, 255),
        row.payload ? JSON.stringify(row.payload) : null,
        row.tsMs ?? Date.now()]);
  },

  async recent(limit = 200) {
    return db.query('SELECT * FROM events ORDER BY id DESC LIMIT ?',
      [Math.max(1, Math.trunc(limit))]);
  },

  async forCycle(cycleId) {
    return db.query('SELECT * FROM events WHERE cycle_id = ? ORDER BY id ASC', [cycleId]);
  },

  async purgeOlderThan(days) {
    const res = await db.query(
      'DELETE FROM events WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [Math.max(1, Math.trunc(days))]);
    return res.affectedRows || 0;
  },
};

/* ----------------------------------------------------------------- locks -- */

const locks = {
  // Take or renew the leader lock. Two engines would double every order, so the
  // loser refuses to start rather than trusting an operator to remember which
  // terminal is which.
  async acquire(name, owner, ttlMs) {
    const res = await db.query(
      `INSERT INTO engine_locks (name, owner, heartbeat_at) VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         owner = IF(owner = VALUES(owner) OR heartbeat_at < DATE_SUB(NOW(), INTERVAL ? SECOND),
                    VALUES(owner), owner),
         heartbeat_at = IF(owner = VALUES(owner), NOW(), heartbeat_at)`,
      [name, owner, Math.ceil(ttlMs / 1000)]);
    void res;
    const row = await db.queryOne('SELECT owner FROM engine_locks WHERE name = ? LIMIT 1', [name]);
    return row?.owner === owner;
  },

  async release(name, owner) {
    await db.query('DELETE FROM engine_locks WHERE name = ? AND owner = ?', [name, owner]);
  },
};

module.exports = {
  settings, flags, instruments, broker, cycles, legs, candles,
  orders, positions, stats, events, locks,
};
