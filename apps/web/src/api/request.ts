// The web app's network core: every call to the api goes through `request()`, which handles what
// every endpoint shares (a network error, a 401 behind the login, a status the endpoint does not
// know, an unreadable body, an unexpected error). The endpoints themselves live next to it, one
// module per resource as in packages/shared (authApi.ts, bookingApi.ts, customerOrderApi.ts,
// collectorOrdersApi.ts, roundsApi.ts, historyApi.ts, pushApi.ts). Each endpoint takes the fetch
// to use, so tests pass a fake and never touch the network (CLAUDE.md: every external call sits
// behind an interface). The api is same-origin (ADR-0002), so paths are relative.
import { DEFAULT_LANG, t, type Lang } from '@bottlerun/shared';
import { UNKNOWN_FIELD_ERROR, mapFieldErrors, type FormErrors } from '../orderForm/formValues.ts';

/** The subset of `fetch` the app uses. Tests pass a fake that records calls. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The default fetch of every endpoint: the global fetch, called as a plain function and looked up
 * at call time. Some browsers throw "Illegal invocation" when fetch is called as a method of
 * another object, which is what passing `fetch` itself around as a parameter or property can
 * turn into.
 */
export const globalFetch: FetchFn = (input, init) => fetch(input, init);

// ---------------------------------------------------------------------------------------------
// One request helper: `request()`
//
// Every endpoint, in every resource module, sends through it, and it decides once for all:
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
// in that endpoint's `on` map.
// ---------------------------------------------------------------------------------------------

/** No usable answer: what an endpoint answers when nothing better can be said. */
export type Failed = { kind: 'failed' };

/** A 401 on a route behind the login: the session is gone, and the screen goes to /login. */
export type LoggedOut = { kind: 'loggedOut' };

export const FAILED: Failed = { kind: 'failed' };
const LOGGED_OUT: LoggedOut = { kind: 'loggedOut' };

/** Turns the body of one status (JSON, or undefined when it is not JSON) into an outcome. */
export type StatusHandler<O> = (body: unknown) => O;

/** The outcome of each status an endpoint knows, its success included; any other is `failed`. */
export type StatusHandlers<O> = Readonly<Record<number, StatusHandler<O | Failed>>>;

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
 * Sends one request and turns its answer into the endpoint's outcome (see the section comment above).
 * Never rejects. `O` is the endpoint's outcome union; behind the login it must hold `loggedOut`.
 */
export function request<O>(
  fetchFn: FetchFn,
  spec: RequestSpec<O> & { behindLogin: true },
): Promise<O | Failed | LoggedOut>;
export function request<O>(
  fetchFn: FetchFn,
  spec: RequestSpec<O> & { behindLogin: false },
): Promise<O | Failed>;
export async function request<O>(
  fetchFn: FetchFn,
  spec: RequestSpec<O>,
): Promise<O | Failed | LoggedOut> {
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
export function parsed<T, O>(
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
export function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** The init of a GET that skips the browser cache, so a list is never one kept from before a change. */
export const FRESH_GET: RequestInit = { method: 'GET', cache: 'no-store' };

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

// ---------------------------------------------------------------------------------------------
// Reading an answer's body: what several resources' handlers share
// ---------------------------------------------------------------------------------------------

/**
 * The form errors of a 400 body. `fieldErrors` is used only when it is an object of strings, as
 * the route sends it (`invalid_order`); any other 400 (`invalid_json`, an unreadable body) still
 * tells the customer to check the form instead of showing nothing.
 */
export function invalidOrderErrors(body: unknown): FormErrors {
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
export function fieldErrorsOf(body: unknown): Record<string, string> {
  const fieldErrors = isObject(body) ? body.fieldErrors : undefined;
  return isStringRecord(fieldErrors) ? fieldErrors : {};
}

/** The `error` code of a 4xx body, or undefined when the body has none. */
export function errorCodeOf(body: unknown): unknown {
  return isObject(body) ? body.error : undefined;
}

/** A plain JSON object (not null, not an array). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A plain JSON object whose every value is a string, like the 400 body's `fieldErrors`. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === 'string');
}

/** A JSON array whose every item is a string, like the 409 body's `orderIds`. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
