// The contract of /api/collector/rounds (spec §3.5 "תכנון סבב", §3.6 step 1 "אישורים" and step 2
// "מסלול"): planning a round, the round's view with its orders in three groups, its "שלח" list and
// its route's stops, "אישר בטלפון", building the route ("סגור אישורים ובנה מסלול"), moving a stop
// up or down, the two stop actions "אספתי" (collected, with its "שלח תודה" row) and "לא נמצא"
// (not found), closing the round ("סגור סבב", no body: its answer is the round's view), and the
// error bodies with their plain-Hebrew messages. Every route is behind
// requireCollector (ADR-0004). apps/api implements the routes with it and apps/web's screens call
// them, so the two sides agree on one definition.
import { z } from 'zod';
import {
  collectorOrderSchema,
  toCollectorOrder,
  type InvalidTransitionErrorBody,
  type OrderNotFoundErrorBody,
} from './collectorOrdersApi.ts';
import { messageLinkSchema, pickupTimeSchema, toMessageLink } from './messages.ts';
import { MAX_BOTTLES, type Order } from './order.ts';
import { MAX_ROUND_ORDERS, roundSchema, roundStopSchema, type Round } from './round.ts';
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
 * come in the view instead: in its groups (step 1) and, with their details, in its `stops`
 * (step 2). Built from the stored round's schema, so the ISO dates of the api's JSON parse back
 * into `Date`s on the web.
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
 * Where one stop of the route is (spec §3.6 step 2, §4). A stop stores no state of its own: it is
 * derived from its order by {@link roundStopStateOf}, so "אספתי", "לא נמצא" and a customer's
 * cancel change only the order, and the route can never disagree with it.
 * - `toCollect`: still in this round, confirmed (or pending): Yoel has yet to stop there.
 * - `collected`: "אספתי" was tapped. Final.
 * - `notFound`: "לא נמצא": the order went back to `waiting`, but stays in the route, shown as
 *   handled, so Yoel sees what happened at that stop.
 * - `cancelled`: the customer or Yoel cancelled it while it was in the round. Final.
 * - `left`: it left the round another way (changed its address, or asked for another date), so
 *   there is nothing to do at that stop any more.
 */
export const ROUND_STOP_STATES = [
  'toCollect',
  'collected',
  'notFound',
  'cancelled',
  'left',
] as const;
/** One of {@link ROUND_STOP_STATES}. */
export const roundStopStateSchema = z.enum(ROUND_STOP_STATES);
/** Where one stop of the route is; see {@link ROUND_STOP_STATES}. */
export type RoundStopState = z.infer<typeof roundStopStateSchema>;

/**
 * One stop of a routed round, as the route screen shows it: the order with its details, in the
 * route's driving order.
 */
export const routeStopViewSchema = z.object({
  order: collectorOrderSchema,
  /**
   * The STORED stop's `hasLocation`, from when the route was built, not the order's current one
   * (`order.hasLocation`). If Yoel picks a near street later, the stop stays where `planRoute` put
   * it (at the end), and the "בלי מיקום" tag still explains why it is there (round.ts).
   */
  hasLocation: roundStopSchema.shape.hasLocation,
  /** Derived from the order, never stored; see {@link roundStopStateOf}. */
  state: roundStopStateSchema,
  /**
   * The stop's "שלח תודה" row: the NEWEST `thankYou` entry of the order as a wa.me link
   * (`toMessageLink(order, 'thankYou')`). Set only while `state` is `collected`, and left out
   * (not set to undefined) otherwise, or when that newest entry is not a `manual` link (it failed,
   * or was sent automatically). This is how the "אספתי" response returns the wa.me link, and how
   * the route screen and "סגור סבב" find it again after a refresh: an unsent thank-you is a
   * collected stop whose `thankYou` has no `openedAt`.
   */
  thankYou: messageLinkSchema.optional(),
});
export type RouteStopView = z.infer<typeof routeStopViewSchema>;

/**
 * One round with its orders, as the round screen shows it; see {@link buildRoundView}. Body of a
 * 201 from POST /api/collector/rounds, and of a 200 from GET /api/collector/rounds/:id, from
 * POST /api/collector/rounds/:id/orders/:orderId/confirm-by-phone, from
 * POST /api/collector/rounds/:id/route, from POST /api/collector/rounds/:id/stops/:orderId/move,
 * from the two stop actions POST /api/collector/rounds/:id/stops/:orderId/collected and
 * .../not-found, and from "סגור סבב" POST /api/collector/rounds/:id/close (the round `closed`,
 * with `closedAt`, in the phase it was closed in; its unhandled orders sent back to `waiting`).
 */
export const roundViewSchema = z.object({
  round: collectorRoundSchema,
  /** Always the three groups in {@link ROUND_GROUP_KEYS} order, empty ones too. */
  groups: z.array(roundOrderGroupSchema),
  /** The "שלח" rows of the confirmation requests, one per customer who has not confirmed yet. */
  sendList: z.array(messageLinkSchema),
  /**
   * The route's stops in driving order. Always present: empty until the route is built (phase
   * `confirming`); a closed round that was routed keeps its stops.
   */
  stops: z.array(routeStopViewSchema),
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
 * The state of `order`'s stop in `round`'s route (see {@link ROUND_STOP_STATES}), derived from
 * the order alone:
 * - still in this round (`roundId`): `collected` and `cancelled` as its status says, and
 *   `toCollect` while it is `confirmed` (or `pending`, which a routed round does not normally
 *   have: building the route sends whoever did not confirm back to `waiting`).
 * - out of this round, and its `lastMiss` is this round with reason `notFound`: `notFound`.
 * - anything else: `left`.
 *
 * `collected` and `cancelled` count only while `roundId` is this round. Both keep the order's
 * `roundId` (collectorOrdersRoutes.ts), so a stop collected or cancelled here is found by it; an
 * order that was not found here and was collected or cancelled LATER, in another round or while
 * waiting, stays `notFound` in this round's route, which is what happened at this stop.
 *
 * `notFound` works because "לא נמצא" stores `lastMiss { roundId: this round, reason: 'notFound' }`
 * and unsets `roundId`. Known limit: only one `lastMiss` is kept (spec §4), so if the same order
 * later leaves ANOTHER round uncollected (did not confirm in time, asked for another date, not
 * found again, ...), its `lastMiss` points at that round and this round's stop then shows `left`.
 * That is still a handled state, never `toCollect`, so the route screen and "סגור סבב" (which
 * touches only `toCollect` stops) are unaffected; only this old stop's history label loses
 * "לא נמצא".
 */
export function roundStopStateOf(round: Round, order: Order): RoundStopState {
  if (order.roundId === round.id) {
    if (order.status === 'collected') return 'collected';
    if (order.status === 'cancelled') return 'cancelled';
    if (order.status === 'confirmed' || order.status === 'pending') return 'toCollect';
  }
  const notFoundHere = order.lastMiss?.roundId === round.id && order.lastMiss.reason === 'notFound';
  return notFoundHere ? 'notFound' : 'left';
}

/**
 * A round and its orders as the round screen shows them (spec §3.6, steps 1 and 2). Pure, and
 * here rather than in the api, so it is tested once without a database. The api passes the
 * orders of `orders.list({ ids: round.orderIds })`: the stops' ids are always a subset of
 * `orderIds` (the route is built from the round's own orders), so that list has them all.
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
 * - `stops`: walks `round.stops` in their STORED driving order (not plan order), skipping a stop
 *   whose order is not given. Each has the order ({@link toCollectorOrder}), the stored
 *   `hasLocation`, and the state from {@link roundStopStateOf}. Empty until the route is built.
 *   A `collected` stop also gets its `thankYou` row ({@link toMessageLink}) when the newest
 *   thank-you is a wa.me link; any other stop never has the key, even if its order holds a
 *   thank-you from before.
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
    stops: round.stops.flatMap((stop) => {
      const order = ordersById.get(stop.orderId);
      if (order === undefined) return [];
      const state = roundStopStateOf(round, order);
      // Only a collected stop has a thank-you to send; an older one (an earlier round's) on an
      // order that is not collected here must not show a "שלח תודה" row.
      const thankYou = state === 'collected' ? toMessageLink(order, 'thankYou') : undefined;
      return [
        {
          order: toCollectorOrder(order),
          hasLocation: stop.hasLocation,
          state,
          // Left out rather than set to undefined, like toMessageLink's `openedAt`.
          ...(thankYou === undefined ? {} : { thankYou }),
        },
      ];
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Request: POST /api/collector/rounds/:id/stops/:orderId/move
// ---------------------------------------------------------------------------------------------

/**
 * Which way Yoel moves a stop in the stored route (spec §3.6 step 2): `up` is one place earlier
 * in the route, `down` one place later. One place per tap keeps the route screen simple; the rest
 * of the route stays as `planRoute` built it.
 */
export const STOP_MOVE_DIRECTIONS = ['up', 'down'] as const;

/**
 * Body of POST /api/collector/rounds/:id/stops/:orderId/move. Strict: anything but
 * `{ direction: 'up' | 'down' }` is refused with 400 `invalid_move`.
 */
export const moveStopRequestSchema = z.strictObject({
  direction: z.enum(STOP_MOVE_DIRECTIONS),
});
export type MoveStopRequest = z.infer<typeof moveStopRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Request: POST /api/collector/rounds/:id/stops/:orderId/collected ("אספתי")
// ---------------------------------------------------------------------------------------------

/** Plain-Hebrew messages of "אספתי", shown next to the quantity field. */
export const COLLECT_STOP_ERRORS = {
  bottlesInvalid: 'נא לכתוב כמה בקבוקים נאספו, מספר שלם מ-1 ומעלה',
  bottlesTooMany: `אפשר לכתוב עד ${MAX_BOTTLES} בקבוקים`,
} as const;

/**
 * Body of POST /api/collector/rounds/:id/stops/:orderId/collected ("אספתי", spec §3.6 step 2).
 * Strict: an unknown key is refused with 400 `invalid_collect`.
 *
 * `bottlesCollected` is how many bottles Yoel really took: a JSON number, a whole one from 1 up
 * to {@link MAX_BOTTLES} (a string such as "40", 0, a negative or a fraction is refused). Below
 * MIN_BOTTLES (30) IS allowed: the minimum is a booking rule, and the real count can be lower than
 * the customer's estimate. Absent means the order's `bottlesEstimated`, which the api fills in.
 * The api treats a missing body (Express 5 leaves `req.body` undefined) like `{}`.
 *
 * The api then moves the order `confirmed` → `collected`, sets `collectedAt`, and sends a
 * `thankYou`; the 200 is the round's view, whose stop carries the "שלח תודה" row
 * ({@link routeStopViewSchema}'s `thankYou`). Idempotent: "אספתי" on a stop already collected
 * answers 200 again and sends no second thank-you.
 */
export const collectStopRequestSchema = z.strictObject({
  bottlesCollected: z
    .int({ error: COLLECT_STOP_ERRORS.bottlesInvalid })
    .min(1, COLLECT_STOP_ERRORS.bottlesInvalid)
    .max(MAX_BOTTLES, COLLECT_STOP_ERRORS.bottlesTooMany)
    .optional(),
});
/** What the route screen sends on "אספתי": the count, or nothing for the estimate. */
export type CollectStopRequest = z.input<typeof collectStopRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Plain-Hebrew messages of the round screens that Yoel sees. */
export const ROUND_MESSAGES = {
  /** Some marked order was meanwhile cancelled, edited away or put in another round. */
  ordersNotWaiting: 'חלק מההזמנות כבר לא ממתינות לסבב. נא לרענן את הרשימה ולנסות שוב.',
  roundNotFound: 'הסבב לא נמצא.',
  /**
   * "אישר בטלפון" after the round was routed or closed; also "סגור אישורים ובנה מסלול" on a round
   * that is already routed or closed (a second tap, or another tab).
   */
  confirmationsClosed: 'האישורים לסבב הזה כבר נסגרו.',
  /**
   * A stop action or a move on a round whose route is not built yet (phase `confirming`), or that
   * is closed: the screen is stale, so refreshing shows the round as it is.
   */
  routeNotOpen: 'אין מסלול פתוח בסבב הזה. נא לרענן את המסך.',
  /** Moving the first stop up, or the last one down. */
  stopAtEdge: 'העצירה כבר בקצה המסלול.',
  /**
   * A stop action on a stop already handled another way ("אספתי" on one not found, "לא נמצא" on
   * one collected, ...): the screen is stale, so refreshing shows what happened there.
   */
  stopHandled: 'העצירה הזאת כבר טופלה. נא לרענן את המסך.',
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
 * 409 from "אישר בטלפון" and from "סגור אישורים ובנה מסלול" (POST /api/collector/rounds/:id/route):
 * the round is closed, or its confirmations are closed (phase `routed`), so neither a phone
 * confirmation nor a second route build may change it. `message` is
 * {@link ROUND_MESSAGES}.confirmationsClosed. The customer's own confirm (customerOrderApi.ts)
 * answers the same body, with the customer's message.
 */
export interface ConfirmationsClosedErrorBody {
  error: 'confirmations_closed';
  message: string;
}

/**
 * 409 from a stop's action ("אספתי": POST /api/collector/rounds/:id/stops/:orderId/collected,
 * "לא נמצא": .../not-found) or move (.../move): the round has no open route, because it is still
 * `confirming` or it is closed. Only a round in phase `routed` takes them. `message` is
 * {@link ROUND_MESSAGES}.routeNotOpen.
 */
export interface RouteNotOpenErrorBody {
  error: 'route_not_open';
  message: string;
}

/**
 * 409 from a move: the stop is already first (moving `up`) or last (moving `down`), so nothing
 * changed. `message` is {@link ROUND_MESSAGES}.stopAtEdge.
 */
export interface StopAtEdgeErrorBody {
  error: 'stop_at_edge';
  message: string;
}

/**
 * 400 from a move: the body is not `{ direction: 'up' | 'down' }` ({@link moveStopRequestSchema}).
 * No message: only a broken client sends it, Yoel's screen never does.
 */
export interface InvalidMoveErrorBody {
  error: 'invalid_move';
}

/**
 * 409 from a stop action on a stop already handled another way: "אספתי" on a stop that is
 * `notFound`, `cancelled` or `left`, or "לא נמצא" on one that is `collected`, `cancelled` or
 * `left` ({@link ROUND_STOP_STATES}). The SAME action again is not this error: it is an idempotent
 * 200 that changes and sends nothing. `message` is {@link ROUND_MESSAGES}.stopHandled.
 */
export interface StopHandledErrorBody {
  error: 'stop_handled';
  message: string;
}

/**
 * 400 from "אספתי": the body did not validate ({@link collectStopRequestSchema}). `fieldErrors`
 * maps `bottlesCollected` to its plain-Hebrew message from {@link COLLECT_STOP_ERRORS}, built with
 * orderApi.ts's `formFieldErrors`, like {@link InvalidRoundErrorBody}.
 */
export interface InvalidCollectErrorBody {
  error: 'invalid_collect';
  fieldErrors: Record<string, string>;
}

/**
 * Every error body /api/collector/rounds adds to the ones every route may answer (ApiErrorBody).
 * Also, from other files' contracts:
 * - `order_not_found` (404): "אישר בטלפון" for an order that is not in the round, and a move or
 *   a stop action ("אספתי", "לא נמצא") for an order that is not a stop of the round's route.
 * - `invalid_transition` (409): "אישר בטלפון" for an order that can no longer be confirmed.
 * A 401 comes from the login guard: authApi.ts's `UnauthenticatedErrorBody`.
 */
export type CollectorRoundErrorBody =
  | InvalidRoundErrorBody
  | OrdersNotWaitingErrorBody
  | RoundNotFoundErrorBody
  | ConfirmationsClosedErrorBody
  | RouteNotOpenErrorBody
  | StopAtEdgeErrorBody
  | InvalidMoveErrorBody
  | StopHandledErrorBody
  | InvalidCollectErrorBody
  | OrderNotFoundErrorBody
  | InvalidTransitionErrorBody;
