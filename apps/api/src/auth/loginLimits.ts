// The limit on login attempts (ADR-0004, "הגבלת ניסיונות"): 5 attempts per IP in 15 minutes, and
// 30 per hour from all IPs together. The counts live in the AttemptStore (Mongo in production),
// because the api is serverless and keeps no memory between requests.
//
// ADR-0004 names `express-rate-limit`; this uses the AttemptStore directly instead: no dependency,
// and the count lives in the serverless-safe store the booking form's limit (rateLimit.ts) already
// uses. rateLimitByIp itself does not fit: it counts every request, before the route has parsed it,
// and cannot forget an IP after a correct password.
import type { AttemptStore } from '../attempts/attemptStore.ts';
import { UNKNOWN_IP } from '../rateLimit.ts';

const MINUTE_MS = 60 * 1000;

/**
 * Login attempts allowed inside each sliding window before the login answers 429 (ADR-0004). The
 * password is short enough to type on a phone, so these limits are what makes guessing it slow.
 *
 * - `perIp`: 5 attempts per client IP in 15 minutes.
 * - `global`: 30 attempts per hour from all IPs together, against a guesser spread over many IPs.
 *   It also lets an attacker lock Yoel out of logging in for an hour; ADR-0004 accepts that,
 *   because his existing cookie keeps working meanwhile.
 */
export const LOGIN_LIMITS = {
  perIp: { max: 5, windowMs: 15 * MINUTE_MS },
  global: { max: 30, windowMs: 60 * MINUTE_MS },
} as const;

/** AttemptStore key of one client IP's login attempts (the name attemptStore.ts documents). */
export function loginIpKey(ip: string | undefined): string {
  return `login:ip:${ip ?? UNKNOWN_IP}`;
}

/** AttemptStore key of every login attempt, from all IPs together. */
export const LOGIN_GLOBAL_KEY = 'login:all';

/** The three questions the login route asks of the limit, for one client IP. */
export interface LoginLimiter {
  /**
   * True when this IP, or everyone together, has used up its attempts. A cheap pre-check that
   * records nothing, so a blocked client cannot keep its own lockout going by trying again.
   */
  isBlocked(ip: string | undefined): Promise<boolean>;
  /**
   * Counts one attempt, for this IP and for the global cap, and says whether it may go on to the
   * password check. Call it BEFORE the (slow) password check: the count includes this attempt, so
   * of a burst sent at the same instant only the first `max` get true, however the requests
   * interleave. The check-then-record order this replaces let a whole burst through.
   */
  recordAttempt(ip: string | undefined): Promise<boolean>;
  /**
   * Forgets this IP's attempts after a correct password, so Yoel's own typos do not add up over
   * the day. The global count is kept: one success must not wipe out a spread-out attack's count.
   */
  recordSuccess(ip: string | undefined): Promise<void>;
}

/**
 * The {@link LoginLimiter} on `attempts`, with {@link LOGIN_LIMITS}.
 *
 * Every attempt that reaches the password check is counted up front, so a correct login also uses
 * one slot of the global cap (it is not given back). With one collector logging in a few times a
 * month that never matters; the per-IP count is reset on success.
 *
 * `ip` is `req.ip`: the client's address because the app trusts exactly one proxy hop (app.ts).
 * It ends up in a store key, never in a log; each attempt is deleted once its window has passed.
 */
export function createLoginLimiter(attempts: AttemptStore): LoginLimiter {
  const { perIp, global } = LOGIN_LIMITS;

  return {
    async isBlocked(ip) {
      const [ipAttempts, allAttempts] = await Promise.all([
        attempts.count(loginIpKey(ip), perIp.windowMs),
        attempts.count(LOGIN_GLOBAL_KEY, global.windowMs),
      ]);
      return ipAttempts >= perIp.max || allAttempts >= global.max;
    },

    async recordAttempt(ip) {
      const [ipAttempts, allAttempts] = await Promise.all([
        attempts.hit(loginIpKey(ip), perIp.windowMs),
        attempts.hit(LOGIN_GLOBAL_KEY, global.windowMs),
      ]);
      return ipAttempts <= perIp.max && allAttempts <= global.max;
    },

    recordSuccess(ip) {
      return attempts.reset(loginIpKey(ip));
    },
  };
}
