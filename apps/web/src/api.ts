// The web app's only network code: every call to the api goes through here. Each function takes
// the fetch to use, so tests pass a fake and never touch the network (CLAUDE.md: every external
// call sits behind an interface). The api is same-origin (ADR-0002), so paths are relative.
import {
  CREATE_ORDER_MESSAGES,
  LOGIN_MESSAGES,
  createOrderResponseSchema,
  meResponseSchema,
  type CreateOrderRequest,
  type CreateOrderResponse,
  type LoginRequest,
  type SessionUser,
} from '@bottlerun/shared';
import { UNKNOWN_FIELD_ERROR, mapFieldErrors, type FormErrors } from './orderForm/formValues.ts';

/** The subset of `fetch` the app uses. Tests pass a fake that records calls. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

// The global fetch, called as a plain function and looked up at call time. Some browsers throw
// "Illegal invocation" when fetch is called as a method of another object, which is what passing
// `fetch` itself around as a parameter or property can turn into.
const globalFetch: FetchFn = (input, init) => fetch(input, init);

/** Shown on the form when the order could not be sent, or its answer was not understood. */
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
