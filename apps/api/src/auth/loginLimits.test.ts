// Unit tests of the failed-login limit (ADR-0004: 5 per IP in 15 minutes, 30 per hour from all
// IPs), against the in-memory AttemptStore with a fake clock, so windows pass without waiting.
// The route's use of it (429 before the password check) is tested in authRoutes.test.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryAttemptStore } from '../attempts/inMemoryAttemptStore.ts';
import {
  LOGIN_GLOBAL_KEY,
  LOGIN_LIMITS,
  createLoginLimiter,
  loginIpKey,
  type LoginLimiter,
} from './loginLimits.ts';

const IP = '203.0.113.7';
const OTHER_IP = '198.51.100.9';
const MINUTE_MS = 60 * 1000;

let clock: Date;
let attempts: InMemoryAttemptStore;
let limiter: LoginLimiter;

beforeEach(() => {
  clock = new Date('2026-10-20T09:00:00.000Z');
  attempts = new InMemoryAttemptStore({ now: () => clock });
  limiter = createLoginLimiter(attempts);
});

/** Moves the fake clock forward by `ms`. */
function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

/** Records `failures` wrong passwords from `ip`. */
async function fail(ip: string | undefined, failures: number): Promise<void> {
  for (let i = 0; i < failures; i += 1) await limiter.recordFailure(ip);
}

describe('LOGIN_LIMITS', () => {
  it('are ADR-0004 limits: 5 per IP in 15 minutes, 30 from all IPs in an hour', () => {
    expect(LOGIN_LIMITS).toEqual({
      perIp: { max: 5, windowMs: 15 * MINUTE_MS },
      global: { max: 30, windowMs: 60 * MINUTE_MS },
    });
  });
});

describe('keys', () => {
  it('are the names attemptStore.ts documents', () => {
    expect(loginIpKey(IP)).toBe(`login:ip:${IP}`);
    expect(LOGIN_GLOBAL_KEY).toBe('login:all');
  });

  it('share one key for requests without an IP, so they are still limited', () => {
    expect(loginIpKey(undefined)).toBe('login:ip:unknown');
  });
});

describe('createLoginLimiter', () => {
  it('does not block an IP with no failures', async () => {
    expect(await limiter.isBlocked(IP)).toBe(false);
  });

  it('blocks an IP after its 5th failure, not before', async () => {
    await fail(IP, 4);
    expect(await limiter.isBlocked(IP)).toBe(false);

    await fail(IP, 1);
    expect(await limiter.isBlocked(IP)).toBe(true);
  });

  it('counts each failure for the IP and for everyone together', async () => {
    await fail(IP, 2);

    expect(await attempts.count(loginIpKey(IP), LOGIN_LIMITS.perIp.windowMs)).toBe(2);
    expect(await attempts.count(LOGIN_GLOBAL_KEY, LOGIN_LIMITS.global.windowMs)).toBe(2);
  });

  it("does not block another IP for one IP's failures", async () => {
    await fail(IP, 5);

    expect(await limiter.isBlocked(OTHER_IP)).toBe(false);
  });

  it('lets the IP try again once its failures are 15 minutes old', async () => {
    await fail(IP, 5);

    advance(15 * MINUTE_MS - 1);
    expect(await limiter.isBlocked(IP)).toBe(true);
    advance(1);
    expect(await limiter.isBlocked(IP)).toBe(false);
  });

  it('blocks everyone, a fresh IP too, after 30 failures from different IPs in an hour', async () => {
    for (let i = 0; i < 29; i += 1) await fail(`10.0.0.${i}`, 1);
    expect(await limiter.isBlocked('10.0.1.1')).toBe(false);

    await fail('10.0.0.29', 1);
    expect(await limiter.isBlocked('10.0.1.1')).toBe(true);

    advance(60 * MINUTE_MS);
    expect(await limiter.isBlocked('10.0.1.1')).toBe(false);
  });

  it("forgets the IP's failures on success, but not the global count", async () => {
    await fail(IP, 4);
    await fail(OTHER_IP, 1);

    await limiter.recordSuccess(IP);

    expect(await attempts.count(loginIpKey(IP), LOGIN_LIMITS.perIp.windowMs)).toBe(0);
    expect(await attempts.count(loginIpKey(OTHER_IP), LOGIN_LIMITS.perIp.windowMs)).toBe(1);
    expect(await attempts.count(LOGIN_GLOBAL_KEY, LOGIN_LIMITS.global.windowMs)).toBe(5);
  });

  it('limits requests without an IP together', async () => {
    await fail(undefined, 5);

    expect(await limiter.isBlocked(undefined)).toBe(true);
    expect(await limiter.isBlocked(IP)).toBe(false);
  });
});
