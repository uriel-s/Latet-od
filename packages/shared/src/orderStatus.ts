// Order statuses and the moves between them (spec §4). The api checks every status change
// against ORDER_TRANSITIONS, so a click on an old screen or a forged request cannot, for
// example, cancel an order that was already collected.
import { z } from 'zod';

/** Every order status, in lifecycle order. */
export const ORDER_STATUSES = [
  'waiting',
  'pending',
  'confirmed',
  'collected',
  'cancelled',
] as const;

/**
 * Where an order is in its life (spec §4, ADR-0012): `waiting` for a round, `confirmed` once Yoel
 * puts it in a round ("בסבב": the customer confirms nothing, the name is from before ADR-0012), then
 * `collected` or `cancelled`, both final. `pending` (once "ממתינה לאישור") is legacy: no order enters
 * it any more, but orders planned before ADR-0012 may still be in it, so it stays readable and can
 * leave the way it always could. Leaving a round is not a status: the order goes back to `waiting`
 * and `lastMiss` records why.
 */
export const orderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

/**
 * Hebrew name of each status, as Yoel and the customer see it. The English, and a copy of this
 * Hebrew, are in i18n.ts under `orderStatus.*`: change both.
 */
export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  waiting: 'ממתינה לסבב',
  // Legacy (ADR-0012): shown like `confirmed`, since there is nothing left for the customer to do.
  pending: 'בסבב',
  confirmed: 'בסבב',
  collected: 'נאספה',
  cancelled: 'בוטלה',
};

/**
 * Statuses of an order that may still be collected. One phone has at most one open order
 * (spec §3.1), so this list is the filter of that duplicate check and, later, of the Mongo
 * partial unique index on the phone.
 */
export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = ['waiting', 'pending', 'confirmed'];

/**
 * Allowed moves, exactly the arrows of the spec §4 diagram, by the action behind each:
 * - waiting → confirmed: Yoel plans a round with it and the message announcing the pickup goes
 *   out. No customer confirmation in between (ADR-0012).
 * - pending → confirmed: legacy. "התחל מסלול" takes an order still pending from before ADR-0012
 *   into the route.
 * - pending / confirmed → waiting: it leaves the round uncollected (reason in `lastMiss`).
 * - confirmed → collected: Yoel taps "אספתי". A pending order cannot be collected directly.
 * - waiting / pending / confirmed → cancelled: the customer or Yoel cancels.
 * - collected, cancelled: final, no way out.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  waiting: ['confirmed', 'cancelled'],
  pending: ['confirmed', 'waiting', 'cancelled'],
  confirmed: ['waiting', 'collected', 'cancelled'],
  collected: [],
  cancelled: [],
};

/**
 * Whether an order in status `from` may move to `to`.
 *
 * Staying in the same status is not a transition, so `canTransition('confirmed', 'confirmed')`
 * is false. A repeated action (the customer taps "לא מתאים הפעם" twice, or cancels an already
 * cancelled order) is the api's to answer as an idempotent success; this table only says which
 * changes are allowed.
 */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/**
 * Whether Yoel may delete the order for good (ADR-0008): only a `waiting` or `cancelled` order
 * that is in no round. A `collected` order is history the statistics count. An order with a
 * `roundId` is still named by that round's `orderIds` and by the route stored in it, and deleting
 * it would leave a stop pointing at nothing. An order that came back from a round to `waiting`
 * has no `roundId` any more (rounds/leaveRound.ts), so it can go; a cancelled one keeps the
 * `roundId` of the round it was cancelled in and stays as history.
 */
export function canDeleteOrder(order: {
  status: OrderStatus;
  roundId?: string | undefined;
}): boolean {
  return (
    (order.status === 'waiting' || order.status === 'cancelled') && order.roundId === undefined
  );
}

/** Whether an order in this status is still open, i.e. counts toward one open order per phone. */
export function isOpenStatus(status: OrderStatus): boolean {
  return OPEN_ORDER_STATUSES.includes(status);
}
