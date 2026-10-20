// The guard of every collector-only route (ADR-0004): a request passes only with a valid session
// cookie, and a session more than a day old is renewed on the way through. createApp mounts it on
// /api/collector (so every route sections 6+ add there is protected) and on GET /api/auth/me.
import type { RequestHandler, Response } from 'express';
import type { SessionUser, UnauthenticatedErrorBody } from '@bottlerun/shared';
import type { AuthDeps } from '../deps.ts';
import { readCookie, setSessionCookie } from './cookies.ts';
import { SESSION_COOKIE_NAME, needsRenewal, newSessionPayload, verifySession } from './session.ts';

/**
 * Key in `res.locals` under which requireCollector leaves the logged-in user for the route. Read
 * it with {@link sessionUserOf}, never directly: the accessor gives it a type, where `res.locals`
 * is `any`. (No declaration merging on Express.Locals: that would type `res.locals.sessionUser` on
 * every route, those without the guard too, where it is never set.)
 */
const SESSION_USER_LOCAL = 'sessionUser';

/**
 * Express middleware that lets a request through only with a valid session cookie.
 *
 * - No `session` cookie, or one {@link verifySession} refuses (forged, tampered, signed with
 *   another SESSION_SECRET, expired, garbage) → 401 {@link UnauthenticatedErrorBody}; the route
 *   never runs. The web app shows the login screen.
 * - Valid → the user is stored for the route ({@link sessionUserOf}). When the session was issued
 *   more than a day ago, the response also carries a fresh cookie issued now (ADR-0004), so as
 *   long as Yoel opens the app once in 90 days he is never logged out.
 *
 * Every answer gets `Cache-Control: no-store`: what is behind the login (customers' phones and
 * addresses) and a fresh Set-Cookie must never sit in a cache. A route may still override it.
 *
 * Logs nothing: neither the cookie nor the IP reaches the log.
 */
export function requireCollector(auth: AuthDeps): RequestHandler {
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const now = auth.now?.() ?? new Date();

    const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    const payload = token === undefined ? null : verifySession(token, auth.sessionSecret, now);
    if (payload === null) {
      const body: UnauthenticatedErrorBody = { error: 'unauthenticated' };
      res.status(401).json(body);
      return;
    }

    const user: SessionUser = { sub: payload.sub };
    if (needsRenewal(payload, now)) setSessionCookie(res, newSessionPayload(user, now), auth);
    res.locals[SESSION_USER_LOCAL] = user;
    next();
  };
}

/**
 * The logged-in user of a request that passed {@link requireCollector}.
 *
 * @throws Error when the route was mounted without the guard: a programming mistake, which must
 *   fail loudly (500) rather than serve collector data to nobody in particular.
 */
export function sessionUserOf(res: Response): SessionUser {
  const user = res.locals[SESSION_USER_LOCAL] as SessionUser | undefined;
  if (user === undefined) {
    throw new Error('sessionUserOf: the route is not behind requireCollector');
  }
  return user;
}
