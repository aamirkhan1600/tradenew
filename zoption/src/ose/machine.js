// §18 — the State Machine.
//
// ONE explicit transition table, not scattered `if` statements. §18.4 is precise
// about this: the table is the specification, `to()` validates against it, and
// `currentState` is mutated in exactly one place. A state machine whose rules
// live in the branches that use them is a state machine nobody can audit.
//
// ---------------------------------------------------------------------------
// Throwing and ignoring are the same rule at two levels
// ---------------------------------------------------------------------------
//
// §18.4 says `state.to()` throws on an illegal transition. §18.2 says an illegal
// transition is "logged at error, IGNORED, and increments a counter", and three
// in a session halt the engine. Those are not in conflict — they are the
// mechanism and the policy:
//
//     to()       validates and THROWS. The mechanism. Nothing may move the
//                machine off the table.
//     attempt()  applies the policy: catch, log, count, ignore, halt at three.
//
// The engine calls `attempt()` everywhere. `to()` is exported because a caller
// that genuinely cannot continue past a bad transition should be able to say so,
// and because the tests assert the throw directly (§25.2).
//
// ---------------------------------------------------------------------------
// This is the ENGINE's machine, not the trade's
// ---------------------------------------------------------------------------
//
// Unlike src/pfe/machine.js, which sequences one trade, §18's states describe the
// PROCESS: booting, reconciling, scanning, holding, cooling down, halted. The
// position itself is the §6.1 `ActiveTrade` aggregate built by `newTrade()` at
// the bottom of this file, and it is mutated only by the Position Manager, the
// Target Engine and the Trailing Stop (§24.2).

const { IntegrityError } = require('../core/errors');
const C = require('./constants');

const STATES = Object.freeze({
  BOOTING: 'BOOTING',
  RECONCILING: 'RECONCILING',
  IDLE: 'IDLE',
  SCANNING: 'SCANNING',
  ENTRY_READY: 'ENTRY_READY',
  ORDER_PENDING: 'ORDER_PENDING',
  POSITION_OPEN: 'POSITION_OPEN',
  POSITION_MANAGEMENT: 'POSITION_MANAGEMENT',
  EXIT_PENDING: 'EXIT_PENDING',
  COOLDOWN: 'COOLDOWN',
  HALTED: 'HALTED',
});

const EVENTS = Object.freeze({
  READY: 'READY',
  RECONCILE_CLEAN: 'RECONCILE_CLEAN',
  RECONCILE_RESUMED: 'RECONCILE_RESUMED',
  RECONCILE_UNKNOWN: 'RECONCILE_UNKNOWN',
  RECONCILE_FAILED: 'RECONCILE_FAILED',
  SESSION_OPEN: 'SESSION_OPEN',
  SESSION_CLOSED: 'SESSION_CLOSED',
  ENTRY_VALIDATED: 'ENTRY_VALIDATED',
  ENTRY_REJECTED: 'ENTRY_REJECTED',
  ORDER_PLACED: 'ORDER_PLACED',
  ORDER_FILLED: 'ORDER_FILLED',
  ORDER_DEAD: 'ORDER_DEAD',            // rejected / timed out / cancelled
  MANAGE: 'MANAGE',
  EXIT_TRIGGERED: 'EXIT_TRIGGERED',
  EXIT_FILLED: 'EXIT_FILLED',
  EXIT_FAILED_FINAL: 'EXIT_FAILED_FINAL',
  COOLDOWN_ELAPSED: 'COOLDOWN_ELAPSED',
  HALT: 'HALT',
  MANUAL_RESET: 'MANUAL_RESET',
});

// §18.2 verbatim. `from` -> `event` -> `to`.
//
// `HALT` is deliberately absent from every row and handled separately: §18.2's
// last-but-one line is "*any* | halt() | — | HALTED", and writing it into eleven
// rows would invite one of them to be forgotten.
const TABLE = Object.freeze({
  [STATES.BOOTING]: {
    [EVENTS.READY]: STATES.RECONCILING,
  },
  [STATES.RECONCILING]: {
    [EVENTS.RECONCILE_CLEAN]: STATES.IDLE,
    [EVENTS.RECONCILE_RESUMED]: STATES.POSITION_MANAGEMENT,
    [EVENTS.RECONCILE_UNKNOWN]: STATES.HALTED,
    [EVENTS.RECONCILE_FAILED]: STATES.HALTED,
  },
  [STATES.IDLE]: {
    [EVENTS.SESSION_OPEN]: STATES.SCANNING,
  },
  [STATES.SCANNING]: {
    [EVENTS.ENTRY_VALIDATED]: STATES.ENTRY_READY,
    // A rejected entry is a legal, expected, extremely common transition back to
    // where it came from. Listing it means it does not count as illegal, which
    // matters: the engine rejects thousands of candles a session.
    [EVENTS.ENTRY_REJECTED]: STATES.SCANNING,
    [EVENTS.SESSION_CLOSED]: STATES.IDLE,
  },
  [STATES.ENTRY_READY]: {
    [EVENTS.ORDER_PLACED]: STATES.ORDER_PENDING,
    // The order never left — a pre-send rate limit, a refused claim. Nothing is
    // live, so the cooldown is the honest place to go.
    [EVENTS.ORDER_DEAD]: STATES.COOLDOWN,
  },
  [STATES.ORDER_PENDING]: {
    [EVENTS.ORDER_FILLED]: STATES.POSITION_OPEN,
    [EVENTS.ORDER_DEAD]: STATES.COOLDOWN,
  },
  [STATES.POSITION_OPEN]: {
    [EVENTS.MANAGE]: STATES.POSITION_MANAGEMENT,
    // A position can be exited on its very first management cycle — a stop that
    // was already breached when the fill landed, or a priority-0 timer firing
    // between the fill and the next candle.
    [EVENTS.EXIT_TRIGGERED]: STATES.EXIT_PENDING,
  },
  [STATES.POSITION_MANAGEMENT]: {
    [EVENTS.EXIT_TRIGGERED]: STATES.EXIT_PENDING,
  },
  [STATES.EXIT_PENDING]: {
    [EVENTS.EXIT_FILLED]: STATES.COOLDOWN,
    [EVENTS.EXIT_FAILED_FINAL]: STATES.HALTED,
  },
  [STATES.COOLDOWN]: {
    [EVENTS.COOLDOWN_ELAPSED]: STATES.SCANNING,
    [EVENTS.SESSION_CLOSED]: STATES.IDLE,
  },
  [STATES.HALTED]: {
    // §26.6 — there is no API and no automatic path. Only scripts/ose-reset-halt.js
    // followed by a restart.
    [EVENTS.MANUAL_RESET]: STATES.BOOTING,
  },
});

// The guards §18.2 names in its third column. Kept as data beside the table so
// "what has to be true for this transition" is answered in one place rather than
// inside whichever branch happened to call it.
const GUARDS = Object.freeze({
  [EVENTS.SESSION_OPEN]: (ctx) => (ctx.halted ? 'the engine is halted' : null),
  [EVENTS.COOLDOWN_ELAPSED]: (ctx) => {
    if (ctx.halted) return 'the engine is halted';
    if (ctx.sessionOpen === false) return 'the session is closed';
    return null;
  },
  [EVENTS.ENTRY_VALIDATED]: (ctx) =>
    (ctx.riskAllows === false ? (ctx.riskReason || 'the risk engine refused') : null),
  [EVENTS.RECONCILE_RESUMED]: (ctx) =>
    (ctx.positionMatches === false ? 'the broker position does not match the persisted trade' : null),
});

function nextState(from, event) {
  return TABLE[from]?.[event] ?? null;
}

class StateMachine {
  // `onTransition` receives the §18.3 log record. `onIllegal` receives the same
  // shape with `illegal: true`. Both are injected rather than imported so this
  // file stays free of I/O and the tests can assert on the records directly.
  constructor({ onTransition = null, onIllegal = null, initial = STATES.BOOTING } = {}) {
    this.current = initial;
    this.onTransition = onTransition;
    this.onIllegal = onIllegal;
    this.illegalCount = 0;
    this.history = [];
  }

  is(...states) { return states.includes(this.current); }

  // True while a position may exist. Used by the safety timer, which must know
  // whether there is anything to protect without reaching into the trade object.
  holdsPosition() {
    return this.is(STATES.POSITION_OPEN, STATES.POSITION_MANAGEMENT, STATES.EXIT_PENDING);
  }

  // §18.4 — the mechanism. Validates against the table and throws.
  //
  // `HALT` is legal from anywhere, which is the one rule not in the table.
  // Halting from HALTED is a no-op rather than an error: a halt that races
  // another halt is two things going wrong at once, and the second one must not
  // become a third.
  to(event, ctx = {}) {
    const from = this.current;

    if (event === EVENTS.HALT) {
      if (from === STATES.HALTED) return { from, to: from, changed: false };
      return this._commit(from, STATES.HALTED, event, ctx);
    }

    const to = nextState(from, event);
    if (!to) {
      throw new IntegrityError(`ILLEGAL_TRANSITION: ${event} is not legal from ${from}`,
        { from, event });
    }

    const guard = GUARDS[event];
    const refused = guard ? guard(ctx) : null;
    if (refused) {
      throw new IntegrityError(`GUARD_REFUSED: ${event} from ${from} — ${refused}`,
        { from, event, guard: refused });
    }

    return this._commit(from, to, event, ctx);
  }

  // §18.2 — the policy. Log at error, ignore, count; three in a session halts.
  //
  // Returns `{ ok, from, to, changed, error }` and never throws, so a decision
  // cycle cannot be taken down by a transition that was merely unexpected. A
  // GUARD_REFUSED is NOT counted as illegal: a guard refusing is the table
  // working, not the machine being wrong about itself.
  attempt(event, ctx = {}) {
    try {
      const moved = this.to(event, ctx);
      return { ok: true, error: null, ...moved };
    } catch (err) {
      const guarded = /^GUARD_REFUSED/.test(err.message);
      if (!guarded) {
        this.illegalCount += 1;
        if (this.onIllegal) {
          this.onIllegal({
            evt: 'ILLEGAL_TRANSITION',
            from: this.current,
            trigger: event,
            reason: err.message,
            count: this.illegalCount,
            ts: ctx.ts ?? null,
          });
        }
        if (this.illegalCount >= C.ILLEGAL_TRANSITION_LIMIT) {
          this._commit(this.current, STATES.HALTED, EVENTS.HALT,
            { ...ctx, reason: 'REPEATED_ILLEGAL_TRANSITIONS' });
        }
      }
      return {
        ok: false, from: this.current, to: this.current, changed: false,
        guarded, error: err.message,
      };
    }
  }

  // The ONLY place `current` is assigned. §18.4.
  _commit(from, to, trigger, ctx) {
    this.current = to;
    const record = {
      evt: 'STATE_TRANSITION',
      cycleId: ctx.cycleId ?? null,
      tradeId: ctx.tradeId ?? null,
      from,
      to,
      trigger,
      guardResults: ctx.guardResults ?? null,
      reason: ctx.reason ?? null,
      ts: ctx.ts ?? null,
      latencyMs: ctx.latencyMs ?? null,
    };
    this.history.push(record);
    if (this.history.length > 200) this.history.shift();
    if (this.onTransition) this.onTransition(record);
    return { from, to, changed: from !== to };
  }
}

/* ------------------------------------------------- §6.1, the ActiveTrade ---- */

// The only mutable aggregate in the engine (§24.2). Everything else is
// recomputed each cycle (§3.6).
//
// Readonly-by-convention fields are set once at construction; the four mutable
// ones (`targetLevel`, `targetPriceP`, `stopPriceP`, `candlesHeld`, `mfePoints`)
// are named in §6.1 and are touched only by the Position Manager, the Target
// Engine and the Trailing Stop.
function newTrade(overrides = {}) {
  return {
    tradeId: null,
    dbId: null,
    symbol: null,
    token: null,
    segment: 'nse_fo',
    optionType: null,
    strike: null,
    expiry: null,
    lotSize: null,
    tickP: C.TICK,
    side: 'SELL',
    qty: 0,

    requestedPriceP: null,
    // Always the actual fill VWAP, never the requested price (§12.4). Every
    // target and stop derives from it; `requestedPriceP` is kept for slippage
    // analysis alone.
    entryPriceP: null,
    entryTs: null,
    entryCandleTs: null,
    entryCandleId: null,
    entryTrend: null,

    targetLevel: 0,
    targetPriceP: null,
    stopPriceP: null,
    candlesHeld: 0,
    mfePoints: 0,

    filledQty: 0,
    entryOrderId: null,
    exitOrderId: null,
    exitAttempts: 0,
    exitReason: null,

    selectScore: null,
    selectDetail: null,

    ...overrides,
  };
}

module.exports = { STATES, EVENTS, TABLE, GUARDS, nextState, StateMachine, newTrade };
