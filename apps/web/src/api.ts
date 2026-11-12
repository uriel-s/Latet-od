// The web app's only network code: every call to the api goes through here, and through one
// helper, `request()`, which handles what every endpoint shares (a network error, a 401 behind the
// login, a status the endpoint does not know, an unreadable body, an unexpected error). Each
// function takes the fetch to use, so tests pass a fake and never touch the network (CLAUDE.md:
// every external call sits behind an interface). The api is same-origin (ADR-0002), so paths are
// relative.
import {
  COLLECTOR_ORDER_MESSAGES,
  CREATE_ORDER_MESSAGES,
  CUSTOMER_ORDER_MESSAGES,
  DEFAULT_LANG,
  LOGIN_MESSAGES,
  ROUND_MESSAGES,
  collectorOrderResponseSchema,
  collectorOrdersResponseSchema,
  createOrderResponseSchema,
  customerOrderResponseSchema,
  historyResponseSchema,
  meResponseSchema,
  messageOpenedResponseSchema,
  pushConfigResponseSchema,
  roundViewSchema,
  roundsResponseSchema,
  t,
  type AddOrderRequest,
  type CollectStopRequest,
  type CollectorOrder,
  type CreateOrderRequest,
  type CreateOrderResponse,
  type CustomerOrder,
  type CustomerUpdateOrderRequest,
  type HistoryResponse,
  type Lang,
  type LoginRequest,
  type MoveStopRequest,
  type OrderGroup,
  type PlanRoundRequest,
  type PushConfigResponse,
  type PushSubscription,
  type RoundView,
  type SessionUser,
  type UnsubscribePushRequest,
  type UpdateOrderRequest,
} from '@bottlerun/shared';
import { UNKNOWN_FIELD_ERROR, mapFieldErrors, type FormErrors } from './orderForm/formValues.ts';

/** The subset of `fetch` the app uses. Tests pass a fake that records calls. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

// The global fetch, called as a plain function and looked up at call time. Some browsers throw
// "Illegal invocation" when fetch is called as a method of another object, which is what passing
// `fetch` itself around as a parameter or property can turn into.
const globalFetch: FetchFn = (input, init) => fetch(input, init);

// ---------------------------------------------------------------------------------------------
// One request helper: `request()`
//
// Every endpoint below sends through it, and it decides, once for all of them:
// - a network error (fetch rejects, or throws instead of rejecting) is `failed`, never retried
//   unless the endpoint asks for one retry (only the booking form does);
// - on a route behind the login (ADR-0004) a 401 is `loggedOut`, whatever the body says;
// - a status the endpoint does not list is `failed`;
// - the body reaches the endpoint's handler as JSON, or undefined when it is not JSON, so a
//   success that must parse with its shared zod schema (`parsed`) is `failed` when it does not;
// - anything else that throws is a bug: it is logged with console.error (the method and the
//   error only: never the request body, a phone, an address or the path, which can hold the
//   customer's token) and answered `failed`, so no screen ever gets a rejected promise.
// What a status means for one endpoint (its success, a 404, a 409 told apart by its code) stays
// in that endpoint's `on` map. Self-contained, so it can move to a module of its own.
// ---------------------------------------------------------------------------------------------

/** No usable answer: what an endpoint answers when nothing better can be said. */
type Failed = { kind: 'failed' };

/** A 401 on a route behind the login: the session is gone, and the screen goes to /login. */
type LoggedOut = { kind: 'loggedOut' };

const FAILED: Failed = { kind: 'failed' };
const LOGGED_OUT: LoggedOut = { kind: 'loggedOut' };

/** Turns the body of one status (JSON, or undefined when it is not JSON) into an outcome. */
type StatusHandler<O> = (body: unknown) => O;

/** The outcome of each status an endpoint knows, its success included; any other is `failed`. */
type StatusHandlers<O> = Readonly<Record<number, StatusHandler<O | Failed>>>;

/**
 * The one method of a shared zod schema that `parsed` needs. Structural, so the web app does not
 * depend on zod itself.
 */
interface ResponseSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** One call to the api, as {@link request} takes it. */
interface RequestSpec<O> {
  path: string;
  init: RequestInit;
  /** True for the routes behind the login: a 401 is then `loggedOut`. */
  behindLogin: boolean;
  /** See {@link StatusHandlers}. */
  on: StatusHandlers<O>;
  /** Send once more when the first fetch got no answer. Only for a write that is safe to repeat. */
  retryOnNetworkError?: boolean;
}

/**
 * Sends one request and turns its answer into the endpoint's outcome (see the section comment).
 * Never rejects. `O` is the endpoint's outcome union; behind the login it must hold `loggedOut`.
 */
function request<O>(
  fetchFn: FetchFn,
  spec: RequestSpec<O> & { behindLogin: true },
): Promise<O | Failed | LoggedOut>;
function request<O>(
  fetchFn: FetchFn,
  spec: RequestSpec<O> & { behindLogin: false },
): Promise<O | Failed>;
async function request<O>(fetchFn: FetchFn, spec: RequestSpec<O>): Promise<O | Failed | LoggedOut> {
  const response = await send(fetchFn, spec);
  if (response === null) return FAILED;
  try {
    if (spec.behindLogin && response.status === 401) return LOGGED_OUT;
    const handle = spec.on[response.status];
    if (handle === undefined) return FAILED;
    return handle(await readJson(response));
  } catch (error) {
    console.error(
      `api: unexpected error handling the answer to a ${spec.init.method ?? 'GET'}`,
      error,
    );
    return FAILED;
  }
}

/**
 * The answer of the request, or null when none arrived: every try's fetch rejected (a network
 * error) or threw instead of rejecting.
 */
async function send(fetchFn: FetchFn, spec: RequestSpec<unknown>): Promise<Response | null> {
  const tries = spec.retryOnNetworkError === true ? 2 : 1;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return await fetchFn(spec.path, spec.init);
    } catch {
      // No answer arrived; the next try, if any, sends the same request again.
    }
  }
  return null;
}

/**
 * The handler of a success status: the body must parse with `schema` (the shared zod schema of
 * the answer), or the outcome is `failed`; a body that is not JSON never parses.
 */
function parsed<T, O>(
  schema: ResponseSchema<T>,
  outcome: (data: T) => O,
): StatusHandler<O | Failed> {
  return (body) => {
    const result = schema.safeParse(body);
    return result.success ? outcome(result.data) : FAILED;
  };
}

/** The body as JSON, or undefined when it is not JSON (or could not be read to the end). */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** The init of a request that sends `body` as JSON. */
function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** The init of a GET that skips the browser cache, so a list is never one kept from before a change. */
const FRESH_GET: RequestInit = { method: 'GET', cache: 'no-store' };

/**
 * Shown on a form when what it sent got no usable answer (the booking form's order, the planning
 * screen's round, a button of the customer's page), or its answer was not understood.
 */
export const NETWORK_ERROR_MESSAGE = networkErrorMessage(DEFAULT_LANG);

/** {@link NETWORK_ERROR_MESSAGE} in `lang`, for the English booking form. */
export function networkErrorMessage(lang: Lang): string {
  return t(lang, 'form.networkError');
}

/**
 * Wakes the api when the form loads (ADR-0002, warm-up): `GET /api/health` starts the serverless
 * function and opens its database connection, so both are warm by the time the customer presses
 * "send". Fire-and-forget: the answer does not matter (no status is listed, so none is even
 * read), and `request()` never rejects and logs no network error, so a failed warm-up is silent.
 */
export function warmUp(fetchFn: FetchFn = globalFetch): void {
  void request<never>(fetchFn, {
    path: '/api/health',
    init: FRESH_GET,
    behindLogin: false,
    on: {},
  });
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

/**
 * The `fieldErrors` of a 400 body as the screen places them (planning, "אספתי"): only when it is
 * an object of strings, as the route sends it; empty for any other 400, which still tells the
 * user to check the form.
 */
function fieldErrorsOf(body: unknown): Record<string, string> {
  const fieldErrors = isObject(body) ? body.fieldErrors : undefined;
  return isStringRecord(fieldErrors) ? fieldErrors : {};
}

/** The `error` code of a 4xx body, or undefined when the body has none. */
function errorCodeOf(body: unknown): unknown {
  return isObject(body) ? body.error : undefined;
}

/** A plain JSON object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A plain JSON object whose every value is a string, like the 400 body's `fieldErrors`. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === 'string');
}

/** A JSON array whose every item is a string, like the 409 body's `orderIds`. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
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
 * Not `behindLogin`: its 401 is the wrong password, not a lost session. The 401 and 429 messages
 * are the shared constants, not the body's text, so a 429 from the hosting platform (an HTML body)
 * still says to wait. A 200 that does not parse is `failed`, even though its cookie may be set:
 * the next tap logs in again, and nothing is lost.
 */
export async function login(
  password: string,
  fetchFn: FetchFn = globalFetch,
): Promise<LoginOutcome> {
  const body: LoginRequest = { password };
  return request<LoginOutcome>(fetchFn, {
    path: '/api/auth/login',
    init: jsonInit('POST', body),
    behindLogin: false,
    on: {
      200: parsed(meResponseSchema, ({ user }) => ({ kind: 'loggedIn', user })),
      401: () => ({ kind: 'wrongPassword', message: LOGIN_MESSAGES.wrongPassword }),
      429: () => ({ kind: 'rateLimited', message: LOGIN_MESSAGES.rateLimited }),
    },
  });
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
  return request<SessionOutcome>(fetchFn, {
    path: '/api/auth/me',
    init: FRESH_GET,
    behindLogin: true,
    on: { 200: parsed(meResponseSchema, ({ user }) => ({ kind: 'loggedIn', user })) },
  });
}

/**
 * Logs out with `POST /api/auth/logout`, which clears the session cookie (the cookie is httpOnly,
 * so the page cannot clear it itself). True when the api answered its success (204); false on
 * any other answer or a network error, when the cookie may still be there.
 */
export async function logout(fetchFn: FetchFn = globalFetch): Promise<boolean> {
  const outcome = await request<{ kind: 'cleared' }>(fetchFn, {
    path: '/api/auth/logout',
    init: { method: 'POST' },
    // Not `behindLogin`: the route answers 204 with or without a session, so a 401 is `failed`.
    behindLogin: false,
    on: { 204: () => ({ kind: 'cleared' }) },
  });
  return outcome.kind === 'cleared';
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
   * `pickupBy` (and optional `pickupFrom`) of the round created last, which the planning screen
   * pre-fills (ADR-0003). Each is absent when that round had none, or there was no round yet.
   */
  | { kind: 'loaded'; rounds: RoundView[]; previousPickupBy?: string; previousPickupFrom?: string }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /** No usable answer: a network error, a 5xx, or a 200 the app cannot read. */
  | { kind: 'failed' };

/** Loads the open rounds from `GET /api/collector/rounds`, past the browser cache. */
export async function fetchRounds(fetchFn: FetchFn = globalFetch): Promise<RoundsOutcome> {
  return request<RoundsOutcome>(fetchFn, {
    path: COLLECTOR_ROUNDS_PATH,
    init: FRESH_GET,
    behindLogin: true,
    on: {
      200: parsed(roundsResponseSchema, (data) => ({
        kind: 'loaded',
        rounds: data.rounds,
        previousPickupBy: data.previousPickupBy,
        previousPickupFrom: data.previousPickupFrom,
      })),
    },
  });
}

/** How POST /api/collector/rounds ("שלח הודעות") ended, as the planning screen shows it. */
export type PlanRoundOutcome =
  /** 201: the round is planned and its orders are `confirmed` (ADR-0012); `view` is the round as stored. */
  | { kind: 'planned'; view: RoundView }
  /**
   * 400: the plan did not validate (normally caught by the same check before sending).
   * `fieldErrors` maps a field (`date`, `region`, `orderIds`, `pickupFrom`, `pickupBy`, `personalText`) to its
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
 * moves the orders into it (`confirmed`: nobody confirms, ADR-0012) and writes each one's message.
 */
export async function planRound(
  body: PlanRoundRequest,
  fetchFn: FetchFn = globalFetch,
): Promise<PlanRoundOutcome> {
  return request<PlanRoundOutcome>(fetchFn, {
    path: COLLECTOR_ROUNDS_PATH,
    init: jsonInit('POST', body),
    behindLogin: true,
    on: {
      201: parsed(roundViewSchema, (view) => ({ kind: 'planned', view })),
      // `fieldErrors` of an `invalid_round`; any other 400 still tells Yoel to check the form.
      400: (answer) => ({ kind: 'invalid', fieldErrors: fieldErrorsOf(answer) }),
      // Told apart by the body's code, like the orders' 409s: a conflict this screen does not
      // know is `failed` rather than a guess.
      409: (answer) =>
        isObject(answer) && answer.error === 'orders_not_waiting'
          ? {
              kind: 'ordersNotWaiting',
              message: ROUND_MESSAGES.ordersNotWaiting,
              orderIds: isStringArray(answer.orderIds) ? answer.orderIds : [],
            }
          : FAILED,
    },
  });
}

/** The path of round `roundId`, both ids encoded so each stays one path segment. */
function roundPath(roundId: string): string {
  return `${COLLECTOR_ROUNDS_PATH}/${encodeURIComponent(roundId)}`;
}

/** The path of stop `orderId` in round `roundId`'s route, both ids encoded; the action follows. */
function roundStopPath(roundId: string, orderId: string): string {
  return `${roundPath(roundId)}/stops/${encodeURIComponent(orderId)}`;
}

/** How "התחל מסלול" ended, as the round screen shows it. */
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
 * Yoel's "התחל מסלול" (spec §3.6 step 2) with `POST /api/collector/rounds/:id/route`
 * (no body): every order still in the round is a stop (ADR-0012), and the api stores the route
 * `planRoute` computes. Not retried: a build whose answer was lost is stored,
 * and a second one would only answer `closed`.
 */
export async function buildRoute(
  roundId: string,
  fetchFn: FetchFn = globalFetch,
): Promise<BuildRouteOutcome> {
  return request<BuildRouteOutcome>(fetchFn, {
    path: `${roundPath(roundId)}/route`,
    init: { method: 'POST' },
    behindLogin: true,
    on: {
      200: parsed(roundViewSchema, (view) => ({ kind: 'built', view })),
      404: () => ({ kind: 'notFound' }),
      // Told apart by the body's code: a conflict this screen does not know is `failed`.
      409: (body) =>
        errorCodeOf(body) === 'confirmations_closed'
          ? { kind: 'closed', message: ROUND_MESSAGES.confirmationsClosed }
          : FAILED,
    },
  });
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
  const body: MoveStopRequest = { direction };
  return stopAction(fetchFn, `${roundStopPath(roundId, orderId)}/move`, body, false);
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
  const body: CollectStopRequest = bottlesCollected === undefined ? {} : { bottlesCollected };
  return stopAction(fetchFn, `${roundStopPath(roundId, orderId)}/collected`, body, true);
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
 * Sends one stop action (a JSON `body`, or none when undefined) and turns the answer into a
 * {@link StopActionOutcome}. `hasFields`: whether a 400 is `invalid` (the "אספתי" count) rather
 * than `failed`. Never retried: every stop action is idempotent, so Yoel just taps again.
 */
async function stopAction(
  fetchFn: FetchFn,
  path: string,
  body: MoveStopRequest | CollectStopRequest | undefined,
  hasFields: boolean,
): Promise<StopActionOutcome> {
  const handlers: Record<number, StatusHandler<StopActionOutcome>> = {
    200: parsed(roundViewSchema, (view) => ({ kind: 'saved', view })),
    404: () => ({ kind: 'notFound' }),
    409: stopConflictOutcome,
  };
  if (hasFields) {
    handlers[400] = (answer) => ({ kind: 'invalid', fieldErrors: fieldErrorsOf(answer) });
  }
  return request<StopActionOutcome>(fetchFn, {
    path,
    init: body === undefined ? { method: 'POST' } : jsonInit('POST', body),
    behindLogin: true,
    on: handlers,
  });
}

/**
 * A 409 of a stop action, told apart by the body's `error` code (see {@link StopActionOutcome}).
 * A body without a known code is `failed`: guessing could tell Yoel the wrong thing.
 */
function stopConflictOutcome(body: unknown): StopActionOutcome {
  switch (errorCodeOf(body)) {
    case 'route_not_open':
      return { kind: 'stale', message: ROUND_MESSAGES.routeNotOpen };
    case 'stop_handled':
    case 'invalid_transition':
      return { kind: 'stale', message: ROUND_MESSAGES.stopHandled };
    case 'stop_at_edge':
      return { kind: 'atEdge', message: ROUND_MESSAGES.stopAtEdge };
    default:
      return FAILED;
  }
}

/** How closing a round ended, as the round screen shows it. */
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
 * Yoel's close button ("בטל את הסבב" / "סיימתי את הסבב", spec §3.6) with `POST /api/collector/rounds/:id/close` (no body): the api
 * closes the round and sends every order it did not handle back to `waiting`, as "לא הגענו
 * אליו". No message is sent. Not retried: a close whose answer was lost is stored, and a second
 * close is harmless anyway, since it answers `closed` with the round as it is.
 */
export async function closeRound(
  roundId: string,
  fetchFn: FetchFn = globalFetch,
): Promise<CloseRoundOutcome> {
  return request<CloseRoundOutcome>(fetchFn, {
    path: `${roundPath(roundId)}/close`,
    init: { method: 'POST' },
    behindLogin: true,
    // The route has no 409: a conflict here is from something in between, and so `failed`.
    on: {
      200: parsed(roundViewSchema, (view) => ({ kind: 'closed', view })),
      404: () => ({ kind: 'notFound' }),
    },
  });
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
  return request<HistoryOutcome>(fetchFn, {
    path: `/api/collector/history?month=${encodeURIComponent(month)}`,
    init: FRESH_GET,
    behindLogin: true,
    on: { 200: parsed(historyResponseSchema, (history) => ({ kind: 'loaded', history })) },
  });
}

// ---------------------------------------------------------------------------------------------
// The customer's own page: /api/o/:token (spec §3.3, the page `/o/<token>`)
//
// Public: no login, so no `loggedOut` here (a 401 is `failed`); the order is reached by its random
// token alone, which goes into the path encoded. The same rules as the collector's routes
// otherwise: every message is a shared constant, never the body's text, and every success body is
// parsed with the shared schema. Nothing is retried, not even after a network error: every write
// is idempotent (a second decline or cancel answers `saved` with the order as it is), so the
// customer just taps again, and an answer lost on the way is put right by that tap.
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

// ---------------------------------------------------------------------------------------------
// Collector Web Push: /api/collector/push/* (ADR-0013)
//
// Behind the login like the routes above: a 401 is `loggedOut`, and nothing is retried.
// ---------------------------------------------------------------------------------------------

const COLLECTOR_PUSH_PATH = '/api/collector/push';

/** How GET /api/collector/push/config ended. */
export type PushConfigOutcome =
  { kind: 'loaded'; config: PushConfigResponse } | { kind: 'loggedOut' } | { kind: 'failed' };

/** Fetches whether Web Push is enabled and its public VAPID key from GET /api/collector/push/config. */
export async function fetchPushConfig(fetchFn: FetchFn = globalFetch): Promise<PushConfigOutcome> {
  return request<PushConfigOutcome>(fetchFn, {
    path: `${COLLECTOR_PUSH_PATH}/config`,
    init: FRESH_GET,
    behindLogin: true,
    on: { 200: parsed(pushConfigResponseSchema, (config) => ({ kind: 'loaded', config })) },
  });
}

/** How saving a push subscription ended. */
export type SavePushSubscriptionOutcome =
  { kind: 'saved' } | { kind: 'loggedOut' } | { kind: 'failed' };

/** Saves a Web Push subscription with POST /api/collector/push/subscribe (ADR-0013). */
export async function savePushSubscription(
  subscription: PushSubscription,
  fetchFn: FetchFn = globalFetch,
): Promise<SavePushSubscriptionOutcome> {
  return request<SavePushSubscriptionOutcome>(fetchFn, {
    path: `${COLLECTOR_PUSH_PATH}/subscribe`,
    init: jsonInit('POST', subscription),
    behindLogin: true,
    on: { 204: () => ({ kind: 'saved' }) },
  });
}

/** How deleting a push subscription ended. */
export type DeletePushSubscriptionOutcome =
  { kind: 'deleted' } | { kind: 'loggedOut' } | { kind: 'failed' };

/** Deletes a Web Push subscription with POST /api/collector/push/unsubscribe (ADR-0013). */
export async function deletePushSubscription(
  endpoint: string,
  fetchFn: FetchFn = globalFetch,
): Promise<DeletePushSubscriptionOutcome> {
  const body: UnsubscribePushRequest = { endpoint };
  return request<DeletePushSubscriptionOutcome>(fetchFn, {
    path: `${COLLECTOR_PUSH_PATH}/unsubscribe`,
    init: jsonInit('POST', body),
    behindLogin: true,
    on: { 204: () => ({ kind: 'deleted' }) },
  });
}
