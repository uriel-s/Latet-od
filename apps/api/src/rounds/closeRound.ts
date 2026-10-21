// "סגור סבב" (spec §3.6, §4 "מצבי סבב"): Yoel ends a round. The round becomes `closed` (and leaves
// the "סבבים" tab), and every order still in it that was not handled goes back to `waiting` for the
// next round, with the reason in `lastMiss` ("לא הגענו אליו" / "לא אישר בזמן"). The route
// POST /api/collector/rounds/:id/close (collectorRoundsRoutes.ts) is a thin wrapper around
// closeRound(); the order patch is leaveRound.ts's, like every other way out of a round.
import {
  buildRoundView,
  canTransition,
  type MissReason,
  type Order,
  type Round,
  type RoundView,
} from '@bottlerun/shared';
import type { AppDeps } from '../deps.ts';
import { leaveRoundPatch } from './leaveRound.ts';

/**
 * How many times closing the round itself is tried. Each miss means another request changed the
 * round between the read and the conditional write (a "סגור אישורים ובנה מסלול" moved it to
 * `routed`, or another close won); the next attempt reads it again. With one collector that is at
 * most one miss, so a third one is a bug or a broken database, answered 500.
 */
const CLOSE_ATTEMPTS = 3;

/**
 * How many times one order is sent back. A miss means the order changed meanwhile ("אספתי", or
 * the customer's cancel or decline won the race); it is read again, and tried once more only if it
 * is still unhandled in this round. A second miss leaves it as it is: a second "סגור סבב" sweeps it.
 */
const SWEEP_ATTEMPTS = 2;

/**
 * Closes the round `roundId` and sends its unhandled orders back to `waiting`; resolves to the
 * round's view as stored afterwards, or null when no round has this id (also for a malformed id).
 *
 * In this order, so that nothing can join or act on the round while it is being emptied:
 * 1. The round is closed FIRST, with a write conditional on the status and phase it was read in.
 *    Its `phase` is kept, recording where it was closed (`confirming` or `routed`), and `closedAt`
 *    is now. Once it is closed, every stop action and move answers 409 `route_not_open`, and
 *    "אישר בטלפון" and the customer's confirm answer 409 `confirmations_closed`. A round already
 *    closed is a success, and is not written again: it keeps its first `closedAt`.
 * 2. Then the sweep, on every call, a second close too: that heals a first close whose sweep
 *    stopped half way (a 500 in the middle). Each order of the round that is still in it
 *    (`roundId`) and `pending` or `confirmed` leaves it (leaveRoundPatch): reason `notReached` for
 *    a confirmed stop of a routed round (Yoel did not get to it), `notConfirmed` otherwise (a
 *    confirming round's orders, confirmed or not, and a stray `pending` of a routed round).
 *    Collected, cancelled and not-found orders, and those that already left the round, are not
 *    touched. Each write is conditional on the status read (`ifStatus`), so a "אספתי" or a cancel
 *    racing the close keeps what it wrote.
 *
 * No message is sent, and nothing is logged.
 */
export async function closeRound(
  deps: Pick<AppDeps, 'orders' | 'rounds'>,
  roundId: string,
): Promise<RoundView | null> {
  const { orders } = deps;
  const now = new Date();

  const round = await closeRoundRecord(deps, roundId, now);
  if (round === null) return null;

  for (const order of await orders.list({ ids: round.orderIds })) {
    await sendBackUnhandled(deps, round, order, now);
  }

  // Re-read after the writes, so the view shows the orders as stored now.
  return buildRoundView(round, await orders.list({ ids: round.orderIds }));
}

/**
 * Step 1 of {@link closeRound}: the round, closed. Null when there is no such round. Throws (a
 * 500) when the conditional write keeps missing.
 */
async function closeRoundRecord(
  { rounds }: Pick<AppDeps, 'rounds'>,
  roundId: string,
  now: Date,
): Promise<Round | null> {
  for (let attempt = 0; attempt < CLOSE_ATTEMPTS; attempt += 1) {
    const round = await rounds.findById(roundId);
    if (round === null) return null;
    if (round.status === 'closed') return round;
    // Conditional on the phase read too: a route built in between changes the phase, and the next
    // attempt then closes the routed round (and its sweep gives `notReached`, not `notConfirmed`).
    const closed = await rounds.update(
      round.id,
      { status: 'closed', closedAt: new Date(now) },
      { ifStatus: ['open'], ifPhase: [round.phase] },
    );
    if (closed !== null) return closed;
  }
  throw new Error('the round kept changing while it was being closed');
}

/**
 * Step 2 of {@link closeRound} for one order: sends it back to `waiting` if it is still unhandled
 * in `round`. When the conditional write misses, the order is read again and decided by what it
 * is now (see {@link SWEEP_ATTEMPTS}).
 */
async function sendBackUnhandled(
  { orders }: Pick<AppDeps, 'orders'>,
  round: Round,
  order: Order,
  now: Date,
): Promise<void> {
  let current: Order | null = order;
  for (let attempt = 0; attempt < SWEEP_ATTEMPTS; attempt += 1) {
    if (current === null || !isUnhandledIn(round, current)) return;
    // pending and confirmed may both go back to waiting (spec §4); checked, like every change.
    if (!canTransition(current.status, 'waiting')) return;
    const left = await orders.update(
      current.id,
      leaveRoundPatch(current, round, missReasonAtClose(round, current), now),
      { ifStatus: [current.status] },
    );
    if (left !== null) return;
    current = await orders.findById(current.id);
  }
}

/**
 * Whether `order` is still in `round` and nothing happened to it there: `pending` or `confirmed`
 * with this `roundId`. A collected or cancelled order keeps its `roundId` but is final; a
 * not-found one (and any that left the round) has no `roundId` any more.
 */
function isUnhandledIn(round: Round, order: Order): boolean {
  return order.roundId === round.id && (order.status === 'pending' || order.status === 'confirmed');
}

/**
 * Why `order` leaves `round` at its close: a confirmed stop of a routed round was on the route but
 * Yoel did not get to it ("לא הגענו אליו"); anything else did not confirm before the confirmations
 * ended ("לא אישר בזמן"), including a confirmed order of a round closed before its route was built.
 */
function missReasonAtClose(round: Round, order: Order): MissReason {
  return round.phase === 'routed' && order.status === 'confirmed' ? 'notReached' : 'notConfirmed';
}
