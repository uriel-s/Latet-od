// In-memory dependencies for api tests: route tests build their app with
// `createApp(createFakeDeps())`, and override one piece when they need to see or steer it.
import { randomBytes } from 'node:crypto';
import { InMemoryAttemptStore } from './attempts/inMemoryAttemptStore.ts';
import type { AppDeps, AuthDeps } from './deps.ts';
import { InMemoryOrdersRepo } from './orders/inMemoryOrdersRepo.ts';

/**
 * The password {@link createFakeAuth}'s verifier accepts. Test-only, like this whole module: the
 * real password exists only as its hash, in COLLECTOR_PASSWORD_HASH.
 */
export const FAKE_COLLECTOR_PASSWORD = 'fake collector password for tests';

/**
 * Login settings for tests: a verifier that accepts exactly {@link FAKE_COLLECTOR_PASSWORD} (a
 * plain comparison, no scrypt, so tests stay fast), a fresh random session secret on each call,
 * the Secure cookie as in production, and the real clock.
 *
 * @param overrides E.g. `{ now: () => clock }` to drive issuing and renewal, or the real
 *   `createVerifyCredentials(hash)` to run the whole scrypt path. A test that signs its own
 *   cookies keeps the returned object and signs with its `sessionSecret`.
 */
export function createFakeAuth(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    verifyCredentials: (password) =>
      Promise.resolve(password === FAKE_COLLECTOR_PASSWORD ? { sub: 'collector' } : null),
    sessionSecret: randomBytes(32).toString('base64url'),
    secureCookie: true,
    ...overrides,
  };
}

/**
 * Fresh, empty fakes for every dependency: an {@link InMemoryOrdersRepo}, an
 * {@link InMemoryAttemptStore} on the real clock, a database whose ping always answers, and
 * {@link createFakeAuth}'s login. Each call makes new instances, so tests never share state.
 *
 * @param overrides Pieces to use instead, e.g. `{ db: { ping: () => Promise.reject(...) } }` for a
 *   database that is down, or a repo the test keeps a reference to and inspects.
 */
export function createFakeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    orders: new InMemoryOrdersRepo(),
    attempts: new InMemoryAttemptStore(),
    db: { ping: () => Promise.resolve() },
    auth: createFakeAuth(),
    ...overrides,
  };
}
