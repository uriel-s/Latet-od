// The collector's orders endpoints: /api/collector/orders (spec §3.5, the "הזמנות" screen), and
// the "שלח" list's mark-as-opened (ADR-0003). Sent through `request()` (request.ts), which handles
// what every endpoint shares.
//
// Every route is behind the login (ADR-0004), so every call here answers `loggedOut` on a 401 and
// the screen sends Yoel to /login. The cookie and Origin are the browser's, as in authApi.ts.
// Nothing is retried, not even after a network error: a write that reached the api but lost its
// answer may have been stored, and Yoel taps again instead (a second add then answers
// `duplicate`, a second cancel answers `saved`). Every message is a shared constant, never the
// body's text, and every success body is parsed with the shared schema.
import {
  COLLECTOR_ORDER_MESSAGES,
  CREATE_ORDER_MESSAGES,
  collectorOrderResponseSchema,
  collectorOrdersResponseSchema,
  messageOpenedResponseSchema,
  type AddOrderRequest,
  type CollectorOrder,
  type OrderGroup,
  type UpdateOrderRequest,
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
  type StatusHandler,
  type StatusHandlers,
} from './request.ts';

const COLLECTOR_ORDERS_PATH = '/api/collector/orders';

/**
 * The path of one order. The id is encoded: the edit screen takes it from its own URL, and a `/`
 * or `?` in it must stay part of the id instead of adding a path segment or a query.
 */
function collectorOrderPath(id: string): string {
  return `${COLLECTOR_ORDERS_PATH}/${encodeURIComponent(id)}`;
}

/** How GET /api/collector/orders ended, as the "הזמנות" screen shows it. */
export type WaitingOrdersOutcome =
  /** 200: the waiting orders in their three groups, in screen order (`groupWaitingOrders`). */
  | { kind: 'loaded'; groups: OrderGroup[] }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /** No usable answer: a network error, a 5xx, or a 200 the app cannot read. */
  | { kind: 'failed' };

/**
 * Loads the waiting orders, by region group, from `GET /api/collector/orders`. `cache: 'no-store'`
 * so the list is never one the browser kept from before an edit, a cancel or an add.
 */
export async function fetchWaitingOrders(
  fetchFn: FetchFn = globalFetch,
): Promise<WaitingOrdersOutcome> {
  return request<WaitingOrdersOutcome>(fetchFn, {
    path: COLLECTOR_ORDERS_PATH,
    init: FRESH_GET,
    behindLogin: true,
    on: {
      200: parsed(collectorOrdersResponseSchema, ({ groups }) => ({ kind: 'loaded', groups })),
    },
  });
}

/** How GET /api/collector/orders/:id ended, as the edit screen shows it. */
export type CollectorOrderOutcome =
  /** 200: the order as it is stored now (`createdAt` a Date). */
  | { kind: 'loaded'; order: CollectorOrder }
  /** 404: no order has this id, or the id is not one at all. */
  | { kind: 'notFound' }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /** No usable answer: a network error, a 5xx, or a 200 the app cannot read. */
  | { kind: 'failed' };

/** Loads one order for the edit screen from `GET /api/collector/orders/:id`, past the cache. */
export async function fetchCollectorOrder(
  id: string,
  fetchFn: FetchFn = globalFetch,
): Promise<CollectorOrderOutcome> {
  return request<CollectorOrderOutcome>(fetchFn, {
    path: collectorOrderPath(id),
    init: FRESH_GET,
    behindLogin: true,
    on: {
      200: parsed(collectorOrderResponseSchema, ({ order }) => ({ kind: 'loaded', order })),
      404: () => ({ kind: 'notFound' }),
    },
  });
}

/** How a change to an order ended (add, edit, cancel). */
export type CollectorOrderWriteOutcome =
  /** 200 (201 for an add): the order as stored now, which the screen shows. */
  | { kind: 'saved'; order: CollectorOrder }
  /** 400: a field was refused; placed next to its field like the booking form's own check. */
  | { kind: 'invalid'; errors: FormErrors }
  /** 409 `duplicate_open_order`: the phone has another open order (spec §3.1). */
  | { kind: 'duplicate'; message: string }
  /** 409 `invalid_transition`: the order was collected or cancelled meanwhile. */
  | { kind: 'closed'; message: string }
  /** 404 (edit and cancel only): the order is gone, or the id is not one. */
  | { kind: 'notFound'; message: string }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /** No usable answer: a network error, a 403 or 5xx, or a body the app cannot read. */
  | { kind: 'failed' };

/**
 * Adds an order for a customer who phoned (Yoel's "הוספת הזמנה", spec §3.5) with
 * `POST /api/collector/orders`: the booking form's request, without the honeypot.
 */
export async function addCollectorOrder(
  body: AddOrderRequest,
  fetchFn: FetchFn = globalFetch,
): Promise<CollectorOrderWriteOutcome> {
  return request<CollectorOrderWriteOutcome>(fetchFn, {
    path: COLLECTOR_ORDERS_PATH,
    init: jsonInit('POST', body),
    behindLogin: true,
    // No order id in the path, so a 404 is not "the order is gone": the route itself is missing.
    on: collectorWriteHandlers(201, false),
  });
}

/**
 * Changes an open order (Yoel's "עריכה", "שינוי אזור", "רחוב קרוב") with
 * `PATCH /api/collector/orders/:id`. Only the keys in `body` change; see
 * `updateOrderRequestSchema` for what each does to the region.
 */
export async function updateCollectorOrder(
  id: string,
  body: UpdateOrderRequest,
  fetchFn: FetchFn = globalFetch,
): Promise<CollectorOrderWriteOutcome> {
  return request<CollectorOrderWriteOutcome>(fetchFn, {
    path: collectorOrderPath(id),
    init: jsonInit('PATCH', body),
    behindLogin: true,
    on: collectorWriteHandlers(200, true),
  });
}

/**
 * Cancels an order (Yoel's "ביטול") with `POST /api/collector/orders/:id/cancel`, which takes no
 * body. An order already cancelled answers `saved` too, so a second tap is harmless.
 */
export async function cancelCollectorOrder(
  id: string,
  fetchFn: FetchFn = globalFetch,
): Promise<CollectorOrderWriteOutcome> {
  return request<CollectorOrderWriteOutcome>(fetchFn, {
    path: `${collectorOrderPath(id)}/cancel`,
    init: { method: 'POST' },
    behindLogin: true,
    on: collectorWriteHandlers(200, true),
  });
}

/**
 * The statuses of an order write. `successStatus` is the route's success (201 for an add, 200
 * otherwise); any other 2xx is `failed`, since the app cannot tell what it means.
 * `notFoundMeansOrder` is false for the add, whose path has no order id to be missing.
 */
function collectorWriteHandlers(
  successStatus: 200 | 201,
  notFoundMeansOrder: boolean,
): StatusHandlers<CollectorOrderWriteOutcome> {
  const handlers: Record<number, StatusHandler<CollectorOrderWriteOutcome>> = {
    [successStatus]: parsed(collectorOrderResponseSchema, ({ order }) => ({
      kind: 'saved',
      order,
    })),
    // The same mapping as the booking form's: a path no field shows (`nearStreetCode`,
    // `region`, an unknown key) becomes the message above the form.
    400: (body) => ({ kind: 'invalid', errors: invalidOrderErrors(body) }),
    409: conflictOutcome,
  };
  if (notFoundMeansOrder) {
    handlers[404] = () => ({ kind: 'notFound', message: COLLECTOR_ORDER_MESSAGES.orderNotFound });
  }
  return handlers;
}

/**
 * A 409 told apart by the body's `error` code: the two conflicts need different words and a
 * different next step (check the phone, or go back to the list). A body without a known code is
 * `failed`: guessing could tell Yoel the wrong thing.
 */
function conflictOutcome(body: unknown): CollectorOrderWriteOutcome {
  switch (errorCodeOf(body)) {
    case 'duplicate_open_order':
      return { kind: 'duplicate', message: CREATE_ORDER_MESSAGES.duplicateOpenOrder };
    case 'invalid_transition':
      return { kind: 'closed', message: COLLECTOR_ORDER_MESSAGES.orderClosed };
    default:
      return FAILED;
  }
}

/** How a delete ended (Yoel's "מחיקת ההזמנה", ADR-0008). */
export type DeleteCollectorOrderOutcome =
  /** 204, or 404: the order is gone, which is what Yoel asked for (a second screen got there first). */
  | { kind: 'deleted' }
  /** 409 `cannot_delete`: collected, in a round, or changed meanwhile; `message` says so. */
  | { kind: 'refused'; message: string }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /** No usable answer: a network error, a 403 or 5xx. Nothing is retried: the delete may have arrived. */
  | { kind: 'failed' };

/**
 * Deletes an order for good (Yoel's "מחיקת ההזמנה") with `DELETE /api/collector/orders/:id`, which
 * takes no body and answers 204. Only a waiting or cancelled order in no round may go (ADR-0008).
 */
export async function deleteCollectorOrder(
  id: string,
  fetchFn: FetchFn = globalFetch,
): Promise<DeleteCollectorOrderOutcome> {
  return request<DeleteCollectorOrderOutcome>(fetchFn, {
    path: collectorOrderPath(id),
    init: { method: 'DELETE' },
    behindLogin: true,
    on: {
      204: () => ({ kind: 'deleted' }),
      404: () => ({ kind: 'deleted' }),
      409: (body) =>
        errorCodeOf(body) === 'cannot_delete'
          ? { kind: 'refused', message: COLLECTOR_ORDER_MESSAGES.cannotDelete }
          : FAILED,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The "שלח" list (ADR-0003): POST /api/collector/orders/:id/messages/:index/opened
//
// Behind the login like the orders routes above, with the same rules: a 401 is `loggedOut`, nothing is
// retried, and the success body is parsed with the shared schema.
// ---------------------------------------------------------------------------------------------

/** How marking a wa.me link as opened ended, as the "שלח" list shows it. */
export type MarkMessageOpenedOutcome =
  /** 200: the link is marked; `openedAt` is the FIRST time it was opened, a Date. */
  | { kind: 'marked'; openedAt: Date }
  /**
   * 404: the order is gone (`order_not_found`), or it has no wa.me link at that index
   * (`message_not_found`). Both mean the same to Yoel: this row's opening cannot be stored.
   */
  | { kind: 'notFound' }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /** No usable answer: a network error, a 403 or 5xx, or a 200 the app cannot read. */
  | { kind: 'failed' };

/**
 * Tells the api that Yoel opened the wa.me link of entry `messageIndex` in order `orderId`'s
 * message log, with `POST /api/collector/orders/:id/messages/:index/opened` (no body). Called as
 * his "שלח" tap opens WhatsApp.
 *
 * It never changes the order's status: nobody can know whether he then really tapped "send" in
 * WhatsApp (ADR-0003). A link already opened answers `marked` with its FIRST `openedAt`, and the
 * api writes nothing, so a second tap is harmless. That is also why it is never retried: an answer
 * lost on the way is put right by the next tap.
 */
export async function markMessageOpened(
  orderId: string,
  messageIndex: number,
  fetchFn: FetchFn = globalFetch,
): Promise<MarkMessageOpenedOutcome> {
  return request<MarkMessageOpenedOutcome>(fetchFn, {
    path: `${collectorOrderPath(orderId)}/messages/${messageIndex}/opened`,
    init: { method: 'POST' },
    behindLogin: true,
    on: {
      200: parsed(messageOpenedResponseSchema, ({ openedAt }) => ({ kind: 'marked', openedAt })),
      404: () => ({ kind: 'notFound' }),
    },
  });
}
