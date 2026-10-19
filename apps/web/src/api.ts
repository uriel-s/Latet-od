// The web app's only network code: every call to the api goes through here. Each function takes
// the fetch to use, so tests pass a fake and never touch the network (CLAUDE.md: every external
// call sits behind an interface). The api is same-origin (ADR-0002), so paths are relative.
import {
  CREATE_ORDER_MESSAGES,
  createOrderResponseSchema,
  type CreateOrderRequest,
  type CreateOrderResponse,
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
