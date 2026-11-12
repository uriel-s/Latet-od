// The customer's own page's endpoints: /api/o/:token (spec §3.3, the page `/o/<token>`). Sent
// through `request()` (request.ts), which handles what every endpoint shares.
//
// Public: no login, so no `loggedOut` here (a 401 is `failed`); the order is reached by its random
// token alone, which goes into the path encoded. The same rules as the collector's routes
// otherwise: every message is a shared constant, never the body's text, and every success body is
// parsed with the shared schema. Nothing is retried, not even after a network error: every write
// is idempotent (a second decline or cancel answers `saved` with the order as it is), so the
// customer just taps again, and an answer lost on the way is put right by that tap.
import {
  CUSTOMER_ORDER_MESSAGES,
  customerOrderResponseSchema,
  type CustomerOrder,
  type CustomerUpdateOrderRequest,
} from '@bottlerun/shared';
import { type FormErrors } from '../orderForm/formValues.ts';
import {
  FAILED,
  FRESH_GET,
  errorCodeOf,
  globalFetch,
  invalidOrderErrors,
  jsonInit,
  parsed,
  request,
  type FetchFn,
} from './request.ts';

/**
 * The path of the order with `token`. Encoded although a real token is base64url (nothing to
 * encode): the page takes it from its own URL, and whatever is there must stay one path segment.
 */
function customerOrderPath(token: string): string {
  return `/api/o/${encodeURIComponent(token)}`;
}

/** How GET /api/o/:token ended, as the customer's page shows it. */
export type CustomerOrderOutcome =
  /** 200: the order as it is stored now, with its round's date while it is in a round. */
  | { kind: 'loaded'; order: CustomerOrder }
  /** 404: no order has this token, or the token is not one at all (the same answer for both). */
  | { kind: 'notFound' }
  /** No usable answer: a network error, a 5xx, or a 200 the app cannot read. */
  | { kind: 'failed' };

/**
 * Loads the customer's order from `GET /api/o/:token`. `cache: 'no-store'`, so the page never
 * shows a status the browser kept from before a decline or a cancel.
 */
export async function fetchCustomerOrder(
  token: string,
  fetchFn: FetchFn = globalFetch,
): Promise<CustomerOrderOutcome> {
  return request<CustomerOrderOutcome>(fetchFn, {
    path: customerOrderPath(token),
    init: FRESH_GET,
    behindLogin: false,
    on: {
      200: parsed(customerOrderResponseSchema, ({ order }) => ({ kind: 'loaded', order })),
      404: () => ({ kind: 'notFound' }),
    },
  });
}

/** How a button of the customer's page (or its "שינוי") ended. */
export type CustomerOrderWriteOutcome =
  /** 200: the order as stored now, which the page draws instead of what it sent. */
  | { kind: 'saved'; order: CustomerOrder }
  /** 409: the order was collected or cancelled meanwhile (`invalid_transition`). */
  | { kind: 'closed'; message: string }
  /** 400 (PATCH only): a field was refused; placed next to its field like the booking form's. */
  | { kind: 'invalid'; errors: FormErrors }
  /** 404: no order has this token (any more), or the token is not one at all. */
  | { kind: 'notFound' }
  /** No usable answer: a network error, a 403 or 5xx, another 409, or a body it cannot read. */
  | { kind: 'failed' };

/**
 * "לא מתאים הפעם" with `POST /api/o/:token/decline` (no body): the order leaves its round, back
 * to waiting, and Yoel sees that the customer asked for another date. An order already waiting
 * answers `saved` as it is.
 */
export async function declineCustomerOrder(
  token: string,
  fetchFn: FetchFn = globalFetch,
): Promise<CustomerOrderWriteOutcome> {
  return customerWrite(fetchFn, `${customerOrderPath(token)}/decline`, { method: 'POST' });
}

/**
 * "ביטול" with `POST /api/o/:token/cancel` (no body). An order already cancelled answers `saved`
 * too; a collected one answers `closed`.
 */
export async function cancelCustomerOrder(
  token: string,
  fetchFn: FetchFn = globalFetch,
): Promise<CustomerOrderWriteOutcome> {
  return customerWrite(fetchFn, `${customerOrderPath(token)}/cancel`, { method: 'POST' });
}

/**
 * "שינוי" with `PATCH /api/o/:token`: the address (with its note) and the number of bottles, never
 * the phone. A change of street or house number takes an order out of its round; see
 * `customerUpdateOrderRequestSchema`.
 */
export async function updateCustomerOrder(
  token: string,
  body: CustomerUpdateOrderRequest,
  fetchFn: FetchFn = globalFetch,
): Promise<CustomerOrderWriteOutcome> {
  return customerWrite(fetchFn, customerOrderPath(token), jsonInit('PATCH', body));
}

/** Sends one write of the customer's page. Every route's success is 200. */
async function customerWrite(
  fetchFn: FetchFn,
  path: string,
  init: RequestInit,
): Promise<CustomerOrderWriteOutcome> {
  return request<CustomerOrderWriteOutcome>(fetchFn, {
    path,
    init,
    behindLogin: false,
    on: {
      200: parsed(customerOrderResponseSchema, ({ order }) => ({ kind: 'saved', order })),
      // The booking form's mapping: `fieldErrors: {}` (a body refused as a whole) becomes the
      // message above the form instead of nothing.
      400: (body) => ({ kind: 'invalid', errors: invalidOrderErrors(body) }),
      404: () => ({ kind: 'notFound' }),
      // Told apart by the body's code: a conflict without a known one is `failed`, since
      // guessing could tell the customer the wrong thing.
      409: (body) =>
        errorCodeOf(body) === 'invalid_transition'
          ? { kind: 'closed', message: CUSTOMER_ORDER_MESSAGES.orderClosed }
          : FAILED,
    },
  });
}
