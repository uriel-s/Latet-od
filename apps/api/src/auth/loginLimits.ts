// The limit on failed logins (ADR-0004, "הגבלת ניסיונות"): 5 failures per IP in 15 minutes, and
// 30 failures per hour from all IPs together. The counts live in the AttemptStore (Mongo in
// production), because the api is serverless and keeps no memory between requests.
//
// ADR-0004 names `express-rate-limit`; this uses the AttemptStore directly instead: no dependency,
// it counts FAILURES only (a correct login is never held against anyone), and the count lives in
// the serverless-safe store the booking form's limit (rateLimit.ts) already uses. rateLimitByIp
// itself does not fit: it counts every request, before the route knows whether it failed.
import type { AttemptStore } from '../attempts/attemptStore.ts';
import { UNKNOWN_IP } from '../rateLimit.ts';

const MINUTE_MS = 60 * 1000;

/**
 * Failed logins allowed inside each sliding window before the login answers 429 (ADR-0004). A
 * strong password (a long sentence) is the real protection; these only slow down guessing.
 *
 * - `perIp`: 5 failures per client IP in 15 minutes.
 * - `global`: 30 failures per hour from all IPs together, against a guesser spread over many IPs.
 *   It also lets an attacker lock Yoel out of logging in for an hour; ADR-0004 accepts that,
 *   because his existing cookie keeps working meanwhile.
 */
export const LOGIN_LIMITS = {
  perIp: { max: 5, windowMs: 15 * MINUTE_MS },
  global: { max: 30, windowMs: 60 * MINUTE_MS },
} as const;

/** AttemptStore key of one client IP's failed logins (the name attemptStore.ts documents). */
export function loginIpKey(ip: string | undefined): string {
  return `login:ip:${ip ?? UNKNOWN_IP}`;
}

/** AttemptStore key of every failed login, from all IPs together. */
export const LOGIN_GLOBAL_KEY = 'login:all';

/** The three questions the login route asks of the limit, for one client IP. */
export interface LoginLimiter {
  /**
   * True when this IP, or everyone together, has used up its failures: the login must answer 429
   * BEFORE checking the password, so a blocked client learns nothing, even with the right one.
   */
  isBlocked(ip: string | undefined): Promise<boolean>;
  /** Counts one wrong password, for this IP and for the global cap. */
  recordFailure(ip: string | undefined): Promise<void>;
  /**
   * Forgets this IP's failures after a correct password, so Yoel's own typos do not add up over
   * the day. The global count is kept: one success must not wipe out a spread-out attack's count.
   */
  recordSuccess(ip: string | undefined): Promise<void>;
}

/**
 * The {@link LoginLimiter} on `attempts`, with {@link LOGIN_LIMITS}.
 *
 * Count-then-hit is not atomic: two wrong passwords sent at the same instant may both be checked
 * before either is counted, so a burst can go a few failures past the limit. At this volume (one
 * collector, a handful of logins a month) that is fine, and every failure is still counted, so the
 * next attempt is blocked.
 *
 * `ip` is `req.ip`: the client's address because the app trusts exactly one proxy hop (app.ts).
 * It ends up in a store key, never in a log; each attempt is deleted once its window has passed.
 */
export function createLoginLimiter(attempts: AttemptStore): LoginLimiter {
  const { perIp, global } = LOGIN_LIMITS;

  return {
    async isBlocked(ip) {
      const [ipFailures, allFailures] = await Promise.all([
        attempts.count(loginIpKey(ip), perIp.windowMs),
        attempts.count(LOGIN_GLOBAL_KEY, global.windowMs),
      ]);
      return ipFailures >= perIp.max || allFailures >= global.max;
    },

    async recordFailure(ip) {
      await Promise.all([
        attempts.hit(loginIpKey(ip), perIp.windowMs),
        attempts.hit(LOGIN_GLOBAL_KEY, global.windowMs),
      ]);
    },

    recordSuccess(ip) {
      return attempts.reset(loginIpKey(ip));
    },
  };
}
