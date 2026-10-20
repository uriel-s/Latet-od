// Taking an order out of its round without collecting it (spec §4 "יציאה מסבב"): the order goes
// back to `waiting`, leaves the round, and keeps the round's date and the reason in `lastMiss`,
// which Yoel's screens show as a tag ("ביקש מועד אחר · 12/11"). One patch for every way out: the
// customer's "לא מתאים הפעם" (orders/customerOrderRoutes.ts), the customer's address change
// (section 9), and the route building of section 10 (notConfirmed / notFound / notReached).
import type { MissReason, Order, Round } from '@bottlerun/shared';
import type { OrderPatch } from '../orders/ordersRepo.ts';

/**
 * The {@link OrderPatch} that takes `order` out of its round for `reason`, at `now`:
 *
 * - `status: 'waiting'`: it waits for the next round (spec §4: leaving a round is a reason, not a
 *   status).
 * - `roundId` removed (`undefined` = Mongo `$unset`). It MUST go: planning a round
 *   (`isPlannable` in collectorRoundsRoutes.ts) refuses a waiting order that still has a
 *   `roundId`, so an order sent back to `waiting` with its old `roundId` could never be planned
 *   again. It is also what keeps "an order is in at most one open round" (spec §4) true.
 * - `lastMiss: { date, reason, roundId }`: the round's date (YYYY-MM-DD) and id, replacing any
 *   earlier miss (one reason is kept, spec §4). Only when `round` is the order's round
 *   (`round.id === order.roundId`): without it there is no date to record, and a wrong round must
 *   not be recorded as the order's, so `lastMiss` is then left as it is.
 * - `updatedAt: now` (a copy, so the caller's Date is never shared).
 *
 * Nothing else: never `messages` (sendAndLog rewrites that array as a whole, so a patch that
 * carried it could undo a message logged meanwhile), the address or the dates of other events.
 *
 * Pure: the caller writes the patch, conditional on the status it decided on
 * (`orders.update(id, patch, { ifStatus: [order.status] })`), and checks with `canTransition`
 * that the order may move to `waiting` (only `pending` and `confirmed` may).
 */
export function leaveRoundPatch(
  order: Order,
  round: Round | null,
  reason: MissReason,
  now: Date,
): OrderPatch {
  const patch: OrderPatch = {
    status: 'waiting',
    roundId: undefined,
    updatedAt: new Date(now),
  };
  if (round !== null && round.id === order.roundId) {
    patch.lastMiss = { date: round.date, reason, roundId: round.id };
  }
  return patch;
}
