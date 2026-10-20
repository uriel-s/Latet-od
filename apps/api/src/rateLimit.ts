// Per-IP rate limit middleware for public endpoints (spec §7, "מגבלת קצב פשוטה לפי IP"): first
// for POST /api/orders. The api is serverless, so the count cannot live in this function's memory:
// it lives in an AttemptStore (Mongo in production, the same mechanism as the login limit, ADR-0004).
import type { RequestHandler } from 'express';
import type { RateLimitedErrorBody } from '@bottlerun/shared';
import type { AttemptStore } from './attempts/attemptStore.ts';

/** How {@link rateLimitByIp} counts and what it answers once an IP is over its limit. */
export interface RateLimitOptions {
  /** Where attempts are counted (Mongo in production, so it holds across serverless instances). */
  attempts: AttemptStore;
  /** Namespace of the key, e.g. 'order:ip'; the key is `${keyPrefix}:${ip}`. */
  keyPrefix: string;
  /** Requests allowed per IP inside the window; the next one gets 429. */
  max: number;
  /** Length of the sliding window, in milliseconds. */
  windowMs: number;
  /** Plain-Hebrew text for the 429 body. */
  message: string;
}

/**
 * Stands in for `req.ip` when Express has none (the socket closed before the request was handled).
 * Such requests share one key, so they are still limited, together, rather than let through. The
 * login's limit (auth/loginLimits.ts) uses it too.
 */
export const UNKNOWN_IP = 'unknown';

/**
 * Express middleware that allows each client IP `max` requests per sliding window of `windowMs`,
 * and answers the rest `429` with a {@link RateLimitedErrorBody}, without calling the route.
 *
 * - Every request is counted, with one `attempts.hit` (a single store call per request, cheap on a
 *   serverless function). That includes requests made while blocked: they are attempts inside the
 *   window too, so a client that keeps hammering stays blocked, while a person who stops and waits
 *   out the window gets through again.
 * - `req.ip` is the client's address only because the app trusts exactly one proxy hop
 *   (`trust proxy` = 1 in app.ts); mount this after that setting, on the app that has it.
 * - If the store fails (database down), the rejected promise reaches the app's error handler
 *   (Express 5 forwards it), which answers 500: the limit fails closed, never silently skipped.
 * - No Retry-After header: a sliding window frees a slot as each old attempt ages out, so there is
 *   no single reset time to announce.
 * - Logs nothing, so neither the IP nor the request body ever reaches the log.
 */
export function rateLimitByIp(options: RateLimitOptions): RequestHandler {
  const { attempts, keyPrefix, max, windowMs, message } = options;

  return async (req, res, next) => {
    const key = `${keyPrefix}:${req.ip ?? UNKNOWN_IP}`;
    const attemptsInWindow = await attempts.hit(key, windowMs);

    if (attemptsInWindow > max) {
      const body: RateLimitedErrorBody = { error: 'rate_limited', message };
      res.status(429).json(body);
      return;
    }
    next();
  };
}
