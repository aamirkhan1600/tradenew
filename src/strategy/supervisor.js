// The supervisor: owns the tick loop, the leader lock, and the position queue.
//
// Three responsibilities that all exist to stop two things from happening at
// once:
//
//   1. LEADER LOCK. Exactly one engine process may drive trading. Two would
//      race to place the same orders, and the per-order idempotency key would
//      not save us because each would generate its own attempt sequence. The
//      lock is held by heartbeat so a crashed engine's claim expires instead of
//      wedging trading until someone notices.
//
//   2. POSITION QUEUE. Within one user, only one strategy may hold exposure at
//      a time (the doc's "if one strategy is active, others wait"). Whoever
//      already holds it keeps it; otherwise the lowest queue_priority wins.
//
//   3. SERIAL TICKS. Strategies are ticked one after another, not in parallel.
//      They share a broker rate limit and a position book, and interleaving
//      order placement with position reads would make fill-price differencing
//      wrong.

const config = require('../config');
const logger = require('../core/logger');
const repo = require('../repositories');
const feed = require('../market/feed');
const { StrategyRunner } = require('./strategyRunner');
const { EXPOSED_STATES } = require('./stateMachine');

const LOCK_NAME = 'engine';

class Supervisor {
  constructor() {
    this.runners = new Map();          // strategyId -> StrategyRunner
    this.sessions = new Map();         // userId -> kotak session
    this.running = false;
    this.isLeader = false;
    this.timer = null;
    this.ticking = false;
    this.lastTickAt = null;
    this.lastTickMs = null;
    this.lockInfo = null;
    this.halted = false;
    this.errors = [];
  }

  async start() {
    if (this.running) return;
    this.running = true;
    feed.startPersistence();
    logger.info('supervisor: starting', { engineId: config.engine.id, tickMs: config.engine.tickMs });
    await this.tick();                               // fail fast on a broken setup
    this.timer = setInterval(() => {
      this.tick().catch(err => logger.error('supervisor: tick threw', { err: err.message }));
    }, config.engine.tickMs);
    this.timer.unref?.();
  }

  async stop(reason = 'shutdown') {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    feed.stopPersistence();
    feed.detachAll();
    if (this.isLeader) {
      await repo.locks.release(LOCK_NAME, config.engine.id).catch(() => {});
      this.isLeader = false;
    }
    logger.info('supervisor: stopped', { reason });
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    const started = Date.now();
    try {
      // 1. Am I the leader? A follower observes and stays ready to take over.
      const lock = await repo.locks.acquire(LOCK_NAME, config.engine.id, config.engine.lockTtlMs);
      this.lockInfo = lock;
      if (!lock.acquired) {
        if (this.isLeader) logger.warn('supervisor: lost leadership', { holder: lock.owner });
        this.isLeader = false;
        return;
      }
      if (!this.isLeader) {
        this.isLeader = true;
        logger.info('supervisor: leadership acquired', {
          engineId: config.engine.id, tookOver: !!lock.tookOver, previous: lock.previousOwner,
        });
      }

      this.halted = await repo.flags.isTradingHalted();

      // 2. Sync the runner set with the database.
      await this.syncRunners();
      if (!this.runners.size) return;

      // 3. Tick each user's strategies, serially, with the queue applied.
      const byUser = new Map();
      for (const runner of this.runners.values()) {
        if (!byUser.has(runner.userId)) byUser.set(runner.userId, []);
        byUser.get(runner.userId).push(runner);
      }

      const now = Date.now();
      for (const [userId, runners] of byUser) {
        await this.tickUser(userId, runners, now);
      }
    } catch (err) {
      logger.error('supervisor: tick failed', { err: err.message, stack: err.stack });
      this.errors.unshift({ at: new Date().toISOString(), message: err.message });
      this.errors = this.errors.slice(0, 20);
    } finally {
      this.lastTickAt = Date.now();
      this.lastTickMs = Date.now() - started;
      this.ticking = false;
    }
  }

  async tickUser(userId, runners, now) {
    const ticker = await feed.attach(userId);
    const session = await this.kotakSession(userId);
    for (const r of runners) r.updateSession({ ticker, kotakSession: session });

    // The queue: whoever already has exposure keeps the slot.
    const holder = runners.find(r => EXPOSED_STATES.has(r.state));
    const ordered = runners.slice().sort((a, b) =>
      (a.queuePriority - b.queuePriority) || (a.id - b.id));

    for (const runner of ordered) {
      if (!runner.enabled) continue;
      const hasPositionSlot = !holder || holder.id === runner.id;
      await runner.tick({ hasPositionSlot, halted: this.halted, now });
    }
  }

  async syncRunners() {
    const rows = await repo.strategies.listEnabled();
    const seen = new Set();

    for (const row of rows) {
      const id = Number(row.id);
      seen.add(id);
      const existing = this.runners.get(id);
      if (existing) existing.refresh(row);
      else this.runners.set(id, new StrategyRunner({ row, ticker: null, kotakSession: null }));
    }

    // Drop disabled strategies — but never one that still holds exposure. A
    // position must be managed to its exit even if an operator disables the
    // strategy mid-trade; otherwise disabling would orphan a live position.
    for (const [id, runner] of this.runners) {
      if (seen.has(id)) continue;
      if (EXPOSED_STATES.has(runner.state)) {
        logger.warn('supervisor: strategy disabled while exposed — keeping it until flat', {
          strategyId: id, state: runner.state,
        });
        continue;
      }
      this.runners.delete(id);
    }
  }

  async kotakSession(userId) {
    const cached = this.sessions.get(userId);
    if (cached && Date.now() - cached.loadedAt < 60000) return cached.session;
    const account = await repo.brokers.get(userId, 'kotak');
    const session = account?.sessionToken
      ? { sessionToken: account.sessionToken, sid: account.sid, baseUrl: account.baseUrl }
      : null;
    this.sessions.set(userId, { session, loadedAt: Date.now() });
    return session;
  }

  // Operator square-off. Goes through the same exit path as an automatic one,
  // so the leg ordering and the accounting are identical.
  async squareOff(strategyId, reason = 'manual') {
    const runner = this.runners.get(Number(strategyId));
    if (!runner) return { ok: false, reason: 'strategy is not running in this engine' };
    await runner.loadFacts(Date.now());
    if (!runner.trade) return { ok: false, reason: 'no open trade' };
    if (runner.trade.sell_price == null) await runner.unwindLoneHedge(reason, Date.now());
    else await runner.exitPosition(reason, Date.now());
    await runner.persist();
    return { ok: true, state: runner.state, decision: runner.lastDecision };
  }

  status() {
    return {
      engineId: config.engine.id,
      running: this.running,
      isLeader: this.isLeader,
      lock: this.lockInfo,
      halted: this.halted,
      tickMs: config.engine.tickMs,
      lastTickAt: this.lastTickAt,
      lastTickDurationMs: this.lastTickMs,
      strategies: [...this.runners.values()].map(r => r.status()),
      feed: feed.status(),
      recentErrors: this.errors,
    };
  }
}

module.exports = { Supervisor, LOCK_NAME };
