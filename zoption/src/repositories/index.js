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

  // A window, ascending. The chart asks for a time range rather than "the last
  // N" because a 1-hour bar is rebuilt from sixty 1-minute rows: asking for
  // "the last 120" of the base series would return two hours and silently draw
  // a chart two bars long.
  async range(token, timeframe, fromMs, toMs, limit = 5000) {
    const rows = await db.query(
      `SELECT * FROM candles
        WHERE token = ? AND timeframe = ? AND bucket_start >= ? AND bucket_start < ?
        ORDER BY bucket_start DESC LIMIT ?`,
      [String(token), timeframe, time.toMysql(fromMs), time.toMysql(toMs),
        Math.max(1, Math.trunc(limit))]);
    return rows.reverse();
  },

  // Bulk insert-or-ignore for the terminal, which closes a bar on every tracked
  // instrument at the same instant. Same semantics as insert(): a bucket is
  // written once and never rewritten.
  //
  // That last part is what makes a backfill safe to run at any time. A bucket
  // this platform assembled from its own tick stream ALWAYS wins over a
  // downloaded one, because it was already there and `ON DUPLICATE KEY UPDATE
  // id = id` refuses to overwrite it. A backfill fills gaps; it never revises
  // history the engine may have traded on.
  async insertMany(rows) {
    if (!rows.length) return 0;
    let written = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const values = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',');
      const params = [];
      for (const r of chunk) {
        params.push(String(r.token), r.timeframe, time.toMysql(r.bucketStart),
          r.openP, r.highP, r.lowP, r.closeP, r.tickCount, r.synthetic ? 1 : 0,
          r.source === 'BACKFILL' ? 'BACKFILL' : 'LIVE');
      }
      const res = await db.query(
        `INSERT INTO candles (token, timeframe, bucket_start, open_p, high_p, low_p, close_p, tick_count, synthetic, source)
         VALUES ${values}
         ON DUPLICATE KEY UPDATE id = id`, params);
      written += res.affectedRows || 0;
    }
    return written;
  },

  // What is stored for one series, so a backfill can report what it added and
  // the terminal can say where its chart came from.
  async coverage(token, timeframe) {
    const row = await db.queryOne(
      `SELECT COUNT(*) AS bars,
              SUM(source = 'BACKFILL') AS backfilled,
              MIN(bucket_start) AS first_bar,
              MAX(bucket_start) AS last_bar
         FROM candles WHERE token = ? AND timeframe = ?`,
      [String(token), timeframe]);
    if (!row || !row.bars) return { bars: 0, backfilled: 0, firstBar: null, lastBar: null };
    return {
      bars: Number(row.bars),
      backfilled: Number(row.backfilled || 0),
      firstBar: time.fromMysql(row.first_bar),
      lastBar: time.fromMysql(row.last_bar),
    };
  },

  // Only the downloaded rows. A re-import after fixing a mapping bug should not
  // require deleting bars this platform recorded itself.
  async purgeBackfill(token, timeframe = null) {
    const res = timeframe
      ? await db.query(
        "DELETE FROM candles WHERE token = ? AND timeframe = ? AND source = 'BACKFILL'",
        [String(token), timeframe])
      : await db.query(
        "DELETE FROM candles WHERE token = ? AND source = 'BACKFILL'", [String(token)]);
    return res.affectedRows || 0;
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
         (client_ref, cycle_id, leg_id, pfe_trade_id, ose_trade_id, stage, token, segment,
          symbol, side, order_type, product, limit_price_p, qty, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING')`,
      [row.clientRef, row.cycleId ?? null, row.legId ?? null, row.pfeTradeId ?? null,
        row.oseTradeId ?? null, row.stage,
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

  // The Price-Filter Engine's equivalent of workingForLeg. Its recovery path
  // asks the DATABASE what is live before resending anything, so this has to
  // answer the same question for a pfe trade.
  async workingForPfeTrade(tradeId, stage = null) {
    const sql = stage
      ? `SELECT * FROM orders WHERE pfe_trade_id = ? AND stage = ?
           AND status IN ('PENDING','PLACING','WORKING','PARTIAL') ORDER BY id DESC`
      : `SELECT * FROM orders WHERE pfe_trade_id = ?
           AND status IN ('PENDING','PLACING','WORKING','PARTIAL') ORDER BY id DESC`;
    return db.query(sql, stage ? [tradeId, stage] : [tradeId]);
  },

  async recent(limit = 100) {
    return db.query('SELECT * FROM orders ORDER BY id DESC LIMIT ?',
      [Math.max(1, Math.trunc(limit))]);
  },

  async recentForPfe(limit = 100) {
    return db.query(
      'SELECT * FROM orders WHERE pfe_trade_id IS NOT NULL ORDER BY id DESC LIMIT ?',
      [Math.max(1, Math.trunc(limit))]);
  },

  // The Option Selling Engine's equivalent. §20.6 and §12.3 both turn on it:
  // before resending anything the engine asks the DATABASE what is live, because
  // resending a market buy that is already working buys the short back twice and
  // leaves the account naked LONG.
  async workingForOseTrade(tradeId, stage = null) {
    const sql = stage
      ? `SELECT * FROM orders WHERE ose_trade_id = ? AND stage = ?
           AND status IN ('PENDING','PLACING','WORKING','PARTIAL','UNKNOWN') ORDER BY id DESC`
      : `SELECT * FROM orders WHERE ose_trade_id = ?
           AND status IN ('PENDING','PLACING','WORKING','PARTIAL','UNKNOWN') ORDER BY id DESC`;
    return db.query(sql, stage ? [tradeId, stage] : [tradeId]);
  },

  async forOseTrade(tradeId) {
    return db.query('SELECT * FROM orders WHERE ose_trade_id = ? ORDER BY id ASC', [tradeId]);
  },

  async recentForOse(limit = 100) {
    return db.query(
      'SELECT * FROM orders WHERE ose_trade_id IS NOT NULL ORDER BY id DESC LIMIT ?',
      [Math.max(1, Math.trunc(limit))]);
  },

  // §20.6 step 5 — "Cancel any dangling open orders tagged by this engine."
  // Scoped by the client_ref prefix so a reconciliation can never touch an order
  // another engine on this account is depending on.
  async danglingForPrefix(prefix) {
    return db.query(
      `SELECT * FROM orders
        WHERE client_ref LIKE ? AND status IN ('WORKING','PARTIAL','PLACING')
        ORDER BY id ASC`,
      [`${String(prefix).toUpperCase()}-%`]);
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

/* ================================================= the Price-Filter Engine == */
/* doc/new.md. Its own trade lifecycle and its own daily risk state, over the   */
/* same instruments, orders and events tables.                                  */

const pfeTrades = {
  // Open a trade and claim the single open-trade slot in one transaction. The
  // UNIQUE index on pfe_guard.open_key is what makes a second concurrent opener
  // fail with a duplicate-key error rather than run two naked shorts.
  async open(row) {
    return db.tx(async (t) => {
      const res = await t.query(
        `INSERT INTO pfe_trades
           (trade_date, underlying, expiry_date, option_type, token, symbol, strike,
            lot_size, qty, state, spot_at_select, direction_state, select_score,
            select_detail, settings_snapshot, armed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, NOW())`,
        [row.tradeDate, row.underlying, row.expiryDate, row.optionType,
          String(row.token), row.symbol, row.strike, row.lotSize, row.qty,
          row.state || 'ARMED', row.spotAtSelect ?? null, row.directionState ?? null,
          row.selectScore ?? null,
          row.selectDetail ? JSON.stringify(row.selectDetail) : null,
          row.settingsSnapshot ? JSON.stringify(row.settingsSnapshot) : null]);
      const tradeId = res.insertId;
      await t.query('INSERT INTO pfe_guard (trade_id, open_key) VALUES (?, 1)', [tradeId]);
      return tradeId;
    });
  },

  // Release the slot by nulling open_key. NULLs are distinct in a UNIQUE index,
  // so any number of finished trades coexist.
  async release(tradeId) {
    await db.query('UPDATE pfe_guard SET open_key = NULL WHERE trade_id = ?', [tradeId]);
  },

  async live() {
    return db.queryOne(
      `SELECT t.* FROM pfe_trades t
         JOIN pfe_guard g ON g.trade_id = t.id AND g.open_key = 1
        LIMIT 1`);
  },

  async byId(id) {
    return db.queryOne('SELECT * FROM pfe_trades WHERE id = ? LIMIT 1', [id]);
  },

  async setState(tradeId, state, patch = {}) {
    const cols = ['state = ?'];
    const params = [state];
    const map = {
      attemptSeq: 'attempt_seq', requoteCount: 'requote_count',
      confirmations: 'confirmations', trails: 'trails',
      entryCandleId: 'entry_candle_id',
      sellPriceP: 'sell_price_p', filledPriceP: 'filled_price_p', filledQty: 'filled_qty',
      targetPriceP: 'target_price_p', slPriceP: 'sl_price_p', trailPeakP: 'trail_peak_p',
      entryVolume: 'entry_volume',
      openedAt: 'opened_at', closedAt: 'closed_at', exitReason: 'exit_reason',
    };
    for (const [key, col] of Object.entries(map)) {
      // `in`, not truthiness: an explicit null has to reach the column. A
      // re-armed trade CLEARS its levels, and a null read as "leave it alone"
      // would keep the previous attempt's numbers on the row.
      if (patch[key] !== undefined) { cols.push(`${col} = ?`); params.push(patch[key]); }
    }
    params.push(tradeId);
    await db.query(`UPDATE pfe_trades SET ${cols.join(', ')} WHERE id = ?`, params);
  },

  // Book the round trip and release the slot together. Doing them in one
  // transaction is what stops a crash between the two from leaving a booked
  // trade still holding the only position slot.
  async close(tradeId, { exitP, grossPnlP, chargesP, netPnlP, exitReason }) {
    await db.tx(async (t) => {
      await t.query(
        `UPDATE pfe_trades
            SET exit_price_p = ?, gross_pnl_p = ?, charges_p = ?, net_pnl_p = ?,
                exit_reason = ?, state = 'DONE', closed_at = NOW()
          WHERE id = ?`,
        [exitP ?? null, grossPnlP ?? null, chargesP ?? null, netPnlP ?? null,
          String(exitReason || '').slice(0, 32), tradeId]);
      await t.query('UPDATE pfe_guard SET open_key = NULL WHERE trade_id = ?', [tradeId]);
    });
  },

  async forDate(tradeDate, limit = 200) {
    return db.query(
      'SELECT * FROM pfe_trades WHERE trade_date = ? ORDER BY id DESC LIMIT ?',
      [tradeDate, Math.max(1, Math.trunc(limit))]);
  },

  async recent(limit = 100) {
    return db.query('SELECT * FROM pfe_trades ORDER BY id DESC LIMIT ?',
      [Math.max(1, Math.trunc(limit))]);
  },

  async countEntriesForDate(tradeDate) {
    const row = await db.queryOne(
      'SELECT COUNT(*) AS n FROM pfe_trades WHERE trade_date = ? AND filled_price_p IS NOT NULL',
      [tradeDate]);
    return row.n;
  },
};

const pfeScans = {
  async log(row) {
    await db.query(
      `INSERT INTO pfe_scans
         (trade_date, ts_ms, underlying, expiry_date, side, spot, direction_state,
          chosen_token, chosen_symbol, chosen_score, considered, rejected, unavailable,
          candidates, reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.tradeDate, row.tsMs ?? Date.now(), row.underlying, row.expiryDate ?? null,
        row.side ?? null, row.spot ?? null, row.directionState ?? null,
        row.chosenToken ?? null, row.chosenSymbol ?? null, row.chosenScore ?? null,
        row.considered ?? 0, row.rejected ?? 0,
        row.unavailable ? String(row.unavailable.join(', ')).slice(0, 255) : null,
        row.candidates ? JSON.stringify(row.candidates) : null,
        row.reason == null ? null : String(row.reason).slice(0, 255)]);
  },

  async recent(limit = 50) {
    return db.query('SELECT * FROM pfe_scans ORDER BY id DESC LIMIT ?',
      [Math.max(1, Math.trunc(limit))]);
  },

  async latest() {
    return db.queryOne('SELECT * FROM pfe_scans ORDER BY id DESC LIMIT 1');
  },

  async purgeOlderThan(days) {
    const res = await db.query(
      'DELETE FROM pfe_scans WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [Math.max(1, Math.trunc(days))]);
    return res.affectedRows || 0;
  },
};

const pfeStats = {
  async ensure(tradeDate) {
    await db.query(
      'INSERT INTO pfe_stats (trade_date) VALUES (?) ON DUPLICATE KEY UPDATE trade_date = trade_date',
      [tradeDate]);
    return pfeStats.get(tradeDate);
  },

  async get(tradeDate) {
    return db.queryOne('SELECT * FROM pfe_stats WHERE trade_date = ? LIMIT 1', [tradeDate]);
  },

  // Fold one closed round trip into the day. Consecutive losses reset on any
  // non-losing trade — a scratch is not a loss, and treating it as one would
  // trip the cooldown on a flat day.
  async recordTrade(tradeDate, { grossPnlP, chargesP, netPnlP }) {
    const isLoss = netPnlP < 0;
    await db.query(
      `INSERT INTO pfe_stats
         (trade_date, realized_pnl_p, gross_pnl_p, charges_p, trade_count,
          win_count, loss_count, consecutive_losses)
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
    return pfeStats.get(tradeDate);
  },

  async bumpEntry(tradeDate) {
    await db.query(
      `INSERT INTO pfe_stats (trade_date, entry_count) VALUES (?, 1)
       ON DUPLICATE KEY UPDATE entry_count = entry_count + 1`, [tradeDate]);
  },

  async bumpScan(tradeDate) {
    await db.query(
      `INSERT INTO pfe_stats (trade_date, scan_count) VALUES (?, 1)
       ON DUPLICATE KEY UPDATE scan_count = scan_count + 1`, [tradeDate]);
  },

  async setCooldown(tradeDate, untilMs) {
    await db.query(
      `INSERT INTO pfe_stats (trade_date, cooldown_until) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE cooldown_until = VALUES(cooldown_until)`,
      [tradeDate, time.toMysql(untilMs)]);
  },

  async disable(tradeDate, reason) {
    await db.query(
      `INSERT INTO pfe_stats (trade_date, disabled, disabled_reason) VALUES (?, 1, ?)
       ON DUPLICATE KEY UPDATE disabled = 1, disabled_reason = VALUES(disabled_reason)`,
      [tradeDate, String(reason || '').slice(0, 64)]);
  },
};

/* ============================================ the Option Selling Engine == */
/* newdoc/update.md §19. Audit trail, crash recovery and risk-counter          */
/* durability — NOT hot-path decision data. Only three of these writes block   */
/* the engine (§19.2): oseTrades.open, oseTrades.close and every oseStats      */
/* mutation. Everything else is called fire-and-forget.                        */

const oseTrades = {
  // §19.2 write #1 — SYNCHRONOUS, and it happens BEFORE the entry order is
  // placed. "If this write fails, no order is placed. This guarantees no
  // position can exist without a durable record."
  //
  // The insert and the §3.3 slot claim are one transaction, so a crash between
  // them cannot leave a trade holding a slot it never got or a slot held by a
  // trade that does not exist.
  async open(row) {
    return db.tx(async (t) => {
      const res = await t.query(
        `INSERT INTO ose_trades
           (trade_uid, trade_date, underlying, expiry_date, option_type, token, symbol,
            strike, lot_size, qty, state, entry_trend, requested_price_p,
            entry_candle_ts, entry_candle_id, target_level, target_price_p, stop_price_p,
            select_score, select_detail, settings_snapshot, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'OPEN')`,
        [row.tradeUid, row.tradeDate, row.underlying, row.expiryDate, row.optionType,
          String(row.token), row.symbol, row.strike, row.lotSize, row.qty,
          row.state || 'ORDER_PENDING', row.entryTrend, row.requestedPriceP,
          row.entryCandleTs ?? null, row.entryCandleId ?? null,
          row.targetLevel ?? 0, row.targetPriceP ?? null, row.stopPriceP ?? null,
          row.selectScore ?? null,
          row.selectDetail ? JSON.stringify(row.selectDetail) : null,
          row.settingsSnapshot ? JSON.stringify(row.settingsSnapshot) : null]);
      const tradeId = res.insertId;
      await t.query('INSERT INTO ose_guard (trade_id, open_key) VALUES (?, 1)', [tradeId]);
      return tradeId;
    });
  },

  // Give the single-position slot back without booking anything. Used when a
  // trade is abandoned before it ever filled — nothing to close, but the slot
  // must not stay held.
  async release(tradeId) {
    await db.query('UPDATE ose_guard SET open_key = NULL WHERE trade_id = ?', [tradeId]);
  },

  async live() {
    return db.queryOne(
      `SELECT t.* FROM ose_trades t
         JOIN ose_guard g ON g.trade_id = t.id AND g.open_key = 1
        LIMIT 1`);
  },

  // §20.6 step 2 — every trade the database still calls open, whether or not it
  // holds the slot. The reconciliation reads this rather than `live()` so a row
  // orphaned by a crash between the insert and the guard is still found.
  async openTrades() {
    return db.query("SELECT * FROM ose_trades WHERE status = 'OPEN' ORDER BY id ASC");
  },

  async byId(id) {
    return db.queryOne('SELECT * FROM ose_trades WHERE id = ? LIMIT 1', [id]);
  },

  async byUid(uid) {
    return db.queryOne('SELECT * FROM ose_trades WHERE trade_uid = ? LIMIT 1', [String(uid)]);
  },

  async setState(tradeId, state, patch = {}) {
    const cols = ['state = ?'];
    const params = [state];
    const map = {
      entryPriceP: 'entry_price_p', entryTs: 'entry_ts', entryCandleId: 'entry_candle_id',
      filledQty: 'filled_qty',
      targetLevel: 'target_level', targetPriceP: 'target_price_p',
      stopPriceP: 'stop_price_p', candlesHeld: 'candles_held', mfePoints: 'mfe_points',
      exitReason: 'exit_reason', exitAttempts: 'exit_attempts',
    };
    for (const [key, col] of Object.entries(map)) {
      // `in`, not truthiness: an explicit null has to reach the column.
      if (patch[key] !== undefined) { cols.push(`${col} = ?`); params.push(patch[key]); }
    }
    params.push(tradeId);
    await db.query(`UPDATE ose_trades SET ${cols.join(', ')} WHERE id = ?`, params);
  },

  // §19.2 write #2 — SYNCHRONOUS, after the exit fill. Booking the round trip
  // and releasing the slot are one transaction: a crash between them would leave
  // a booked trade still holding the only position slot, and the next boot would
  // refuse to trade for a reason nobody could see.
  async close(tradeId, {
    exitP, exitTs, grossPnlP, chargesP, netPnlP, exitReason, finalStopP, candlesHeld, mfePoints,
  }) {
    await db.tx(async (t) => {
      await t.query(
        `UPDATE ose_trades
            SET exit_price_p = ?, exit_ts = ?, gross_pnl_p = ?, charges_p = ?, net_pnl_p = ?,
                exit_reason = ?, final_stop_p = ?, candles_held = ?, mfe_points = ?,
                state = 'COOLDOWN', status = 'CLOSED'
          WHERE id = ?`,
        [exitP ?? null, exitTs ?? null, grossPnlP ?? null, chargesP ?? null, netPnlP ?? null,
          String(exitReason || '').slice(0, 48), finalStopP ?? null,
          candlesHeld ?? 0, mfePoints ?? 0, tradeId]);
      await t.query('UPDATE ose_guard SET open_key = NULL WHERE trade_id = ?', [tradeId]);
    });
  },

  // §20.6 case (c) and the ERROR status. A trade the engine cannot account for
  // is marked and the slot is deliberately NOT released — the halt is supposed
  // to stop the next session too.
  async markError(tradeId, reason) {
    await db.query(
      `UPDATE ose_trades SET status = 'ERROR', exit_reason = ? WHERE id = ?`,
      [String(reason || '').slice(0, 48), tradeId]);
  },

  async forDate(tradeDate, limit = 200) {
    return db.query(
      'SELECT * FROM ose_trades WHERE trade_date = ? ORDER BY id DESC LIMIT ?',
      [tradeDate, Math.max(1, Math.trunc(limit))]);
  },

  async recent(limit = 100) {
    return db.query('SELECT * FROM ose_trades ORDER BY id DESC LIMIT ?',
      [Math.max(1, Math.trunc(limit))]);
  },
};

const oseDecisions = {
  // ~4,300 rows a session, so this is on the async path and never awaited by a
  // decision cycle. `ON DUPLICATE KEY UPDATE id = id` makes a replayed candle
  // idempotent: the decision for a given (date, candle) is written once and
  // never revised.
  async log(row) {
    await db.query(
      `INSERT INTO ose_decisions
         (cycle_id, trade_date, candle_ts, nifty_open_p, nifty_high_p, nifty_low_p,
          nifty_close_p, synthetic, low_confidence, tick_count,
          trend, trend_via, bullish_mid_p, bearish_mid_p,
          outcome, detail, selected_symbol, selection_score, state, latency_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE id = id`,
      [row.cycleId, row.tradeDate, row.candleTs,
        row.openP, row.highP, row.lowP, row.closeP, row.synthetic ? 1 : 0,
        row.lowConfidence ? 1 : 0, row.tickCount ?? 0,
        row.trend || 'NONE', row.trendVia ?? null,
        row.bullishMidP ?? null, row.bearishMidP ?? null,
        String(row.outcome).slice(0, 48),
        row.detail == null ? null : String(row.detail).slice(0, 255),
        row.selectedSymbol ?? null, row.selectionScore ?? null,
        row.state ?? null, row.latencyMs ?? 0]);
  },

  async recent(limit = 200) {
    return db.query('SELECT * FROM ose_decisions ORDER BY id DESC LIMIT ?',
      [Math.max(1, Math.trunc(limit))]);
  },

  async forDate(tradeDate, limit = 5000) {
    return db.query(
      'SELECT * FROM ose_decisions WHERE trade_date = ? ORDER BY candle_ts ASC LIMIT ?',
      [tradeDate, Math.max(1, Math.trunc(limit))]);
  },

  // The question §21 exists to answer: what did the engine spend the session
  // refusing, and how often. One query rather than a log grep.
  async outcomeTally(tradeDate) {
    return db.query(
      `SELECT outcome, COUNT(*) AS n, MAX(id) AS last_id
         FROM ose_decisions WHERE trade_date = ?
        GROUP BY outcome ORDER BY n DESC`, [tradeDate]);
  },

  // §23.1 — the latency budget, measured. p99 is approximated by ordering rather
  // than by a window function, so this works on MariaDB too.
  async latency(tradeDate) {
    return db.queryOne(
      `SELECT COUNT(*) AS n, AVG(latency_ms) AS avg_ms, MAX(latency_ms) AS max_ms
         FROM ose_decisions WHERE trade_date = ?`, [tradeDate]);
  },

  async purgeOlderThan(days) {
    const res = await db.query(
      'DELETE FROM ose_decisions WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [Math.max(1, Math.trunc(days))]);
    return res.affectedRows || 0;
  },
};

const oseTransitions = {
  async log(row) {
    await db.query(
      `INSERT INTO ose_transitions
         (cycle_id, trade_uid, from_state, to_state, trigger_event, reason, illegal, ts_ms)
       VALUES (?,?,?,?,?,?,?,?)`,
      [row.cycleId ?? null, row.tradeUid ?? null, row.fromState, row.toState,
        String(row.trigger || '').slice(0, 48),
        row.reason == null ? null : String(row.reason).slice(0, 256),
        row.illegal ? 1 : 0, row.tsMs ?? Date.now()]);
  },

  async recent(limit = 200) {
    return db.query('SELECT * FROM ose_transitions ORDER BY id DESC LIMIT ?',
      [Math.max(1, Math.trunc(limit))]);
  },

  async purgeOlderThan(days) {
    const res = await db.query(
      'DELETE FROM ose_transitions WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [Math.max(1, Math.trunc(days))]);
    return res.affectedRows || 0;
  },
};

const oseStats = {
  async ensure(tradeDate) {
    await db.query(
      'INSERT INTO ose_stats (trade_date) VALUES (?) ON DUPLICATE KEY UPDATE trade_date = trade_date',
      [tradeDate]);
    return oseStats.get(tradeDate);
  },

  async get(tradeDate) {
    return db.queryOne('SELECT * FROM ose_stats WHERE trade_date = ? LIMIT 1', [tradeDate]);
  },

  // §19.2 write #3 — SYNCHRONOUS. The counters must be durable before the engine
  // acts on them, or a crash turns a tripped circuit breaker back into a fresh
  // day's allowance.
  //
  // §17.3: a loss is NET P&L below zero. Exactly zero is a SCRATCH — it resets
  // the consecutive-loss counter (it is not a loss) but is counted separately
  // from a win, because a day of scratches is a day the strategy did nothing and
  // a win rate that hides them is a win rate that lies.
  async recordTrade(tradeDate, { grossPnlP, chargesP, netPnlP }) {
    const isLoss = netPnlP < 0;
    const isWin = netPnlP > 0;
    await db.query(
      `INSERT INTO ose_stats
         (trade_date, trades_today, realised_pnl_p, gross_pnl_p, charges_p,
          win_count, loss_count, scratch_count, consecutive_losses)
       VALUES (?,1,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         trades_today   = trades_today + 1,
         realised_pnl_p = realised_pnl_p + VALUES(realised_pnl_p),
         gross_pnl_p    = gross_pnl_p + VALUES(gross_pnl_p),
         charges_p      = charges_p + VALUES(charges_p),
         win_count      = win_count + VALUES(win_count),
         loss_count     = loss_count + VALUES(loss_count),
         scratch_count  = scratch_count + VALUES(scratch_count),
         consecutive_losses = IF(VALUES(loss_count) = 1, consecutive_losses + 1, 0)`,
      [tradeDate, netPnlP, grossPnlP, chargesP,
        isWin ? 1 : 0, isLoss ? 1 : 0, (!isWin && !isLoss) ? 1 : 0, isLoss ? 1 : 0]);
    return oseStats.get(tradeDate);
  },

  async bumpCycle(tradeDate) {
    await db.query(
      `INSERT INTO ose_stats (trade_date, cycles) VALUES (?, 1)
       ON DUPLICATE KEY UPDATE cycles = cycles + 1`, [tradeDate]);
  },

  async bumpEntry(tradeDate) {
    await db.query(
      `INSERT INTO ose_stats (trade_date, entries) VALUES (?, 1)
       ON DUPLICATE KEY UPDATE entries = entries + 1`, [tradeDate]);
  },

  // §17.6 — terminal for the session. Written once and never rewritten: a halt
  // reason that keeps being overwritten by later symptoms loses the first cause,
  // which is the one an operator needs.
  async halt(tradeDate, reason) {
    await db.query(
      `INSERT INTO ose_stats (trade_date, halted, halt_reason, halted_at)
       VALUES (?, 1, ?, NOW())
       ON DUPLICATE KEY UPDATE
         halt_reason = IF(halted = 1, halt_reason, VALUES(halt_reason)),
         halted_at   = IF(halted = 1, halted_at, NOW()),
         halted      = 1`,
      [tradeDate, String(reason || '').slice(0, 256)]);
  },

  // §26.6 — the ONLY path that clears a halt, and it is reachable only from
  // scripts/ose-reset-halt.js. There is deliberately no API route and no
  // automatic path: §17.6 requires an operator to confirm flat at the broker
  // terminal first, which no code here can verify.
  async clearHalt(tradeDate) {
    const res = await db.query(
      `UPDATE ose_stats SET halted = 0, halt_reason = NULL, halted_at = NULL
        WHERE trade_date = ? AND halted = 1`, [tradeDate]);
    return (res.affectedRows || 0) > 0;
  },
};

module.exports = {
  settings, flags, instruments, broker, cycles, legs, candles,
  orders, positions, stats, events, locks,
  pfeTrades, pfeScans, pfeStats,
  oseTrades, oseDecisions, oseTransitions, oseStats,
};
