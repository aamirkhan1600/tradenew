// The leg state machine. A PURE function: (leg, event, cfg) -> {state, patch, actions}.
//
// No I/O, no network, no clock — time and prices arrive as events. That is what
// makes the strategy testable without a broker, and it is the difference between
// a suite that runs in 200ms and one that needs a live market.
//
// ---------------------------------------------------------------------------
// The rule this file exists to enforce
// ---------------------------------------------------------------------------
//
//   calculateSellPrice(candle, offsetPaise)
//
// takes a CANDLE and an OFFSET. There is no third parameter, and no quote,
// tick, ask, bid or LTP is reachable from it. Every source document forbids
// pricing the entry from live data; making that structurally impossible is
// stronger than remembering not to, and `test/invariants.test.js` asserts it.
//
// The premium gate — "is this contract sane to trade right now" — DOES look at
// the live price, but the verdict arrives here as a boolean on the event. The
// machine never sees the number. Gate and price are separate concerns and the
// type system keeps them separate.
//
// The index trend filter (doc/update-point.md) works the same way: NIFTY's own
// 15-second bars decide WHETHER a side may sell, and arrive here as `trendOk`.
// They never contribute a price — "never use the NIFTY candle to calculate the
// sell price, only to decide whether a trade is allowed".
//
// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------
//
//   IDLE            nothing armed
//   WAIT_CANDLE     armed, waiting for a tradable closed candle  (also re-armed
//                   here from DONE under cycleScope PER_LEG)
//   SELL_WORKING    a SELL LIMIT is live at the broker
//   SELL_CANCELLING cancel sent, awaiting confirmation
//   POSITION_OPEN   short filled, target resting at the broker
//   TARGET_MOVING   target cancelled (or cancelling) to be REPLACED, not exited
//   EXITING         target cancelled (or cancelling), market exit in flight
//   DONE            flat for this cycle
//
// The one-way door is POSITION_OPEN -> EXITING: the target order MUST be
// cancelled and the cancel confirmed before any exit market order is sent.
// A resting target plus an engine-fired stop is a double-exit race, and it is
// the most dangerous path in the system.
//
// TARGET_MOVING goes through the SAME door for the same reason. Moving a target
// is a cancel followed by a place, and between the two the position is
// unprotected by anything except the engine-held stop — so every exit trigger
// (stop, timeout, square-off, reversal) is still live in that state, but records
// itself as `pendingExit` instead of sending an order. When the cancel confirms,
// a pending exit outranks the replacement target: the leg exits and no new
// target is placed. Sending both is exactly the naked long this design exists to
// prevent.

const STATES = {
  IDLE: 'IDLE',
  WAIT_CANDLE: 'WAIT_CANDLE',
  SELL_WORKING: 'SELL_WORKING',
  SELL_CANCELLING: 'SELL_CANCELLING',
  POSITION_OPEN: 'POSITION_OPEN',
  // The resting target is being moved: a cancel is out, a replacement is not yet
  // sent. It is a distinct state from EXITING because the same confirmed-cancel
  // door leads to two different places, and conflating them is how a position
  // ends up with two live exits.
  TARGET_MOVING: 'TARGET_MOVING',
  EXITING: 'EXITING',
  DONE: 'DONE',
};

const EXIT_REASONS = {
  TARGET: 'TARGET',
  STOPLOSS: 'STOPLOSS',
  TIMEOUT: 'TIMEOUT',
  SQUAREOFF: 'SQUAREOFF',
  HALT: 'HALT',
  // The index trend that justified the entry turned. Not a stop-loss — it can
  // (and usually should) fire in profit.
  REVERSAL: 'REVERSAL',
  // Not an exit — the leg never opened. It waited for permission it never got
  // and stood down so the cycle could release the strike. See ENTRY_TIMEOUT.
  NO_ENTRY: 'NO_ENTRY',
};

/* --------------------------------------------------------------- pricing -- */

// THE entry price. A candle and an offset. Nothing else.
function calculateSellPrice(candle, sellOffsetPaise) {
  if (!candle || !Number.isFinite(candle.closeP)) {
    throw new Error('calculateSellPrice needs a closed candle');
  }
  return candle.closeP + Math.round(sellOffsetPaise);
}

// The buy-back target, from the price actually FILLED at — not the price asked
// for. A limit that filled at a better price should keep that improvement, and
// one that filled worse should not have its target quietly moved.
function calculateTargetPrice(filledPriceP, targetPaise) {
  return Math.max(5, filledPriceP - Math.round(targetPaise));
}

function calculateStopPrice(filledPriceP, stopLossPaise) {
  return filledPriceP + Math.round(stopLossPaise);
}

// The dynamic target ladder — doc/traling-traget -stoploss.md.
//
// Every time the index trend confirms again, the buy-back is pushed one step
// further into profit instead of the position being closed at one point. Past
// `maxSteps` there is no resting target at all: the position runs on the
// trailing stop until the trend turns, which is what "5th+ — trail until
// reversal" means mechanically.
//
// Priced off the FILL, never off the live premium. Same reasoning as the entry:
// a level that can be recomputed from the audit log months later beats one that
// depended on a tick nobody recorded.
//
// Returns null when the leg should hold no target.
function calculateLadderTarget(filledPriceP, confirmations, stepPaise, maxSteps) {
  const n = Math.max(1, Math.trunc(confirmations || 1));
  if (n > Math.trunc(maxSteps)) return null;                 // trail-only
  return Math.max(5, filledPriceP - n * Math.round(stepPaise));
}

// The trailing stop. The position is SHORT, so "better" means LOWER: the stop
// only ever comes down, and `bestPaise` is the cheapest the premium has been.
//
//   stop = best + trailGap
//
// which is the document's own arithmetic (best 18.80 → stop 19.30, best 18.00 →
// stop 18.50) and lands inside its "protect 50–70% of the unrealized" rule.
//
// Two guards. The trail does not engage until the position is `trailStart` in
// profit — without that, the first tick would clamp the stop to a hair above the
// entry and any noise would take the trade out. And it NEVER moves away from
// profit: a stop that can widen is not a stop.
//
// Returns the new stop, or null when nothing should move.
function calculateTrailStop({ filledPriceP, bestPaise, currentSlP, trailStartPaise, trailGapPaise }) {
  if (!trailGapPaise) return null;                            // trailing disabled
  if (!Number.isFinite(bestPaise) || !Number.isFinite(currentSlP)) return null;

  const profit = filledPriceP - bestPaise;
  if (profit < Math.round(trailStartPaise)) return null;      // not far enough yet

  const candidate = bestPaise + Math.round(trailGapPaise);
  if (candidate >= currentSlP) return null;                   // would widen — refuse
  return Math.max(5, candidate);
}

/* --------------------------------------------------------------- helpers -- */

const noop = (leg) => ({ state: leg.state, patch: {}, actions: [] });

const log = (kind, detail) => ({ type: 'LOG', kind, ...detail });

/* ---------------------------------------------------------------- reduce -- */

// `leg`   — { state, sellPriceP, filledPriceP, targetPriceP, slPriceP, qty,
//             sellOrderId, targetOrderId, exitOrderId, sellPlacedAt, openedAt,
//             attemptSeq, waitingSince }
// `event` — { type, ... }
// `cfg`   — { sellOffsetP, targetP, stopLossP, pendingTimeoutMs,
//             positionTimeoutMs, legEntryTimeoutMs, tickP }
function reduce(leg, event, cfg) {
  switch (event.type) {
    /* ---------------------------------------------------------------- arm */
    case 'ARM':
      if (leg.state !== STATES.IDLE) return noop(leg);
      return {
        state: STATES.WAIT_CANDLE,
        // The clock the entry timeout runs against. It is stamped on every
        // transition INTO waiting and deliberately NOT touched by a gate
        // rejection — a leg the trend filter refuses must keep ageing, or it
        // resets its own deadline forever and the deadlock stands.
        patch: { waitingSince: event.tsMs },
        actions: [log('ARMED', { note: 'waiting for a tradable closed candle' })],
      };

    case 'REARM': {
      // `cycleScope: PER_LEG` (R6). A leg that has finished a round trip goes
      // back to waiting on the SAME locked strike instead of sitting in DONE
      // until its partner is finished too.
      //
      // The engine decides WHETHER to send this — it consults the risk gate and
      // the cycle's age first, neither of which belongs in a pure function. All
      // this does is clear the round trip that just ended.
      if (leg.state !== STATES.DONE) return noop(leg);
      if (leg.filledPriceP != null && leg.closedAt == null) return noop(leg);
      return {
        state: STATES.WAIT_CANDLE,
        patch: {
          sellPriceP: null, filledPriceP: null, targetPriceP: null, slPriceP: null,
          filledQty: 0, entryCandleId: null, openedAt: null, closedAt: null,
          exitReason: null, sellPlacedAt: null,
          sellOrderId: null, targetOrderId: null, exitOrderId: null,
          confirmations: 0, trailPeakP: null, trailingOnly: false,
          pendingExit: null, pendingTargetP: null, haltAfterCancel: false,
          waitingSince: event.tsMs,
          // attemptSeq is NOT reset. It is part of the order idempotency key,
          // so restarting it would make the next entry collide with the one
          // this leg just finished — the same class of bug the target ladder's
          // revision exists to prevent.
        },
        actions: [log('REARMED', {
          note: event.why || 'per-leg cycle scope — waiting for the next candle',
          attemptSeq: leg.attemptSeq || 0,
        })],
      };
    }

    /* --------------------------------------------------------- entry timeout */
    case 'ENTRY_TIMEOUT': {
      // A leg that has been waiting this long has not been refused by the
      // broker — it has been refused permission, by the premium gate or the
      // index trend filter, over and over. It is flat, it holds no order, and
      // it is holding the strike lock hostage: with `tradeMode: BOTH` and a
      // one-sided trend filter the other leg can finish and the cycle can never
      // close, so the engine sits on an ageing strike until the square-off.
      //
      // Standing the leg down releases the lock. A fresh cycle then selects a
      // strike against the spot as it is now, which is what was wanted anyway.
      if (leg.state !== STATES.WAIT_CANDLE) return noop(leg);
      if (!cfg.legEntryTimeoutMs) return noop(leg);             // 0 disables
      const waited = event.tsMs - (leg.waitingSince || 0);
      if (waited < cfg.legEntryTimeoutMs) return noop(leg);
      return {
        state: STATES.DONE,
        patch: { closedAt: event.tsMs, exitReason: EXIT_REASONS.NO_ENTRY },
        actions: [log('NO_ENTRY', {
          reason: event.reason || 'never got permission to enter',
          waitedMs: waited,
        })],
      };
    }

    /* --------------------------------------------------------- candle close */
    case 'CANDLE_CLOSED': {
      if (leg.state !== STATES.WAIT_CANDLE) return noop(leg);

      const { candle } = event;

      // A synthetic bar has no ticks at all; a low-confidence one has too few
      // for its close to describe the end of the bucket. Offsetting from either
      // is fiction, so the leg waits for the next bar rather than guessing.
      if (!candle || !candle.tradable) {
        return {
          state: STATES.WAIT_CANDLE,
          patch: {},
          actions: [log('CANDLE_SKIPPED', {
            reason: candle?.synthetic ? 'synthetic bar (no ticks)' : 'low-confidence bar',
            tickCount: candle?.tickCount ?? 0,
          })],
        };
      }

      // The gate verdict was computed outside and arrives as a boolean. The
      // machine is not told the live price and cannot use one.
      if (event.gateOk === false) {
        return {
          state: STATES.WAIT_CANDLE,
          patch: {},
          actions: [log('PREMIUM_GATE_REJECT', { reason: event.gateReason || 'gate refused' })],
        };
      }

      // The NIFTY micro-trend filter — doc/update-point.md. Same discipline as
      // the premium gate: the index bars are classified outside and the answer
      // arrives as a boolean, so no index price can reach the entry
      // calculation. `undefined` means the filter is off and the leg proceeds.
      if (event.trendOk === false) {
        return {
          state: STATES.WAIT_CANDLE,
          patch: {},
          actions: [log('TREND_GATE_REJECT', {
            reason: event.trendReason || 'the index trend filter refused',
            trendState: event.trendState || null,
          })],
        };
      }

      const raw = calculateSellPrice(candle, cfg.sellOffsetP);
      return {
        state: STATES.SELL_WORKING,
        patch: {
          sellPriceP: raw,
          entryCandleId: candle.id ?? null,
          sellPlacedAt: event.tsMs,
          attemptSeq: (leg.attemptSeq || 0) + 1,
        },
        actions: [
          { type: 'PLACE_SELL', pricePaise: raw, candle, attemptSeq: (leg.attemptSeq || 0) + 1 },
          log('SELL_PRICED', {
            closeP: candle.closeP, offsetP: cfg.sellOffsetP, sellP: raw,
            bucket: candle.bucketStart,
          }),
        ],
      };
    }

    /* ------------------------------------------------------- sell lifecycle */
    case 'SELL_PLACED':
      if (leg.state !== STATES.SELL_WORKING) return noop(leg);
      return { state: leg.state, patch: { sellOrderId: event.orderId }, actions: [] };

    case 'SELL_REJECTED':
      // The broker said no. Back to waiting — the next candle produces a fresh
      // price rather than a retry of the one just refused.
      if (leg.state !== STATES.SELL_WORKING) return noop(leg);
      return {
        state: STATES.WAIT_CANDLE,
        // A rejection is a real attempt, so the entry-timeout clock restarts.
        // Only a leg that never gets as far as an order keeps ageing.
        patch: {
          sellOrderId: null, sellPriceP: null, sellPlacedAt: null,
          waitingSince: event.tsMs,
        },
        actions: [log('SELL_REJECTED', { reason: event.reason })],
      };

    case 'PENDING_TIMEOUT': {
      // Unfilled past pendingTimeout. Cancel — and then WAIT FOR THE NEXT
      // CANDLE. Not an immediate requote: v3.0 supersedes the v2.0 SDD here,
      // and the idle gap between the cancel and the next close is exactly what
      // "never chase the market" means mechanically.
      if (leg.state !== STATES.SELL_WORKING) return noop(leg);
      if (event.tsMs - (leg.sellPlacedAt || 0) < cfg.pendingTimeoutMs) return noop(leg);
      return {
        state: STATES.SELL_CANCELLING,
        patch: {},
        actions: [
          { type: 'CANCEL_SELL', orderId: leg.sellOrderId },
          log('SELL_TIMEOUT', { heldMs: event.tsMs - (leg.sellPlacedAt || 0) }),
        ],
      };
    }

    case 'SELL_CANCELLED':
      if (leg.state !== STATES.SELL_CANCELLING && leg.state !== STATES.SELL_WORKING) return noop(leg);
      return {
        state: STATES.WAIT_CANDLE,
        // A requote is a leg that is working, not a leg that is stuck — the
        // entry-timeout clock restarts with it.
        patch: {
          sellOrderId: null, sellPriceP: null, sellPlacedAt: null,
          waitingSince: event.tsMs,
        },
        actions: [log('REQUOTE_ARMED', { note: 'waiting for the next candle close' })],
      };

    case 'SELL_FILLED': {
      // A fill can land while the cancel is in flight — the cancel lost the
      // race. That is a filled short, not an error, and it is handled from both
      // states for exactly that reason.
      if (leg.state !== STATES.SELL_WORKING && leg.state !== STATES.SELL_CANCELLING) return noop(leg);

      const filledP = event.filledPriceP;
      const targetP = calculateTargetPrice(filledP, cfg.targetP);
      const slP = calculateStopPrice(filledP, cfg.stopLossP);
      return {
        state: STATES.POSITION_OPEN,
        patch: {
          filledPriceP: filledP,
          filledQty: event.filledQty,
          targetPriceP: targetP,
          slPriceP: slP,
          openedAt: event.tsMs,
          sellOrderId: null,
          // Dynamic-target and trailing bookkeeping. The best price starts at
          // the fill, so an immediate adverse tick cannot make the trail think
          // it is in profit.
          confirmations: 0,
          trailPeakP: filledP,
          trailingOnly: false,
          pendingExit: null,
        },
        actions: [
          { type: 'PLACE_TARGET', pricePaise: targetP, qty: event.filledQty },
          log('POSITION_OPEN', { filledP, targetP, slP, qty: event.filledQty }),
        ],
      };
    }

    /* ---------------------------------------------------- position lifetime */
    case 'TARGET_FILLED':
      // The clean exit. Reachable from POSITION_OPEN, from EXITING and from
      // TARGET_MOVING — in the latter two it means the target won the cancel
      // race, which is a flat position, not a problem.
      if (leg.state !== STATES.POSITION_OPEN && leg.state !== STATES.EXITING
        && leg.state !== STATES.TARGET_MOVING) return noop(leg);
      return {
        state: STATES.DONE,
        patch: {
          targetOrderId: null, pendingTargetP: null, pendingExit: null,
          closedAt: event.tsMs, exitReason: EXIT_REASONS.TARGET,
        },
        actions: [
          { type: 'CLOSE_LEG', reason: EXIT_REASONS.TARGET, exitPriceP: event.filledPriceP },
          log(leg.state === STATES.POSITION_OPEN ? 'TARGET_HIT' : 'TARGET_WON_RACE',
            { exitP: event.filledPriceP }),
        ],
      };

    case 'TARGET_PLACED':
      if (leg.state !== STATES.POSITION_OPEN) return noop(leg);
      return { state: leg.state, patch: { targetOrderId: event.orderId }, actions: [] };

    case 'TICK': {
      // The stop is tick-driven, unlike the entry. The candle-only rule governs
      // the ENTRY price; a stop that waited for a bar to close would be a
      // one-minute-wide hole in the only thing capping the loss.
      //
      // Handled in TARGET_MOVING too: a stop must not be deaf for the second or
      // two a target replacement is in flight.
      if (leg.state !== STATES.POSITION_OPEN && leg.state !== STATES.TARGET_MOVING) return noop(leg);
      if (!Number.isFinite(leg.slPriceP)) return noop(leg);

      const patch = {};
      const actions = [];

      // Track the cheapest the premium has been, then trail the stop up behind
      // it. Both are pure arithmetic on numbers already in the leg.
      const previousBest = Number.isFinite(leg.trailPeakP) ? leg.trailPeakP : leg.filledPriceP;
      const best = Math.min(previousBest, event.ltpPaise);
      if (best !== previousBest) patch.trailPeakP = best;

      const trailed = calculateTrailStop({
        filledPriceP: leg.filledPriceP,
        bestPaise: best,
        currentSlP: leg.slPriceP,
        trailStartPaise: cfg.trailStartP || 0,
        trailGapPaise: cfg.trailGapP || 0,
      });
      if (trailed != null) {
        patch.slPriceP = trailed;
        actions.push(log('TRAIL_STOP', {
          from: leg.slPriceP, to: trailed, bestP: best, entryP: leg.filledPriceP,
          lockedP: leg.filledPriceP - trailed,
        }));
      }

      const stop = patch.slPriceP ?? leg.slPriceP;
      if (event.ltpPaise < stop) return { state: leg.state, patch, actions };

      // The stop is hit. From TARGET_MOVING the cancel is ALREADY in flight, so
      // the exit is recorded as pending and sent the moment that cancel
      // confirms — sending one now would race the replacement.
      if (leg.state === STATES.TARGET_MOVING) {
        return {
          state: STATES.TARGET_MOVING,
          patch: { ...patch, pendingExit: EXIT_REASONS.STOPLOSS },
          actions: [...actions, log('SL_HIT', {
            ltp: event.ltpPaise, slP: stop, entryP: leg.filledPriceP,
            note: 'a target move was in flight — exiting once the cancel confirms',
          })],
        };
      }

      return {
        state: STATES.EXITING,
        patch: { ...patch, exitReason: EXIT_REASONS.STOPLOSS },
        actions: [
          // Cancel FIRST. The exit market order is only sent once this cancel
          // is confirmed — see TARGET_CANCELLED below.
          { type: 'CANCEL_TARGET', orderId: leg.targetOrderId, reason: EXIT_REASONS.STOPLOSS },
          ...actions,
          log('SL_HIT', { ltp: event.ltpPaise, slP: stop, entryP: leg.filledPriceP }),
        ],
      };
    }

    /* ------------------------------------------- the dynamic target ladder */

    case 'TREND_CONFIRMED': {
      // The index still points the way it did at entry. Push the target one
      // step further out rather than banking one point.
      if (leg.state !== STATES.POSITION_OPEN) return noop(leg);
      if (!cfg.dynamicTarget) return noop(leg);

      const n = (leg.confirmations || 0) + 1;
      const next = calculateLadderTarget(leg.filledPriceP, n, cfg.dynamicStepP, cfg.dynamicMax);

      // Past the ladder: the resting target comes off entirely and the position
      // runs on the trailing stop until the trend turns.
      if (next == null) {
        if (leg.trailingOnly) return { state: leg.state, patch: { confirmations: n }, actions: [] };
        return {
          state: STATES.TARGET_MOVING,
          patch: { confirmations: n, trailingOnly: true },
          actions: [
            { type: 'CANCEL_TARGET', orderId: leg.targetOrderId, reason: 'TRAIL_ONLY' },
            log('TRAIL_ONLY', { confirmations: n, note: 'target withdrawn; trailing until reversal' }),
          ],
        };
      }

      // The ladder only ever moves the target DEEPER into profit. Confirmation 1
      // usually lands exactly on the resting target — the initial `target` is
      // already one step — and a configuration where `target` is wider than
      // `dynamicTargetStep` would otherwise walk the target BACKWARDS, turning a
      // trend that is going your way into a smaller win. Refuse both.
      if (leg.targetPriceP != null && next >= leg.targetPriceP) {
        return { state: leg.state, patch: { confirmations: n }, actions: [] };
      }

      return {
        state: STATES.TARGET_MOVING,
        patch: { confirmations: n, pendingTargetP: next },
        actions: [
          // Same door as an exit: nothing is placed until the cancel confirms.
          { type: 'CANCEL_TARGET', orderId: leg.targetOrderId, reason: 'RETARGET' },
          log('TARGET_LADDER', { confirmations: n, from: leg.targetPriceP, to: next }),
        ],
      };
    }

    case 'TREND_REVERSED': {
      // A WORKING sell is cancelled whenever the trend turns, independently of
      // `exitOnReversal` — that setting governs open positions, and this is
      // about not opening one at all.
      //
      // This matters more than it looks. The entry is a LIMIT ABOVE the market,
      // so a PE sell fills when PE premium RISES — which is when NIFTY FALLS.
      // The filter permits PE selling in an uptrend and the resting order then
      // fills on the downturn: the fill is selected for the moment the reason
      // to be there has gone. Gating only at placement leaves that wide open.
      if (leg.state === STATES.SELL_WORKING) {
        return {
          state: STATES.SELL_CANCELLING,
          // NOT haltAfterCancel: the leg goes back to waiting and may enter
          // again when the trend returns. This is a withdrawn quote, not a stop.
          patch: {},
          actions: [
            { type: 'CANCEL_SELL', orderId: leg.sellOrderId },
            log('TREND_REVERSAL', {
              reason: event.reason,
              note: 'cancelling a working sell — the trend that justified it has turned',
            }),
          ],
        };
      }

      // "Exit immediately if the last three 5s candles change direction." It is
      // not a stop-loss — this usually fires in profit, and it is the exit the
      // trail-only mode depends on.
      if (!cfg.exitOnReversal) return noop(leg);
      if (leg.state === STATES.TARGET_MOVING) {
        return {
          state: STATES.TARGET_MOVING,
          patch: { pendingExit: EXIT_REASONS.REVERSAL },
          actions: [log('TREND_REVERSAL', {
            reason: event.reason, note: 'exiting once the target cancel confirms',
          })],
        };
      }
      if (leg.state !== STATES.POSITION_OPEN) return noop(leg);
      return {
        state: STATES.EXITING,
        patch: { exitReason: EXIT_REASONS.REVERSAL },
        actions: [
          { type: 'CANCEL_TARGET', orderId: leg.targetOrderId, reason: EXIT_REASONS.REVERSAL },
          log('TREND_REVERSAL', { reason: event.reason, confirmations: leg.confirmations || 0 }),
        ],
      };
    }

    case 'POSITION_TIMEOUT': {
      if (leg.state !== STATES.POSITION_OPEN && leg.state !== STATES.TARGET_MOVING) return noop(leg);
      if (event.tsMs - (leg.openedAt || 0) < cfg.positionTimeoutMs) return noop(leg);
      // The maximum hold outranks the ladder: a trailing winner is still a naked
      // short, and an uncapped holding time is a different risk profile than the
      // one the rest of the engine was built for.
      if (leg.state === STATES.TARGET_MOVING) {
        return {
          state: STATES.TARGET_MOVING,
          patch: { pendingExit: EXIT_REASONS.TIMEOUT },
          actions: [log('POSITION_TIMEOUT', {
            heldMs: event.tsMs - (leg.openedAt || 0),
            note: 'a target move was in flight — exiting once the cancel confirms',
          })],
        };
      }
      return {
        state: STATES.EXITING,
        patch: { exitReason: EXIT_REASONS.TIMEOUT },
        actions: [
          { type: 'CANCEL_TARGET', orderId: leg.targetOrderId, reason: EXIT_REASONS.TIMEOUT },
          log('POSITION_TIMEOUT', { heldMs: event.tsMs - (leg.openedAt || 0) }),
        ],
      };
    }

    case 'SQUARE_OFF': {
      // The end-of-day flatten. From POSITION_OPEN it goes through the same
      // cancel-then-exit door; from anywhere else it just stops the leg.
      if (leg.state === STATES.POSITION_OPEN) {
        return {
          state: STATES.EXITING,
          patch: { exitReason: EXIT_REASONS.SQUAREOFF },
          actions: [
            { type: 'CANCEL_TARGET', orderId: leg.targetOrderId, reason: EXIT_REASONS.SQUAREOFF },
            log('SQUARE_OFF', { note: 'flattening for the session close' }),
          ],
        };
      }
      if (leg.state === STATES.TARGET_MOVING) {
        return {
          state: STATES.TARGET_MOVING,
          patch: { pendingExit: EXIT_REASONS.SQUAREOFF },
          actions: [log('SQUARE_OFF', {
            note: 'a target move was in flight — exiting once the cancel confirms',
          })],
        };
      }
      if (leg.state === STATES.SELL_WORKING) {
        return {
          state: STATES.SELL_CANCELLING,
          patch: { haltAfterCancel: true },
          actions: [
            { type: 'CANCEL_SELL', orderId: leg.sellOrderId },
            log('SQUARE_OFF', { note: 'cancelling a working sell' }),
          ],
        };
      }
      if (leg.state === STATES.WAIT_CANDLE || leg.state === STATES.IDLE) {
        return {
          state: STATES.DONE,
          patch: { closedAt: event.tsMs, exitReason: EXIT_REASONS.SQUAREOFF },
          actions: [log('SQUARE_OFF', { note: 'leg was flat' })],
        };
      }
      return noop(leg);
    }

    case 'HALT':
      // Risk limit or kill switch. Stops NEW entries only — an open position
      // keeps being managed, because abandoning a live short is not a risk
      // control.
      if (leg.state === STATES.WAIT_CANDLE || leg.state === STATES.IDLE) {
        return {
          state: STATES.DONE,
          patch: { closedAt: event.tsMs, exitReason: EXIT_REASONS.HALT },
          actions: [log('HALTED', { reason: event.reason })],
        };
      }
      if (leg.state === STATES.SELL_WORKING) {
        return {
          state: STATES.SELL_CANCELLING,
          patch: { haltAfterCancel: true },
          actions: [
            { type: 'CANCEL_SELL', orderId: leg.sellOrderId },
            log('HALTED', { reason: event.reason, note: 'cancelling a working sell' }),
          ],
        };
      }
      return noop(leg);

    /* -------------------------------------------------------------- exiting */
    case 'TARGET_CANCELLED': {
      // The cancel is confirmed, so the target is definitely not going to fill.
      // ONLY NOW is anything else safe to send. Two destinations:
      //
      //   EXITING       -> the market exit, as before
      //   TARGET_MOVING -> the replacement target... unless something asked to
      //                    exit while the cancel was in flight, in which case
      //                    the exit wins and the target is not replaced.
      if (leg.state !== STATES.EXITING && leg.state !== STATES.TARGET_MOVING) return noop(leg);

      // Is an exit owed? From EXITING, always — that is what the state means.
      // From TARGET_MOVING, only if something asked for one while the cancel was
      // in flight. Both answers converge on the SINGLE construction site for
      // EXIT_MARKET below; `test/invariants.js` I3 asserts there is only one, so
      // that no future branch can learn to send an exit without a confirmed
      // cancel behind it.
      const owed = leg.state === STATES.EXITING ? leg.exitReason : leg.pendingExit;
      if (owed) {
        const overtaken = leg.state === STATES.TARGET_MOVING;
        return {
          state: STATES.EXITING,
          patch: {
            targetOrderId: null, exitReason: owed, pendingExit: null, pendingTargetP: null,
          },
          actions: [
            { type: 'EXIT_MARKET', reason: owed, qty: leg.filledQty },
            ...(overtaken ? [log('RETARGET_ABANDONED', {
              reason: owed, note: 'an exit overtook the target move — no replacement placed',
            })] : []),
          ],
        };
      }

      if (leg.trailingOnly) {
        return {
          state: STATES.POSITION_OPEN,
          patch: { targetOrderId: null, targetPriceP: null, pendingTargetP: null },
          actions: [log('TRAIL_ONLY', { note: 'running on the trailing stop alone' })],
        };
      }

      return {
        state: STATES.POSITION_OPEN,
        patch: { targetOrderId: null, targetPriceP: leg.pendingTargetP, pendingTargetP: null },
        actions: [
          { type: 'PLACE_TARGET', pricePaise: leg.pendingTargetP, qty: leg.filledQty },
        ],
      };
    }

    case 'TARGET_CANCEL_FAILED_FILLED':
      // The cancel came back "already executed". The target won; the position
      // is flat. Nothing to send — and this is precisely the case where sending
      // anyway would open a naked long. Just as true of a cancel sent to MOVE
      // the target as of one sent to exit.
      if (leg.state !== STATES.EXITING && leg.state !== STATES.TARGET_MOVING) return noop(leg);
      return {
        state: STATES.DONE,
        patch: {
          targetOrderId: null, pendingTargetP: null, pendingExit: null,
          closedAt: event.tsMs, exitReason: EXIT_REASONS.TARGET,
        },
        actions: [
          { type: 'CLOSE_LEG', reason: EXIT_REASONS.TARGET, exitPriceP: event.filledPriceP ?? leg.targetPriceP },
          log('TARGET_WON_RACE', { note: 'cancel refused — the target had already filled' }),
        ],
      };

    case 'EXIT_PLACED':
      if (leg.state !== STATES.EXITING) return noop(leg);
      return { state: leg.state, patch: { exitOrderId: event.orderId }, actions: [] };

    case 'EXIT_FILLED':
      if (leg.state !== STATES.EXITING) return noop(leg);
      return {
        state: STATES.DONE,
        patch: { exitOrderId: null, closedAt: event.tsMs },
        actions: [
          { type: 'CLOSE_LEG', reason: leg.exitReason, exitPriceP: event.filledPriceP },
          log('EXITED', { reason: leg.exitReason, exitP: event.filledPriceP }),
        ],
      };

    default:
      return noop(leg);
  }
}

// After a cancel confirms in SELL_CANCELLING, a leg that was cancelling because
// of a halt or a square-off must stop rather than re-arm. Kept separate from
// reduce() so the state table stays readable.
function afterSellCancel(leg, tsMs) {
  if (leg.haltAfterCancel) {
    return {
      state: STATES.DONE,
      patch: { sellOrderId: null, sellPriceP: null, closedAt: tsMs },
      actions: [log('HALTED', { note: 'working sell cancelled, leg stopped' })],
    };
  }
  return reduce(leg, { type: 'SELL_CANCELLED', tsMs }, {});
}

module.exports = {
  STATES, EXIT_REASONS,
  reduce, afterSellCancel,
  calculateSellPrice, calculateTargetPrice, calculateStopPrice,
  calculateLadderTarget, calculateTrailStop,
};
