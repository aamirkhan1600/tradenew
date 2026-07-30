-- zoption schema. Statement-per-`;`, every table CREATE TABLE IF NOT EXISTS so
-- the file is safe to re-run. Columns added to an already-deployed table need an
-- idempotent patch block in migrate.js as well — IF NOT EXISTS will not alter a
-- table that already exists.
--
-- All prices are stored as INT paise. 12.40 is 1240. Nothing in this schema is
-- a FLOAT: a premium multiplied by a lot size and compared against a rupee limit
-- is exactly where P&L silently drifts.

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email         VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One broker account. Single-account by design: the strategy holds at most one
-- CE and one PE, and multi-account execution is a post-M9 item.
CREATE TABLE IF NOT EXISTS broker_account (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  label          VARCHAR(64) NOT NULL DEFAULT 'primary',
  mobile         VARCHAR(32) NULL,
  ucc            VARCHAR(32) NULL,
  user_name      VARCHAR(128) NULL,
  -- AES-256-GCM at rest. MPIN and TOTP are never stored — they are the second
  -- factor and persisting them would defeat the point of having one.
  session_token  TEXT NULL,
  sid            TEXT NULL,
  base_url       VARCHAR(255) NULL,
  status         ENUM('DISCONNECTED','ACTIVE','EXPIRED') NOT NULL DEFAULT 'DISCONNECTED',
  last_login_at  DATETIME NULL,
  last_error     VARCHAR(500) NULL,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_broker_label (label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The instrument master, synced once a session. A stale row points at a
-- contract that no longer exists and the selector would happily choose it.
CREATE TABLE IF NOT EXISTS instruments (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  underlying   VARCHAR(24) NOT NULL,
  expiry_date  DATE NOT NULL,
  strike       DECIMAL(12,2) NOT NULL,
  option_type  ENUM('CE','PE','IDX') NOT NULL,
  token        VARCHAR(32) NOT NULL,
  segment      VARCHAR(16) NOT NULL DEFAULT 'nse_fo',
  symbol       VARCHAR(64) NOT NULL,
  lot_size     INT UNSIGNED NULL,
  tick_size    DECIMAL(8,4) NULL,
  tradable     TINYINT(1) NOT NULL DEFAULT 0,
  synced_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_instr_contract (underlying, expiry_date, strike, option_type),
  KEY idx_instr_token (token),
  KEY idx_instr_chain (underlying, expiry_date, option_type, strike)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The config block from doc/PROJECT_PLAN.md §6, one row per profile. The engine
-- reads it at cycle start and never mid-cycle: changing the offset under a
-- working order would produce a trade neither the old nor the new config
-- describes.
CREATE TABLE IF NOT EXISTS settings (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(64) NOT NULL DEFAULT 'default',
  payload         JSON NOT NULL,
  version         INT UNSIGNED NOT NULL DEFAULT 1,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_settings_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per strike lock. The lock lives in the database rather than in
-- process memory so a restart cannot double-lock, and so the dashboard can show
-- what is locked without asking the engine.
CREATE TABLE IF NOT EXISTS cycles (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  trade_date    DATE NOT NULL,
  underlying    VARCHAR(24) NOT NULL,
  expiry_date   DATE NOT NULL,
  ce_token      VARCHAR(32) NULL,
  ce_symbol     VARCHAR(64) NULL,
  ce_strike     DECIMAL(12,2) NULL,
  pe_token      VARCHAR(32) NULL,
  pe_symbol     VARCHAR(64) NULL,
  pe_strike     DECIMAL(12,2) NULL,
  spot_at_lock  DECIMAL(12,2) NULL,
  lot_size      INT UNSIGNED NOT NULL,
  qty           INT UNSIGNED NOT NULL,
  settings_snapshot JSON NULL,
  status        ENUM('LOCKED','CLOSING','CLOSED') NOT NULL DEFAULT 'LOCKED',
  locked_at     DATETIME NOT NULL,
  unlocked_at   DATETIME NULL,
  unlock_reason VARCHAR(64) NULL,
  PRIMARY KEY (id),
  KEY idx_cycles_open (status, trade_date),
  KEY idx_cycles_date (trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Only one cycle may be open at a time. Enforced by a partial-unique trick:
-- `open_key` is the constant 1 while the cycle is live and NULL once it closes,
-- and MySQL treats NULLs as distinct in a UNIQUE index. Two engines racing to
-- open a cycle therefore produce one winner and one duplicate-key error rather
-- than two locked strikes.
CREATE TABLE IF NOT EXISTS cycle_guard (
  cycle_id  INT UNSIGNED NOT NULL,
  open_key  TINYINT UNSIGNED NULL,
  PRIMARY KEY (cycle_id),
  UNIQUE KEY uk_cycle_open (open_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per leg (CE / PE) within a cycle.
CREATE TABLE IF NOT EXISTS legs (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  cycle_id       INT UNSIGNED NOT NULL,
  option_type    ENUM('CE','PE') NOT NULL,
  token          VARCHAR(32) NOT NULL,
  symbol         VARCHAR(64) NOT NULL,
  strike         DECIMAL(12,2) NOT NULL,
  state          VARCHAR(32) NOT NULL DEFAULT 'IDLE',
  attempt_seq    INT UNSIGNED NOT NULL DEFAULT 0,
  -- The candle this leg's working SELL was priced from. The single most useful
  -- column in a post-mortem: it answers "why did it sell there".
  entry_candle_id INT UNSIGNED NULL,
  sell_price_p   INT NULL,
  filled_price_p INT NULL,
  target_price_p INT NULL,
  sl_price_p     INT NULL,
  filled_qty     INT UNSIGNED NOT NULL DEFAULT 0,
  -- How many consecutive index-trend confirmations this position has collected.
  -- It is what the dynamic target ladder is indexed by, so it is the column that
  -- explains why a trade's target was 3 points and not 1.
  confirmations  INT UNSIGNED NOT NULL DEFAULT 0,
  opened_at      DATETIME NULL,
  closed_at      DATETIME NULL,
  exit_reason    VARCHAR(32) NULL,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_leg_cycle_type (cycle_id, option_type),
  KEY idx_legs_state (state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Persisted OHLC. The dashboard chart and every post-mortem read the same rows
-- the engine decided on — a chart drawn from a second source would eventually
-- disagree with the trade, and then neither can be trusted.
CREATE TABLE IF NOT EXISTS candles (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  token        VARCHAR(32) NOT NULL,
  timeframe    VARCHAR(8) NOT NULL,
  bucket_start DATETIME NOT NULL,
  open_p       INT NOT NULL,
  high_p       INT NOT NULL,
  low_p        INT NOT NULL,
  close_p      INT NOT NULL,
  tick_count   INT UNSIGNED NOT NULL DEFAULT 0,
  -- A bucket that saw no ticks at all. Its close is stale by definition, so it
  -- is recorded for continuity but never triggers an entry.
  synthetic    TINYINT(1) NOT NULL DEFAULT 0,
  -- Where the bar came from. LIVE is assembled here from the tick stream and is
  -- the only kind the engine may ever price an order from. BACKFILL was
  -- downloaded from a third party (Yahoo) to give the charts history Kotak has
  -- no endpoint for — it is a different measurement of the same market, taken
  -- with a different clock and a different definition of a bar, and mixing the
  -- two without being able to tell them apart would make a post-mortem
  -- impossible.
  --
  -- `tick_count` is meaningless on a BACKFILL row: an exchange-aggregated bar
  -- has no sample count. It is stored as 0 and readers must gate on `source`
  -- rather than on tick_count when deciding whether a bar measured anything.
  source       ENUM('LIVE','BACKFILL') NOT NULL DEFAULT 'LIVE',
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_candle_bucket (token, timeframe, bucket_start),
  KEY idx_candle_recent (token, timeframe, bucket_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every order. `client_ref` is the idempotency key: Kotak's place-order has no
-- client order id, so this column plus the PENDING -> PLACING claim is the only
-- thing standing between a retry and a duplicate position.
CREATE TABLE IF NOT EXISTS orders (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_ref      VARCHAR(64) NOT NULL,
  cycle_id        INT UNSIGNED NULL,
  leg_id          INT UNSIGNED NULL,
  stage           VARCHAR(24) NOT NULL,           -- ENTRY / TARGET / SL / TIMEOUT / SQUAREOFF
  broker_order_id VARCHAR(48) NULL,
  token           VARCHAR(32) NOT NULL,
  segment         VARCHAR(16) NOT NULL DEFAULT 'nse_fo',
  symbol          VARCHAR(64) NOT NULL,
  side            ENUM('BUY','SELL') NOT NULL,
  order_type      ENUM('L','MKT','SL','SL-M') NOT NULL,
  product         VARCHAR(8) NOT NULL DEFAULT 'NRML',
  limit_price_p   INT NOT NULL DEFAULT 0,
  qty             INT UNSIGNED NOT NULL,
  filled_qty      INT UNSIGNED NOT NULL DEFAULT 0,
  filled_price_p  INT NULL,
  -- PENDING  -> claimed exactly once ->
  -- PLACING  -> WORKING | REJECTED | UNKNOWN ->
  -- WORKING  -> FILLED | PARTIAL | CANCELLED
  status          ENUM('PENDING','PLACING','WORKING','FILLED','PARTIAL',
                       'CANCELLED','REJECTED','UNKNOWN') NOT NULL DEFAULT 'PENDING',
  reason          VARCHAR(500) NULL,
  placed_at       DATETIME NULL,
  closed_at       DATETIME NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_orders_client_ref (client_ref),
  KEY idx_orders_status (status),
  KEY idx_orders_leg (leg_id, stage),
  KEY idx_orders_broker (broker_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One completed round trip: the short and its buy-back.
CREATE TABLE IF NOT EXISTS positions (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  cycle_id      INT UNSIGNED NOT NULL,
  leg_id        INT UNSIGNED NOT NULL,
  trade_date    DATE NOT NULL,
  option_type   ENUM('CE','PE') NOT NULL,
  symbol        VARCHAR(64) NOT NULL,
  strike        DECIMAL(12,2) NOT NULL,
  qty           INT UNSIGNED NOT NULL,
  entry_p       INT NOT NULL,
  exit_p        INT NULL,
  target_p      INT NOT NULL,
  sl_p          INT NOT NULL,
  gross_pnl_p   INT NULL,
  charges_p     INT NULL,
  -- Net is what the strategy actually earned. Gross on a 1-point target is
  -- misleading by roughly the size of the target itself.
  net_pnl_p     INT NULL,
  status        ENUM('OPEN','CLOSED') NOT NULL DEFAULT 'OPEN',
  exit_reason   VARCHAR(32) NULL,
  opened_at     DATETIME NOT NULL,
  closed_at     DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_pos_date (trade_date),
  KEY idx_pos_open (status),
  KEY idx_pos_cycle (cycle_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The risk state of one trading day.
CREATE TABLE IF NOT EXISTS daily_stats (
  trade_date          DATE NOT NULL,
  realized_pnl_p      INT NOT NULL DEFAULT 0,
  gross_pnl_p         INT NOT NULL DEFAULT 0,
  charges_p           INT NOT NULL DEFAULT 0,
  trade_count         INT UNSIGNED NOT NULL DEFAULT 0,
  cycle_count         INT UNSIGNED NOT NULL DEFAULT 0,
  win_count           INT UNSIGNED NOT NULL DEFAULT 0,
  loss_count          INT UNSIGNED NOT NULL DEFAULT 0,
  consecutive_losses  INT UNSIGNED NOT NULL DEFAULT 0,
  cooldown_until      DATETIME NULL,
  disabled            TINYINT(1) NOT NULL DEFAULT 0,
  disabled_reason     VARCHAR(64) NULL,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The audit trail. "Maintain complete audit logs for every state transition"
-- appears in the engineering rules of three of the four source documents, and
-- after a bad session it is the only way to answer why the engine did what it
-- did.
CREATE TABLE IF NOT EXISTS events (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cycle_id    INT UNSIGNED NULL,
  leg_id      INT UNSIGNED NULL,
  option_type VARCHAR(4) NULL,
  kind        VARCHAR(32) NOT NULL,
  from_state  VARCHAR(32) NULL,
  to_state    VARCHAR(32) NULL,
  reason      VARCHAR(255) NULL,
  payload     JSON NULL,
  ts_ms       BIGINT UNSIGNED NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_events_cycle (cycle_id, id),
  KEY idx_events_kind (kind, id),
  KEY idx_events_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Leader election. Two engines would double every order, so the second one
-- refuses to start rather than trusting an operator to remember.
CREATE TABLE IF NOT EXISTS engine_locks (
  name        VARCHAR(48) NOT NULL,
  owner       VARCHAR(64) NOT NULL,
  heartbeat_at DATETIME NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Runtime flags the web tier writes and the engine reads: the start/stop/pause
-- intent, and anything else that must survive a restart.
CREATE TABLE IF NOT EXISTS system_flags (
  name       VARCHAR(48) NOT NULL,
  value      VARCHAR(255) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
