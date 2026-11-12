// The collector's session endpoints (ADR-0004): /api/auth/*. Sent through `request()`
// (request.ts), which handles what every endpoint shares.
//
// The api is same-origin, so the browser attaches the httpOnly session cookie and the Origin
// header by itself (fetch's default `credentials: 'same-origin'`). Neither is set here: the api
// refuses a POST whose Origin does not match its host, and only the browser's own header does.
import {
  LOGIN_MESSAGES,
  meResponseSchema,
  type LoginRequest,
  type SessionUser,
} from '@bottlerun/shared';
import { FRESH_GET, globalFetch, jsonInit, parsed, request, type FetchFn } from './request.ts';

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
