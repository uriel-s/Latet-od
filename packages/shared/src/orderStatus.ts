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
 * Where an order is in its life (spec §4): `waiting` for a round, `pending` the customer's
 * confirmation, `confirmed`, then `collected` or `cancelled`, both final. Leaving a round is not
 * a status: the order goes back to `waiting` and `lastMiss` records why.
 */
export const orderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

/** Hebrew name of each status, as Yoel and the customer see it. */
export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  waiting: 'ממתינה לסבב',
  pending: 'ממתינה לאישור',
  confirmed: 'אושרה',
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
 * - waiting → pending: Yoel plans a round with it and the confirmation request goes out.
 * - pending → confirmed: the customer confirms, or Yoel marks "אישר בטלפון".
 * - pending / confirmed → waiting: it leaves the round uncollected (reason in `lastMiss`).
 * - confirmed → collected: Yoel taps "אספתי". A pending order cannot be collected directly.
 * - waiting / pending / confirmed → cancelled: the customer or Yoel cancels.
 * - collected, cancelled: final, no way out.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  waiting: ['pending', 'cancelled'],
  pending: ['confirmed', 'waiting', 'cancelled'],
  confirmed: ['waiting', 'collected', 'cancelled'],
  collected: [],
  cancelled: [],
};

/**
 * Whether an order in status `from` may move to `to`.
 *
 * Staying in the same status is not a transition, so `canTransition('confirmed', 'confirmed')`
 * is false. A repeated action (the customer taps "confirm" twice, or cancels an already
 * cancelled order) is the api's to answer as an idempotent success; this table only says which
 * changes are allowed.
 */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** Whether an order in this status is still open, i.e. counts toward one open order per phone. */
export function isOpenStatus(status: OrderStatus): boolean {
  return OPEN_ORDER_STATUSES.includes(status);
}
