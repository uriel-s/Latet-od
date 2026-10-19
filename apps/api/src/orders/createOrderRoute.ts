// POST /api/orders: the public booking form (spec §3.1, §7). A request passes the per-IP rate
// limit, is validated with the shared form schema, is checked against the spam honeypot, and is
// stored as a `waiting` order; the answer is the customer's token and a summary of their order,
// nothing else. createApp mounts the handlers built here; the order itself is built by
// newOrderFromForm and stored through OrdersRepo.
import type { RequestHandler } from 'express';
import {
  CREATE_ORDER_MESSAGES,
  ORDER_HONEYPOT_FIELD,
  formFieldErrors,
  orderFormSchema,
  toOrderSummary,
  type CreateOrderResponse,
  type DuplicateOpenOrderErrorBody,
  type InvalidOrderErrorBody,
  type Order,
} from '@bottlerun/shared';
import type { AppDeps } from '../deps.ts';
import { rateLimitByIp } from '../rateLimit.ts';
import { newOrderFromForm, newOrderToken } from './newOrderFromForm.ts';
import { DuplicateOpenOrderError } from './ordersRepo.ts';

/**
 * Per-IP limit of POST /api/orders: 10 requests per IP per hour (spec §7, "מגבלת קצב פשוטה לפי IP").
 *
 * Spec §7 dropped v1's 3 requests per IP per day: many mobile customers share one IP (carrier
 * NAT), so a tight limit would block real customers. At about 1.5 orders a day, 10 an hour never
 * blocks a real customer (the web form validates before sending and retries a network error only
 * once), yet it stops a script. The main protection is one open order per phone, not this limit.
 */
export const ORDER_RATE_LIMIT = { max: 10, windowMs: 60 * 60 * 1000 } as const;

/**
 * The handlers of POST /api/orders, in order: the per-IP rate limit ({@link ORDER_RATE_LIMIT}),
 * then the route itself. Mount them with `app.post('/api/orders', ...createOrderHandlers(deps))`.
 *
 * Answers:
 * - 201 {@link CreateOrderResponse}: `{ token, order }` only, the token being the secret of the
 *   customer's page `/o/<token>` (spec §3.3).
 * - 400 {@link InvalidOrderErrorBody}: the form did not validate (also: no body, or not an object).
 * - 409 {@link DuplicateOpenOrderErrorBody}: the phone already has an open order (spec §3.1).
 * - 429 `rate_limited`: too many requests from this IP.
 * - 201 with a fake token when the honeypot field is filled: nothing is stored (spec §7).
 *
 * Logs nothing itself: the body holds a phone and an address (spec §7, no request content in the
 * logs). An unexpected error goes to the app's error handler, which logs it safely and answers 500.
 */
export function createOrderHandlers(deps: Pick<AppDeps, 'orders' | 'attempts'>): RequestHandler[] {
  // Runs before the route, so every request counts: invalid, duplicate and honeypot ones too.
  // Counting the 409s also slows anyone probing which phones have an open order.
  const rateLimit = rateLimitByIp({
    attempts: deps.attempts,
    keyPrefix: 'order:ip',
    ...ORDER_RATE_LIMIT,
    message: CREATE_ORDER_MESSAGES.rateLimited,
  });

  const createOrder: RequestHandler = async (req, res) => {
    // Every answer of the route: a 201 carries the secret token, and no answer to a booking is
    // worth keeping in a cache.
    res.set('Cache-Control', 'no-store');

    // Express 5 leaves `req.body` undefined when no JSON body was sent; safeParse turns that into
    // a 400 too (with no field errors, since no field can show it).
    const body: unknown = req.body;
    const parsed = orderFormSchema.safeParse(body);
    if (!parsed.success) {
      const invalid: InvalidOrderErrorBody = {
        error: 'invalid_order',
        fieldErrors: formFieldErrors(parsed.error),
      };
      res.status(400).json(invalid);
      return;
    }
    const form = parsed.data;

    // Checked after validation on purpose: a bot that fills the hidden field gets exactly what a
    // real success looks like (status, shape, a well-formed token that opens nothing), so it
    // cannot tell it was caught. A real customer never fills the hidden field, and the web form
    // validates with the same schema before sending, so no person ever lands here. The repo is
    // not called at all: nothing stored, nothing looked up.
    if (isHoneypotFilled(body)) {
      const fake: CreateOrderResponse = { token: newOrderToken(), order: toOrderSummary(form) };
      res.status(201).json(fake);
      return;
    }

    // No findOpenByPhone first: the repo enforces one open order per phone atomically (in Mongo,
    // a partial unique index), so a pre-check would cost a call and still race with a double tap.
    let order: Order;
    try {
      order = await deps.orders.create(newOrderFromForm(form, { now: new Date(), source: 'form' }));
    } catch (error) {
      if (error instanceof DuplicateOpenOrderError) {
        // Only the fixed message, and nothing else happens: no message is sent to the phone and
        // the existing order and its token are never in the answer, because anyone can type
        // someone else's number (spec §3.1).
        const duplicate: DuplicateOpenOrderErrorBody = {
          error: 'duplicate_open_order',
          message: CREATE_ORDER_MESSAGES.duplicateOpenOrder,
        };
        res.status(409).json(duplicate);
        return;
      }
      // A bug or an outage: the error handler logs it without its message and answers 500.
      throw error;
    }

    const created: CreateOrderResponse = { token: order.token, order: toOrderSummary(order) };
    res.status(201).json(created);
  };

  return [rateLimit, createOrder];
}

/**
 * True when the request filled the hidden honeypot field ({@link ORDER_HONEYPOT_FIELD}). The
 * parsed form has no such field (the schema strips unknown keys), so it is read from the raw body,
 * which may be anything a client sent.
 *
 * Absent, `null`, `''` and whitespace-only text count as empty, as the web form sends it. Any
 * other value is filled, a non-string one too (a number, an object): the form never sends one.
 */
function isHoneypotFilled(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  // Own keys only: a parsed JSON body has every field as an own key, and this never reads the
  // prototype.
  if (!Object.hasOwn(body, ORDER_HONEYPOT_FIELD)) return false;
  const value: unknown = (body as Record<string, unknown>)[ORDER_HONEYPOT_FIELD];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}
