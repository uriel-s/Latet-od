// /api/auth/* (ADR-0004): the collector's login, logout, and "who is logged in". createApp mounts
// the router built here on /api/auth. The password check is AuthDeps.verifyCredentials, the
// session cookie is session.ts + cookies.ts, and failed logins are limited by loginLimits.ts.
import { Router } from 'express';
import {
  LOGIN_MESSAGES,
  loginRequestSchema,
  type InvalidCredentialsErrorBody,
  type InvalidLoginRequestErrorBody,
  type LoginResponse,
  type MeResponse,
  type RateLimitedErrorBody,
  type SessionUser,
} from '@bottlerun/shared';
import type { AppDeps } from '../deps.ts';
import { clearSessionCookie, setSessionCookie } from './cookies.ts';
import { createLoginLimiter } from './loginLimits.ts';
import { requireCollector, sessionUserOf } from './requireCollector.ts';
import { newSessionPayload } from './session.ts';

/**
 * The router of /api/auth. Mount it with `app.use('/api/auth', createAuthRouter(deps))`, after the
 * Origin check and the JSON body parser (both POSTs need the Origin check: ADR-0004, CSRF).
 *
 * POST /login, body `{ password }` ({@link loginRequestSchema}, never trimmed):
 * - 429 `rate_limited` with {@link LOGIN_MESSAGES}.rateLimited when this IP or everyone together
 *   has used up the failed logins (loginLimits.ts). Answered BEFORE the password is checked, so a
 *   blocked client learns nothing, even with the right password. An existing cookie keeps working.
 * - 400 `invalid_login_request`: no body, not an object, or the password missing, empty or over
 *   the length cap. Not counted as a failure: it is no guess at the password.
 * - 401 `invalid_credentials` with {@link LOGIN_MESSAGES}.wrongPassword: counted against this IP
 *   and the global cap.
 * - 200 {@link LoginResponse} and the session cookie (90 days): this IP's failures are forgotten.
 *
 * POST /logout: clears the session cookie and answers 204, with or without a session (idempotent:
 * a second tap, or a cookie that already expired, still ends logged out).
 *
 * GET /me: behind {@link requireCollector}, so it renews an old session too. 200 {@link MeResponse}
 * when logged in, 401 `unauthenticated` otherwise. The web app's guard calls it on load.
 *
 * Every answer is `Cache-Control: no-store`. Nothing is logged: never the password, the cookie or
 * the IP. An unexpected error (say, the attempt store is down) goes to the app's error handler,
 * which logs it without the request and answers 500: the limit fails closed.
 */
export function createAuthRouter(deps: Pick<AppDeps, 'auth' | 'attempts'>): Router {
  const { auth } = deps;
  const limiter = createLoginLimiter(deps.attempts);
  const router = Router();

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/login', async (req, res) => {
    if (await limiter.isBlocked(req.ip)) {
      const body: RateLimitedErrorBody = {
        error: 'rate_limited',
        message: LOGIN_MESSAGES.rateLimited,
      };
      res.status(429).json(body);
      return;
    }

    // Express 5 leaves `req.body` undefined when no JSON body was sent; safeParse turns that into
    // a 400 too. The web form checks for an empty field itself, so it never gets here with one.
    const parsed = loginRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const body: InvalidLoginRequestErrorBody = { error: 'invalid_login_request' };
      res.status(400).json(body);
      return;
    }

    const user = await auth.verifyCredentials(parsed.data.password);
    if (user === null) {
      await limiter.recordFailure(req.ip);
      const body: InvalidCredentialsErrorBody = {
        error: 'invalid_credentials',
        message: LOGIN_MESSAGES.wrongPassword,
      };
      res.status(401).json(body);
      return;
    }

    await limiter.recordSuccess(req.ip);
    // Only `sub` goes into the cookie and the answer, whatever else a verifier might return.
    const sessionUser: SessionUser = { sub: user.sub };
    setSessionCookie(res, newSessionPayload(sessionUser, auth.now?.() ?? new Date()), auth);
    const body: LoginResponse = { user: sessionUser };
    res.json(body);
  });

  router.post('/logout', (_req, res) => {
    clearSessionCookie(res, auth);
    res.status(204).end();
  });

  router.get('/me', requireCollector(auth), (_req, res) => {
    const body: MeResponse = { user: sessionUserOf(res) };
    res.json(body);
  });

  return router;
}
