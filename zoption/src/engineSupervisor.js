// Runs the Option Selling Engine as a child of the web process, so `npm start`
// brings up both.
//
// ---------------------------------------------------------------------------
// The coupling this introduces, stated plainly
// ---------------------------------------------------------------------------
//
// The two tiers were separate on purpose: the web console is restarted casually
// — a settings tweak, a template edit, nodemon noticing a save — and a trading
// engine is not. Making the engine a child means every one of those restarts
// now bounces a process that may be holding a naked short.
//
// That is survivable, and only because of two rules that already existed:
//
//   * SHUTDOWN DOES NOT FLATTEN. `oseEngine.js` deliberately leaves an open
//     position alone on SIGTERM — squaring off on a routine deploy would turn a
//     restart into a market order at whatever the spread happens to be.
//   * BOOT ADOPTS. §20.6 reconciliation finds the open trade in `ose_trades`,
//     matches it against the broker, and resumes POSITION_MANAGEMENT.
//
// So a bounce costs the engine its in-memory candle history — it warms up again
// over the next fifteen seconds — and nothing else. What it must never do is
// leave a position with nobody managing it, which is why the restart logic below
// is insistent rather than polite.
//
// Set OSE_AUTOSTART=false to go back to running `npm run ose` yourself.

const path = require('path');
const { spawn } = require('child_process');
const logger = require('./core/logger');
const config = require('./config');

const SCRIPT = path.join(__dirname, 'oseEngine.js');

// A crash-looping trading engine must stay down (§26.2's StartLimitBurst). Three
// failures inside this window and the supervisor stops trying and says so —
// restarting for ever would bury the reason in a scrolling log.
const WINDOW_MS = 60_000;
const MAX_RESTARTS = 3;
const BACKOFF_MS = 5_000;

// A lock collision is not a crash — the previous engine's row simply has not
// gone stale yet. Wait past ENGINE_LOCK_TTL_MS (30s by default) rather than
// hammering, and bound it so a genuinely competing process is still reported
// rather than retried for ever.
const LOCK_RETRY_MS = Math.max(35_000, (config.engine.lockTtlMs || 30_000) + 5_000);
const MAX_LOCK_WAITS = 3;

class EngineSupervisor {
  constructor() {
    this.child = null;
    this.stopping = false;
    this.failures = [];
    this.startedAt = null;
    this.givenUp = false;
    this.lockWaits = 0;
  }

  start() {
    if (!config.ose.autostart) {
      logger.info('app: OSE_AUTOSTART is off — run `npm run ose` separately');
      return this;
    }
    this._spawn();
    return this;
  }

  _spawn() {
    if (this.stopping || this.givenUp) return;

    // `stdio: inherit` rather than piping: the engine already writes structured
    // lines through the shared logger, and re-wrapping them here would give
    // every engine line two timestamps and two levels.
    this.child = spawn(process.execPath, [SCRIPT], {
      cwd: path.join(__dirname, '..'),
      env: process.env,
      // The fourth channel is an IPC pipe, and it is the ONLY reliable way to
      // make the child die with the parent on Windows.
      //
      // `detached: false` is not enough: Windows has no process groups in the
      // POSIX sense, and `process.on('SIGTERM')` is emulated — a hard terminate
      // of the console never runs our handler, and the engine is left running
      // with nobody to stop it. An orphan keeps the `zoption-engine` leader lock
      // and silently blocks every future start, which presents as the lock being
      // broken rather than as a stray process. (This is not hypothetical: an
      // orphan from a killed `npm run ose` did exactly that during testing.)
      //
      // The OS closes this pipe when the parent goes, however it goes, so the
      // child gets `disconnect` and exits itself. See src/oseEngine.js.
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      detached: false,
      windowsHide: true,
    });
    this.startedAt = Date.now();

    logger.info('app: started the Option Selling Engine', { pid: this.child.pid });

    this.child.on('exit', (code, signal) => this._onExit(code, signal));
    this.child.on('error', (err) => {
      logger.error('app: the engine could not be spawned', { err: err.message });
    });
  }

  _onExit(code, signal) {
    this.child = null;
    if (this.stopping) return;

    // Exit code 1 on a fast exit is usually the leader lock: another trading
    // process already holds it. That is correct behaviour rather than a crash,
    // so it gets its own slower retry instead of the crash backoff.
    //
    // It must NOT give up on the first collision. Now that the console starts
    // the engine, restarting the console within the lock's TTL is an ordinary
    // thing to do — the previous engine's row is still warm for up to
    // ENGINE_LOCK_TTL_MS. Giving up there would mean a console restart silently
    // leaves you with no engine, and the only clue is one warn line scrolled off
    // the top. So: wait out the TTL and try again, a bounded number of times.
    const ranFor = Date.now() - this.startedAt;
    if (code === 1 && ranFor < 10_000) {
      this.lockWaits += 1;
      if (this.lockWaits > MAX_LOCK_WAITS) {
        logger.error('app: the engine still cannot take the `zoption-engine` lock after '
          + `${MAX_LOCK_WAITS} attempts — another trading process (npm run engine / npm run pfe) `
          + 'is holding it. Stop that one, then restart this console.', { code });
        this.givenUp = true;
        return;
      }
      logger.warn('app: the engine could not take the leader lock — retrying once it goes stale', {
        attempt: this.lockWaits, inMs: LOCK_RETRY_MS,
      });
      setTimeout(() => this._spawn(), LOCK_RETRY_MS).unref?.();
      return;
    }
    // A start that got past the lock resets the counter, so a collision today
    // does not consume an attempt tomorrow.
    this.lockWaits = 0;

    this.failures.push(Date.now());
    this.failures = this.failures.filter(t => Date.now() - t < WINDOW_MS);

    if (this.failures.length >= MAX_RESTARTS) {
      logger.error(`app: THE ENGINE HAS EXITED ${this.failures.length} TIMES IN A MINUTE — `
        + 'not restarting it again. If a position was open it is now unmanaged: check the Kotak '
        + 'terminal, then fix the cause and restart.', { code, signal });
      this.givenUp = true;
      return;
    }

    logger.warn('app: the engine exited — restarting', {
      code, signal, attempt: this.failures.length, inMs: BACKOFF_MS,
    });
    setTimeout(() => this._spawn(), BACKOFF_MS).unref?.();
  }

  // SIGTERM, not SIGKILL: the engine's own handler releases the leader lock and
  // closes the database pool. Killing it outright leaves the lock held until its
  // TTL expires, and the next start refuses for thirty seconds for no reason.
  stop() {
    this.stopping = true;
    if (!this.child) return;
    logger.info('app: stopping the Option Selling Engine', { pid: this.child.pid });
    try { this.child.kill('SIGTERM'); } catch (_) { /* already gone */ }
  }

  status() {
    return {
      autostart: config.ose.autostart,
      running: Boolean(this.child),
      pid: this.child?.pid ?? null,
      givenUp: this.givenUp,
      failures: this.failures.length,
      lockWaits: this.lockWaits,
    };
  }
}

module.exports = { EngineSupervisor };
