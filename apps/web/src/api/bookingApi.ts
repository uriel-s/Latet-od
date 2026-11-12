// The public booking form's endpoint (spec §3.1): POST /api/orders. Sent through `request()`
// (request.ts), which handles what every endpoint shares.
import {
  CREATE_ORDER_MESSAGES,
  createOrderResponseSchema,
  type CreateOrderRequest,
  type CreateOrderResponse,
} from '@bottlerun/shared';
import { type FormErrors } from '../orderForm/formValues.ts';
import {
  globalFetch,
  invalidOrderErrors,
  jsonInit,
  parsed,
  request,
  type FetchFn,
} from './request.ts';

/** How POST /api/orders ended, as the form shows it. */
export type CreateOrderOutcome =
  /** 201: the order exists; `response.token` opens the customer's page `/o/<token>`. */
  | { kind: 'created'; response: CreateOrderResponse }
  /** 400: the api refused a field (normally caught by the same check before sending). */
  | { kind: 'invalid'; errors: FormErrors }
  /** 409: this phone already has an open order (spec §3.1); shown next to the phone field. */
  | { kind: 'duplicate'; message: string }
  /** 429: too many attempts from this IP (spec §7). */
  | { kind: 'rateLimited'; message: string }
  /** No usable answer: two network errors, a 5xx, or an answer the app cannot read. */
  | { kind: 'failed' };

/**
 * Sends the booking form to `POST /api/orders` and turns the answer into a {@link CreateOrderOutcome}.
 *
 * Retries exactly once, and only when fetch itself rejects (a network error: no answer arrived).
 * An HTTP answer is never retried, not even a 500: the route counts every request toward its
 * limit of 10 an hour per IP, and a 500 would most likely repeat.
 *
 * Known edge: if the first request reached the server but its answer was lost on the way back,
 * the order exists and the retry gets a 409. The customer then sees "כבר יש הזמנה פתוחה למספר
 * הזה.", which is still true: the order exists, and its link reaches them in the WhatsApp
 * message sent when a round is planned.
 *
 * 400, 409 and 429 are decided by the status: their messages are the shared constants, not the
 * body's text, so a 429 from the hosting platform (an HTML body) still tells the customer to wait.
 */
export async function createOrder(
  order: CreateOrderRequest,
  fetchFn: FetchFn = globalFetch,
): Promise<CreateOrderOutcome> {
  return request<CreateOrderOutcome>(fetchFn, {
    path: '/api/orders',
    init: jsonInit('POST', order),
    behindLogin: false,
    retryOnNetworkError: true,
    on: {
      201: parsed(createOrderResponseSchema, (response) => ({ kind: 'created', response })),
      400: (body) => ({ kind: 'invalid', errors: invalidOrderErrors(body) }),
      409: () => ({ kind: 'duplicate', message: CREATE_ORDER_MESSAGES.duplicateOpenOrder }),
      429: () => ({ kind: 'rateLimited', message: CREATE_ORDER_MESSAGES.rateLimited }),
    },
  });
}
