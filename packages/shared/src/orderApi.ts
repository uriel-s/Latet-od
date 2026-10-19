// The contract of POST /api/orders (spec §3.1, §7): what the booking form sends, what the api
// answers on success, and the error bodies with their plain-Hebrew messages. apps/api implements
// the route with it and apps/web's form calls it, so the two sides agree on one definition.
import { z } from 'zod';
import {
  addressSchema,
  orderSchema,
  orderTokenSchema,
  type Order,
  type OrderForm,
  type OrderFormInput,
} from './order.ts';

// ---------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------

/**
 * The hidden anti-spam field of the booking form (spec §7, "שדה honeypot"). The web form renders
 * it off-screen and always sends it empty; bots fill every field they find. A request with it
 * filled gets a fake success and nothing is stored. `orderFormSchema` strips unknown keys,
 * so the api reads this field from the raw body, not from the parsed form.
 */
export const ORDER_HONEYPOT_FIELD = 'website';

/** Body of POST /api/orders: the booking form as typed, plus the (empty) honeypot field. */
export type CreateOrderRequest = OrderFormInput & { [ORDER_HONEYPOT_FIELD]?: string };

// ---------------------------------------------------------------------------------------------
// Success response (201)
// ---------------------------------------------------------------------------------------------

/**
 * The part of an order its customer sees right after booking. An allow-list: zod objects strip
 * unknown keys, also inside the nested `contact` and `address`, so parsing a whole stored order
 * keeps only these fields and drops id, token, status, region, source, the message log,
 * `contact.method`, `address.nearStreetCode` and the dates. A field added to the order later stays
 * internal until it is added here on purpose.
 *
 * The field schemas are the stored order's own, so the phone is E.164 and the bottles are the
 * validated whole number. No dates, so the summary survives JSON unchanged.
 */
export const orderSummarySchema = z.object({
  contact: orderSchema.shape.contact.pick({ name: true, phone: true }),
  address: addressSchema.omit({ nearStreetCode: true }),
  bottlesEstimated: orderSchema.shape.bottlesEstimated,
});
export type OrderSummary = z.infer<typeof orderSummarySchema>;

/**
 * What the customer sees about their own order after booking (the thank-you screen, spec §3.2):
 * name, phone, address and number of bottles, never an internal field.
 *
 * A stored order and the validated form of the same input give the identical summary. The
 * honeypot's fake success relies on this: it answers with the summary of the form, which nothing
 * stored, and a bot cannot tell it from a real answer.
 */
export function toOrderSummary(order: Order | OrderForm): OrderSummary {
  return orderSummarySchema.parse(order);
}

/**
 * Body of a 201 from POST /api/orders. `token` opens the customer's page `/o/<token>` (spec §3.3);
 * it is the only secret in the answer. The web app parses the response with this schema.
 */
export const createOrderResponseSchema = z.object({
  token: orderTokenSchema,
  order: orderSummarySchema,
});
export type CreateOrderResponse = z.infer<typeof createOrderResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Plain-Hebrew messages of POST /api/orders that the customer sees, above the form. */
export const CREATE_ORDER_MESSAGES = {
  /** Exactly the spec's text (§3.1). */
  duplicateOpenOrder: 'כבר יש הזמנה פתוחה למספר הזה.',
  rateLimited: 'יותר מדי ניסיונות. נא לנסות שוב מאוחר יותר.',
} as const;

// The bodies below follow ApiErrorBody (index.ts): a stable `error` code, plus a Hebrew `message`
// where the customer sees it. They are declared standalone because index.ts re-exports this file,
// and importing back from it would be circular.

/**
 * 400: the form did not validate. `fieldErrors` maps a form field's dotted path (`contact.phone`,
 * `address.floorApt`, `bottlesEstimated`) to the first plain-Hebrew message for it; see
 * {@link formFieldErrors}. Never the values that were sent.
 */
export interface InvalidOrderErrorBody {
  error: 'invalid_order';
  fieldErrors: Record<string, string>;
}

/**
 * 409: this phone already has an open order (spec §3.1: one open order per phone). Only the
 * message: never the existing order or its token, because anyone can type someone else's number.
 */
export interface DuplicateOpenOrderErrorBody {
  error: 'duplicate_open_order';
  message: string;
}

/**
 * 429: too many attempts. The booking form counts per IP (spec §7); login reuses this body, and
 * counts failures per IP and from all IPs together (ADR-0004).
 */
export interface RateLimitedErrorBody {
  error: 'rate_limited';
  message: string;
}

/** Every error body POST /api/orders adds to the ones every route may answer (ApiErrorBody). */
export type CreateOrderErrorBody =
  InvalidOrderErrorBody | DuplicateOpenOrderErrorBody | RateLimitedErrorBody;

/**
 * A failed form validation as `{ dottedPath: message }`, one message per field: the first one, so
 * a field shows one plain sentence (spec §7, errors next to the field). The api sends it as the
 * 400 body's `fieldErrors`, and the web form can use it to place each message next to its field.
 *
 * Issues with an empty path are left out: they mean the body was not an object at all, which no
 * field can show. Only the path and the message are read, never `issue.input`, so what the
 * customer typed (phone, address) never reaches the answer.
 */
export function formFieldErrors(error: z.ZodError): Record<string, string> {
  const messagesByPath = new Map<string, string>();
  for (const issue of error.issues) {
    if (issue.path.length === 0) continue;
    const path = issue.path.map(String).join('.');
    if (!messagesByPath.has(path)) messagesByPath.set(path, issue.message);
  }
  // From a Map, not by assignment: a path such as "__proto__" stays an ordinary key.
  return Object.fromEntries(messagesByPath);
}
