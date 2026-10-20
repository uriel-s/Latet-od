// The contract of /api/auth/* (ADR-0004): who is logged in, what the login form sends, what the
// api answers, and the error bodies with their plain-Hebrew messages. There is one logged-in user,
// the collector (Yoel), so a session names no person, only the role `collector`.
import { z } from 'zod';
import type { RateLimitedErrorBody } from './orderApi.ts';

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

/**
 * The logged-in user, as the api's routes and the web app see it. `sub` is always `collector`
 * today (one password, no `users` collection, ADR-0004); it is kept as a field so a future `users`
 * collection only widens its values instead of changing the format.
 */
export const sessionUserSchema = z.object({
  sub: z.literal('collector'),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

/**
 * The content of the signed session cookie (ADR-0004): who, issued at, expires at, in epoch
 * SECONDS like a JWT. Only the api reads it (the cookie is httpOnly); it lives here because the
 * zod schemas live in shared. The api checks the cookie's signature before it parses this, so the
 * schema guards against a payload signed by an older format, not against forgery.
 */
export const sessionPayloadSchema = z.object({
  sub: z.literal('collector'),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type SessionPayload = z.infer<typeof sessionPayloadSchema>;

// ---------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------

/**
 * Longest password the login accepts. The real one is a long sentence (ADR-0004), far below this;
 * the cap only keeps a hostile request from making the server hash a huge string.
 */
export const LOGIN_PASSWORD_MAX_LENGTH = 1000;

/**
 * Body of POST /api/auth/login. Only "non-empty and not huge": whether it is the right password
 * is the api's check, and a wrong one answers 401, not 400. No trimming: spaces are part of a
 * sentence password, and a typed one must hash exactly as it was set.
 */
export const loginRequestSchema = z.object({
  password: z.string().min(1).max(LOGIN_PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Success responses (200)
// ---------------------------------------------------------------------------------------------

/**
 * Body of a 200 from GET /api/auth/me: who is logged in. The web app parses it with this schema
 * to decide between the collector app and the login screen.
 */
export const meResponseSchema = z.object({
  user: sessionUserSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Body of a 200 from POST /api/auth/login: the same as GET /api/auth/me right after it. */
export type LoginResponse = MeResponse;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Plain-Hebrew messages of the login screen that Yoel sees, under the password field. */
export const LOGIN_MESSAGES = {
  wrongPassword: 'הסיסמה שגויה.',
  passwordRequired: 'נא להקליד את הסיסמה.',
  rateLimited: 'יותר מדי ניסיונות כניסה. נא לנסות שוב מאוחר יותר.',
} as const;

// The bodies below follow ApiErrorBody (index.ts): a stable `error` code, plus a Hebrew `message`
// where the user sees it. Standalone, like orderApi.ts, because index.ts re-exports this file and
// importing back from it would be circular. Login's 429 is orderApi.ts's RateLimitedErrorBody.

/**
 * 401 from POST /api/auth/login: the password is wrong. Never says more (no hint, no attempt
 * count), and never echoes what was typed.
 */
export interface InvalidCredentialsErrorBody {
  error: 'invalid_credentials';
  message: string;
}

/**
 * 400 from POST /api/auth/login: the body is not `{ password: <non-empty string> }`. The web form
 * never sends that (it checks for an empty field first), so there is no message to show.
 */
export interface InvalidLoginRequestErrorBody {
  error: 'invalid_login_request';
}

/**
 * 401 from any collector-only route (and GET /api/auth/me): no session cookie, or one that is
 * forged, expired, or signed with an old SESSION_SECRET. The web app shows the login screen.
 */
export interface UnauthenticatedErrorBody {
  error: 'unauthenticated';
}

/**
 * 403 from a request that changes something when its `Origin` header does not match the host the
 * api serves (ADR-0004, CSRF: same origin + SameSite=Lax, no separate token).
 */
export interface ForbiddenOriginErrorBody {
  error: 'forbidden_origin';
}

/**
 * Every error body POST /api/auth/login adds to the ones every route may answer (ApiErrorBody).
 * Its 429 is the booking form's body, with {@link LOGIN_MESSAGES}.rateLimited as the message.
 */
export type LoginErrorBody =
  InvalidLoginRequestErrorBody | InvalidCredentialsErrorBody | RateLimitedErrorBody;
