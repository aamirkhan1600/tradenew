-- NOTE ON `LONGTEXT` RATHER THAN `JSON`
--
-- These columns hold JSON documents and every one of them is written with
-- JSON.stringify and read back with a "parse it if it is a string" guard. The
-- column type is therefore free, and LONGTEXT is chosen because JSON is not:
-- MySQL gained it in 5.7 and MariaDB in 10.2, and a schema that will not apply
-- is a deployment that does not happen.
--
-- The one thing given up is server-side validation of the document. Nothing
-- relied on it: the writers are all JSON.stringify, so an invalid document
-- could only come from someone editing a row by hand, and the readers already
-- treat a parse failure as "no detail" rather than trusting the column.

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
  payload         LONGTEXT NOT NULL,
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
  settings_snapshot LONGTEXT NULL,
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
  -- The Price-Filter Engine's orders link here instead of to cycle/leg. Exactly
  -- one of (leg_id, pfe_trade_id) is set on any given row, and the client_ref
  -- prefix says which engine owns it: `zo-` for the scalper, `pf-` for the PFE.
  -- One orders table means one idempotency key, one reconciler and one place to
  -- read when the question is "what did this account send today".
  pfe_trade_id    INT UNSIGNED NULL,
  -- The Option Selling Engine's orders (newdoc/update.md) link here. Exactly one
  -- of (leg_id, pfe_trade_id, ose_trade_id) is set on any row, and the
  -- client_ref prefix says which engine owns it: `zo-`, `pf-` or `os-`.
  ose_trade_id    INT UNSIGNED NULL,
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
  KEY idx_orders_pfe (pfe_trade_id, stage),
  KEY idx_orders_ose (ose_trade_id, stage),
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
  payload     LONGTEXT NULL,
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

-- =========================================================================== --
-- The Price-Filter Engine (doc/new.md). A second strategy over the same
-- broker, the same instrument master, the same orders table and the same
-- reconciler — but its own trade lifecycle, its own daily risk state and its
-- own settings profile, because it disagrees with the scalper about what a
-- good configuration is and merging the two would mean one silently getting
-- the other's numbers.
-- =========================================================================== --

-- One row per selected contract, from the moment the scanner picks it to the
-- moment the round trip is booked. It carries what `cycles`, `legs` and
-- `positions` carry between them for the scalper — the PFE holds at most one
-- position at a time, so one row says everything.
CREATE TABLE IF NOT EXISTS pfe_trades (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  trade_date      DATE NOT NULL,
  underlying      VARCHAR(24) NOT NULL,
  expiry_date     DATE NOT NULL,
  option_type     ENUM('CE','PE') NOT NULL,
  token           VARCHAR(32) NOT NULL,
  symbol          VARCHAR(64) NOT NULL,
  strike          DECIMAL(12,2) NOT NULL,
  lot_size        INT UNSIGNED NOT NULL,
  qty             INT UNSIGNED NOT NULL,
  state           VARCHAR(24) NOT NULL DEFAULT 'ARMED',
  attempt_seq     INT UNSIGNED NOT NULL DEFAULT 0,
  requote_count   INT UNSIGNED NOT NULL DEFAULT 0,
  -- Completed index candles whose price position filter still permitted this
  -- side. It is what the target ladder is indexed by, so it is the column that
  -- explains why a trade's target was 4 points and not 1.
  confirmations   INT UNSIGNED NOT NULL DEFAULT 0,
  -- How many times the stop has been trailed. The gap tightens with each one,
  -- so this is not cosmetic — it is an input to the next trail.
  trails          INT UNSIGNED NOT NULL DEFAULT 0,
  spot_at_select  DECIMAL(12,2) NULL,
  direction_state VARCHAR(16) NULL,
  select_score    DECIMAL(6,2) NULL,
  -- The ranked candidate list and which liquidity checks could actually be
  -- made. "Why this strike" is the first question of every post-mortem.
  select_detail   LONGTEXT NULL,
  entry_candle_id INT UNSIGNED NULL,
  sell_price_p    INT NULL,
  filled_price_p  INT NULL,
  filled_qty      INT UNSIGNED NOT NULL DEFAULT 0,
  target_price_p  INT NULL,
  sl_price_p      INT NULL,
  trail_peak_p    INT NULL,
  entry_volume    BIGINT NULL,
  exit_price_p    INT NULL,
  gross_pnl_p     INT NULL,
  charges_p       INT NULL,
  net_pnl_p       INT NULL,
  exit_reason     VARCHAR(32) NULL,
  settings_snapshot LONGTEXT NULL,
  armed_at        DATETIME NOT NULL,
  opened_at       DATETIME NULL,
  closed_at       DATETIME NULL,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pfe_date (trade_date, id),
  KEY idx_pfe_state (state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- "Maximum simultaneous positions: 1" — doc/new.md §12 — enforced by the
-- database rather than by remembering. Same partial-unique trick as
-- `cycle_guard`: `open_key` is the constant 1 while a trade is live and NULL
-- once it is finished, and MySQL treats NULLs as distinct in a UNIQUE index.
CREATE TABLE IF NOT EXISTS pfe_guard (
  trade_id  INT UNSIGNED NOT NULL,
  open_key  TINYINT UNSIGNED NULL,
  PRIMARY KEY (trade_id),
  UNIQUE KEY uk_pfe_open (open_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every scan the engine runs, whether or not it selected anything. A scan that
-- found nothing is the more interesting row: it is the difference between "the
-- market offered nothing" and "the filter can never pass on this account".
CREATE TABLE IF NOT EXISTS pfe_scans (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  trade_date     DATE NOT NULL,
  ts_ms          BIGINT UNSIGNED NOT NULL,
  underlying     VARCHAR(24) NOT NULL,
  expiry_date    DATE NULL,
  side           VARCHAR(4) NULL,
  spot           DECIMAL(12,2) NULL,
  direction_state VARCHAR(16) NULL,
  chosen_token   VARCHAR(32) NULL,
  chosen_symbol  VARCHAR(64) NULL,
  chosen_score   DECIMAL(6,2) NULL,
  considered     INT UNSIGNED NOT NULL DEFAULT 0,
  rejected       INT UNSIGNED NOT NULL DEFAULT 0,
  -- Which liquidity fields the broker sent nothing for, across the whole scan.
  unavailable    VARCHAR(255) NULL,
  candidates     LONGTEXT NULL,
  reason         VARCHAR(255) NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pfe_scan_date (trade_date, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The PFE's own risk state for one trading day. Separate from `daily_stats`
-- because the two engines have separate limits and separate P&L, and a shared
-- row would let one strategy's losses disable the other.
CREATE TABLE IF NOT EXISTS pfe_stats (
  trade_date         DATE NOT NULL,
  realized_pnl_p     INT NOT NULL DEFAULT 0,
  gross_pnl_p        INT NOT NULL DEFAULT 0,
  charges_p          INT NOT NULL DEFAULT 0,
  trade_count        INT UNSIGNED NOT NULL DEFAULT 0,
  entry_count        INT UNSIGNED NOT NULL DEFAULT 0,
  scan_count         INT UNSIGNED NOT NULL DEFAULT 0,
  win_count          INT UNSIGNED NOT NULL DEFAULT 0,
  loss_count         INT UNSIGNED NOT NULL DEFAULT 0,
  consecutive_losses INT UNSIGNED NOT NULL DEFAULT 0,
  cooldown_until     DATETIME NULL,
  disabled           TINYINT(1) NOT NULL DEFAULT 0,
  disabled_reason    VARCHAR(64) NULL,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =========================================================================== --
-- The Option Selling Engine (newdoc/update.md). A third strategy over the same
-- broker, the same instrument master, the same orders table and the same
-- reconciler — with its own trade lifecycle, its own decision log, its own
-- state-transition audit and its own daily risk state.
--
-- §19 is explicit about what this layer is FOR: "audit trail, crash recovery and
-- risk-counter durability — NOT hot-path decision data. No decision path
-- performs a synchronous DB read." Only three writes block the engine (§19.2):
-- the OPEN insert before an order is placed, the CLOSED update after the exit
-- fill, and every risk-counter mutation. Everything else goes through a bounded
-- async queue that must never stall a decision cycle.
-- =========================================================================== --

-- §19.1 `trades`. One row per position, from the moment the strike is selected
-- to the moment the round trip is booked.
CREATE TABLE IF NOT EXISTS ose_trades (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- §6.1 — the engine-generated trade id. It is the §12.3 idempotency key:
  -- `orders.client_ref` is derived from it, so a retried placement can only ever
  -- collide with itself.
  trade_uid         CHAR(36) NOT NULL,
  trade_date        DATE NOT NULL,
  underlying        VARCHAR(24) NOT NULL,
  expiry_date       DATE NOT NULL,
  option_type       ENUM('CE','PE') NOT NULL,
  token             VARCHAR(32) NOT NULL,
  symbol            VARCHAR(64) NOT NULL,
  strike            DECIMAL(12,2) NOT NULL,
  lot_size          INT UNSIGNED NOT NULL,
  qty               INT UNSIGNED NOT NULL,
  state             VARCHAR(24) NOT NULL DEFAULT 'ORDER_PENDING',
  entry_trend       ENUM('BULLISH','BEARISH') NOT NULL,
  -- What was asked for, and what actually filled. §12.4: every target and stop
  -- derives from the FILL; the request is kept for slippage analysis alone, and
  -- keeping both is the only way to measure §20.3 SEVERE_SLIPPAGE after the fact.
  requested_price_p INT NOT NULL,
  entry_price_p     INT NULL,
  entry_ts          BIGINT UNSIGNED NULL,
  entry_candle_ts   BIGINT UNSIGNED NULL,
  entry_candle_id   INT UNSIGNED NULL,
  filled_qty        INT UNSIGNED NOT NULL DEFAULT 0,
  -- The ladder rung this trade reached. §14 — the column that explains why a
  -- target was 4 points and not 1.
  target_level      INT UNSIGNED NOT NULL DEFAULT 0,
  target_price_p    INT NULL,
  -- Monotone non-increasing for the life of the trade (§15.3). A row where this
  -- ever rose is an integrity failure, not a data-entry mistake.
  stop_price_p      INT NULL,
  final_stop_p      INT NULL,
  candles_held      INT UNSIGNED NOT NULL DEFAULT 0,
  -- Maximum favourable excursion in premium POINTS, not paise: it is a
  -- post-trade analysis figure, not a price.
  mfe_points        DECIMAL(8,2) NOT NULL DEFAULT 0,
  exit_price_p      INT NULL,
  exit_ts           BIGINT UNSIGNED NULL,
  exit_reason       VARCHAR(48) NULL,
  exit_attempts     INT UNSIGNED NOT NULL DEFAULT 0,
  gross_pnl_p       INT NULL,
  charges_p         INT NULL,
  -- The number the risk limits read. §17.3 and [MUST-CONFIRM #6]: a gross-scratch
  -- round trip is a real net loss and the circuit breaker must see it as one.
  net_pnl_p         INT NULL,
  select_score      DECIMAL(9,6) NULL,
  select_detail     LONGTEXT NULL,
  settings_snapshot LONGTEXT NULL,
  status            ENUM('OPEN','CLOSED','ERROR') NOT NULL DEFAULT 'OPEN',
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ose_uid (trade_uid),
  KEY idx_ose_date_status (trade_date, status),
  KEY idx_ose_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- §3.3 — "Single active trade. The engine MUST reject any entry attempt while
-- activeTrade !== null." Enforced by the database as well as by the Risk Engine,
-- using the same partial-unique trick as `cycle_guard` and `pfe_guard`:
-- `open_key` is the constant 1 while a trade is live and NULL once it is
-- finished, and MySQL treats NULLs as distinct in a UNIQUE index.
--
-- The in-process guard is the one §3.3 names; this one is what survives a
-- process that died between selecting a strike and recording it.
CREATE TABLE IF NOT EXISTS ose_guard (
  trade_id  INT UNSIGNED NOT NULL,
  open_key  TINYINT UNSIGNED NULL,
  PRIMARY KEY (trade_id),
  UNIQUE KEY uk_ose_open (open_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- §19.1 `decisions`. ONE ROW PER SEALED CANDLE, whether or not anything
-- happened — roughly 4,300 rows a session.
--
-- The rows where nothing happened are the valuable ones. §11.5 forbids a silent
-- rejection, and this table is where that promise is kept: every non-trade
-- carries the trend, both midpoints, the reference price and the machine-readable
-- reason, so "why did it not trade at 10:42:15" is a SELECT rather than an
-- argument.
CREATE TABLE IF NOT EXISTS ose_decisions (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cycle_id        CHAR(36) NOT NULL,
  trade_date      DATE NOT NULL,
  candle_ts       BIGINT UNSIGNED NOT NULL,
  nifty_open_p    INT NOT NULL,
  nifty_high_p    INT NOT NULL,
  nifty_low_p     INT NOT NULL,
  nifty_close_p   INT NOT NULL,
  synthetic       TINYINT(1) NOT NULL DEFAULT 0,
  -- §7.8. How many SAMPLES the bucket held, and whether that was too few to
  -- price an order from. On Kotak's REST quote fallback a 5s bar can hold one
  -- sample, and one sample is not an OHLC — so these two columns are the record
  -- of how much evidence each decision actually had.
  --
  -- They are stored rather than merely counted because a falling sample rate is
  -- the leading indicator of every downstream problem (untradable candles,
  -- skipped entries, a stop evaluated on a high that was never observed) and it
  -- falls SILENTLY. A gauge answers "is it bad now"; only a column answers "was
  -- it always like this", which is the question asked after a bad fill.
  low_confidence  TINYINT(1) NOT NULL DEFAULT 0,
  tick_count      INT UNSIGNED NOT NULL DEFAULT 0,
  trend           ENUM('BULLISH','BEARISH','NONE') NOT NULL DEFAULT 'NONE',
  trend_via       VARCHAR(24) NULL,
  bullish_mid_p   INT NULL,
  bearish_mid_p   INT NULL,
  -- newdoc/ema.md — the EMA Trend Confirmation Engine's state on this candle.
  --
  -- DECIMAL rather than INT: an EMA of integer paise is a fractional paise, and
  -- the quantity every rule in that document compares is the DIFFERENCE between
  -- these two. Rounding them to whole paise before storing would make a row
  -- whose stored values say "level" while the engine acted on a crossover — the
  -- decision log would then disagree with the decision, which is the one thing
  -- it may never do.
  --
  -- Populated on EVERY row, including the ones the EMA filter did not decide.
  -- A column only written on refusals cannot answer "what were the averages
  -- doing when it DID trade", which is the more expensive question.
  ema9_p          DECIMAL(14,4) NULL,
  ema20_p         DECIMAL(14,4) NULL,
  -- BULLISH / BEARISH / SIDEWAYS / NO_CONFIRM / WARMING_UP. Not an ENUM: the
  -- sideways rules are `[MUST-CONFIRM #18]` and a register still under review
  -- should not need an ALTER TABLE to gain a state.
  ema_trend       VARCHAR(12) NULL,
  ema_via         VARCHAR(24) NULL,
  -- Where the index level behind this decision came from — 'FEED' (the quoted
  -- index) or 'CHAIN' (put-call parity over subscribed option legs). See
  -- src/ose/syntheticIndex.js.
  --
  -- On every row rather than only on the derived ones: the question asked after
  -- a surprising trade is "what was the index doing, and did we believe it",
  -- and a column that is null for the normal case cannot distinguish "quoted"
  -- from "written before this column existed".
  index_source    VARCHAR(8) NULL,
  -- Who wrote this row: 'LIVE' (the engine), 'REPLAY' (scripts/ose-replay.js) or
  -- 'SELFTEST' (scripts/ose-selftest.js).
  --
  -- The replay and the self test drive the REAL engine, so they write real
  -- decision rows into this table — and the /ose panel counted them alongside
  -- the live ones. On 2026-08-02 that made the page report ENTRY_TAKEN 18 on a
  -- day the engine had taken no trades at all: eighteen simulated entries,
  -- written in a one-second burst, indistinguishable from a morning's trading.
  --
  -- A simulation that cannot be told apart from the record of what actually
  -- happened is worse than no simulation.
  source          VARCHAR(8) NOT NULL DEFAULT 'LIVE',
  -- ENTRY_TAKEN, or the §11.5 rejection reason. Never null.
  outcome         VARCHAR(48) NOT NULL,
  detail          VARCHAR(255) NULL,
  selected_symbol VARCHAR(64) NULL,
  selection_score DECIMAL(9,6) NULL,
  state           VARCHAR(24) NULL,
  -- §23.1 budgets 100ms at p99 from CANDLE_SEALED to ORDER_PLACED. Recorded per
  -- cycle so the budget is measured rather than assumed.
  latency_ms      DECIMAL(9,3) NOT NULL DEFAULT 0,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ose_decision (trade_date, candle_ts),
  KEY idx_ose_decision_outcome (outcome, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- §19.1 `state_transitions` and §18.3. Every transition the machine made, legal
-- or illegal, with the trigger that caused it.
CREATE TABLE IF NOT EXISTS ose_transitions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cycle_id      CHAR(36) NULL,
  trade_uid     CHAR(36) NULL,
  from_state    VARCHAR(32) NOT NULL,
  to_state      VARCHAR(32) NOT NULL,
  trigger_event VARCHAR(48) NOT NULL,
  reason        VARCHAR(256) NULL,
  -- An event/state pair that is not in the §18.2 table. Logged, ignored and
  -- counted; three in a session halt the engine.
  illegal       TINYINT(1) NOT NULL DEFAULT 0,
  ts_ms         BIGINT UNSIGNED NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ose_trans_ts (ts_ms),
  KEY idx_ose_trans_trade (trade_uid, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- §19.1 `risk_state` and §17.1. One row per trading day.
--
-- `halted` is NOT auto-clearing and MUST NOT be cleared by a process restart
-- (§17.6). Only scripts/ose-reset-halt.js clears it, and it records the reset in
-- `ose_transitions` when it does.
CREATE TABLE IF NOT EXISTS ose_stats (
  trade_date         DATE NOT NULL,
  trades_today       INT UNSIGNED NOT NULL DEFAULT 0,
  consecutive_losses INT UNSIGNED NOT NULL DEFAULT 0,
  realised_pnl_p     INT NOT NULL DEFAULT 0,
  gross_pnl_p        INT NOT NULL DEFAULT 0,
  charges_p          INT NOT NULL DEFAULT 0,
  win_count          INT UNSIGNED NOT NULL DEFAULT 0,
  loss_count         INT UNSIGNED NOT NULL DEFAULT 0,
  scratch_count      INT UNSIGNED NOT NULL DEFAULT 0,
  cycles             INT UNSIGNED NOT NULL DEFAULT 0,
  entries            INT UNSIGNED NOT NULL DEFAULT 0,
  halted             TINYINT(1) NOT NULL DEFAULT 0,
  halt_reason        VARCHAR(256) NULL,
  halted_at          DATETIME NULL,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
