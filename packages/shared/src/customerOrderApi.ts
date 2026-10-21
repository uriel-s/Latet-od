// The contract of /api/o/:token (spec §3.3, the customer's own page `/o/<token>`): what the page
// shows of the order, the change the customer may make (address, quantity, note), the business
// rule of when that change takes the order out of its round, and the error bodies with their
// plain-Hebrew messages. The routes are public and reached by the order's random token only,
// never by its id. apps/api implements them with this file and apps/web's page calls them, so the
// two sides agree on one definition.
//
// The routes, each answering 200 with a CustomerOrderResponse (the order as it is now):
// - GET    /api/o/:token          the page. Changes nothing: WhatsApp's link preview sends a GET.
// - POST   /api/o/:token/confirm  "כן, אוציא את הבקבוקים": pending → confirmed. A second tap succeeds too.
// - POST   /api/o/:token/decline  "לא מתאים הפעם": the order leaves its round, back to `waiting`
//                                 with `lastMiss` reason `askedOtherDate`, so Yoel's round screen
//                                 shows it under "ביקשו מועד אחר".
// - POST   /api/o/:token/cancel   "ביטול": → cancelled. A second tap succeeds too.
// - PATCH  /api/o/:token          "שינוי": address, quantity, note; body
//                                 customerUpdateOrderRequestSchema.
import { z } from 'zod';
import type { InvalidTransitionErrorBody, OrderNotFoundErrorBody } from './collectorOrdersApi.ts';
import {
  addressInputSchema,
  orderFormSchema,
  orderSchema,
  type Address,
  type Order,
} from './order.ts';
import { orderSummarySchema, type InvalidOrderErrorBody } from './orderApi.ts';
import type { OrderStatus } from './orderStatus.ts';
import { roundSchema, type Round } from './round.ts';
import type { ConfirmationsClosedErrorBody } from './roundsApi.ts';

// ---------------------------------------------------------------------------------------------
// Success response (200)
// ---------------------------------------------------------------------------------------------

/**
 * The round as the customer's page shows it: its day ("נתראה ב-<תאריך>", spec §3.3) and, when
 * Yoel set one, the time to put the bottles out by (ADR-0003). Picked from the stored round's own
 * schema, so never its id, region, orders or stops: those would tell the customer about others.
 */
const customerRoundSchema = roundSchema.pick({ date: true, pickupBy: true, pickupFrom: true });

/**
 * What the customer's own page sees of the order (spec §3.3). An allow-list, like
 * `orderSummarySchema` it extends: the thank-you screen's name, phone, address and bottles, plus
 * the status the page is drawn by and the round the order is in. zod objects strip unknown keys,
 * also inside `contact` and `address`, so parsing a whole stored order keeps only these fields.
 *
 * Never here: `id` (guessable; the page is reached by token only), `token` (the caller already
 * holds it), `roundId`, `region`, `source`, `lastMiss`, the message log, `contact.method`,
 * `address.nearStreetCode` (Yoel's, ADR-0005) and the dates. A field added to the order later
 * stays internal until it is added here on purpose.
 *
 * No dates either, so the order survives JSON unchanged.
 */
export const customerOrderSchema = orderSummarySchema.extend({
  status: orderSchema.shape.status,
  /**
   * The round the order is in, while the customer has something to do with it: present for a
   * `pending` order (the date to confirm) and a `confirmed` one ("נתראה ב-<תאריך>"), absent
   * otherwise. See {@link toCustomerOrder}.
   */
  round: customerRoundSchema.optional(),
});
export type CustomerOrder = z.infer<typeof customerOrderSchema>;

/**
 * The statuses whose page shows the round's date (spec §3.3): `pending` asks to confirm that
 * date, `confirmed` says "נתראה ב-<תאריך>". A `waiting` order is in no round, and a collected or
 * cancelled one is done: its page shows thanks and "הזמנה חדשה", not a date.
 */
const ROUND_SHOWN_STATUSES: readonly OrderStatus[] = ['pending', 'confirmed'];

/**
 * A stored order as its customer's page gets it: only the fields of {@link customerOrderSchema}.
 *
 * `round` is the given round's date, `pickupBy` and `pickupFrom`, set only when the order is still in that
 * round (`order.roundId === round.id`) and its status is `pending` or `confirmed`. Otherwise the
 * key is absent, not `undefined`. The api passes the round it looked up by `order.roundId`, or
 * nothing when the order has none; checking the id here as well means a wrong round is never
 * shown as the customer's.
 */
export function toCustomerOrder(order: Order, round: Round | null | undefined): CustomerOrder {
  const showsRound =
    round !== null &&
    round !== undefined &&
    order.roundId === round.id &&
    ROUND_SHOWN_STATUSES.includes(order.status);
  // The whole round goes in, and the schema keeps only its date, pickupBy and pickupFrom. Without the round,
  // the order alone: a `round: undefined` key would survive the parse, since zod keeps a key that
  // is present.
  return customerOrderSchema.parse(showsRound ? { ...order, round } : order);
}

/**
 * Body of a 200 from every /api/o/:token route: GET, POST confirm / decline / cancel and PATCH.
 * The order as it is now, so the page draws what was stored rather than what it sent. The web
 * page parses the response with this schema.
 */
export const customerOrderResponseSchema = z.object({
  order: customerOrderSchema,
});
export type CustomerOrderResponse = z.infer<typeof customerOrderResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Request: PATCH /api/o/:token ("שינוי")
// ---------------------------------------------------------------------------------------------

/**
 * Body of PATCH /api/o/:token (spec §3.3): "אפשר לשנות כתובת, כמות והערה. לא את הטלפון." The
 * note is `address.note`, so it comes with the address. Every key is optional; at least one must
 * be present, since a PATCH with nothing to change is a client bug.
 *
 * Strict: an unknown key is refused with 400. Above all `contact`: the phone is how one open
 * order per phone is kept (spec §3.1), and the name is not on the spec's list either. And
 * `status`: a status change has its own route.
 *
 * Keys, with the booking form's own rules and Hebrew messages (they are its schemas):
 * - `address`: replaces the stored address as a whole. It never carries `nearStreetCode`, which
 *   only Yoel sets (ADR-0005). When the order is in a round and the street or house number
 *   changes ({@link isLocationChange}), the api takes it out of the round: back to `waiting`,
 *   `lastMiss` reason `addressChanged`.
 * - `bottlesEstimated`: at least 30.
 */
export const customerUpdateOrderRequestSchema = z
  .strictObject({
    address: addressInputSchema.optional(),
    bottlesEstimated: orderFormSchema.shape.bottlesEstimated.optional(),
  })
  .refine((update) => Object.values(update).some((value) => value !== undefined), {
    error: 'expected at least one field to change',
  });

/** What the page's change form sends: strings as typed, the bottles possibly as a string. */
export type CustomerUpdateOrderRequest = z.input<typeof customerUpdateOrderRequestSchema>;
/** The PATCH after validation: what the api applies to the stored order. */
export type CustomerUpdateOrder = z.output<typeof customerUpdateOrderRequestSchema>;

/**
 * The fields of an address that say where the house is, as {@link isLocationChange} compares
 * them. Not location.ts's `AddressLocationKeys`: those are the codes that give the region and the
 * map point; this is the place the customer wrote.
 */
export type AddressPlace = Pick<Address, 'streetCode' | 'streetName' | 'houseNumber'>;

/**
 * Whether a change of address moves the pickup to another place: the street code, the street
 * name or the house number differ.
 *
 * The business rule (spec §3.3): "שינוי כתובת אחרי שההזמנה נכנסה לסבב מוציא אותה מהסבב". A
 * change of WHERE, because the round was planned, and its route will be built, for the old place.
 * A change of where the bottles wait at the same house (`bottlesSpot`, `floorApt`), of the note,
 * or of the number of bottles does not take the order out of its round. The api's PATCH applies
 * the rule, and the web page uses it to warn the customer before saving.
 *
 * Compare like with like: the stored address and the PATCH's address after
 * {@link customerUpdateOrderRequestSchema}, which trims the text and gives a listed street its
 * official name, as the stored one has.
 */
export function isLocationChange(before: AddressPlace, after: AddressPlace): boolean {
  return (
    before.streetCode !== after.streetCode ||
    before.streetName !== after.streetName ||
    before.houseNumber !== after.houseNumber
  );
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/**
 * Plain-Hebrew messages of the customer's page that the customer sees. A 400 is
 * `InvalidOrderErrorBody`, whose field messages are the booking form's own.
 */
export const CUSTOMER_ORDER_MESSAGES = {
  /** "כן, אוציא את הבקבוקים" after Yoel closed the confirmations. Exactly the spec's text (§3.3). */
  confirmationsClosed: 'האישור נסגר. נחזור אליך עם מועד חדש.',
  /** Any change to an order that was collected or cancelled meanwhile. */
  orderClosed: 'ההזמנה כבר נסגרה, ואי אפשר לשנות אותה.',
  /** An unknown token. Most likely a link cut short when it was copied, so the text says so. */
  orderNotFound: 'לא מצאנו את ההזמנה. ייתכן שהקישור לא הועתק עד הסוף.',
} as const;

/**
 * Every error body /api/o/:token adds to the ones every route may answer (ApiErrorBody in
 * index.ts). The bodies are the collector routes' own, imported as types from their modules
 * (not from index.ts, which re-exports this file: that would be circular):
 * - 404 `order_not_found` (`OrderNotFoundErrorBody`), from every route: no order has this token,
 *   or the token is not one at all (malformed, forged). The identical body for both, so an answer
 *   never tells a guess anything. The page shows {@link CUSTOMER_ORDER_MESSAGES}.orderNotFound.
 * - 409 `confirmations_closed` (`ConfirmationsClosedErrorBody`), from confirm: the order is not in
 *   a round whose confirmations are open. It left its round (back to `waiting`), or the round's
 *   phase is `routed`, or the round is closed. `message` is
 *   {@link CUSTOMER_ORDER_MESSAGES}.confirmationsClosed.
 * - 409 `invalid_transition` (`InvalidTransitionErrorBody`): the order is collected or cancelled,
 *   so nothing on it changes any more. `message` is {@link CUSTOMER_ORDER_MESSAGES}.orderClosed.
 * - 400 `invalid_order` (`InvalidOrderErrorBody`), from PATCH: the body did not validate.
 *   `fieldErrors` is orderApi.ts's `formFieldErrors`, one plain message per field. A refusal of
 *   the body as a whole (a `contact` or other unknown key, or nothing to change) has no field to
 *   show it, so it adds nothing to `fieldErrors`: a body refused only for that has `{}`.
 */
export type CustomerOrderErrorBody =
  | OrderNotFoundErrorBody
  | InvalidOrderErrorBody
  | ConfirmationsClosedErrorBody
  | InvalidTransitionErrorBody;
