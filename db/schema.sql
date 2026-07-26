-- ===========================================================================
-- Premium Range Trader — schema
--
-- Every statement is idempotent (CREATE TABLE IF NOT EXISTS); db/migrate.js
-- applies this file statement-by-statement and then runs additive patches for
-- installs that already have an older shape.
--
-- Conventions:
--   * money      DECIMAL(12,2) — premiums; DECIMAL(14,2) for P&L totals
--   * strikes    DECIMAL(14,4) — the join key between the two brokers
--   * timestamps DATETIME in UTC (connections are pinned to +00:00)
--   * ids        BIGINT UNSIGNED
-- ===========================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email         VARCHAR(191) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(150) DEFAULT NULL,
  role          ENUM('OWNER','TRADER','VIEWER') NOT NULL DEFAULT 'OWNER',
  status        ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  last_login_at DATETIME DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- ---------------------------------------------------------------------------
-- Broker connections. One row per (user, broker).
--   zerodha -> market data only  (access_token expires ~06:00 IST daily)
--   kotak   -> execution only    (session token from the TOTP+MPIN flow)
-- Secrets are AES-256-GCM encrypted (src/core/crypto.js). MPIN and TOTP are
-- NEVER stored — they are forwarded once to Kotak and discarded.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS broker_accounts (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  broker         ENUM('zerodha','kotak') NOT NULL,
  status         ENUM('DISCONNECTED','CONNECTED','EXPIRED','ERROR') NOT NULL DEFAULT 'DISCONNECTED',
  -- zerodha: api_key / kotak: ucc
  public_id      VARCHAR(64)  DEFAULT NULL,
  -- zerodha: api_secret / kotak: mobile
  secret_enc     TEXT         DEFAULT NULL,
  -- zerodha: access_token / kotak: session token
  access_token_enc TEXT       DEFAULT NULL,
  -- kotak: sid, base_url, data centre; zerodha: public_token
  aux1_enc       TEXT         DEFAULT NULL,
  aux2_enc       TEXT         DEFAULT NULL,
  aux3           VARCHAR(191) DEFAULT NULL,
  broker_user_id VARCHAR(64)  DEFAULT NULL,
  broker_user_name VARCHAR(150) DEFAULT NULL,
  last_login_at  DATETIME     DEFAULT NULL,
  last_error     VARCHAR(500) DEFAULT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_broker_user (user_id, broker),
  CONSTRAINT fk_broker_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ---------------------------------------------------------------------------
-- Instrument master — ONE table holding BOTH brokers' identifiers.
--
-- This is the design decision the platform rests on. Zerodha's ticker addresses
-- an option by its own numeric instrument_token; Kotak's order API needs its
-- pSymbol token plus the trading symbol. Nothing links them, so both masters
-- are ingested into this single row keyed by the contract's economics:
--     (underlying, expiry_date, strike, option_type)
-- A contract present on only one side keeps NULLs on the other and is reported
-- as not tradable — the strategy can quote it but could never order it, so it
-- must never be selected.
-- ---------------------------------------------------------------------------
-- NOTE ON THE UNIQUE KEY: MySQL treats NULLs as DISTINCT in a unique index, so
-- a row with a NULL expiry or strike can never match an existing one and every
-- upsert would INSERT instead of UPDATE. Index (spot) rows therefore carry the
-- sentinels expiry_date = '1970-01-01' and strike = 0 rather than NULL — see
-- instrumentStore.INDEX_SENTINEL. Option rows always have both.
CREATE TABLE IF NOT EXISTS instruments (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  underlying      VARCHAR(32) NOT NULL,
  expiry_date     DATE DEFAULT NULL,
  strike          DECIMAL(14,4) DEFAULT NULL,
  option_type     ENUM('CE','PE','FUT','IDX') NOT NULL,
  -- Zerodha (market data)
  z_token         BIGINT UNSIGNED DEFAULT NULL,
  z_symbol        VARCHAR(64) DEFAULT NULL,
  z_exchange      VARCHAR(16) DEFAULT NULL,
  -- Kotak (execution)
  k_token         VARCHAR(32) DEFAULT NULL,
  k_symbol        VARCHAR(64) DEFAULT NULL,
  k_segment       VARCHAR(16) DEFAULT NULL,
  lot_size        INT DEFAULT NULL,
  tick_size       DECIMAL(10,4) DEFAULT NULL,
  tradable        TINYINT(1) NOT NULL DEFAULT 0,   -- both sides present
  synced_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_contract (underlying, expiry_date, strike, option_type),
  KEY idx_chain (underlying, expiry_date, option_type, strike),
  KEY idx_ztoken (z_token),
  KEY idx_ktoken (k_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ---------------------------------------------------------------------------
-- Strategies. Config is JSON so the shape can evolve without a migration;
-- everything the engine needs to schedule or recover is a real column.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS strategies (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  name           VARCHAR(100) NOT NULL,
  config         LONGTEXT NOT NULL,
  state          LONGTEXT DEFAULT NULL,            -- runtime snapshot for crash recovery
  status         ENUM('IDLE','SCANNING','STRIKE_SELECTED','HEDGE_PENDING','HEDGE_OPEN',
                      'ARM_WAIT','OFFSET_WAIT','SHORT_PENDING','POSITION_OPEN',
                      'EXIT_SHORT','EXIT_HEDGE','COMPLETE','HALTED')
                 NOT NULL DEFAULT 'IDLE',
  enabled        TINYINT(1) NOT NULL DEFAULT 0,
  queue_priority INT NOT NULL DEFAULT 5,           -- lower wins the position slot
  last_decision  VARCHAR(500) DEFAULT NULL,
  last_error     VARCHAR(500) DEFAULT NULL,
  -- Operator square-off request. Deliberately its OWN columns rather than a
  -- field inside `state`: the engine rewrites `state` on every tick, so a flag
  -- placed there by the web tier would be overwritten within a second and the
  -- request silently lost. The engine clears these with a conditional UPDATE.
  square_off_requested_at DATETIME DEFAULT NULL,
  square_off_requested_by VARCHAR(191) DEFAULT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_strat_user (user_id, enabled),
  CONSTRAINT fk_strat_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ---------------------------------------------------------------------------
-- Orders — one row per order sent to Kotak, written BEFORE the request leaves.
--
-- `client_order_id` is the idempotency key and it is UNIQUE per user. Kotak's
-- place-order API has no client reference of its own, so this row is what makes
-- "place at most once" enforceable: a duplicate insert fails at the database,
-- which is the only check that survives a process restart or a second engine.
--
-- Status flow:  NEW -> SENDING -> PLACED | REJECTED | UNKNOWN
--   UNKNOWN means the request left but no response came back. The order MAY be
--   live. It is never resent; the reconciler resolves it against the broker.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED NOT NULL,
  strategy_id      BIGINT UNSIGNED DEFAULT NULL,
  trade_id         BIGINT UNSIGNED DEFAULT NULL,
  client_order_id  VARCHAR(96) NOT NULL,
  purpose          ENUM('HEDGE_ENTRY','SHORT_ENTRY','SHORT_EXIT','HEDGE_EXIT','MANUAL') NOT NULL,
  instrument_id    BIGINT UNSIGNED DEFAULT NULL,
  k_token          VARCHAR(32) NOT NULL,
  k_symbol         VARCHAR(64) NOT NULL,
  k_segment        VARCHAR(16) NOT NULL DEFAULT 'nse_fo',
  side             ENUM('BUY','SELL') NOT NULL,
  qty              INT NOT NULL,
  product          VARCHAR(8) NOT NULL DEFAULT 'MIS',
  order_type       VARCHAR(8) NOT NULL DEFAULT 'MKT',
  limit_price      DECIMAL(12,2) DEFAULT NULL,
  trigger_price    DECIMAL(12,2) DEFAULT NULL,
  reduce_only      TINYINT(1) NOT NULL DEFAULT 0,
  status           ENUM('NEW','SENDING','PLACED','REJECTED','UNKNOWN','CANCELLED') NOT NULL DEFAULT 'NEW',
  broker_order_id  VARCHAR(64) DEFAULT NULL,
  avg_fill_price   DECIMAL(12,2) DEFAULT NULL,
  filled_qty       INT DEFAULT NULL,
  reject_reason    VARCHAR(255) DEFAULT NULL,
  raw_request      LONGTEXT DEFAULT NULL,
  raw_response     LONGTEXT DEFAULT NULL,
  sent_at          DATETIME DEFAULT NULL,
  settled_at       DATETIME DEFAULT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_client_order (user_id, client_order_id),
  KEY idx_orders_trade (trade_id),
  KEY idx_orders_status (status, updated_at),
  KEY idx_orders_user (user_id, id),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ---------------------------------------------------------------------------
-- Trades — the two-leg structure, matching the doc's Trade Table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trades (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED NOT NULL,
  strategy_id      BIGINT UNSIGNED NOT NULL,
  trade_date       DATE NOT NULL,
  underlying       VARCHAR(32) NOT NULL,
  expiry_date      DATE DEFAULT NULL,
  option_type      ENUM('CE','PE') NOT NULL,
  -- Short (main) leg
  sell_symbol      VARCHAR(64) DEFAULT NULL,
  sell_k_token     VARCHAR(32) DEFAULT NULL,
  sell_z_token     BIGINT UNSIGNED DEFAULT NULL,
  sell_strike      DECIMAL(14,4) DEFAULT NULL,
  sell_price       DECIMAL(12,2) DEFAULT NULL,
  sell_exit_price  DECIMAL(12,2) DEFAULT NULL,
  -- Hedge (long) leg
  hedge_symbol     VARCHAR(64) DEFAULT NULL,
  hedge_k_token    VARCHAR(32) DEFAULT NULL,
  hedge_z_token    BIGINT UNSIGNED DEFAULT NULL,
  hedge_strike     DECIMAL(14,4) DEFAULT NULL,
  hedge_price      DECIMAL(12,2) DEFAULT NULL,
  hedge_exit_price DECIMAL(12,2) DEFAULT NULL,
  -- Sizing and levels
  lots             INT DEFAULT NULL,
  lot_size         INT DEFAULT NULL,
  qty              INT NOT NULL,
  arm_price        DECIMAL(12,2) DEFAULT NULL,
  offset_value     DECIMAL(12,2) DEFAULT NULL,
  armed_at         DATETIME DEFAULT NULL,
  armed_low        DECIMAL(12,2) DEFAULT NULL,
  target_points    DECIMAL(12,2) DEFAULT NULL,     -- points actually used (may be lifted to clear charges)
  target_price     DECIMAL(12,2) DEFAULT NULL,
  sl_price         DECIMAL(12,2) DEFAULT NULL,
  -- Outcome
  exit_reason      VARCHAR(32) DEFAULT NULL,
  gross_pnl        DECIMAL(14,2) DEFAULT NULL,
  charges          DECIMAL(12,2) DEFAULT NULL,
  net_pnl          DECIMAL(14,2) DEFAULT NULL,
  mode             ENUM('live','paper') NOT NULL DEFAULT 'paper',
  status           ENUM('HEDGE_OPEN','OPEN','EXITING','CLOSED','ABORTED','NEEDS_ATTENTION')
                   NOT NULL DEFAULT 'HEDGE_OPEN',
  opened_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at        DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_trades_user_date (user_id, trade_date),
  KEY idx_trades_open (user_id, status),
  KEY idx_trades_strategy (strategy_id, id),
  CONSTRAINT fk_trades_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ---------------------------------------------------------------------------
-- Audit trail. The doc asks for "complete audit logs for every LTP tick, arm
-- event, offset trigger, order request, broker response and exit decision" —
-- this is that table. Trimmed to EVENT_RETENTION_DAYS by the app's sweeper.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS strategy_events (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  strategy_id BIGINT UNSIGNED DEFAULT NULL,
  trade_id    BIGINT UNSIGNED DEFAULT NULL,
  event_type  VARCHAR(24) NOT NULL,
  level       ENUM('DEBUG','INFO','WARN','ERROR') NOT NULL DEFAULT 'INFO',
  from_state  VARCHAR(24) DEFAULT NULL,
  to_state    VARCHAR(24) DEFAULT NULL,
  message     VARCHAR(500) DEFAULT NULL,
  ltp         DECIMAL(12,2) DEFAULT NULL,
  spot        DECIMAL(14,2) DEFAULT NULL,
  meta        LONGTEXT DEFAULT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_events_strategy (strategy_id, id),
  KEY idx_events_user_time (user_id, created_at),
  KEY idx_events_trade (trade_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ---------------------------------------------------------------------------
-- Per-strategy daily counters. A real table rather than a JSON blob so the risk
-- limits survive a restart and can be reported on directly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_stats (
  strategy_id  BIGINT UNSIGNED NOT NULL,
  trade_date   DATE NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,
  trades       INT NOT NULL DEFAULT 0,
  wins         INT NOT NULL DEFAULT 0,
  losses       INT NOT NULL DEFAULT 0,
  gross_pnl    DECIMAL(14,2) NOT NULL DEFAULT 0,
  charges      DECIMAL(14,2) NOT NULL DEFAULT 0,
  net_pnl      DECIMAL(14,2) NOT NULL DEFAULT 0,
  blocked_reason VARCHAR(200) DEFAULT NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (strategy_id, trade_date),
  KEY idx_daily_user (user_id, trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ---------------------------------------------------------------------------
-- Leader lock. Exactly one engine process may drive a user's strategies; two
-- would race to place the same orders. A lock is held by heartbeat and expires
-- if the holder dies, so a crashed engine does not wedge trading forever.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS engine_locks (
  lock_name    VARCHAR(64) NOT NULL,
  owner        VARCHAR(96) NOT NULL,
  acquired_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (lock_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ---------------------------------------------------------------------------
-- Runtime flags — the kill switch, togglable without a restart. The env var
-- TRADING_HALTED sets the boot default; this table is the live override.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_flags (
  flag_key   VARCHAR(64) NOT NULL,
  flag_value VARCHAR(255) DEFAULT NULL,
  note       VARCHAR(255) DEFAULT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (flag_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ---------------------------------------------------------------------------
-- Tick history for the monitored legs. Enough to reconstruct why a trade armed
-- or exited when it did, without storing the whole chain.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tick_history (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  z_token    BIGINT UNSIGNED NOT NULL,
  ts_ms      BIGINT UNSIGNED NOT NULL,
  ltp        DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_tick (z_token, ts_ms),
  KEY idx_tick_time (ts_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;
