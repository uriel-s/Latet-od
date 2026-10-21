// The contract of /api/collector/orders (spec §3.5, the collector app's "הזמנות" screen): the
// waiting orders in region groups, editing, cancelling and adding an order, the success bodies,
// and the error bodies with their plain-Hebrew messages. Every route is behind requireCollector
// (ADR-0004). apps/api implements the routes with it and apps/web's screens call them, so the two
// sides agree on one definition.
import { z } from 'zod';
import { pointForAddress } from './location.ts';
import {
  ORDER_FORM_ERRORS,
  addressInputSchema,
  addressSchema,
  orderFormSchema,
  orderSchema,
  type Order,
  type OrderFormInput,
} from './order.ts';
import type { DuplicateOpenOrderErrorBody, InvalidOrderErrorBody } from './orderApi.ts';
import { canDeleteOrder } from './orderStatus.ts';
import { findStreet, regionSchema, type Region } from './streets.ts';

// ---------------------------------------------------------------------------------------------
// Groups and labels
// ---------------------------------------------------------------------------------------------

/**
 * The groups of the "הזמנות" screen, in screen order (spec §3.5): the two regions, then `none`,
 * "בלי אזור": an order whose street gives no region (a free-text street) until Yoel assigns one.
 */
export const ORDER_GROUP_KEYS = ['ramat', 'old', 'none'] as const;
export type OrderGroupKey = (typeof ORDER_GROUP_KEYS)[number];

/** Hebrew name of each region, as Yoel picks it in "שינוי אזור" (spec §3.5). */
export const REGION_LABELS: Readonly<Record<Region, string>> = {
  ramat: 'רמת בית שמש',
  old: 'בית שמש',
};

/** Hebrew title of each group on the "הזמנות" screen (spec §3.5). */
export const ORDER_GROUP_LABELS: Readonly<Record<OrderGroupKey, string>> = {
  ...REGION_LABELS,
  none: 'בלי אזור',
};

// ---------------------------------------------------------------------------------------------
// Success responses
// ---------------------------------------------------------------------------------------------

/**
 * One order as Yoel's screens get it. An allow-list built from the stored order's own field
 * schemas (like `orderSummarySchema`): zod strips unknown keys, also inside `contact`, so parsing
 * a whole stored order keeps only these fields. Left out on purpose:
 * - `token`: the customer's secret link; Yoel's screens never need it.
 * - `messages`: the WhatsApp log belongs to the round screens, not this list.
 * - `contact.method`: always `whatsapp` in the MVP.
 *
 * `address` is the full stored address, `nearStreetCode` included: Yoel sees and changes it.
 * `createdAt` uses the stored order's timestamp schema, so the ISO string the api's JSON carries
 * parses back into a `Date` on the web. `hasLocation` is computed, see {@link toCollectorOrder}.
 */
export const collectorOrderSchema = z.object({
  id: orderSchema.shape.id,
  contact: orderSchema.shape.contact.pick({ name: true, phone: true }),
  address: addressSchema,
  bottlesEstimated: orderSchema.shape.bottlesEstimated,
  status: orderSchema.shape.status,
  region: orderSchema.shape.region,
  /** Set when the order came back from a round uncollected: the tag "לא אישר · 12/11". */
  lastMiss: orderSchema.shape.lastMiss,
  source: orderSchema.shape.source,
  createdAt: orderSchema.shape.createdAt,
  /** Whether the address has a map point; false shows the "בלי מיקום" tag (ADR-0005). */
  hasLocation: z.boolean(),
  /**
   * Whether "מחיקת ההזמנה" is offered: `canDeleteOrder`, decided by the api (ADR-0008), which
   * always sends it. Optional in the type so a screen's test data need not spell it out; absent
   * means "not offered", the safe reading.
   */
  deletable: z.boolean().optional(),
});
export type CollectorOrder = z.infer<typeof collectorOrderSchema>;

/**
 * A stored order as Yoel's screens get it: only the fields of {@link collectorOrderSchema}, plus
 * `hasLocation`.
 *
 * `hasLocation` is whether {@link pointForAddress} finds a point, from the near street or the
 * street (ADR-0005). An order without one gets the "בלי מיקום" tag, because route planning cannot
 * place it and puts it last: the tag tells Yoel to pick a near street ("רחוב קרוב") before he
 * plans a round. Computed here, not stored, because orders store no point: fixing a street's point
 * in the street list fixes every order on it.
 */
export function toCollectorOrder(order: Order): CollectorOrder {
  return collectorOrderSchema.parse({
    ...order,
    hasLocation: pointForAddress(order.address) !== undefined,
    deletable: canDeleteOrder(order),
  });
}

/** One group of the "הזמנות" screen: its orders, with the count and bottle total in its header. */
export const orderGroupSchema = z.object({
  key: z.enum(ORDER_GROUP_KEYS),
  orderCount: z.int().nonnegative(),
  /** Sum of the group's `bottlesEstimated`, shown next to the order count (spec §3.5). */
  bottlesTotal: z.int().nonnegative(),
  orders: z.array(collectorOrderSchema),
});
export type OrderGroup = z.infer<typeof orderGroupSchema>;

/**
 * Body of a 200 from GET /api/collector/orders: the `waiting` orders, by group. Always the three
 * groups in {@link ORDER_GROUP_KEYS} order, empty ones too, so the screen's layout does not jump;
 * inside a group the orders are oldest first. See {@link groupWaitingOrders}.
 */
export const collectorOrdersResponseSchema = z.object({
  groups: z.array(orderGroupSchema),
});
export type CollectorOrdersResponse = z.infer<typeof collectorOrdersResponseSchema>;

/** The group an order is listed in: its region, or "בלי אזור" while it has none. */
function groupKeyOf(order: CollectorOrder): OrderGroupKey {
  // Type-checks only while every Region is also a group key: a new region needs its own group.
  return order.region ?? 'none';
}

/**
 * The waiting orders in the groups of the "הזמנות" screen (spec §3.5): each order in the group of
 * its `region`, `none` when it has none. Returns all three groups in {@link ORDER_GROUP_KEYS}
 * order, empty ones with 0 orders and 0 bottles, and keeps the input order inside a group (the
 * api passes the orders oldest first). Pure, and here rather than in the api, so it is tested
 * once without a database. It groups what it is given; picking the `waiting` orders is the api's.
 */
export function groupWaitingOrders(orders: readonly CollectorOrder[]): OrderGroup[] {
  return ORDER_GROUP_KEYS.map((key) => {
    const groupOrders = orders.filter((order) => groupKeyOf(order) === key);
    return {
      key,
      orderCount: groupOrders.length,
      bottlesTotal: groupOrders.reduce((total, order) => total + order.bottlesEstimated, 0),
      orders: groupOrders,
    };
  });
}

/**
 * Body of a 200 from GET /api/collector/orders/:id, PATCH /api/collector/orders/:id and
 * POST /api/collector/orders/:id/cancel, and of a 201 from POST /api/collector/orders (add): the
 * order as it is now, so the screen shows what was stored rather than what it sent.
 */
export const collectorOrderResponseSchema = z.object({
  order: collectorOrderSchema,
});
export type CollectorOrderResponse = z.infer<typeof collectorOrderResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/**
 * A street code that must be in the official list: the same rule, and the same plain message, as
 * the booking form's `address.streetCode`.
 */
const listedStreetCodeSchema = z
  .int({ error: ORDER_FORM_ERRORS.streetNotFound })
  .refine((code) => findStreet(code) !== undefined, { error: ORDER_FORM_ERRORS.streetNotFound });

/**
 * Body of PATCH /api/collector/orders/:id: Yoel's "עריכה" and "שינוי אזור" (spec §3.5), and
 * picking a near street (ADR-0005). Every key is optional; at least one must be present, since a
 * PATCH with nothing to change is a client bug. Strict: an unknown key is refused with 400, `status`
 * above all. A PATCH never changes the status; a status change has its own route, checked by
 * `canTransition`.
 *
 * Keys, and what the api does with each:
 * - `contact`: name and phone together, with the form's rules (the phone is stored in E.164).
 *   The api answers 409 `duplicate_open_order` when the new phone has another open order.
 * - `address`: the form's address rules; it replaces the stored address as a whole, except
 *   `nearStreetCode`, which the form's address does not carry: the stored one is kept unless the
 *   body has `nearStreetCode` too.
 * - `bottlesEstimated`: the form's rules (at least 30).
 * - `nearStreetCode`: a listed street ("רחוב קרוב") that sets both region and map point
 *   (ADR-0005), or `null` to remove it.
 * - `region`: Yoel's explicit choice. There is no way to go back to "בלי אזור".
 *
 * The region after the PATCH:
 * 1. An explicit `region` in the body wins.
 * 2. Otherwise it is derived again (`regionForAddress`) only when the street code or the near
 *    street code actually changes. A derived region replaces the stored one; when the new streets
 *    give no region, the stored one is kept, so a region Yoel set by hand is not lost by fixing a
 *    house number or the free-text street name.
 * 3. Otherwise the stored region stays.
 *
 * The api refuses the PATCH with 409 `invalid_transition` once the order is no longer open
 * (collected or cancelled).
 */
export const updateOrderRequestSchema = z
  .strictObject({
    contact: orderFormSchema.shape.contact.optional(),
    address: addressInputSchema.optional(),
    bottlesEstimated: orderFormSchema.shape.bottlesEstimated.optional(),
    region: regionSchema.optional(),
    nearStreetCode: listedStreetCodeSchema.nullable().optional(),
  })
  // Any value but undefined counts, `nearStreetCode: null` included: it is a change.
  .refine((update) => Object.values(update).some((value) => value !== undefined), {
    error: 'expected at least one field to change',
  });

/** What the edit screen sends: form strings as typed, the bottles possibly as a string. */
export type UpdateOrderRequest = z.input<typeof updateOrderRequestSchema>;
/** The PATCH after validation: what the api applies to the stored order. */
export type UpdateOrder = z.output<typeof updateOrderRequestSchema>;

/**
 * Body of POST /api/collector/orders: Yoel's "הוספת הזמנה" for a customer who phoned (spec
 * §3.5). The booking form, validated with the same `orderFormSchema`, without the honeypot field
 * and without the public form's rate limit (the route is behind the login). The api stores it with
 * `source: 'collector'`, and answers 409 `duplicate_open_order` like the public form does.
 */
export type AddOrderRequest = OrderFormInput;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/**
 * Plain-Hebrew messages of the collector's order screens that Yoel sees. A 409 for a phone with an
 * open order reuses `CREATE_ORDER_MESSAGES.duplicateOpenOrder`; a 400 is `InvalidOrderErrorBody`,
 * whose field messages are the form's own.
 */
export const COLLECTOR_ORDER_MESSAGES = {
  /** The order was collected or cancelled meanwhile (e.g. on another screen). */
  orderClosed: 'ההזמנה כבר נסגרה, ואי אפשר לשנות אותה.',
  orderNotFound: 'ההזמנה לא נמצאה.',
  /** A delete the order's state does not allow (collected, or in a round), ADR-0008. */
  cannotDelete: 'אי אפשר למחוק את ההזמנה: היא נאספה או שהיא בסבב. אפשר לבטל אותה.',
} as const;

// The bodies below follow ApiErrorBody (index.ts): a stable `error` code, plus a Hebrew `message`
// where Yoel sees it. Standalone, like orderApi.ts, because index.ts re-exports this file and
// importing back from it would be circular.

/**
 * 404 from /api/collector/orders/:id and its sub-routes: no order has this id, or the id is not
 * one at all. The same body for both, so a malformed id needs no answer of its own. The web app
 * shows {@link COLLECTOR_ORDER_MESSAGES}.orderNotFound.
 */
export interface OrderNotFoundErrorBody {
  error: 'order_not_found';
}

/**
 * 409: the change does not fit the order's status. Either `canTransition` refuses a status change
 * (cancelling an order that was already collected), or an edit reaches an order that is no longer
 * open (collected or cancelled). `message` is {@link COLLECTOR_ORDER_MESSAGES}.orderClosed.
 */
export interface InvalidTransitionErrorBody {
  error: 'invalid_transition';
  message: string;
}

/**
 * 409 from DELETE /api/collector/orders/:id: `canDeleteOrder` refuses the order (it was collected,
 * or it is in a round), or it changed status while the delete was on its way. `message` is
 * {@link COLLECTOR_ORDER_MESSAGES}.cannotDelete.
 */
export interface CannotDeleteErrorBody {
  error: 'cannot_delete';
  message: string;
}

/**
 * Every error body /api/collector/orders adds to the ones every route may answer (ApiErrorBody).
 * A 401 comes from the login guard: authApi.ts's `UnauthenticatedErrorBody`.
 */
export type CollectorOrderErrorBody =
  | InvalidOrderErrorBody
  | DuplicateOpenOrderErrorBody
  | OrderNotFoundErrorBody
  | InvalidTransitionErrorBody
  | CannotDeleteErrorBody;
