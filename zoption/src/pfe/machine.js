// The Price-Filter Engine's trade state machine.
//
// A PURE function: (trade, event, cfg) -> { state, patch, actions }. No I/O, no
// network, no clock — time and prices arrive as events. Everything the engine
// does is a consequence of what this returns, which is what lets the whole of
// doc/new.md's decision table be tested in a millisecond without a market.
//
// ---------------------------------------------------------------------------
// One position at a time
// ---------------------------------------------------------------------------
//
// doc/new.md §12: "Maximum simultaneous positions: 1". So unlike the scalper's
// two-leg cycle there is exactly one of these alive at once, and the exclusion
// is enforced twice over — by a UNIQUE index on `pfe_guard.open_key` in the
// database, and by the engine holding a single `trade` object.
//
// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------
//
//   IDLE            nothing selected
//   ARMED           a contract is chosen and held; waiting for THAT contract's
//                   own candle to close so the sell can be priced from it
//   SELL_WORKING    a SELL LIMIT is live at the broker
//   SELL_CANCELLING cancel sent, awaiting confirmation
//   POSITION_OPEN   short filled, target resting at the broker
//   TARGET_MOVING   target cancelled to be REPLACED (the ladder), not exited
//   EXITING         target cancel confirmed; a market buy-back is in flight
//   DONE            flat
//
// ---------------------------------------------------------------------------
// The one-way door
// ---------------------------------------------------------------------------
//
// POSITION_OPEN -> EXITING goes through a CONFIRMED cancel of the resting
// target. A resting buy-back plus an engine-fired market buy-back is a
// double-exit race, and on a short that leaves the account naked LONG. There is
// exactly ONE place in this file that emits EXIT_MARKET, and it sits behind
// TARGET_CANCELLED; test/pfeMachine.test.js asserts that count so no future
// branch can learn to send an exit without a confirmed cancel behind it.
//
// TARGET_MOVING uses the same door. Moving a target is a cancel followed by a
// place, and an exit trigger that arrives in between is recorded as
// `pendingExit` and sent when the cancel confirms — a pending exit outranks the
// replacement target and no new target is placed.

const rules = require('./exitRules');

const { EXIT_REASONS } = rules;

const STATES = {
  IDLE: 'IDLE',
  ARMED: 'ARMED',
  SELL_WORKING: 'SELL_WORKING',
  SELL_CANCELLING: 'SELL_CANCELLING',
  POSITION_OPEN: 'POSITION_OPEN',
  TARGET_MOVING: 'TARGET_MOVING',
  EXITING: 'EXITING',
  DONE: 'DONE',
};

// Exits that may fire on an OPEN position, in the order they are considered
// when several are true at once. The stop is first because it is the one that
// caps the loss; the square-off is last because it is a deadline, not an
// opinion.
const noop = (trade) => ({ state: trade.state, patch: {}, actions: [] });
const log = (kind, detail) => ({ type: 'LOG', kind, ...detail });

// Every exit converges here so the ordering and the OCO door are stated once.
// From POSITION_OPEN it cancels the target first; from TARGET_MOVING a cancel
// is already in flight so the exit is only recorded.
function beginExit(trade, reason, note) {
  if (trade.state === STATES.TARGET_MOVING) {
    return {
      state: STATES.TARGET_MOVING,
      patch: { pendingExit: reason },
      actions: [log('EXIT_TRIGGERED', {
        reason, note: note || null,
        detail: 'a target move was in flight — exiting once the cancel confirms',
      })],
    };
  }
  return {
    state: STATES.EXITING,
    patch: { exitReason: reason },
    actions: [
      { type: 'CANCEL_TARGET', orderId: trade.targetOrderId, reason },
      log('EXIT_TRIGGERED', { reason, note: note || null }),
    ],
  };
}

const isOpen = (trade) =>
  trade.state === STATES.POSITION_OPEN || trade.state === STATES.TARGET_MOVING;

/* ---------------------------------------------------------------- reduce -- */

// `trade` — { state, optionType, sellPriceP, filledPriceP, targetPriceP,
//             slPriceP, filledQty, attemptSeq, confirmations, trails,
//             trailPeakP, trailingOnly, pendingExit, pendingTargetP,
//             armedAt, openedAt, sellPlacedAt, sellOrderId, targetOrderId,
//             exitOrderId, entryVolume }
// `cfg`   — { sellOffsetP, targetP, stopLossP, stepP, maxSteps,
//             trailStartP, trailGapP, trailTightenP, trailMinGapP,
//             pendingTimeoutMs, maxHoldMs, armTimeoutMs, safetyMarginP,
//             dynamicTarget }
function reduce(trade, event, cfg) {
  switch (event.type) {
    /* ------------------------------------------------------------- arming */

    case 'ARM':
      if (trade.state !== STATES.IDLE) return noop(trade);
      return {
        state: STATES.ARMED,
        patch: { armedAt: event.tsMs, waitingSince: event.tsMs },
        actions: [log('ARMED', {
          note: 'waiting for this contract\'s own candle to close',
          symbol: event.symbol, score: event.score,
        })],
      };

    // The armed contract never got a tradable candle inside the window the
    // engine allows. Release it so the next scan can choose against the spot as
    // it is NOW rather than as it was when this one was picked — a strike chosen
    // three minutes ago is a strike chosen for a different market.
    case 'ARM_TIMEOUT': {
      if (trade.state !== STATES.ARMED) return noop(trade);
      if (!cfg.armTimeoutMs) return noop(trade);
      const waited = event.tsMs - (trade.waitingSince || trade.armedAt || 0);
      if (waited < cfg.armTimeoutMs) return noop(trade);
      return {
        state: STATES.DONE,
        patch: { closedAt: event.tsMs, exitReason: EXIT_REASONS.NO_ENTRY },
        actions: [log('NO_ENTRY', {
          reason: event.reason || 'never got permission to enter', waitedMs: waited,
        })],
      };
    }

    /* -------------------------------------------------- Module 5, pricing */

    // A completed candle OF THE ARMED CONTRACT. The gates were evaluated
    // outside and arrive as booleans — the machine never sees a live price, so
    // no live price can leak into the sell.
    case 'OPTION_CANDLE': {
      if (trade.state !== STATES.ARMED) return noop(trade);

      const { candle } = event;
      if (!candle || !candle.tradable) {
        return {
          state: STATES.ARMED,
          patch: {},
          actions: [log('CANDLE_SKIPPED', {
            reason: candle?.synthetic ? 'synthetic bar (no ticks)' : 'low-confidence bar',
            tickCount: candle?.tickCount ?? 0,
          })],
        };
      }

      if (event.entryOk === false) {
        return {
          state: STATES.ARMED,
          patch: {},
          actions: [log('ENTRY_REJECTED', { reason: event.entryReason || 'a gate refused' })],
        };
      }

      const price = rules.calculateSellPrice(candle, cfg.sellOffsetP);
      const attemptSeq = (trade.attemptSeq || 0) + 1;
      return {
        state: STATES.SELL_WORKING,
        patch: {
          sellPriceP: price,
          entryCandleId: candle.id ?? null,
          sellPlacedAt: event.tsMs,
          attemptSeq,
        },
        actions: [
          { type: 'PLACE_SELL', pricePaise: price, attemptSeq },
          log('SELL_PRICED', {
            closeP: candle.closeP, offsetP: cfg.sellOffsetP, sellP: price,
            bucket: candle.bucketStart,
          }),
        ],
      };
    }

    /* ------------------------------------------------------ sell lifecycle */

    case 'SELL_PLACED':
      if (trade.state !== STATES.SELL_WORKING) return noop(trade);
      return { state: trade.state, patch: { sellOrderId: event.orderId }, actions: [] };

    case 'SELL_REJECTED':
      if (trade.state !== STATES.SELL_WORKING) return noop(trade);
      return {
        state: STATES.ARMED,
        patch: {
          sellOrderId: null, sellPriceP: null, sellPlacedAt: null,
          waitingSince: event.tsMs,
        },
        actions: [log('SELL_REJECTED', { reason: event.reason })],
      };

    case 'PENDING_TIMEOUT': {
      // Unfilled past the timeout. Cancel — and then wait for the NEXT candle
      // rather than requoting immediately. The idle gap with no working order
      // is what "never chase the market" means mechanically.
      if (trade.state !== STATES.SELL_WORKING) return noop(trade);
      if (event.tsMs - (trade.sellPlacedAt || 0) < cfg.pendingTimeoutMs) return noop(trade);
      return {
        state: STATES.SELL_CANCELLING,
        patch: {},
        actions: [
          { type: 'CANCEL_SELL', orderId: trade.sellOrderId },
          log('SELL_TIMEOUT', { heldMs: event.tsMs - (trade.sellPlacedAt || 0) }),
        ],
      };
    }

    // The entry gate turned while a limit was resting. Withdraw it.
    //
    // This matters more than it looks. The sell is a LIMIT ABOVE the market, so
    // a PE sell fills when the PE premium RISES — which is when NIFTY FALLS.
    // The filter permits PE selling while the index is above the bullish mid,
    // and the resting order then fills on the move that takes it back below:
    // the fill is selected for the moment the reason to be there has gone.
    // Gating only at placement leaves that wide open.
    case 'ENTRY_INVALIDATED': {
      if (trade.state !== STATES.SELL_WORKING) return noop(trade);
      return {
        state: STATES.SELL_CANCELLING,
        // NOT haltAfterCancel — this is a withdrawn quote, not a stop. The trade
        // goes back to ARMED and may sell again when the filter permits.
        patch: {},
        actions: [
          { type: 'CANCEL_SELL', orderId: trade.sellOrderId },
          log('ENTRY_INVALIDATED', {
            reason: event.reason,
            note: 'cancelling a working sell — the filter that justified it has turned',
          }),
        ],
      };
    }

    case 'SELL_CANCELLED':
      if (trade.state !== STATES.SELL_CANCELLING && trade.state !== STATES.SELL_WORKING) {
        return noop(trade);
      }
      return {
        state: STATES.ARMED,
        patch: {
          sellOrderId: null, sellPriceP: null, sellPlacedAt: null,
          waitingSince: event.tsMs,
        },
        actions: [log('REQUOTE_ARMED', { note: 'waiting for the next candle close' })],
      };

    case 'SELL_FILLED': {
      // A fill can land while a cancel is in flight — the cancel lost the race.
      // That is a filled short, not an error, and it is handled from both states
      // for exactly that reason.
      if (trade.state !== STATES.SELL_WORKING && trade.state !== STATES.SELL_CANCELLING) {
        return noop(trade);
      }
      const filledP = event.filledPriceP;
      const targetP = rules.calculateTargetPrice(filledP, cfg.targetP);
      const slP = rules.calculateStopPrice(filledP, cfg.stopLossP);
      return {
        state: STATES.POSITION_OPEN,
        patch: {
          filledPriceP: filledP,
          filledQty: event.filledQty,
          targetPriceP: targetP,
          slPriceP: slP,
          openedAt: event.tsMs,
          sellOrderId: null,
          confirmations: 0,
          trails: 0,
          // The best price starts AT the fill, so an immediate adverse tick
          // cannot make the trail believe it is in profit.
          trailPeakP: filledP,
          trailingOnly: false,
          pendingExit: null,
          entryVolume: event.volume ?? null,
        },
        actions: [
          { type: 'PLACE_TARGET', pricePaise: targetP, qty: event.filledQty },
          log('POSITION_OPEN', { filledP, targetP, slP, qty: event.filledQty }),
        ],
      };
    }

    /* --------------------------------------------------- the open position */

    case 'TARGET_PLACED':
      if (trade.state !== STATES.POSITION_OPEN) return noop(trade);
      return { state: trade.state, patch: { targetOrderId: event.orderId }, actions: [] };

    case 'TARGET_FILLED':
      // The clean exit. Reachable from EXITING and TARGET_MOVING too, where it
      // means the target won the cancel race — a flat position, not a problem.
      if (!isOpen(trade) && trade.state !== STATES.EXITING) return noop(trade);
      return {
        state: STATES.DONE,
        patch: {
          targetOrderId: null, pendingTargetP: null, pendingExit: null,
          closedAt: event.tsMs, exitReason: EXIT_REASONS.TARGET,
        },
        actions: [
          { type: 'CLOSE_TRADE', reason: EXIT_REASONS.TARGET, exitPriceP: event.filledPriceP },
          log(trade.state === STATES.POSITION_OPEN ? 'TARGET_HIT' : 'TARGET_WON_RACE',
            { exitP: event.filledPriceP }),
        ],
      };

    case 'TICK': {
      // The stop and the premium safety exit react at TICK speed, unlike the
      // entry. The candle-only rule governs the ENTRY price; a stop that waited
      // for a bar to close would be a five-second-wide hole in the only thing
      // capping the loss.
      //
      // Handled in TARGET_MOVING too: a stop must not be deaf for the moment a
      // target replacement is in flight.
      if (!isOpen(trade)) return noop(trade);
      if (!Number.isFinite(trade.slPriceP)) return noop(trade);

      const patch = {};
      const actions = [];

      const previousBest = Number.isFinite(trade.trailPeakP) ? trade.trailPeakP : trade.filledPriceP;
      const best = Math.min(previousBest, event.ltpPaise);
      if (best !== previousBest) patch.trailPeakP = best;

      const trailed = rules.trailStop({
        filledPriceP: trade.filledPriceP,
        bestPaise: best,
        currentStopP: trade.slPriceP,
        trailStartPaise: cfg.trailStartP || 0,
        trailGapPaise: cfg.trailGapP || 0,
        tightenPaise: cfg.trailTightenP || 0,
        minGapPaise: cfg.trailMinGapP || 0,
        trails: trade.trails || 0,
      });
      if (trailed != null) {
        patch.slPriceP = trailed;
        patch.trails = (trade.trails || 0) + 1;
        actions.push(log('TRAIL_STOP', {
          from: trade.slPriceP, to: trailed, bestP: best, entryP: trade.filledPriceP,
          lockedP: trade.filledPriceP - trailed,
        }));
      }

      // Module 10's premium safety exit: the premium has run against us by the
      // margin even though nothing else has failed yet. Checked BEFORE the stop
      // so a configuration where the safety margin is tighter than the stop
      // still reports the reason an operator can act on.
      if (rules.premiumSafetyBreached(trade.filledPriceP, event.ltpPaise, cfg.safetyMarginP)) {
        const next = beginExit(trade, EXIT_REASONS.PREMIUM_SAFETY,
          `the premium has risen ${((event.ltpPaise - trade.filledPriceP) / 100).toFixed(2)} `
          + 'against the position');
        return { ...next, patch: { ...patch, ...next.patch }, actions: [...actions, ...next.actions] };
      }

      const stop = patch.slPriceP ?? trade.slPriceP;
      if (event.ltpPaise < stop) return { state: trade.state, patch, actions };

      const next = beginExit(trade, EXIT_REASONS.STOPLOSS,
        `the premium reached the stop at ${(stop / 100).toFixed(2)}`);
      return { ...next, patch: { ...patch, ...next.patch }, actions: [...actions, ...next.actions] };
    }

    /* ------------------------------------------ Module 8, the target ladder */

    case 'CONFIRMED': {
      // A completed index candle whose price position filter still permits this
      // side. Push the target one rung further out instead of banking a point.
      if (trade.state !== STATES.POSITION_OPEN) return noop(trade);

      const n = (trade.confirmations || 0) + 1;
      if (!cfg.dynamicTarget) {
        return { state: trade.state, patch: { confirmations: n }, actions: [] };
      }

      const next = rules.ladderTarget(
        trade.filledPriceP, n, cfg.targetP, cfg.stepP, cfg.maxSteps);

      // Past the top of the ladder the resting target comes off entirely and the
      // position runs on the trailing stop until something exits it — "Fourth+:
      // trail until exit".
      if (next == null) {
        if (trade.trailingOnly) return { state: trade.state, patch: { confirmations: n }, actions: [] };
        return {
          state: STATES.TARGET_MOVING,
          patch: { confirmations: n, trailingOnly: true },
          actions: [
            { type: 'CANCEL_TARGET', orderId: trade.targetOrderId, reason: 'TRAIL_ONLY' },
            log('TRAIL_ONLY', { confirmations: n, note: 'target withdrawn; trailing until exit' }),
          ],
        };
      }

      // The ladder only ever moves the target DEEPER into profit. A
      // configuration whose step is smaller than the initial target would
      // otherwise walk it backwards, turning a move that is going our way into a
      // smaller win.
      if (trade.targetPriceP != null && next >= trade.targetPriceP) {
        return { state: trade.state, patch: { confirmations: n }, actions: [] };
      }

      return {
        state: STATES.TARGET_MOVING,
        patch: { confirmations: n, pendingTargetP: next },
        actions: [
          { type: 'CANCEL_TARGET', orderId: trade.targetOrderId, reason: 'RETARGET' },
          log('TARGET_LADDER', { confirmations: n, from: trade.targetPriceP, to: next }),
        ],
      };
    }

    /* ---------------------------------------------- Module 10, the exits -- */

    case 'FILTER_FAIL':
      if (trade.state === STATES.SELL_WORKING) {
        return reduce(trade, { ...event, type: 'ENTRY_INVALIDATED' }, cfg);
      }
      if (!isOpen(trade)) return noop(trade);
      return beginExit(trade, EXIT_REASONS.FILTER_FAIL, event.reason);

    case 'TREND_BREAK':
      if (trade.state === STATES.SELL_WORKING) {
        return reduce(trade, { ...event, type: 'ENTRY_INVALIDATED' }, cfg);
      }
      if (!isOpen(trade)) return noop(trade);
      return beginExit(trade, EXIT_REASONS.TREND_BREAK, event.reason);

    case 'LIQUIDITY_FAIL':
      if (!isOpen(trade)) return noop(trade);
      return beginExit(trade, EXIT_REASONS.LIQUIDITY, event.reason);

    case 'MAX_HOLD': {
      if (!isOpen(trade)) return noop(trade);
      if (!rules.heldTooLong(trade.openedAt, event.tsMs, cfg.maxHoldMs)) return noop(trade);
      // The maximum hold outranks the ladder. A trailing winner is still a naked
      // short, and an uncapped holding time is a different risk profile than the
      // one the rest of this engine was built for.
      return beginExit(trade, EXIT_REASONS.MAX_HOLD,
        `held for ${Math.round((event.tsMs - trade.openedAt) / 1000)}s`);
    }

    case 'SQUARE_OFF': {
      if (isOpen(trade)) return beginExit(trade, EXIT_REASONS.SQUAREOFF, 'the session close');
      if (trade.state === STATES.SELL_WORKING) {
        return {
          state: STATES.SELL_CANCELLING,
          patch: { haltAfterCancel: true },
          actions: [
            { type: 'CANCEL_SELL', orderId: trade.sellOrderId },
            log('SQUARE_OFF', { note: 'cancelling a working sell' }),
          ],
        };
      }
      if (trade.state === STATES.ARMED || trade.state === STATES.IDLE) {
        return {
          state: STATES.DONE,
          patch: { closedAt: event.tsMs, exitReason: EXIT_REASONS.SQUAREOFF },
          actions: [log('SQUARE_OFF', { note: 'nothing was open' })],
        };
      }
      return noop(trade);
    }

    case 'HALT':
      // A risk limit stops NEW entries. It never abandons an open position —
      // halting entries is a risk control, walking away from a live naked short
      // is not.
      if (trade.state === STATES.ARMED || trade.state === STATES.IDLE) {
        return {
          state: STATES.DONE,
          patch: { closedAt: event.tsMs, exitReason: EXIT_REASONS.HALT },
          actions: [log('HALTED', { reason: event.reason })],
        };
      }
      if (trade.state === STATES.SELL_WORKING) {
        return {
          state: STATES.SELL_CANCELLING,
          patch: { haltAfterCancel: true },
          actions: [
            { type: 'CANCEL_SELL', orderId: trade.sellOrderId },
            log('HALTED', { reason: event.reason, note: 'cancelling a working sell' }),
          ],
        };
      }
      return noop(trade);

    /* -------------------------------------------------------- the OCO door */

    case 'TARGET_CANCELLED': {
      // The cancel is confirmed, so the target is definitely not going to fill.
      // ONLY NOW is anything else safe to send.
      if (trade.state !== STATES.EXITING && trade.state !== STATES.TARGET_MOVING) {
        return noop(trade);
      }

      // Is an exit owed? From EXITING, always — that is what the state means.
      // From TARGET_MOVING, only if something asked for one while the cancel was
      // in flight, and then the exit outranks the replacement target.
      const owed = trade.state === STATES.EXITING ? trade.exitReason : trade.pendingExit;
      if (owed) {
        const overtaken = trade.state === STATES.TARGET_MOVING;
        return {
          state: STATES.EXITING,
          patch: {
            targetOrderId: null, exitReason: owed, pendingExit: null, pendingTargetP: null,
          },
          actions: [
            // THE ONLY EXIT_MARKET IN THIS FILE.
            { type: 'EXIT_MARKET', reason: owed, qty: trade.filledQty },
            ...(overtaken ? [log('RETARGET_ABANDONED', {
              reason: owed, note: 'an exit overtook the target move — no replacement placed',
            })] : []),
          ],
        };
      }

      if (trade.trailingOnly) {
        return {
          state: STATES.POSITION_OPEN,
          patch: { targetOrderId: null, targetPriceP: null, pendingTargetP: null },
          actions: [log('TRAIL_ONLY', { note: 'running on the trailing stop alone' })],
        };
      }

      return {
        state: STATES.POSITION_OPEN,
        patch: { targetOrderId: null, targetPriceP: trade.pendingTargetP, pendingTargetP: null },
        actions: [{ type: 'PLACE_TARGET', pricePaise: trade.pendingTargetP, qty: trade.filledQty }],
      };
    }

    case 'TARGET_CANCEL_FAILED_FILLED':
      // The cancel came back "already executed". The target won; the position is
      // flat. Sending anything now is precisely how a naked long is opened.
      if (trade.state !== STATES.EXITING && trade.state !== STATES.TARGET_MOVING) {
        return noop(trade);
      }
      return {
        state: STATES.DONE,
        patch: {
          targetOrderId: null, pendingTargetP: null, pendingExit: null,
          closedAt: event.tsMs, exitReason: EXIT_REASONS.TARGET,
        },
        actions: [
          {
            type: 'CLOSE_TRADE', reason: EXIT_REASONS.TARGET,
            exitPriceP: event.filledPriceP ?? trade.targetPriceP,
          },
          log('TARGET_WON_RACE', { note: 'cancel refused — the target had already filled' }),
        ],
      };

    case 'EXIT_PLACED':
      if (trade.state !== STATES.EXITING) return noop(trade);
      return { state: trade.state, patch: { exitOrderId: event.orderId }, actions: [] };

    case 'EXIT_FILLED':
      if (trade.state !== STATES.EXITING) return noop(trade);
      return {
        state: STATES.DONE,
        patch: { exitOrderId: null, closedAt: event.tsMs },
        actions: [
          { type: 'CLOSE_TRADE', reason: trade.exitReason, exitPriceP: event.filledPriceP },
          log('EXITED', { reason: trade.exitReason, exitP: event.filledPriceP }),
        ],
      };

    default:
      return noop(trade);
  }
}

// After a cancel confirms in SELL_CANCELLING, a trade that was cancelling
// because of a halt or a square-off must STOP rather than re-arm. Kept out of
// reduce() so the state table stays readable.
function afterSellCancel(trade, tsMs) {
  if (trade.haltAfterCancel) {
    return {
      state: STATES.DONE,
      patch: { sellOrderId: null, sellPriceP: null, closedAt: tsMs, haltAfterCancel: false },
      actions: [log('HALTED', { note: 'working sell cancelled, trade stopped' })],
    };
  }
  return reduce(trade, { type: 'SELL_CANCELLED', tsMs }, {});
}

// A fresh in-memory trade. One place so the engine and the tests agree on what
// a trade looks like before anything has happened to it.
function blank(overrides = {}) {
  return {
    id: null,
    state: STATES.IDLE,
    optionType: null,
    token: null,
    symbol: null,
    strike: null,
    tickP: 5,
    attemptSeq: 0,
    requoteCount: 0,
    confirmations: 0,
    trails: 0,
    entryCandleId: null,
    sellPriceP: null,
    filledPriceP: null,
    filledQty: 0,
    targetPriceP: null,
    slPriceP: null,
    trailPeakP: null,
    trailingOnly: false,
    pendingExit: null,
    pendingTargetP: null,
    haltAfterCancel: false,
    entryVolume: null,
    armedAt: null,
    waitingSince: null,
    sellPlacedAt: null,
    openedAt: null,
    closedAt: null,
    exitReason: null,
    sellOrderId: null,
    targetOrderId: null,
    exitOrderId: null,
    cancelFailedAt: null,
    _recoveredAt: 0,
    ...overrides,
  };
}

module.exports = { STATES, EXIT_REASONS, reduce, afterSellCancel, blank, isOpen };
