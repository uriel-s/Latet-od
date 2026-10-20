// The contract of /api/collector/rounds (spec §3.5 "תכנון סבב", §3.6 step 1 "אישורים"): planning a
// round, the round's view with its orders in three groups and its "שלח" list, "אישר בטלפון", and
// the error bodies with their plain-Hebrew messages. Every route is behind requireCollector
// (ADR-0004). apps/api implements the routes with it and apps/web's screens call them, so the two
// sides agree on one definition.
import { z } from 'zod';
import {
  collectorOrderSchema,
  toCollectorOrder,
  type InvalidTransitionErrorBody,
  type OrderNotFoundErrorBody,
} from './collectorOrdersApi.ts';
import { messageLinkSchema, pickupTimeSchema, toMessageLink } from './messages.ts';
import type { Order } from './order.ts';
import { MAX_ROUND_ORDERS, roundSchema, type Round } from './round.ts';
import { regionSchema } from './streets.ts';

// ---------------------------------------------------------------------------------------------
// Request: POST /api/collector/rounds ("תכנון סבב")
// ---------------------------------------------------------------------------------------------

/**
 * Plain-Hebrew messages of the planning screen. Each is shown next to its field, so it says what
 * to do in a few words.
 */
export const ROUND_PLAN_ERRORS = {
  dateRequired: 'נא לבחור תאריך',
  regionRequired: 'נא לבחור אזור',
  noOrders: 'נא לסמן לפחות הזמנה אחת',
  tooManyOrders: `אפשר לסמן עד ${MAX_ROUND_ORDERS} הזמנות בסבב`,
  duplicateOrders: 'אותה הזמנה סומנה פעמיים',
  pickupByInvalid: 'נא לכתוב שעה, למשל 08:00',
  personalTextTooLong: 'הטקסט ארוך מדי',
} as const;

/**
 * Longest personal text the planning screen accepts, after trimming. It goes into every
 * confirmation request of the round, so a few lines is plenty; it stops a pasted essay.
 */
export const PERSONAL_TEXT_MAX_LENGTH = 500;

const ERR = ROUND_PLAN_ERRORS;

/**
 * Yoel's personal text (spec §3.5, ת11). Trimmed at the ends only, so the line breaks he wrote
 * inside stay in the message. A textarea left empty sends '' (or only spaces): that becomes
 * absent instead of a blank text, like the booking form's optional fields.
 */
const personalTextInputSchema = z
  .string()
  .trim()
  .max(PERSONAL_TEXT_MAX_LENGTH, ERR.personalTextTooLong)
  .transform((text) => (text === '' ? undefined : text))
  .optional();

/**
 * "עד איזו שעה להוציא את הבקבוקים" (ADR-0003). An `<input type="time">` yields `HH:MM`, or '' when
 * left empty: '' becomes absent, anything else must be a strict `HH:MM` ({@link pickupTimeSchema}).
 * A refine rather than a union of '' and the time: zod would report the time schema's own English
 * message instead of the union's Hebrew one.
 */
const pickupByInputSchema = z
  .string({ error: ERR.pickupByInvalid })
  .refine((time) => time === '' || pickupTimeSchema.safeParse(time).success, {
    error: ERR.pickupByInvalid,
  })
  .transform((time) => (time === '' ? undefined : time))
  .optional();

/**
 * Body of POST /api/collector/rounds: "שלח בקשות אישור" on the planning screen (spec §3.5). A
 * date, a region, and the order ids Yoel left marked; optionally his personal text and the pickup
 * time. Strict: an unknown key is refused with 400.
 *
 * The api then checks what needs the database: every id must be an order that is `waiting` and in
 * no open round (409 `orders_not_waiting` otherwise, listing the ids). It stores the round (open,
 * phase `confirming`), moves the orders to `pending` with its `roundId`, and sends each one a
 * `confirmRequest`.
 *
 * Output: `personalText` trimmed, `personalText` and `pickupBy` undefined when left empty (the
 * Mongo client is set to `ignoreUndefined`, so they are not stored).
 */
export const planRoundRequestSchema = z.strictObject({
  /** The round's calendar day in Israel, `YYYY-MM-DD`, as an `<input type="date">` sends it. */
  date: z.iso.date({ error: ERR.dateRequired }),
  region: z.enum(regionSchema.options, { error: ERR.regionRequired }),
  orderIds: z
    .array(z.string().min(1), { error: ERR.noOrders })
    .min(1, ERR.noOrders)
    // spec §1: a round of more than 25 stops is out of the MVP.
    .max(MAX_ROUND_ORDERS, ERR.tooManyOrders)
    // A duplicate would send the same customer two confirmation requests.
    .refine((orderIds) => new Set(orderIds).size === orderIds.length, {
      error: ERR.duplicateOrders,
    }),
  personalText: personalTextInputSchema,
  pickupBy: pickupByInputSchema,
});

/** What the planning screen sends: the fields as typed, '' for an empty optional field. */
export type PlanRoundRequest = z.input<typeof planRoundRequestSchema>;
/** The plan after validation: what the api stores as a new round. */
export type PlanRound = z.output<typeof planRoundRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Success responses: the round's view
// ---------------------------------------------------------------------------------------------

/**
 * The groups of a round's confirmation step, in screen order (spec §3.6): who confirmed, who did
 * not yet, and who asked for another date.
 */
export const ROUND_GROUP_KEYS = ['confirmed', 'pending', 'otherDate'] as const;
export type RoundGroupKey = (typeof ROUND_GROUP_KEYS)[number];

/** Hebrew title of each group (spec §3.6: "מי אישר, מי עוד לא, ומי ביקש מועד אחר"). */
export const ROUND_GROUP_LABELS: Readonly<Record<RoundGroupKey, string>> = {
  confirmed: 'אישרו',
  pending: 'עוד לא אישרו',
  otherDate: 'ביקשו מועד אחר',
};

/**
 * A round as Yoel's screens get it: the stored round without `orderIds` and `stops`. The orders
 * come in the view's groups instead, and the route has its own screen. Built from the stored
 * round's schema, so the ISO dates of the api's JSON parse back into `Date`s on the web.
 */
export const collectorRoundSchema = roundSchema.pick({
  id: true,
  date: true,
  region: true,
  status: true,
  phase: true,
  personalText: true,
  pickupBy: true,
  createdAt: true,
  closedAt: true,
});
export type CollectorRound = z.infer<typeof collectorRoundSchema>;

/** One group of the round's confirmation step, with its orders in plan order. */
export const roundOrderGroupSchema = z.object({
  key: z.enum(ROUND_GROUP_KEYS),
  orders: z.array(collectorOrderSchema),
});
export type RoundOrderGroup = z.infer<typeof roundOrderGroupSchema>;

/**
 * One round with its orders, as the round screen shows it; see {@link buildRoundView}. Body of a
 * 201 from POST /api/collector/rounds, and of a 200 from GET /api/collector/rounds/:id and from
 * POST /api/collector/rounds/:id/orders/:orderId/confirm-by-phone.
 */
export const roundViewSchema = z.object({
  round: collectorRoundSchema,
  /** Always the three groups in {@link ROUND_GROUP_KEYS} order, empty ones too. */
  groups: z.array(roundOrderGroupSchema),
  /** The "שלח" rows of the confirmation requests, one per customer who has not confirmed yet. */
  sendList: z.array(messageLinkSchema),
});
export type RoundView = z.infer<typeof roundViewSchema>;

/** Body of a 200 from GET /api/collector/rounds. */
export const roundsResponseSchema = z.object({
  /** The OPEN rounds, by date, then by when they were created. */
  rounds: z.array(roundViewSchema),
  /**
   * `pickupBy` of the most recently created round, open or closed: the planning screen pre-fills
   * "עד איזו שעה להוציא את הבקבוקים" with it (ADR-0003). Absent when that round had none.
   */
  previousPickupBy: pickupTimeSchema.optional(),
});
export type RoundsResponse = z.infer<typeof roundsResponseSchema>;

/**
 * The group an order of the round is shown in, or `undefined` for none:
 * - still in this round (`roundId`) and `confirmed` (or already `collected`): "אישרו".
 * - still in this round and `pending`: "עוד לא אישרו".
 * - out of this round, and it left this round because the customer asked for another date (its
 *   `lastMiss` is this round, reason `askedOtherDate`: "לא מתאים הפעם" on the customer's page):
 *   "ביקשו מועד אחר".
 * Anything else is in no group: an order cancelled while in the round, and one that left it for
 * another reason (it changed its address, or did not confirm in time), since the group's title
 * says what they asked for and they did not ask for it.
 */
function roundGroupOf(round: Round, order: Order): RoundGroupKey | undefined {
  if (order.roundId === round.id) {
    if (order.status === 'confirmed' || order.status === 'collected') return 'confirmed';
    if (order.status === 'pending') return 'pending';
    return undefined;
  }
  const askedOtherDate =
    order.lastMiss?.roundId === round.id && order.lastMiss.reason === 'askedOtherDate';
  return askedOtherDate ? 'otherDate' : undefined;
}

/**
 * A round and its orders as the round screen shows them (spec §3.6, step 1). Pure, and here
 * rather than in the api, so it is tested once without a database.
 *
 * - Walks `round.orderIds` in plan order and looks each up in `orders`; an id with no order given
 *   is skipped, and so is an order given whose id is not in the round.
 * - Puts each order in its group (see `roundGroupOf`), as Yoel's screens get an order
 *   ({@link toCollectorOrder}). All three groups are returned, in {@link ROUND_GROUP_KEYS} order.
 *   An order that left the round is in "ביקשו מועד אחר" only for the reason `askedOtherDate`;
 *   for any other reason it is in no group.
 * - `sendList`: the latest confirmation request ({@link toMessageLink}) of each `pending` order,
 *   in the same order. A confirmed customer needs no request, so the list shrinks as people
 *   confirm; an order whose newest request is not a wa.me link has no row.
 * - `round` without `orderIds` and `stops` ({@link collectorRoundSchema}).
 */
export function buildRoundView(round: Round, orders: readonly Order[]): RoundView {
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  const ordersByGroup: Record<RoundGroupKey, Order[]> = {
    confirmed: [],
    pending: [],
    otherDate: [],
  };
  for (const orderId of round.orderIds) {
    const order = ordersById.get(orderId);
    if (order === undefined) continue;
    const key = roundGroupOf(round, order);
    if (key !== undefined) ordersByGroup[key].push(order);
  }
  return {
    round: collectorRoundSchema.parse(round),
    groups: ROUND_GROUP_KEYS.map((key) => ({
      key,
      orders: ordersByGroup[key].map(toCollectorOrder),
    })),
    sendList: ordersByGroup.pending
      .map((order) => toMessageLink(order, 'confirmRequest'))
      .filter((link) => link !== undefined),
  };
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Plain-Hebrew messages of the round screens that Yoel sees. */
export const ROUND_MESSAGES = {
  /** Some marked order was meanwhile cancelled, edited away or put in another round. */
  ordersNotWaiting: 'חלק מההזמנות כבר לא ממתינות לסבב. נא לרענן את הרשימה ולנסות שוב.',
  roundNotFound: 'הסבב לא נמצא.',
  /** "אישר בטלפון" after the round was routed or closed. */
  confirmationsClosed: 'האישורים לסבב הזה כבר נסגרו.',
} as const;

// The bodies below follow ApiErrorBody (index.ts): a stable `error` code, plus a Hebrew `message`
// where Yoel sees it. Standalone, like collectorOrdersApi.ts, because index.ts re-exports this
// file and importing back from it would be circular.

/**
 * 400 from POST /api/collector/rounds: the plan did not validate. `fieldErrors` maps a field
 * (`date`, `region`, `orderIds`, `personalText`, `pickupBy`) to its first plain-Hebrew message
 * from {@link ROUND_PLAN_ERRORS}, built with orderApi.ts's `formFieldErrors`.
 */
export interface InvalidRoundErrorBody {
  error: 'invalid_round';
  fieldErrors: Record<string, string>;
}

/**
 * 409 from POST /api/collector/rounds: the listed ids are unknown, no longer `waiting`, or already
 * in a round, so nothing was planned. `message` is {@link ROUND_MESSAGES}.ordersNotWaiting; the
 * screen can unmark `orderIds` after it refreshes.
 */
export interface OrdersNotWaitingErrorBody {
  error: 'orders_not_waiting';
  message: string;
  orderIds: string[];
}

/**
 * 404 from /api/collector/rounds/:id and its sub-routes: no round has this id, or the id is not
 * one at all. The web app shows {@link ROUND_MESSAGES}.roundNotFound.
 */
export interface RoundNotFoundErrorBody {
  error: 'round_not_found';
}

/**
 * 409 from "אישר בטלפון": the round is closed, or its confirmations are closed (phase `routed`).
 * `message` is {@link ROUND_MESSAGES}.confirmationsClosed. The customer's own confirm
 * (customerOrderApi.ts) answers the same body, with the customer's message.
 */
export interface ConfirmationsClosedErrorBody {
  error: 'confirmations_closed';
  message: string;
}

/**
 * Every error body /api/collector/rounds adds to the ones every route may answer (ApiErrorBody).
 * "אישר בטלפון" also answers `order_not_found` (404) for an order that is not in the round, and
 * `invalid_transition` (409) for one that can no longer be confirmed. A 401 comes from the login
 * guard: authApi.ts's `UnauthenticatedErrorBody`.
 */
export type CollectorRoundErrorBody =
  | InvalidRoundErrorBody
  | OrdersNotWaitingErrorBody
  | RoundNotFoundErrorBody
  | ConfirmationsClosedErrorBody
  | OrderNotFoundErrorBody
  | InvalidTransitionErrorBody;
