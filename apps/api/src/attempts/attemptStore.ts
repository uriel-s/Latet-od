// Counts attempts per key in a sliding time window (ADR-0004, "הגבלת ניסיונות"): failed logins
// (5 per IP in 15 minutes, 30 per hour from all IPs together) and the public form's rate limit.
// The api is serverless and keeps no memory between requests, so the counts live in Mongo
// (`loginAttempts`, with a TTL index) behind this interface; tests use the in-memory fake.

/**
 * Options every AttemptStore implementation takes, so tests can drive time with a fake clock
 * instead of waiting for a window to pass.
 */
export interface AttemptStoreOptions {
  /** The current time. Defaults to the real clock, `() => new Date()`. */
  now?: () => Date;
}

/**
 * Attempts per key in a sliding window. An attempt made at `at` is inside the window of
 * `windowMs` exactly when `at > now - windowMs`: one exactly `windowMs` old no longer counts.
 *
 * Callers namespace their keys by purpose, e.g. `login:ip:<ip>`, `login:all`, `order:ip:<ip>`,
 * and use one `windowMs` per key, in `hit` and in `count` alike. A key may hold an IP address:
 * that is fine, because every attempt is deleted once its window has passed.
 */
export interface AttemptStore {
  /**
   * Records one attempt for `key` and returns how many attempts `key` has in the last
   * `windowMs`, this one included. The record expires after `windowMs` (Mongo: a TTL index;
   * its cleanup runs late, so the count itself must not rely on it).
   */
  hit(key: string, windowMs: number): Promise<number>;

  /** Attempts for `key` in the last `windowMs`, without recording one. */
  count(key: string, windowMs: number): Promise<number>;

  /** Forgets every attempt of `key`, e.g. the IP's failures after a successful login. */
  reset(key: string): Promise<void>;
}
