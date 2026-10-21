// The web app's only network code: every call to the api goes through here. Each function takes
// the fetch to use, so tests pass a fake and never touch the network (CLAUDE.md: every external
// call sits behind an interface). The api is same-origin (ADR-0002), so paths are relative.
import {
  COLLECTOR_ORDER_MESSAGES,
  CREATE_ORDER_MESSAGES,
  CUSTOMER_ORDER_MESSAGES,
  LOGIN_MESSAGES,
  ROUND_MESSAGES,
  collectorOrderResponseSchema,
  collectorOrdersResponseSchema,
  createOrderResponseSchema,
  customerOrderResponseSchema,
  historyResponseSchema,
  meResponseSchema,
  messageOpenedResponseSchema,
  roundViewSchema,
  roundsResponseSchema,
  type AddOrderRequest,
  type CollectStopRequest,
  type CollectorOrder,
  type CreateOrderRequest,
  type CreateOrderResponse,
  type CustomerOrder,
  type CustomerUpdateOrderRequest,
  type HistoryResponse,
  type LoginRequest,
  type MoveStopRequest,
  type OrderGroup,
  type PlanRoundRequest,
  type RoundView,
  type SessionUser,
  type UpdateOrderRequest,
} from '@bottlerun/shared';
import { UNKNOWN_FIELD_ERROR, mapFieldErrors, type FormErrors } from './orderForm/formValues.ts';

/** The subset of `fetch` the app uses. Tests pass a fake that records calls. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

// The global fetch, called as a plain function and looked up at call time. Some browsers throw
// "Illegal invocation" when fetch is called as a method of another object, which is what passing
// `fetch` itself around as a parameter or property can turn into.
const globalFetch: FetchFn = (input, init) => fetch(input, init);

/**
 * Shown on a form when what it sent got no usable answer (the booking form's order, the planning
 * screen's round, a button of the customer's page), or its answer was not understood.
 */
export const NETWORK_ERROR_MESSAGE = 'לא הצלחנו לשלוח. נא לבדוק את החיבור לאינטרנט ולנסות שוב.';

/**
 * Wakes the api when the form loads (ADR-0002, warm-up): `GET /api/health` starts the serverless
 * function and opens its database connection, so both are warm by the time the customer presses
 * "send". Fire-and-forget: the answer does not matter, and every failure (a rejected or a throwing
 * fetch) is swallowed without logging, so it can never surface as an unhandled rejection.
 */
export function warmUp(fetchFn: FetchFn = globalFetch): void {
  try {
    void fetchFn('/api/health', { method: 'GET', cache: 'no-store' }).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // A fetch that throws instead of rejecting: as harmless as any other failed warm-up.
  }
}

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
 */
export async function createOrder(
  request: CreateOrderRequest,
  fetchFn: FetchFn = globalFetch,
): Promise<CreateOrderOutcome> {
  const send = () =>
    fetchFn('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });

  let response: Response;
  try {
    response = await send();
  } catch {
    try {
      response = await send();
    } catch {
      return { kind: 'failed' };
    }
  }
  return outcomeOf(response);
}

/**
 * The outcome of an HTTP answer. 400, 409 and 429 are decided by the status: their messages are
 * the shared constants, not the body's text, so a 429 from the hosting platform (an HTML body)
 * still tells the customer to wait. A 201 must carry a body that parses as the shared response.
 */
async function outcomeOf(response: Response): Promise<CreateOrderOutcome> {
  switch (response.status) {
    case 201: {
      const parsed = createOrderResponseSchema.safeParse(await readJson(response));
      return parsed.success ? { kind: 'created', response: parsed.data } : { kind: 'failed' };
    }
    case 400:
      return { kind: 'invalid', errors: invalidOrderErrors(await readJson(response)) };
    case 409:
      return { kind: 'duplicate', message: CREATE_ORDER_MESSAGES.duplicateOpenOrder };
    case 429:
      return { kind: 'rateLimited', message: CREATE_ORDER_MESSAGES.rateLimited };
    default:
      return { kind: 'failed' };
  }
}

/** The body as JSON, or undefined when it is not JSON (or could not be read to the end). */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The form errors of a 400 body. `fieldErrors` is used only when it is an object of strings, as
 * the route sends it (`invalid_order`); any other 400 (`invalid_json`, an unreadable body) still
 * tells the customer to check the form instead of showing nothing.
 */
function invalidOrderErrors(body: unknown): FormErrors {
  const fieldErrors = isObject(body) ? body.fieldErrors : undefined;
  return isStringRecord(fieldErrors)
    ? mapFieldErrors(fieldErrors)
    : { byField: {}, other: UNKNOWN_FIELD_ERROR };
}

/** A plain JSON object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A plain JSON object whose every value is a string, like the 400 body's `fieldErrors`. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === 'string');
}

// ---------------------------------------------------------------------------------------------
// The collector's session (ADR-0004): /api/auth/*
//
// The api is same-origin, so the browser attaches the httpOnly session cookie and the Origin
// header by itself (fetch's default `credentials: 'same-origin'`). Neither is set here: the api
// refuses a POST whose Origin does not match its host, and only the browser's own header does.
// ---------------------------------------------------------------------------------------------

/** How POST /api/auth/login ended, as the login screen shows it. */
export type LoginOutcome =
  /** 200: the session cookie is set; the collector app opens. */
  | { kind: 'loggedIn'; user: SessionUser }
  /** 401: the password is wrong; shown next to the password field. */
  | { kind: 'wrongPassword'; message: string }
  /** 429: too many failed logins from this IP, or from everyone together (ADR-0004). */
  | { kind: 'rateLimited'; message: string }
  /** No usable answer: a network error, a 400, 403 or 5xx, or a 200 the app cannot read. */
  | { kind: 'failed' };

/**
 * Sends the password to `POST /api/auth/login` and turns the answer into a {@link LoginOutcome}.
 * The password goes exactly as typed: never trimmed, since spaces are part of a sentence password
 * (loginRequestSchema), and never stored or logged here.
 *
 * Never retried, not even after a network error: a request that reached the api but lost its
 * answer may have counted as a failed attempt, and every failure counts toward the limit (5 per
 * IP in 15 minutes). Yoel taps "כניסה" again instead.
 *
 * The 401 and 429 messages are the shared constants, not the body's text, so a 429 from the
 * hosting platform (an HTML body) still says to wait. A 200 that does not parse is `failed`, even
 * though its cookie may be set: the next tap logs in again, and nothing is lost.
 */
export async function login(
  password: string,
  fetchFn: FetchFn = globalFetch,
): Promise<LoginOutcome> {
  const request: LoginRequest = { password };
  const response = await fetchOrNull(fetchFn, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (response === null) return { kind: 'failed' };
  switch (response.status) {
    case 200: {
      const user = await sessionUserOf(response);
      return user === null ? { kind: 'failed' } : { kind: 'loggedIn', user };
    }
    case 401:
      return { kind: 'wrongPassword', message: LOGIN_MESSAGES.wrongPassword };
    case 429:
      return { kind: 'rateLimited', message: LOGIN_MESSAGES.rateLimited };
    default:
      return { kind: 'failed' };
  }
}

/** Who `GET /api/auth/me` says is logged in on this browser. */
export type SessionOutcome =
  /** 200: a valid session cookie (the api renews an old one on the way). */
  | { kind: 'loggedIn'; user: SessionUser }
  /** 401: no session cookie, or an expired, forged or outdated one; the login screen opens. */
  | { kind: 'loggedOut' }
  /** No usable answer (network error, 5xx, unreadable body): whether he is logged in is unknown. */
  | { kind: 'failed' };

/**
 * Asks `GET /api/auth/me` whether this browser is logged in, for the collector app's guard.
 * `cache: 'no-store'`, so the answer is never one the browser kept from before a login or a
 * logout. `failed` is kept apart from `loggedOut`: a dropped connection mid-round must not look
 * like a logout and send Yoel to the password screen.
 */
export async function fetchSession(fetchFn: FetchFn = globalFetch): Promise<SessionOutcome> {
  const response = await fetchOrNull(fetchFn, '/api/auth/me', { method: 'GET', cache: 'no-store' });
  if (response === null) return { kind: 'failed' };
  switch (response.status) {
    case 200: {
      const user = await sessionUserOf(response);
      return user === null ? { kind: 'failed' } : { kind: 'loggedIn', user };
    }
    case 401:
      return { kind: 'loggedOut' };
    default:
      return { kind: 'failed' };
  }
}

/**
 * Logs out with `POST /api/auth/logout`, which clears the session cookie (the cookie is httpOnly,
 * so the page cannot clear it itself). True when the api answered with success (204); false on
 * any other answer or a network error, when the cookie may still be there.
 */
export async function logout(fetchFn: FetchFn = globalFetch): Promise<boolean> {
  const response = await fetchOrNull(fetchFn, '/api/auth/logout', { method: 'POST' });
  return response?.ok ?? false;
}

/**
 * The answer of one fetch, or null when none arrived: fetch rejected (a network error) or threw
 * instead of rejecting. Never retries.
 */
async function fetchOrNull(
  fetchFn: FetchFn,
  input: string,
  init: RequestInit,
): Promise<Response | null> {
  try {
    return await fetchFn(input, init);
  } catch {
    return null;
  }
}

/** The user of a 200 from login or /me, or null when the body is not a `MeResponse`. */
async function sessionUserOf(response: Response): Promise<SessionUser | null> {
  const parsed = meResponseSchema.safeParse(await readJson(response));
  return parsed.success ? parsed.data.user : null;
}

// ---------------------------------------------------------------------------------------------
// The collector's orders: /api/collector/orders (spec §3.5, the "הזמנות" screen)
//
// Every route is behind the login (ADR-0004), so every call here answers `loggedOut` on a 401 and
// the screen sends Yoel to /login. The cookie and Origin are the browser's, as in the auth
// section. Nothing is retried, not even after a network error: a write that reached the api but
// lost its answer may have been stored, and Yoel taps again instead (a second add then answers
// `duplicate`, a second cancel answers `saved`). Every message is a shared constant, never the
// body's text, and every success body is parsed with the shared schema.
// ---------------------------------------------------------------------------------------------

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
  const response = await fetchOrNull(fetchFn, COLLECTOR_ORDERS_PATH, {
    method: 'GET',
    cache: 'no-store',
  });
  if (response === null) return { kind: 'failed' };
  switch (response.status) {
    case 200: {
      const parsed = collectorOrdersResponseSchema.safeParse(await readJson(response));
      return parsed.success ? { kind: 'loaded', groups: parsed.data.groups } : { kind: 'failed' };
    }
    case 401:
      return { kind: 'loggedOut' };
    default:
      return { kind: 'failed' };
  }
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
  const response = await fetchOrNull(fetchFn, collectorOrderPath(id), {
    method: 'GET',
    cache: 'no-store',
  });
  if (response === null) return { kind: 'failed' };
  switch (response.status) {
    case 200: {
      const order = await collectorOrderOf(response);
      return order === null ? { kind: 'failed' } : { kind: 'loaded', order };
    }
    case 401:
      return { kind: 'loggedOut' };
    case 404:
      return { kind: 'notFound' };
    default:
      return { kind: 'failed' };
  }
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
  request: AddOrderRequest,
  fetchFn: FetchFn = globalFetch,
): Promise<CollectorOrderWriteOutcome> {
  const response = await fetchOrNull(fetchFn, COLLECTOR_ORDERS_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  // No order id in the path, so a 404 is not "the order is gone": the route itself is missing.
  return writeOutcomeOf(response, { successStatus: 201, notFoundMeansOrder: false });
}

/**
 * Changes an open order (Yoel's "עריכה", "שינוי אזור", "רחוב קרוב") with
 * `PATCH /api/collector/orders/:id`. Only the keys in `request` change; see
 * `updateOrderRequestSchema` for what each does to the region.
 */
export async function updateCollectorOrder(
  id: string,
  request: UpdateOrderRequest,
  fetchFn: FetchFn = globalFetch,
): Promise<CollectorOrderWriteOutcome> {
  const response = await fetchOrNull(fetchFn, collectorOrderPath(id), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  return writeOutcomeOf(response, { successStatus: 200, notFoundMeansOrder: true });
}

/**
 * Cancels an order (Yoel's "ביטול") with `POST /api/collector/orders/:id/cancel`, which takes no
 * body. An order already cancelled answers `saved` too, so a second tap is harmless.
 */
export async function cancelCollectorOrder(
  id: string,
  fetchFn: FetchFn = globalFetch,
): Promise<CollectorOrderWriteOutcome> {
  const response = await fetchOrNull(fetchFn, `${collectorOrderPath(id)}/cancel`, {
    method: 'POST',
  });
  return writeOutcomeOf(response, { successStatus: 200, notFoundMeansOrder: true });
}

/**
 * The outcome of a write's answer (null: none arrived). `successStatus` is the route's success
 * (201 for an add, 200 otherwise); any other 2xx is `failed`, since the app cannot tell what it
 * means. `notFoundMeansOrder` is false for the add, whose path has no order id to be missing.
 */
async function writeOutcomeOf(
  response: Response | null,
  expected: { successStatus: 200 | 201; notFoundMeansOrder: boolean },
): Promise<CollectorOrderWriteOutcome> {
  if (response === null) return { kind: 'failed' };
  if (response.status === expected.successStatus) {
    const order = await collectorOrderOf(response);
    return order === null ? { kind: 'failed' } : { kind: 'saved', order };
  }
  switch (response.status) {
    case 400:
      // The same mapping as the booking form's: a path no field shows (`nearStreetCode`,
      // `region`, an unknown key) becomes the message above the form.
      return { kind: 'invalid', errors: invalidOrderErrors(await readJson(response)) };
    case 401:
      return { kind: 'loggedOut' };
    case 404:
      return expected.notFoundMeansOrder
        ? { kind: 'notFound', message: COLLECTOR_ORDER_MESSAGES.orderNotFound }
        : { kind: 'failed' };
    case 409:
      return conflictOutcome(await readJson(response));
    default:
      return { kind: 'failed' };
  }
}

/**
 * A 409 told apart by the body's `error` code: the two conflicts need different words and a
 * different next step (check the phone, or go back to the list). A body without a known code is
 * `failed`: guessing could tell Yoel the wrong thing.
 */
function conflictOutcome(body: unknown): CollectorOrderWriteOutcome {
  const code = isObject(body) ? body.error : undefined;
  switch (code) {
    case 'duplicate_open_order':
      return { kind: 'duplicate', message: CREATE_ORDER_MESSAGES.duplicateOpenOrder };
    case 'invalid_transition':
      return { kind: 'closed', message: COLLECTOR_ORDER_MESSAGES.orderClosed };
    default:
      return { kind: 'failed' };
  }
}

/** The order of a success body, or null when the body is not a `CollectorOrderResponse`. */
async function collectorOrderOf(response: Response): Promise<CollectorOrder | null> {
  const parsed = collectorOrderResponseSchema.safeParse(await readJson(response));
  return parsed.success ? parsed.data.order : null;
}

// ---------------------------------------------------------------------------------------------
// The "שלח" list (ADR-0003): POST /api/collector/orders/:id/messages/:index/opened
//
// Behind the login like the routes above, with the same rules: a 401 is `loggedOut`, nothing is
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
  const response = await fetchOrNull(
    fetchFn,
    `${collectorOrderPath(orderId)}/messages/${messageIndex}/opened`,
    { method: 'POST' },
  );
  if (response === null) return { kind: 'failed' };
  switch (response.status) {
    case 200: {
      const parsed = messageOpenedResponseSchema.safeParse(await readJson(response));
      return parsed.success
        ? { kind: 'marked', openedAt: parsed.data.openedAt }
        : { kind: 'failed' };
    }
    case 401:
      return { kind: 'loggedOut' };
    case 404:
      return { kind: 'notFound' };
    default:
      return { kind: 'failed' };
  }
}

// ---------------------------------------------------------------------------------------------
// The collector's rounds: /api/collector/rounds (spec §3.5 "תכנון סבב", §3.6 "סבב")
//
// Behind the login like the routes above, with the same rules: a 401 is `loggedOut`, nothing is
// retried (a plan that reached the api but lost its answer is stored, and sending it again would
// only answer `ordersNotWaiting`), every message is a shared constant, never the body's text, and
// every success body is parsed with the shared schema.
// ---------------------------------------------------------------------------------------------

const COLLECTOR_ROUNDS_PATH = '/api/collector/rounds';

/** How GET /api/collector/rounds ended, as the "סבבים" tab and the planning screen use it. */
export type RoundsOutcome =
  /**
   * 200: the OPEN rounds, by date, each with its orders in groups and its "שלח" list; and the
   * `pickupBy` of the round created last, which the planning screen pre-fills (ADR-0003). Absent
   * when that round had none, or there was no round yet.
   */
  | { kind: 'loaded'; rounds: RoundView[]; previousPickupBy?: string }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /** No usable answer: a network error, a 5xx, or a 200 the app cannot read. */
  | { kind: 'failed' };

/** Loads the open rounds from `GET /api/collector/rounds`, past the browser cache. */
export async function fetchRounds(fetchFn: FetchFn = globalFetch): Promise<RoundsOutcome> {
  const response = await fetchOrNull(fetchFn, COLLECTOR_ROUNDS_PATH, {
    method: 'GET',
    cache: 'no-store',
  });
  if (response === null) return { kind: 'failed' };
  switch (response.status) {
    case 200: {
      const parsed = roundsResponseSchema.safeParse(await readJson(response));
      return parsed.success
        ? {
            kind: 'loaded',
            rounds: parsed.data.rounds,
            previousPickupBy: parsed.data.previousPickupBy,
          }
        : { kind: 'failed' };
    }
    case 401:
      return { kind: 'loggedOut' };
    default:
      return { kind: 'failed' };
  }
}

/** How POST /api/collector/rounds ("שלח בקשות אישור") ended, as the planning screen shows it. */
export type PlanRoundOutcome =
  /** 201: the round is planned and its orders are `pending`; `view` is the round as stored. */
  | { kind: 'planned'; view: RoundView }
  /**
   * 400: the plan did not validate (normally caught by the same check before sending).
   * `fieldErrors` maps a field (`date`, `region`, `orderIds`, `pickupBy`, `personalText`) to its
   * plain-Hebrew message; empty when the body had none the app can read.
   */
  | { kind: 'invalid'; fieldErrors: Record<string, string> }
  /**
   * 409 `orders_not_waiting`: some marked order was meanwhile cancelled, edited away or planned
   * into another round, so nothing was planned. `orderIds` lists them (empty when the body did
   * not); the screen reloads its list.
   */
  | { kind: 'ordersNotWaiting'; message: string; orderIds: string[] }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /** No usable answer: a network error, a 403 or 5xx, another 409, or a body it cannot read. */
  | { kind: 'failed' };

/**
 * Plans a round (spec §3.5 "תכנון סבב") with `POST /api/collector/rounds`: the api stores it,
 * moves the orders to `pending` and writes each one's confirmation request.
 */
export async function planRound(
  request: PlanRoundRequest,
  fetchFn: FetchFn = globalFetch,
): Promise<PlanRoundOutcome> {
  const response = await fetchOrNull(fetchFn, COLLECTOR_ROUNDS_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (response === null) return { kind: 'failed' };
  switch (response.status) {
    case 201: {
      const view = await roundViewOf(response);
      return view === null ? { kind: 'failed' } : { kind: 'planned', view };
    }
    case 400: {
      // `fieldErrors` only when it is an object of strings, as the route sends it
      // (`invalid_round`); any other 400 still tells Yoel to check the form.
      const body = await readJson(response);
      const fieldErrors = isObject(body) ? body.fieldErrors : undefined;
      return { kind: 'invalid', fieldErrors: isStringRecord(fieldErrors) ? fieldErrors : {} };
    }
    case 401:
      return { kind: 'loggedOut' };
    case 409: {
      // Told apart by the body's code, like the orders' 409s: a conflict this screen does not
      // know is `failed` rather than a guess.
      const body = await readJson(response);
      if (!isObject(body) || body.error !== 'orders_not_waiting') return { kind: 'failed' };
      return {
        kind: 'ordersNotWaiting',
        message: ROUND_MESSAGES.ordersNotWaiting,
        orderIds: isStringArray(body.orderIds) ? body.orderIds : [],
      };
    }
    default:
      return { kind: 'failed' };
  }
}

/** How "אישר בטלפון" ended, as the round screen shows it. */
export type ConfirmByPhoneOutcome =
  /** 200: the order is confirmed (also when it already was); `view` is the round as it is now. */
  | { kind: 'confirmed'; view: RoundView }
  /**
   * 409: the round's confirmations are closed (`confirmations_closed`), or the order can no longer
   * be confirmed, because it was cancelled or collected (`invalid_transition`).
   */
  | { kind: 'closed'; message: string }
  /** 404: the round is gone, or the order is not in it (any more). */
  | { kind: 'notFound' }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /** No usable answer: a network error, a 403 or 5xx, another 409, or a body it cannot read. */
  | { kind: 'failed' };

/**
 * Yoel's "אישר בטלפון" (spec §3.6): marks order `orderId` of round `roundId` confirmed, with
 * `POST /api/collector/rounds/:id/orders/:orderId/confirm-by-phone` (no body). Both ids are
 * encoded into the path. An order already confirmed answers `confirmed` too, so a second tap is
 * harmless.
 */
export async function confirmOrderByPhone(
  roundId: string,
  orderId: string,
  fetchFn: FetchFn = globalFetch,
): Promise<ConfirmByPhoneOutcome> {
  const path = `${roundPath(roundId)}/orders/${encodeURIComponent(orderId)}/confirm-by-phone`;
  const response = await fetchOrNull(fetchFn, path, { method: 'POST' });
  if (response === null) return { kind: 'failed' };
  switch (response.status) {
    case 200: {
      const view = await roundViewOf(response);
      return view === null ? { kind: 'failed' } : { kind: 'confirmed', view };
    }
    case 401:
      return { kind: 'loggedOut' };
    case 404:
      return { kind: 'notFound' };
    case 409:
      return confirmConflictOutcome(await readJson(response));
    default:
      return { kind: 'failed' };
  }
}

/**
 * A 409 of "אישר בטלפון", told apart by the body's `error` code: both are `closed`, each with its
 * own words. A body without a known code is `failed`: guessing could tell Yoel the wrong thing.
 */
function confirmConflictOutcome(body: unknown): ConfirmByPhoneOutcome {
  const code = isObject(body) ? body.error : undefined;
  switch (code) {
    case 'confirmations_closed':
      return { kind: 'closed', message: ROUND_MESSAGES.confirmationsClosed };
    case 'invalid_transition':
      return { kind: 'closed', message: COLLECTOR_ORDER_MESSAGES.orderClosed };
    default:
      return { kind: 'failed' };
  }
}

/** The path of round `roundId`, both ids encoded so each stays one path segment. */
function roundPath(roundId: string): string {
  return `${COLLECTOR_ROUNDS_PATH}/${encodeURIComponent(roundId)}`;
}

/** The path of stop `orderId` in round `roundId`'s route, both ids encoded; the action follows. */
function roundStopPath(roundId: string, orderId: string): string {
  return `${roundPath(roundId)}/stops/${encodeURIComponent(orderId)}`;
}

/** How "סגור אישורים ובנה מסלול" ended, as the round screen shows it. */
export type BuildRouteOutcome =
  /** 200: the route is built (phase `routed`); `view.stops` holds it in driving order. */
  | { kind: 'built'; view: RoundView }
  /**
   * 409 `confirmations_closed`: the round is already routed or closed (a second tap, or another
   * tab), so nothing changed; the screen shows the message and reloads the round.
   */
  | { kind: 'closed'; message: string }
  /** 404: the round is gone. */
  | { kind: 'notFound' }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /** No usable answer: a network error, a 403 or 5xx, another 409, or a body it cannot read. */
  | { kind: 'failed' };

/**
 * Yoel's "סגור אישורים ובנה מסלול" (spec §3.6 step 2) with `POST /api/collector/rounds/:id/route`
 * (no body): the api closes the confirmations, sends whoever did not confirm back to `waiting`,
 * and stores the route `planRoute` computes. Not retried: a build whose answer was lost is stored,
 * and a second one would only answer `closed`.
 */
export async function buildRoute(
  roundId: string,
  fetchFn: FetchFn = globalFetch,
): Promise<BuildRouteOutcome> {
  const response = await fetchOrNull(fetchFn, `${roundPath(roundId)}/route`, { method: 'POST' });
  if (response === null) return { kind: 'failed' };
  switch (response.status) {
    case 200: {
      const view = await roundViewOf(response);
      return view === null ? { kind: 'failed' } : { kind: 'built', view };
    }
    case 401:
      return { kind: 'loggedOut' };
    case 404:
      return { kind: 'notFound' };
    case 409: {
      // Told apart by the body's code: a conflict this screen does not know is `failed`.
      const body = await readJson(response);
      return isObject(body) && body.error === 'confirmations_closed'
        ? { kind: 'closed', message: ROUND_MESSAGES.confirmationsClosed }
        : { kind: 'failed' };
    }
    default:
      return { kind: 'failed' };
  }
}

/** How a stop's move, "אספתי" or "לא נמצא" ended, as the route screen shows it. */
export type StopActionOutcome =
  /**
   * 200: done (also when the same action was already done: a second tap is harmless); `view` is
   * the round as it is now. After "אספתי", the collected stop's `thankYou` is its "שלח תודה" row.
   */
  | { kind: 'saved'; view: RoundView }
  /**
   * 409: the screen is stale, so it shows `message` and reloads the round. `route_not_open` (the
   * route is not built yet, or the round is closed), `stop_handled` (the stop was handled another
   * way), or `invalid_transition` (the order changed status meanwhile, e.g. the customer cancelled
   * at that moment), which is told with the `stop_handled` words: either way the stop is no longer
   * Yoel's to act on, and refreshing shows what happened there.
   */
  | { kind: 'stale'; message: string }
  /** 409 `stop_at_edge` (a move only): the stop is already first or last, so nothing moved. */
  | { kind: 'atEdge'; message: string }
  /**
   * 400 from "אספתי" (`invalid_collect`): the count did not validate (normally caught before
   * sending). `fieldErrors` maps `bottlesCollected` to its plain-Hebrew message; empty when the
   * body had none the app can read.
   */
  | { kind: 'invalid'; fieldErrors: Record<string, string> }
  /** 404: the round is gone, or the order is not a stop of its route. */
  | { kind: 'notFound' }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /**
   * No usable answer: a network error, a 403 or 5xx, another 409, a body it cannot read, or a 400
   * from a move or "לא נמצא" (only a broken client sends one, so there is no field to show).
   */
  | { kind: 'failed' };

/**
 * Moves stop `orderId` of round `roundId` one place `up` (earlier) or `down` (later) in the stored
 * route (spec §3.6 step 2), with `POST /api/collector/rounds/:id/stops/:orderId/move`.
 */
export async function moveStop(
  roundId: string,
  orderId: string,
  direction: MoveStopRequest['direction'],
  fetchFn: FetchFn = globalFetch,
): Promise<StopActionOutcome> {
  const request: MoveStopRequest = { direction };
  return stopAction(fetchFn, `${roundStopPath(roundId, orderId)}/move`, request, false);
}

/**
 * Yoel's "אספתי" (spec §3.6 step 2) on stop `orderId` of round `roundId`, with
 * `POST /api/collector/rounds/:id/stops/:orderId/collected`. `bottlesCollected` is the real
 * count; left out (`{}` is sent), the api uses the order's estimate. The api sends the thank-you,
 * and the `saved` view's collected stop carries its "שלח תודה" row.
 */
export async function collectStop(
  roundId: string,
  orderId: string,
  bottlesCollected?: number,
  fetchFn: FetchFn = globalFetch,
): Promise<StopActionOutcome> {
  // The key is left out rather than sent as undefined: "no count" means the estimate.
  const request: CollectStopRequest = bottlesCollected === undefined ? {} : { bottlesCollected };
  return stopAction(fetchFn, `${roundStopPath(roundId, orderId)}/collected`, request, true);
}

/**
 * Yoel's "לא נמצא" (spec §3.6 step 2) on stop `orderId` of round `roundId`, with
 * `POST /api/collector/rounds/:id/stops/:orderId/not-found` (no body): the order goes back to
 * `waiting` and its stop stays in the route as not found. No message is sent.
 */
export async function markStopNotFound(
  roundId: string,
  orderId: string,
  fetchFn: FetchFn = globalFetch,
): Promise<StopActionOutcome> {
  return stopAction(fetchFn, `${roundStopPath(roundId, orderId)}/not-found`, undefined, false);
}

/**
 * Sends one stop action (a JSON `request`, or no body when undefined) and turns the answer into a
 * {@link StopActionOutcome}. `hasFields`: whether a 400 is `invalid` (the "אספתי" count) rather
 * than `failed`. Never retried: every stop action is idempotent, so Yoel just taps again.
 */
async function stopAction(
  fetchFn: FetchFn,
  path: string,
  request: MoveStopRequest | CollectStopRequest | undefined,
  hasFields: boolean,
): Promise<StopActionOutcome> {
  const init: RequestInit =
    request === undefined
      ? { method: 'POST' }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        };
  const response = await fetchOrNull(fetchFn, path, init);
  if (response === null) return { kind: 'failed' };
  switch (response.status) {
    case 200: {
      const view = await roundViewOf(response);
      return view === null ? { kind: 'failed' } : { kind: 'saved', view };
    }
    case 400: {
      if (!hasFields) return { kind: 'failed' };
      const body = await readJson(response);
      const fieldErrors = isObject(body) ? body.fieldErrors : undefined;
      return { kind: 'invalid', fieldErrors: isStringRecord(fieldErrors) ? fieldErrors : {} };
    }
    case 401:
      return { kind: 'loggedOut' };
    case 404:
      return { kind: 'notFound' };
    case 409:
      return stopConflictOutcome(await readJson(response));
    default:
      return { kind: 'failed' };
  }
}

/**
 * A 409 of a stop action, told apart by the body's `error` code (see {@link StopActionOutcome}).
 * A body without a known code is `failed`: guessing could tell Yoel the wrong thing.
 */
function stopConflictOutcome(body: unknown): StopActionOutcome {
  const code = isObject(body) ? body.error : undefined;
  switch (code) {
    case 'route_not_open':
      return { kind: 'stale', message: ROUND_MESSAGES.routeNotOpen };
    case 'stop_handled':
    case 'invalid_transition':
      return { kind: 'stale', message: ROUND_MESSAGES.stopHandled };
    case 'stop_at_edge':
      return { kind: 'atEdge', message: ROUND_MESSAGES.stopAtEdge };
    default:
      return { kind: 'failed' };
  }
}

/** How "סגור סבב" ended, as the round screen shows it. */
export type CloseRoundOutcome =
  /**
   * 200: the round is closed (`view.round.status` is `closed`, `closedAt` set), also when it was
   * already closed. Every order it did not handle is back in `waiting` with its `lastMiss`.
   */
  | { kind: 'closed'; view: RoundView }
  /** 404: the round is gone. */
  | { kind: 'notFound' }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /** No usable answer: a network error, a 403, 409 or 5xx, or a body it cannot read. */
  | { kind: 'failed' };

/**
 * Yoel's "סגור סבב" (spec §3.6) with `POST /api/collector/rounds/:id/close` (no body): the api
 * closes the round and sends every order it did not handle back to `waiting` (a pending or
 * confirmed order of a round still confirming as "לא אישר בזמן", a stop not reached as "לא הגענו
 * אליו"). No message is sent. Not retried: a close whose answer was lost is stored, and a second
 * close is harmless anyway, since it answers `closed` with the round as it is.
 */
export async function closeRound(
  roundId: string,
  fetchFn: FetchFn = globalFetch,
): Promise<CloseRoundOutcome> {
  const response = await fetchOrNull(fetchFn, `${roundPath(roundId)}/close`, { method: 'POST' });
  if (response === null) return { kind: 'failed' };
  switch (response.status) {
    case 200: {
      const view = await roundViewOf(response);
      return view === null ? { kind: 'failed' } : { kind: 'closed', view };
    }
    case 401:
      return { kind: 'loggedOut' };
    case 404:
      return { kind: 'notFound' };
    default:
      // The route has no 409: a conflict here is from something in between, and so `failed`.
      return { kind: 'failed' };
  }
}

/** The round of a success body, or null when the body is not a `RoundView`. */
async function roundViewOf(response: Response): Promise<RoundView | null> {
  const parsed = roundViewSchema.safeParse(await readJson(response));
  return parsed.success ? parsed.data : null;
}

/** A JSON array whose every item is a string, like the 409 body's `orderIds`. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// ---------------------------------------------------------------------------------------------
// The collector's history: GET /api/collector/history?month=YYYY-MM (spec §3.7, "היסטוריה")
//
// Behind the login like the routes above, with the same rules: a 401 is `loggedOut`, nothing is
// retried, and the success body is parsed with the shared schema.
// ---------------------------------------------------------------------------------------------

/** How GET /api/collector/history ended, as the "היסטוריה" tab shows it. */
export type HistoryOutcome =
  /** 200: the month's totals and its closed orders, newest first (`closedAt` a Date). */
  | { kind: 'loaded'; history: HistoryResponse }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /**
   * No usable answer: a network error, a 5xx, or a 200 the app cannot read. A 400
   * (`invalid_month`) is `failed` too: the screen's picker only builds valid months, so it is a
   * client bug, and Yoel can do nothing about it but try again.
   */
  | { kind: 'failed' };

/**
 * Loads one calendar month's history (`YYYY-MM`, a month in Israel) from
 * `GET /api/collector/history?month=`, past the browser cache: the current month changes with
 * every "אספתי". The month is encoded, so whatever the caller passes stays one query value.
 */
export async function fetchHistory(
  month: string,
  fetchFn: FetchFn = globalFetch,
): Promise<HistoryOutcome> {
  const response = await fetchOrNull(
    fetchFn,
    `/api/collector/history?month=${encodeURIComponent(month)}`,
    { method: 'GET', cache: 'no-store' },
  );
  if (response === null) return { kind: 'failed' };
  switch (response.status) {
    case 200: {
      const parsed = historyResponseSchema.safeParse(await readJson(response));
      return parsed.success ? { kind: 'loaded', history: parsed.data } : { kind: 'failed' };
    }
    case 401:
      return { kind: 'loggedOut' };
    default:
      return { kind: 'failed' };
  }
}

// ---------------------------------------------------------------------------------------------
// The customer's own page: /api/o/:token (spec §3.3, the page `/o/<token>`)
//
// Public: no login, so no `loggedOut` here; the order is reached by its random token alone, which
// goes into the path encoded. The same rules as the collector's routes otherwise: every message is
// a shared constant, never the body's text, and every success body is parsed with the shared
// schema. Nothing is retried, not even after a network error: every write is idempotent (a second
// confirm, decline or cancel answers `saved` with the order as it is), so the customer just taps
// again, and an answer lost on the way is put right by that tap.
// ---------------------------------------------------------------------------------------------

/**
 * The path of the order with `token`. Encoded although a real token is base64url (nothing to
 * encode): the page takes it from its own URL, and whatever is there must stay one path segment.
 */
function customerOrderPath(token: string): string {
  return `/api/o/${encodeURIComponent(token)}`;
}

/** How GET /api/o/:token ended, as the customer's page shows it. */
export type CustomerOrderOutcome =
  /** 200: the order as it is stored now, with its round's date while it is pending or confirmed. */
  | { kind: 'loaded'; order: CustomerOrder }
  /** 404: no order has this token, or the token is not one at all (the same answer for both). */
  | { kind: 'notFound' }
  /** No usable answer: a network error, a 5xx, or a 200 the app cannot read. */
  | { kind: 'failed' };

/**
 * Loads the customer's order from `GET /api/o/:token`. `cache: 'no-store'`, so the page never
 * shows a status the browser kept from before a confirm or a cancel.
 */
export async function fetchCustomerOrder(
  token: string,
  fetchFn: FetchFn = globalFetch,
): Promise<CustomerOrderOutcome> {
  const response = await fetchOrNull(fetchFn, customerOrderPath(token), {
    method: 'GET',
    cache: 'no-store',
  });
  if (response === null) return { kind: 'failed' };
  switch (response.status) {
    case 200: {
      const order = await customerOrderOf(response);
      return order === null ? { kind: 'failed' } : { kind: 'loaded', order };
    }
    case 404:
      return { kind: 'notFound' };
    default:
      return { kind: 'failed' };
  }
}

/** How a button of the customer's page (or its "שינוי") ended. */
export type CustomerOrderWriteOutcome =
  /** 200: the order as stored now, which the page draws instead of what it sent. */
  | { kind: 'saved'; order: CustomerOrder }
  /**
   * 409: the confirmations of its round are closed (`confirmations_closed`, confirm only), or the
   * order was collected or cancelled meanwhile (`invalid_transition`). `message` says which.
   */
  | { kind: 'closed'; message: string }
  /** 400 (PATCH only): a field was refused; placed next to its field like the booking form's. */
  | { kind: 'invalid'; errors: FormErrors }
  /** 404: no order has this token (any more), or the token is not one at all. */
  | { kind: 'notFound' }
  /** No usable answer: a network error, a 403 or 5xx, another 409, or a body it cannot read. */
  | { kind: 'failed' };

/**
 * "כן, אוציא את הבקבוקים" with `POST /api/o/:token/confirm` (no body): pending → confirmed. An order
 * already confirmed answers `saved` too; a round no longer taking confirmations answers `closed`.
 */
export async function confirmCustomerOrder(
  token: string,
  fetchFn: FetchFn = globalFetch,
): Promise<CustomerOrderWriteOutcome> {
  return customerWriteOutcomeOf(
    await fetchOrNull(fetchFn, `${customerOrderPath(token)}/confirm`, { method: 'POST' }),
  );
}

/**
 * "לא מתאים הפעם" with `POST /api/o/:token/decline` (no body): the order leaves its round, back
 * to waiting, and Yoel sees that the customer asked for another date. An order already waiting
 * answers `saved` as it is.
 */
export async function declineCustomerOrder(
  token: string,
  fetchFn: FetchFn = globalFetch,
): Promise<CustomerOrderWriteOutcome> {
  return customerWriteOutcomeOf(
    await fetchOrNull(fetchFn, `${customerOrderPath(token)}/decline`, { method: 'POST' }),
  );
}

/**
 * "ביטול" with `POST /api/o/:token/cancel` (no body). An order already cancelled answers `saved`
 * too; a collected one answers `closed`.
 */
export async function cancelCustomerOrder(
  token: string,
  fetchFn: FetchFn = globalFetch,
): Promise<CustomerOrderWriteOutcome> {
  return customerWriteOutcomeOf(
    await fetchOrNull(fetchFn, `${customerOrderPath(token)}/cancel`, { method: 'POST' }),
  );
}

/**
 * "שינוי" with `PATCH /api/o/:token`: the address (with its note) and the number of bottles, never
 * the phone. A change of street or house number takes an order out of its round; see
 * `customerUpdateOrderRequestSchema`.
 */
export async function updateCustomerOrder(
  token: string,
  request: CustomerUpdateOrderRequest,
  fetchFn: FetchFn = globalFetch,
): Promise<CustomerOrderWriteOutcome> {
  return customerWriteOutcomeOf(
    await fetchOrNull(fetchFn, customerOrderPath(token), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );
}

/** The outcome of a customer write's answer (null: none arrived). Every route's success is 200. */
async function customerWriteOutcomeOf(
  response: Response | null,
): Promise<CustomerOrderWriteOutcome> {
  if (response === null) return { kind: 'failed' };
  switch (response.status) {
    case 200: {
      const order = await customerOrderOf(response);
      return order === null ? { kind: 'failed' } : { kind: 'saved', order };
    }
    case 400:
      // The booking form's mapping: `fieldErrors: {}` (a body refused as a whole) becomes the
      // message above the form instead of nothing.
      return { kind: 'invalid', errors: invalidOrderErrors(await readJson(response)) };
    case 404:
      return { kind: 'notFound' };
    case 409:
      return customerConflictOutcome(await readJson(response));
    default:
      return { kind: 'failed' };
  }
}

/**
 * A 409 of the customer's page, told apart by the body's `error` code: both are `closed`, each
 * with its own words. A body without a known code is `failed`: guessing could tell the customer
 * the wrong thing.
 */
function customerConflictOutcome(body: unknown): CustomerOrderWriteOutcome {
  const code = isObject(body) ? body.error : undefined;
  switch (code) {
    case 'confirmations_closed':
      return { kind: 'closed', message: CUSTOMER_ORDER_MESSAGES.confirmationsClosed };
    case 'invalid_transition':
      return { kind: 'closed', message: CUSTOMER_ORDER_MESSAGES.orderClosed };
    default:
      return { kind: 'failed' };
  }
}

/** The order of a 200 body, or null when the body is not a `CustomerOrderResponse`. */
async function customerOrderOf(response: Response): Promise<CustomerOrder | null> {
  const parsed = customerOrderResponseSchema.safeParse(await readJson(response));
  return parsed.success ? parsed.data.order : null;
}
